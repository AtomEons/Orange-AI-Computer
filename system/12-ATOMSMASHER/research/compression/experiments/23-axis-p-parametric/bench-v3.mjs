// Experiment 23 v3 — Axis P with STRICT constant detection + lossless guarantee
//
// Bug in v2: marked a key constant if its distinct-value-set had size 1, but
// the key might not appear in every receipt of that action. On decode we'd
// inject the constant into receipts that didn't originally have it → corruption.
//
// Fix: a key is "true-constant for action A" iff EVERY receipt of action A
// contains that key AND that key always has the same value. Additionally,
// only strip from actions where ALL payloads share the same key order.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const CORPUS = path.resolve(ROOT, '../../data/canonical-corpus.jsonl');
const RECEIPT_FILE = path.join(ROOT, 'RECEIPT-v3.json');

const corpusBytes = fs.readFileSync(CORPUS);
const corpusSha = crypto.createHash('sha256').update(corpusBytes).digest('hex');
const lines = corpusBytes.toString('utf8').split('\n').filter(Boolean);
const receipts = lines.map(l => JSON.parse(l));
const N = receipts.length;
console.log(`Loaded ${N} receipts, ${corpusBytes.length} B`);

// Per-action: collect key orders + key→values
const perAction = new Map(); // action → { receipts:[], keyOrders:Map(sig→count), keyValues:Map(key→Set) }
for (let idx = 0; idx < receipts.length; idx++) {
  const r = receipts[idx];
  if (r.payload_json == null) continue;
  let p;
  try { p = JSON.parse(r.payload_json); } catch { continue; }
  if (p == null || typeof p !== 'object' || Array.isArray(p)) continue;
  if (!perAction.has(r.action)) perAction.set(r.action, { receiptIdxs: [], keyOrders: new Map(), keyValues: new Map() });
  const a = perAction.get(r.action);
  a.receiptIdxs.push(idx);
  const sig = Object.keys(p).join('\x00');
  a.keyOrders.set(sig, (a.keyOrders.get(sig) || 0) + 1);
  for (const [k, v] of Object.entries(p)) {
    if (!a.keyValues.has(k)) a.keyValues.set(k, new Map());
    const vs = a.keyValues.get(k);
    const str = JSON.stringify(v);
    vs.set(str, (vs.get(str) || 0) + 1);
  }
}

// Identify action homogeneity + TRUE constants (key in EVERY payload + same value)
const truConstants = new Map(); // action → { keyOrder: [], consts: Map(key → value JSON) }
let homogActions = 0, heteroActions = 0;
for (const [action, info] of perAction) {
  const isHomog = info.keyOrders.size === 1;
  if (isHomog) homogActions++;
  else { heteroActions++; continue; }
  const keyOrder = [...info.keyOrders.keys()][0].split('\x00');
  const consts = new Map();
  for (const k of keyOrder) {
    const vs = info.keyValues.get(k);
    // True constant: appears in every receipt of this action AND has 1 distinct value
    const totalOccurrences = [...vs.values()].reduce((s, c) => s + c, 0);
    if (vs.size === 1 && totalOccurrences === info.receiptIdxs.length) {
      consts.set(k, [...vs.keys()][0]);
    }
  }
  truConstants.set(action, { keyOrder, consts });
}
console.log(`\nHomogeneous-shape actions: ${homogActions} / ${perAction.size}`);
console.log(`Heterogeneous-shape actions (no strip): ${heteroActions}`);

// Count + impact of true constants
let totalConstFields = 0;
let totalConstImpact = 0;
const topConstants = [];
for (const [action, info] of truConstants) {
  totalConstFields += info.consts.size;
  for (const [k, v] of info.consts) {
    const action_receipt_count = perAction.get(action).receiptIdxs.length;
    const bytesPer = k.length + 4 + v.length; // "k":v,
    const total = bytesPer * action_receipt_count;
    totalConstImpact += total;
    topConstants.push({ action, key: k, value: v, count: action_receipt_count, bytesPer, total });
  }
}
topConstants.sort((a, b) => b.total - a.total);
console.log(`\nTotal true-constant (action,key) pairs: ${totalConstFields}`);
console.log(`Total raw byte impact: ${totalConstImpact.toLocaleString()}`);

console.log(`\nTop 10 true-constants by byte impact:`);
console.log(`${'(action, key)'.padEnd(45)} ${'count'.padStart(6)} ${'bytes/occ'.padStart(10)} ${'total'.padStart(10)}`);
for (const c of topConstants.slice(0, 10)) {
  console.log(`${(c.action + '|' + c.key).padEnd(45)} ${c.count.toString().padStart(6)} ${c.bytesPer.toString().padStart(10)} ${c.total.toString().padStart(10)}`);
}

// ── Encode: strip constants from each receipt's payload (preserving stripped key order) ──
const strippedReceipts = receipts.map(r => {
  if (r.payload_json == null) return r;
  const tc = truConstants.get(r.action);
  if (!tc) return r;
  let p;
  try { p = JSON.parse(r.payload_json); } catch { return r; }
  if (p == null || typeof p !== 'object' || Array.isArray(p)) return r;
  const stripped = {};
  for (const [k, v] of Object.entries(p)) {
    if (!tc.consts.has(k)) stripped[k] = v;
  }
  return { ...r, payload_json: JSON.stringify(stripped) };
});

const strippedJsonl = strippedReceipts.map(r => JSON.stringify(r)).join('\n') + '\n';
const strippedBytes = Buffer.from(strippedJsonl, 'utf8');
console.log(`\nStripped corpus pre-brotli: ${strippedBytes.length} B (saved ${corpusBytes.length - strippedBytes.length} B raw vs original)`);

// Recipe: per-homogeneous-action: keyOrder + constants
const recipe = {};
for (const [action, info] of truConstants) {
  recipe[action] = { ko: info.keyOrder, c: Object.fromEntries(info.consts) };
}
const recipeBytes = Buffer.from(JSON.stringify(recipe), 'utf8');
const recipeBrotli = zlib.brotliCompressSync(recipeBytes, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } });
const strippedBrotli = zlib.brotliCompressSync(strippedBytes, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } });
const total = strippedBrotli.length + recipeBrotli.length;
const ratio = corpusBytes.length / total;
console.log(`Recipe size raw: ${recipeBytes.length} B, brotli: ${recipeBrotli.length} B`);
console.log(`Stripped + brotli q11: ${strippedBrotli.length} B`);
console.log(`Total lossless: ${total} B`);
console.log(`Axis P v3 ratio: ${ratio.toFixed(2)}x  (vs plait 18.05x ${ratio > 18.05 ? 'BEATS +' + (ratio - 18.05).toFixed(2) + 'x' : 'below by ' + (18.05 - ratio).toFixed(2) + 'x'})`);

// ── Decode + roundtrip verify ───────────────────────────────────────────────
const recipeDecoded = JSON.parse(zlib.brotliDecompressSync(recipeBrotli).toString('utf8'));
const strippedDecoded = zlib.brotliDecompressSync(strippedBrotli).toString('utf8');
const strippedRecs = strippedDecoded.split('\n').filter(Boolean).map(l => JSON.parse(l));

const reconstructed = strippedRecs.map(r => {
  const tc = recipeDecoded[r.action];
  if (!tc || r.payload_json == null) return r;
  let strippedP;
  try { strippedP = JSON.parse(r.payload_json); } catch { return r; }
  if (strippedP == null || typeof strippedP !== 'object' || Array.isArray(strippedP)) return r;
  const restored = {};
  for (const k of tc.ko) {
    if (k in tc.c) restored[k] = JSON.parse(tc.c[k]);
    else if (k in strippedP) restored[k] = strippedP[k];
  }
  return { ...r, payload_json: JSON.stringify(restored) };
});

const recJsonl = reconstructed.map(r => JSON.stringify(r)).join('\n') + '\n';
const recSha = crypto.createHash('sha256').update(recJsonl).digest('hex');
const lossless = recSha === corpusSha;
console.log(`\nRoundtrip: ${lossless ? '✓ BYTE-EXACT' : '✗ MISMATCH'} (sha256 in=${corpusSha.slice(0,16)}... out=${recSha.slice(0,16)}...)`);

if (!lossless) {
  const orig = corpusBytes.toString('utf8');
  const minLen = Math.min(orig.length, recJsonl.length);
  for (let i = 0; i < minLen; i++) {
    if (orig[i] !== recJsonl[i]) {
      console.log(`First diff at byte ${i}:`);
      console.log(`  orig: ...${orig.slice(Math.max(0, i-80), i+80)}...`);
      console.log(`  dec:  ...${recJsonl.slice(Math.max(0, i-80), i+80)}...`);
      break;
    }
  }
  // Find which receipt mismatched
  for (let i = 0; i < receipts.length; i++) {
    if (JSON.stringify(receipts[i]) !== JSON.stringify(reconstructed[i])) {
      console.log(`\nFirst mismatched receipt at index ${i}:`);
      console.log(`  orig action=${receipts[i].action}, payload=${receipts[i].payload_json?.slice(0,120)}`);
      console.log(`  dec  action=${reconstructed[i].action}, payload=${reconstructed[i].payload_json?.slice(0,120)}`);
      break;
    }
  }
}

const receiptOut = {
  experiment: '23-axis-p-parametric',
  version: 'v3-strict-constants',
  generated_at: new Date().toISOString(),
  corpus_sha256_in: corpusSha,
  homogeneous_actions: homogActions,
  heterogeneous_actions: heteroActions,
  total_const_fields: totalConstFields,
  total_const_raw_impact: totalConstImpact,
  top_constants: topConstants.slice(0, 15),
  stripped_pre_brotli: strippedBytes.length,
  stripped_brotli: strippedBrotli.length,
  recipe_brotli: recipeBrotli.length,
  total_lossless: total,
  ratio: Number(ratio.toFixed(2)),
  roundtrip_lossless: lossless,
  beats_plait: ratio > 18.05,
};
fs.writeFileSync(RECEIPT_FILE, JSON.stringify(receiptOut, null, 2));
console.log(`\nReceipt: ${RECEIPT_FILE}`);
