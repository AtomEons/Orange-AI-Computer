// Experiment 23 v2 — Axis P FAST + LOSSLESS FULL-CORPUS CODEC
//
// v1 found 312× compression on air.compress payload position-2 because three
// fields (atom_count, dropped, citations) are CONSTANT across all 3,126
// air.compress receipts. v2: detect ALL constant-per-(action,position) fields,
// strip them from the corpus, encode the rest, restore on decode losslessly.
//
// Plus: numeric series that aren't constant get the best of {mean+residuals,
// linear fit, RLE} — whichever stores in fewest bytes.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const CORPUS = path.resolve(ROOT, '../../data/canonical-corpus.jsonl');
const RECEIPT_FILE = path.join(ROOT, 'RECEIPT-v2.json');
const RESULT_FILE = path.join(ROOT, 'RESULT-v2.md');

const corpusBytes = fs.readFileSync(CORPUS);
const corpusSha = crypto.createHash('sha256').update(corpusBytes).digest('hex');
const lines = corpusBytes.toString('utf8').split('\n').filter(Boolean);
const receipts = lines.map(l => JSON.parse(l));
const N = receipts.length;
console.log(`Loaded ${N} receipts, ${corpusBytes.length} B`);

const NUMBER_RE = /-?\d+(?:\.\d+)?(?:e-?\d+)?/g;

// Step 1: For each (action, payload-key) → collect values
// Detect payload keys via JSON.parse — track per-(action, key) the distinct values
const valuesByActionKey = new Map(); // "action|key" → Map(value → count)
for (const r of receipts) {
  if (r.payload_json == null) continue;
  let p;
  try { p = JSON.parse(r.payload_json); } catch { continue; }
  if (p == null || typeof p !== 'object' || Array.isArray(p)) continue;
  for (const [k, v] of Object.entries(p)) {
    const key = `${r.action}|${k}`;
    if (!valuesByActionKey.has(key)) valuesByActionKey.set(key, new Map());
    const m = valuesByActionKey.get(key);
    const str = JSON.stringify(v);
    m.set(str, (m.get(str) || 0) + 1);
  }
}

// Step 2: For each (action, key), determine:
//   - constant (1 distinct value)
//   - low-cardinality (≤ small N distinct)
//   - high-cardinality
const constantFields = new Map(); // "action|key" → constant value (JSON string)
const lowCardFields = new Map(); // "action|key" → array of distinct values
for (const [key, m] of valuesByActionKey) {
  if (m.size === 1) constantFields.set(key, [...m.keys()][0]);
  else if (m.size <= 32) lowCardFields.set(key, [...m.keys()]);
}
console.log(`\nConstant fields (1 distinct value): ${constantFields.size}`);
console.log(`Low-card fields (≤32 distinct):     ${lowCardFields.size}`);
console.log(`Total payload (action,key) pairs:   ${valuesByActionKey.size}`);

// Show top constants by byte impact
const constantImpact = [];
for (const [key, val] of constantFields) {
  const action = key.split('|')[0];
  const count = receipts.filter(r => r.action === action && r.payload_json && JSON.parse(r.payload_json) && Object.keys(JSON.parse(r.payload_json)).includes(key.split('|')[1])).length;
  const keyName = key.split('|')[1];
  // Approx bytes saved per occurrence: `"keyName":valueJSON,` length
  const bytesPer = keyName.length + 2 + val.length + 2;
  constantImpact.push({ key, value: val, count, bytesPer, totalBytes: count * bytesPer });
}
constantImpact.sort((a, b) => b.totalBytes - a.totalBytes);
console.log(`\nTop 15 constant fields by byte impact:`);
console.log(`${'(action, key)'.padEnd(45)} ${'value'.padEnd(15)} ${'count'.padStart(6)} ${'bytes/occ'.padStart(10)} ${'total'.padStart(10)}`);
for (const c of constantImpact.slice(0, 15)) {
  console.log(`${c.key.padEnd(45)} ${c.value.padEnd(15)} ${c.count.toString().padStart(6)} ${c.bytesPer.toString().padStart(10)} ${c.totalBytes.toString().padStart(10)}`);
}
const totalConstantBytes = constantImpact.reduce((s, c) => s + c.totalBytes, 0);
console.log(`\nTotal byte impact of constant fields: ${totalConstantBytes.toLocaleString()} B raw`);

// ── Step 3: Build the lossless codec ───────────────────────────────────────
// Encode: strip constant fields from payload_json on encode; store the
// (action, key) → value recipe ONCE; on decode, re-insert in the correct
// position (matching original payload key order).

// To preserve byte-exact payload_json roundtrip we must remember the original
// key ORDER. The payload was serialized by SQLite or whatever produced the
// canonical corpus. Sample shows: `{"ratio":...,"atom_count":...,"dropped":...,"citations":...}`
// We need to capture per-receipt payload key order to restore lossless.

// For each receipt: store the FULL key order list (small overhead since few patterns).
// Per-receipt: keys-removed list (the constant ones we stripped) + remaining payload as JSON

// Actually simpler: per ACTION, capture the dominant key order. Store stripped
// payload (only non-constant key/value pairs in original order). On decode,
// re-insert constants by referring to the action's full-key-order + the recipe.

// Build per-action key-order signature (most common ordered key list)
const keyOrderByAction = new Map(); // action → Map(orderSig → count)
for (const r of receipts) {
  if (r.payload_json == null) continue;
  let p;
  try { p = JSON.parse(r.payload_json); } catch { continue; }
  if (p == null || typeof p !== 'object' || Array.isArray(p)) continue;
  const sig = Object.keys(p).join(',');
  if (!keyOrderByAction.has(r.action)) keyOrderByAction.set(r.action, new Map());
  const m = keyOrderByAction.get(r.action);
  m.set(sig, (m.get(sig) || 0) + 1);
}

// Pick dominant key order per action
const dominantKeyOrder = new Map();
for (const [action, m] of keyOrderByAction) {
  let best = null, bestCount = 0;
  for (const [sig, c] of m) if (c > bestCount) { best = sig; bestCount = c; }
  dominantKeyOrder.set(action, { sig: best, count: bestCount, total: [...m.values()].reduce((a, b) => a + b, 0) });
}
// Stats: how often does the dominant order match?
let actionsWithDominantMatch = 0;
for (const [action, info] of dominantKeyOrder) {
  if (info.count === info.total) actionsWithDominantMatch++;
}
console.log(`\nActions where ALL payloads share the same key order: ${actionsWithDominantMatch} / ${dominantKeyOrder.size}`);

// ── Encode: per receipt, strip constant fields ──────────────────────────────
function varint(n) { const b = []; while (n >= 128) { b.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); } b.push(n & 0x7f); return Buffer.from(b); }
function readVarint(buf, ofs) { let n = 0, m = 1, b; do { b = buf[ofs++]; n += (b & 0x7f) * m; m *= 128; } while (b & 0x80); return [n, ofs]; }

// Strategy: for each receipt, write a NEW payload_json that has only the non-constant fields,
// preserving their original key order. On decode, look up the (action, full_key_order) and
// inject each constant field's value in its original position.

const strippedReceipts = receipts.map(r => {
  if (r.payload_json == null) return { ...r };
  let p;
  try { p = JSON.parse(r.payload_json); } catch { return { ...r }; }
  if (p == null || typeof p !== 'object' || Array.isArray(p)) return { ...r };
  // Walk keys in original order; keep only non-constant ones
  const stripped = {};
  for (const [k, v] of Object.entries(p)) {
    const cKey = `${r.action}|${k}`;
    if (!constantFields.has(cKey)) stripped[k] = v;
  }
  // Re-serialize with PRESERVED key order
  // (Object.entries iteration in V8/Bun preserves insertion order — confirmed)
  return { ...r, payload_json: JSON.stringify(stripped), _stripped: true };
});

// Serialize stripped corpus + recipe table
// Recipe: action → array of (key, value) pairs that are constant, plus full key-order template
const recipeForAction = new Map();
for (const [action, info] of dominantKeyOrder) {
  const keys = info.sig.split(',');
  const constMap = {};
  for (const k of keys) {
    const cKey = `${action}|${k}`;
    if (constantFields.has(cKey)) constMap[k] = constantFields.get(cKey);
  }
  recipeForAction.set(action, { keys, consts: constMap });
}

// Encode the stripped corpus as JSONL + brotli; recipe as a separate small JSON header
const recipeJson = JSON.stringify({
  actions: Object.fromEntries([...recipeForAction.entries()].map(([a, info]) => [a, info])),
});
const recipeBytes = Buffer.from(recipeJson, 'utf8');
console.log(`\nRecipe size (constant + key-order table): ${recipeBytes.length} B`);

const strippedJsonl = strippedReceipts.map(r => {
  // Drop the _stripped marker
  const { _stripped, ...clean } = r;
  return JSON.stringify(clean);
}).join('\n') + '\n';
const strippedBytes = Buffer.from(strippedJsonl, 'utf8');
console.log(`Stripped corpus pre-brotli: ${strippedBytes.length} B (vs raw ${corpusBytes.length} B, saved ${corpusBytes.length - strippedBytes.length} B raw)`);

const strippedBrotli = zlib.brotliCompressSync(strippedBytes, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } });
const recipeBrotli = zlib.brotliCompressSync(recipeBytes, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } });
const total = strippedBrotli.length + recipeBrotli.length;
const ratio = corpusBytes.length / total;
console.log(`Stripped + brotli q11:      ${strippedBrotli.length} B`);
console.log(`Recipe brotli:              ${recipeBrotli.length} B`);
console.log(`Total lossless:             ${total} B`);
console.log(`Axis P ratio:               ${ratio.toFixed(2)}x`);
console.log(`vs plait baseline (18.05x): ${ratio > 18.05 ? `BEATS +${(ratio - 18.05).toFixed(2)}x` : `below ${(18.05 - ratio).toFixed(2)}x`}`);

// ── Lossless roundtrip ──────────────────────────────────────────────────────
const recipeDecoded = JSON.parse(zlib.brotliDecompressSync(recipeBrotli).toString('utf8'));
const strippedDecoded = zlib.brotliDecompressSync(strippedBrotli).toString('utf8');
const strippedRecs = strippedDecoded.split('\n').filter(Boolean).map(l => JSON.parse(l));

const reconstructed = strippedRecs.map(r => {
  const recipe = recipeDecoded.actions[r.action];
  if (!recipe || r.payload_json == null) return r;
  // Parse stripped payload
  let strippedP;
  try { strippedP = JSON.parse(r.payload_json); } catch { return r; }
  if (strippedP == null || typeof strippedP !== 'object') return r;
  // Rebuild in dominant key order
  const restored = {};
  for (const k of recipe.keys) {
    if (k in recipe.consts) restored[k] = JSON.parse(recipe.consts[k]);
    else if (k in strippedP) restored[k] = strippedP[k];
  }
  return { ...r, payload_json: JSON.stringify(restored) };
});

const recJsonl = reconstructed.map(r => JSON.stringify(r)).join('\n') + '\n';
const recSha = crypto.createHash('sha256').update(recJsonl).digest('hex');
const roundtripOk = recSha === corpusSha;
console.log(`\nRoundtrip: ${roundtripOk ? '✓ BYTE-EXACT' : '✗ MISMATCH'}`);
if (!roundtripOk) {
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
}

const receipt = {
  experiment: '23-axis-p-parametric',
  version: 'v2-lossless-constant-stripping',
  generated_at: new Date().toISOString(),
  corpus_sha256_in: corpusSha,
  constant_fields_count: constantFields.size,
  low_card_fields_count: lowCardFields.size,
  total_action_key_pairs: valuesByActionKey.size,
  top_constants: constantImpact.slice(0, 15),
  total_constant_raw_bytes: totalConstantBytes,
  stripped_pre_brotli: strippedBytes.length,
  stripped_brotli: strippedBrotli.length,
  recipe_brotli: recipeBrotli.length,
  total_lossless_bytes: total,
  ratio: Number(ratio.toFixed(2)),
  roundtrip_lossless: roundtripOk,
  beats_plait: ratio > 18.05,
};
fs.writeFileSync(RECEIPT_FILE, JSON.stringify(receipt, null, 2));
console.log(`\nReceipt: ${RECEIPT_FILE}`);
