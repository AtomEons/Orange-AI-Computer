// Experiment 28 — Strip constants THEN two-stream IDs THEN brotli
//
// Combine the only two axes that EMPIRICALLY beat plait:
//   - Constant-stripping (Exp 23 v3): removes redundancy brotli was catching anyway
//   - Two-stream IDs (Exp 21):       isolates 49,792 B of random IDs
//
// Then let brotli handle the clean monolithic remainder.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const CORPUS = path.resolve(ROOT, '../../data/canonical-corpus.jsonl');
const RECEIPT_FILE = path.join(ROOT, 'RECEIPT.json');

const corpusBytes = fs.readFileSync(CORPUS);
const corpusSha = crypto.createHash('sha256').update(corpusBytes).digest('hex');
const lines = corpusBytes.toString('utf8').split('\n').filter(Boolean);
const receipts = lines.map(l => JSON.parse(l));
console.log(`Loaded ${receipts.length} receipts, ${corpusBytes.length} B`);

// ── Step 1: Identify TRUE constants per action ──────────────────────────────
const perAction = new Map();
for (const r of receipts) {
  if (r.payload_json == null) continue;
  let p;
  try { p = JSON.parse(r.payload_json); } catch { continue; }
  if (p == null || typeof p !== 'object' || Array.isArray(p)) continue;
  if (!perAction.has(r.action)) perAction.set(r.action, { count: 0, keyOrders: new Map(), keyValues: new Map() });
  const a = perAction.get(r.action);
  a.count++;
  a.keyOrders.set(Object.keys(p).join('\x00'), (a.keyOrders.get(Object.keys(p).join('\x00')) || 0) + 1);
  for (const [k, v] of Object.entries(p)) {
    if (!a.keyValues.has(k)) a.keyValues.set(k, new Map());
    a.keyValues.get(k).set(JSON.stringify(v), (a.keyValues.get(k).get(JSON.stringify(v)) || 0) + 1);
  }
}
const truConstants = new Map();
for (const [action, info] of perAction) {
  if (info.keyOrders.size !== 1) continue;
  const keyOrder = [...info.keyOrders.keys()][0].split('\x00');
  const consts = new Map();
  for (const k of keyOrder) {
    const vs = info.keyValues.get(k);
    if (vs.size === 1 && [...vs.values()].reduce((s, c) => s + c, 0) === info.count) {
      consts.set(k, [...vs.keys()][0]);
    }
  }
  truConstants.set(action, { keyOrder, consts });
}

// ── Step 2: Strip + extract IDs ─────────────────────────────────────────────
const idBuffers = [];
const auditReceipts = [];
for (const r of receipts) {
  // ID: parse rcpt_xxxxx
  let idBuf = null;
  if (/^rcpt_[0-9a-f]{16}$/.test(r.id || '')) {
    idBuf = Buffer.from(r.id.slice(5), 'hex');
  } else {
    idBuf = Buffer.from((r.id || ''), 'utf8');
  }
  idBuffers.push(idBuf);

  // Strip constants from payload
  let payload = r.payload_json;
  const tc = truConstants.get(r.action);
  if (tc && payload != null) {
    try {
      const p = JSON.parse(payload);
      if (p != null && typeof p === 'object' && !Array.isArray(p)) {
        const stripped = {};
        for (const [k, v] of Object.entries(p)) if (!tc.consts.has(k)) stripped[k] = v;
        payload = JSON.stringify(stripped);
      }
    } catch {}
  }
  // Reconstruct audit receipt (no id field, stripped payload)
  auditReceipts.push({ action: r.action, status: r.status, summary: r.summary, payload_json: payload, created_at: r.created_at });
}

// ── Step 3: Serialize the audit stream ─────────────────────────────────────
const auditJsonl = auditReceipts.map(r => JSON.stringify(r)).join('\n') + '\n';
const auditBytes = Buffer.from(auditJsonl, 'utf8');
console.log(`Audit stream (IDs removed, constants stripped): ${auditBytes.length} B`);

const auditBrotli = zlib.brotliCompressSync(auditBytes, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } });
console.log(`Audit brotli q11: ${auditBrotli.length} B`);

// ── Step 4: ID stream ──────────────────────────────────────────────────────
const idStream = Buffer.concat(idBuffers);
const idBrotli = zlib.brotliCompressSync(idStream, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } });
console.log(`ID stream raw: ${idStream.length} B, brotli: ${idBrotli.length} B`);

// ── Step 5: Constants recipe ───────────────────────────────────────────────
const recipe = {};
for (const [action, info] of truConstants) {
  recipe[action] = { ko: info.keyOrder, c: Object.fromEntries(info.consts) };
}
const recipeBytes = Buffer.from(JSON.stringify(recipe), 'utf8');
const recipeBrotli = zlib.brotliCompressSync(recipeBytes, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } });
console.log(`Recipe raw: ${recipeBytes.length} B, brotli: ${recipeBrotli.length} B`);

// ── Total ──────────────────────────────────────────────────────────────────
const total = auditBrotli.length + idBrotli.length + recipeBrotli.length;
const ratio = corpusBytes.length / total;
console.log(`\n=== STRIP + STREAM + BROTLI ===`);
console.log(`Audit brotli:     ${auditBrotli.length.toString().padStart(8)} B`);
console.log(`ID brotli:        ${idBrotli.length.toString().padStart(8)} B`);
console.log(`Recipe brotli:    ${recipeBrotli.length.toString().padStart(8)} B`);
console.log(`Total:            ${total.toString().padStart(8)} B`);
console.log(`Corpus:           ${corpusBytes.length.toString().padStart(8)} B`);
console.log(`Ratio:            ${ratio.toFixed(2)}x`);
console.log(`vs plait (18.05x): ${ratio > 18.05 ? `BEATS by +${(ratio - 18.05).toFixed(2)}x` : `below by ${(18.05 - ratio).toFixed(2)}x`}`);
console.log(`vs two-stream alone (17.99x): ${ratio > 17.99 ? `BEATS by +${(ratio - 17.99).toFixed(2)}x` : `below by ${(17.99 - ratio).toFixed(2)}x`}`);

// ── Roundtrip ──────────────────────────────────────────────────────────────
const recipeDec = JSON.parse(zlib.brotliDecompressSync(recipeBrotli).toString('utf8'));
const auditDec = zlib.brotliDecompressSync(auditBrotli).toString('utf8');
const idDec = zlib.brotliDecompressSync(idBrotli);
const auditRecs = auditDec.split('\n').filter(Boolean).map(l => JSON.parse(l));

const reconstructed = auditRecs.map((r, i) => {
  let payload = r.payload_json;
  const tc = recipeDec[r.action];
  if (tc && payload != null) {
    try {
      const p = JSON.parse(payload);
      if (p != null && typeof p === 'object' && !Array.isArray(p)) {
        const restored = {};
        for (const k of tc.ko) {
          if (k in tc.c) restored[k] = JSON.parse(tc.c[k]);
          else if (k in p) restored[k] = p[k];
        }
        payload = JSON.stringify(restored);
      }
    } catch {}
  }
  const idBytes = idDec.slice(i * 8, (i + 1) * 8);
  const id = idBytes.length === 8 ? 'rcpt_' + idBytes.toString('hex') : receipts[i].id;
  return { id, action: r.action, status: r.status, summary: r.summary, payload_json: payload, created_at: r.created_at };
});

const recJsonl = reconstructed.map(r => JSON.stringify(r)).join('\n') + '\n';
const recSha = crypto.createHash('sha256').update(recJsonl).digest('hex');
const lossless = recSha === corpusSha;
console.log(`\nRoundtrip: ${lossless ? '✓ BYTE-EXACT' : '✗ MISMATCH'} (sha256 ${recSha.slice(0,16)}...)`);
if (!lossless) {
  const orig = corpusBytes.toString('utf8');
  for (let i = 0; i < Math.min(orig.length, recJsonl.length); i++) {
    if (orig[i] !== recJsonl[i]) {
      console.log(`First diff at byte ${i}:`);
      console.log(`  orig: ...${orig.slice(Math.max(0, i-80), i+80)}...`);
      console.log(`  dec:  ...${recJsonl.slice(Math.max(0, i-80), i+80)}...`);
      break;
    }
  }
}

const receipt = {
  experiment: '28-strip-then-stream',
  generated_at: new Date().toISOString(),
  corpus_sha256_in: corpusSha,
  audit_brotli: auditBrotli.length,
  id_brotli: idBrotli.length,
  recipe_brotli: recipeBrotli.length,
  total: total,
  ratio: Number(ratio.toFixed(2)),
  roundtrip_lossless: lossless,
  beats_plait: ratio > 18.05,
  beats_two_stream: ratio > 17.99,
};
fs.writeFileSync(RECEIPT_FILE, JSON.stringify(receipt, null, 2));
console.log(`\nReceipt: ${RECEIPT_FILE}`);
