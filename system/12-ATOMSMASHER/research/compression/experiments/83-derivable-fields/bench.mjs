// Experiment 83 — Derivable-field static analysis + strip + brotli + regen + sha256 verify.
// Principle: M19's "regenerate from seed" generalized. Walk corpus, find fields that are
// constants per action class OR deterministic functions of other fields in same receipt.
// Strip them, brotli q11 the residual, regenerate at decode, verify byte-exact.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const CORPUS = path.resolve(ROOT, '../../data/canonical-corpus.jsonl');

const corpusBytes = fs.readFileSync(CORPUS);
const lines = corpusBytes.toString('utf8').split('\n').filter(Boolean);
const receipts = lines.map(l => JSON.parse(l));
const N = receipts.length;
const rawTotal = corpusBytes.length;

function brotli11(b) { return zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }); }
function sha256(b) { return crypto.createHash('sha256').update(b).digest('hex'); }

// === STATIC ANALYSIS PHASE ===
// Per-action: which top-level fields are constants?
const t0 = performance.now();
const byAction = new Map();
for (const r of receipts) {
  if (!byAction.has(r.action)) byAction.set(r.action, []);
  byAction.get(r.action).push(r);
}

// Find: for each (action, field), the distinct value count.
// If count==1 -> constant for that action class -> can be regenerated from action.
const FIELDS = ['status']; // top-level candidate fields known to often be constant
const constantPerAction = {}; // action -> {field -> constantValue}
for (const [action, rs] of byAction) {
  constantPerAction[action] = {};
  for (const f of FIELDS) {
    const vals = new Set();
    for (const r of rs) vals.add(r[f]);
    if (vals.size === 1) {
      constantPerAction[action][f] = [...vals][0];
    }
  }
}

// Count how many action classes have status as constant
const constStatusActions = Object.entries(constantPerAction).filter(([a, c]) => 'status' in c).length;

// === STRIP + BROTLI PHASE ===
// Build stripped corpus: remove status when it's constant for its action class.
// Also keep an action -> status constant dictionary to ship alongside.
const dict = {};
for (const [a, c] of Object.entries(constantPerAction)) {
  if ('status' in c) dict[a] = c.status;
}

// Build the stripped receipts (keep all fields except status when in dict).
const stripped = receipts.map(r => {
  if (r.action in dict) {
    const { status, ...rest } = r;
    return rest;
  }
  return r;
});
const strippedJsonl = stripped.map(o => JSON.stringify(o)).join('\n') + '\n';
const strippedBytes = Buffer.from(strippedJsonl, 'utf8');

// Encode: dict size + dict json + brotli(stripped)
const dictJson = JSON.stringify(dict);
const dictBytes = Buffer.from(dictJson, 'utf8');
const compResidual = brotli11(strippedBytes);

// Wire format: [varint dictLen][dictBytes][brotli payload]
const dictLen = Buffer.byteLength(dictJson);
const lenBuf = Buffer.alloc(4);
lenBuf.writeUInt32LE(dictLen, 0);
const wire = Buffer.concat([lenBuf, dictBytes, compResidual]);
const encode_ms = performance.now() - t0;

// === DECODE + VERIFY ===
const d0 = performance.now();
const dLen = wire.readUInt32LE(0);
const dStr = wire.slice(4, 4 + dLen).toString('utf8');
const dict2 = JSON.parse(dStr);
const decResid = zlib.brotliDecompressSync(wire.slice(4 + dLen));
const decReceipts = decResid.toString('utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
// Regenerate
const regen = decReceipts.map(r => {
  if (r.action in dict2 && !('status' in r)) {
    return { ...r, status: dict2[r.action] };
  }
  return r;
});
// Restore original field order? The originals had: id, action, status, summary, payload_json, created_at.
// We need byte-exact roundtrip. Reconstruct with same key order.
const ORDER = ['id', 'action', 'status', 'summary', 'payload_json', 'created_at'];
const recon = regen.map(r => {
  const o = {};
  for (const k of ORDER) if (k in r) o[k] = r[k];
  for (const k of Object.keys(r)) if (!(k in o)) o[k] = r[k];
  return o;
});
const reconJsonl = recon.map(o => JSON.stringify(o)).join('\n') + '\n';
const reconBytes = Buffer.from(reconJsonl, 'utf8');
const decode_ms = performance.now() - d0;

const origSha = sha256(corpusBytes);
const reconSha = sha256(reconBytes);
const lossless = origSha === reconSha;

const ratio = rawTotal / wire.length;

const summary = {
  experiment: '83-derivable-fields',
  ratio: Number(ratio.toFixed(3)),
  encode_ms: Number(encode_ms.toFixed(1)),
  decode_ms: Number(decode_ms.toFixed(1)),
  lossless,
  notes: `Found ${constStatusActions} action classes with constant status field. Dict bytes=${dictLen}. Stripped status from ${stripped.filter(r => !('status' in r)).length}/${N} receipts. Wire bytes=${wire.length}. Original sha256=${origSha.slice(0,16)} recon sha256=${reconSha.slice(0,16)}.`,
  baseline_m19_ratio: 47.071,
  vs_m19_delta: Number((ratio - 47.071).toFixed(3)),
  raw_bytes: rawTotal,
  wire_bytes: wire.length,
};
fs.writeFileSync(path.join(ROOT, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
