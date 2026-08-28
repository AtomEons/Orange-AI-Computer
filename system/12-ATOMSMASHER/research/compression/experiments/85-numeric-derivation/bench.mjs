// Experiment 85 — Numeric-derivation regeneration.
// Hypothesis: numeric fields like payload.ratio = round(raw_bytes/compressed_bytes * 100)/100
// are deterministic functions of other numeric fields in the same receipt.
// We verify a candidate formula across the whole corpus; if it holds, strip the derived
// field; regenerate at decode; sha256 verify the WHOLE corpus.

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

const t0 = performance.now();

// Banker's rounding to 2dp — observed in M19 baseline as the operative formula
function bankerRound2(x) {
  const v = x * 100;
  const f = Math.floor(v);
  const fr = v - f;
  if (Math.abs(fr - 0.5) < 1e-9) {
    return (f + (f % 2)) / 100;
  }
  return Math.round(v) / 100;
}

// === FORMULA VERIFICATION PHASE ===
// For mesh.compress: payload.ratio === round(raw_bytes / compressed_bytes, 2)?
// For air.compress: payload.ratio === round(seed_bytes / compressed_bytes, 2)? – this one
//   we don't strip because we don't know seed bytes directly without testing.
// We START SAFE: only strip ratio when the formula is verified for every receipt in the class.

const candidates = [
  { action: 'mesh.compress', field: 'ratio', formula: (p) => bankerRound2(p.raw_bytes / p.compressed_bytes) },
];

// Verify each candidate
const verified = [];
for (const c of candidates) {
  let allMatch = true;
  let count = 0;
  let mismatches = 0;
  for (const r of receipts) {
    if (r.action !== c.action) continue;
    count++;
    let p;
    try { p = JSON.parse(r.payload_json); } catch { allMatch = false; break; }
    if (!(c.field in p)) continue;
    // To preserve byte-exactness we need round() AND the textual encoding to match.
    // JSON.stringify(1.98) === "1.98"; JSON.stringify(2.0) === "2"; tricky.
    // Verify by re-encoding into JSON and comparing string equivalence.
    const derived = c.formula(p);
    const want = p[c.field];
    if (derived !== want) { mismatches++; }
    if (mismatches > 0) { allMatch = false; }
  }
  verified.push({ ...c, count, allMatch, mismatches });
}

// For verified candidates, strip the field from payload_json — but also note that
// payload_json is a STRING in the receipt, so we must reformat the residual payload
// EXACTLY the way the original did (key order preserved, no extra spaces).
// To guarantee byte-exact roundtrip, we precompute the suffix layout and store a
// flag indicating "strip ratio key".
// Simplest robust approach: for each mesh.compress receipt where formula holds and the
// payload_json matches a canonical "{raw_bytes:X,compressed_bytes:Y,ratio:Z}" form,
// replace payload_json with the no-ratio version. We can then derive the rest.

function tryStripMeshPayload(payloadStr) {
  // Original layout: {"raw_bytes":<int>,"compressed_bytes":<int>,"ratio":<num>}
  const m = payloadStr.match(/^\{"raw_bytes":(\d+),"compressed_bytes":(\d+),"ratio":([0-9.]+)\}$/);
  if (!m) return null;
  const raw = Number(m[1]);
  const comp = Number(m[2]);
  const ratio = Number(m[3]);
  const derived = bankerRound2(raw / comp);
  // Stringify both as JSON to check byte-level equivalence
  if (JSON.stringify(derived) !== JSON.stringify(ratio)) return null;
  return `{"raw_bytes":${raw},"compressed_bytes":${comp}}`;
}

let strippedCount = 0;
const stripped = receipts.map(r => {
  if (r.action === 'mesh.compress') {
    const newPayload = tryStripMeshPayload(r.payload_json);
    if (newPayload) {
      strippedCount++;
      return { ...r, payload_json: newPayload };
    }
  }
  return r;
});
const strippedJsonl = stripped.map(o => JSON.stringify(o)).join('\n') + '\n';
const strippedBytes = Buffer.from(strippedJsonl, 'utf8');

// We don't need a dict — the decoder regenerates `ratio` for any payload_json that
// matches the 2-key form. Just store a magic flag (0 = with-ratio, 1 = stripped).
const flag = Buffer.from([1]);
const compResid = brotli11(strippedBytes);
const wire = Buffer.concat([flag, compResid]);
const encode_ms = performance.now() - t0;

// === DECODE ===
const d0 = performance.now();
const f = wire[0];
const decResid = zlib.brotliDecompressSync(wire.slice(1));
const decReceipts = decResid.toString('utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const ORDER = ['id', 'action', 'status', 'summary', 'payload_json', 'created_at'];
const recon = decReceipts.map(r => {
  if (f === 1 && r.action === 'mesh.compress') {
    const m = r.payload_json.match(/^\{"raw_bytes":(\d+),"compressed_bytes":(\d+)\}$/);
    if (m) {
      const raw = Number(m[1]);
      const comp = Number(m[2]);
      const ratio = bankerRound2(raw / comp);
      r = { ...r, payload_json: `{"raw_bytes":${raw},"compressed_bytes":${comp},"ratio":${JSON.stringify(ratio)}}` };
    }
  }
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
  experiment: '85-numeric-derivation',
  ratio: Number(ratio.toFixed(3)),
  encode_ms: Number(encode_ms.toFixed(1)),
  decode_ms: Number(decode_ms.toFixed(1)),
  lossless,
  notes: `Verified formula ratio=round(raw/comp,2) across mesh.compress class (${verified[0].count} receipts, ${verified[0].mismatches} mismatches, allMatch=${verified[0].allMatch}). Stripped ratio from ${strippedCount} payloads. Wire=${wire.length}. orig sha=${origSha.slice(0,16)} recon=${reconSha.slice(0,16)}.`,
  baseline_m19_ratio: 47.071,
  vs_m19_delta: Number((ratio - 47.071).toFixed(3)),
  raw_bytes: rawTotal,
  wire_bytes: wire.length,
  formula_verified: verified[0].allMatch,
  formula_class_count: verified[0].count,
  stripped_payloads: strippedCount,
};
fs.writeFileSync(path.join(ROOT, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
