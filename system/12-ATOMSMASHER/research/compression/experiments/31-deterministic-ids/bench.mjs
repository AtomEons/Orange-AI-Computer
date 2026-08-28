// Experiment 31 — Deterministic ID Simulation
//
// Replace each receipt's random ID tail with sha256(seed||index)[0..8] and
// measure compression. This SIMULATES what would happen if uniqueRuntimeId in
// the canonical organism produced deterministic IDs instead of random UUIDs.
//
// Output: the regeneration ceiling for byte-exact lossless compression when
// IDs are regenerable from the seed.

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
console.log(`Original corpus: ${corpusBytes.length} B, sha256 ${corpusSha.slice(0,16)}...`);

// Replace each id with sha256(seed || index)[0..16 hex chars]
const SEED = 'orange5-receipt-stream-v1';
function detId(seed, index) {
  return 'rcpt_' + crypto.createHash('sha256').update(seed + '||' + index).digest('hex').slice(0, 16);
}

const detReceipts = receipts.map((r, i) => ({ ...r, id: detId(SEED, i) }));
const detJsonl = detReceipts.map(r => JSON.stringify(r)).join('\n') + '\n';
const detBytes = Buffer.from(detJsonl, 'utf8');
const detSha = crypto.createHash('sha256').update(detBytes).digest('hex');
console.log(`Det-ID corpus:   ${detBytes.length} B, sha256 ${detSha.slice(0,16)}...`);

// (The det-ID corpus is the SIMULATED "what the corpus would have looked like
// if uniqueRuntimeId had been deterministic.")

function brotli11(b) {
  return zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } });
}

// ── Method A: Raw det-ID corpus brotli ──────────────────────────────────────
const detRawBrotli = brotli11(detBytes);
const detRawRatio = detBytes.length / detRawBrotli.length;
console.log(`\nDet-ID corpus raw brotli q11: ${detRawBrotli.length} B = ${detRawRatio.toFixed(2)}x`);

// ── Method B: Det-ID corpus, two-stream ─────────────────────────────────────
const detIds = detReceipts.map(r => Buffer.from(r.id.slice(5), 'hex'));
const detIdStream = Buffer.concat(detIds);
const detNoIds = detReceipts.map(r => ({ ...r, id: '' }));
const detNoIdsJsonl = detNoIds.map(r => JSON.stringify(r)).join('\n') + '\n';
const detNoIdsBytes = Buffer.from(detNoIdsJsonl, 'utf8');
const detNoIdsBrotli = brotli11(detNoIdsBytes);
const detIdBrotli = brotli11(detIdStream);
console.log(`\nDet-ID two-stream:`);
console.log(`  audit (no IDs) brotli: ${detNoIdsBrotli.length} B`);
console.log(`  ID stream brotli:      ${detIdBrotli.length} B (raw ${detIdStream.length})`);
console.log(`  combined:              ${detNoIdsBrotli.length + detIdBrotli.length} B = ${(detBytes.length / (detNoIdsBrotli.length + detIdBrotli.length)).toFixed(2)}x`);

// ── Method C: Det-ID — IDs replaced with seed + recipe ─────────────────────
// On encode: store ONLY (seed, N). On decode: regenerate all IDs as
// sha256(seed || i) for i in 0..N-1. ID stream cost = ~32 bytes (seed + count).
//
// This is the REAL regeneration ceiling: IDs are completely free.

// Use the SAME no-IDs audit content
const seedRecipe = Buffer.from(JSON.stringify({ seed: SEED, n: detReceipts.length }), 'utf8');
const seedRecipeBrotli = brotli11(seedRecipe);
const regenTotal = detNoIdsBrotli.length + seedRecipeBrotli.length;
console.log(`\nDet-ID regeneration mode (seed recipe only):`);
console.log(`  audit (no IDs) brotli: ${detNoIdsBrotli.length} B`);
console.log(`  seed recipe brotli:    ${seedRecipeBrotli.length} B (raw ${seedRecipe.length})`);
console.log(`  combined:              ${regenTotal} B`);
console.log(`  ratio vs det-corpus:   ${(detBytes.length / regenTotal).toFixed(2)}x`);
console.log(`  ratio vs orig-corpus:  ${(corpusBytes.length / regenTotal).toFixed(2)}x`);

// ── Method D: Strip constants + det-ID + regen ─────────────────────────────
// Apply Exp 23 v3 constant-stripping to the det-ID corpus, then brotli
const perAction = new Map();
for (const r of detReceipts) {
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

const detStripped = detReceipts.map(r => {
  if (r.payload_json == null) return { ...r, id: '' };
  const tc = truConstants.get(r.action);
  if (!tc) return { ...r, id: '' };
  try {
    const p = JSON.parse(r.payload_json);
    if (p == null || typeof p !== 'object' || Array.isArray(p)) return { ...r, id: '' };
    const stripped = {};
    for (const [k, v] of Object.entries(p)) if (!tc.consts.has(k)) stripped[k] = v;
    return { ...r, id: '', payload_json: JSON.stringify(stripped) };
  } catch { return { ...r, id: '' }; }
});
const detStrippedJsonl = detStripped.map(r => JSON.stringify(r)).join('\n') + '\n';
const detStrippedBrotli = brotli11(Buffer.from(detStrippedJsonl, 'utf8'));
const recipe = {};
for (const [action, info] of truConstants) {
  recipe[action] = { ko: info.keyOrder, c: Object.fromEntries(info.consts) };
}
const recipeBrotli = brotli11(Buffer.from(JSON.stringify(recipe), 'utf8'));
const stripRegenTotal = detStrippedBrotli.length + recipeBrotli.length + seedRecipeBrotli.length;
console.log(`\nDet-ID + strip-constants + regen mode:`);
console.log(`  stripped audit brotli: ${detStrippedBrotli.length} B`);
console.log(`  constants recipe:      ${recipeBrotli.length} B`);
console.log(`  seed recipe:           ${seedRecipeBrotli.length} B`);
console.log(`  combined:              ${stripRegenTotal} B`);
console.log(`  ratio vs det-corpus:   ${(detBytes.length / stripRegenTotal).toFixed(2)}x`);
console.log(`  ratio vs orig-corpus:  ${(corpusBytes.length / stripRegenTotal).toFixed(2)}x`);

// ── Lossless roundtrip for det-ID regen mode ────────────────────────────────
// Decode: brotli decompress, parse JSONL, regenerate IDs from seed
const auditDec = zlib.brotliDecompressSync(detNoIdsBrotli).toString('utf8');
const auditRecs = auditDec.split('\n').filter(Boolean).map(l => JSON.parse(l));
const seedDec = JSON.parse(zlib.brotliDecompressSync(seedRecipeBrotli).toString('utf8'));
const reconstructed = auditRecs.map((r, i) => ({ ...r, id: detId(seedDec.seed, i) }));
const recJsonl = reconstructed.map(r => JSON.stringify(r)).join('\n') + '\n';
const recSha = crypto.createHash('sha256').update(recJsonl).digest('hex');
const lossless = recSha === detSha; // matches det-corpus, not original
console.log(`\nDet-ID regen roundtrip: ${lossless ? '✓ BYTE-EXACT to det-corpus' : '✗ MISMATCH'} (sha256 ${recSha.slice(0,16)}...)`);

// ── Summary ────────────────────────────────────────────────────────────────
console.log(`\n=== SUMMARY (regeneration ceiling) ===`);
console.log(`Original corpus baseline:                     ${corpusBytes.length} B`);
console.log(`Original corpus best lossless (Exp 21):       115,396 B = 17.99x`);
console.log(``);
console.log(`Det-ID corpus baseline (would be the corpus): ${detBytes.length} B`);
console.log(`Det-ID raw brotli:                            ${detRawBrotli.length} B = ${detRawRatio.toFixed(2)}x`);
console.log(`Det-ID two-stream:                            ${detNoIdsBrotli.length + detIdBrotli.length} B = ${(detBytes.length / (detNoIdsBrotli.length + detIdBrotli.length)).toFixed(2)}x`);
console.log(`Det-ID regen mode (seed + audit):             ${regenTotal} B = ${(detBytes.length / regenTotal).toFixed(2)}x vs det / ${(corpusBytes.length / regenTotal).toFixed(2)}x vs orig`);
console.log(`Det-ID + constants strip + regen:             ${stripRegenTotal} B = ${(detBytes.length / stripRegenTotal).toFixed(2)}x vs det / ${(corpusBytes.length / stripRegenTotal).toFixed(2)}x vs orig`);

const receipt = {
  experiment: '31-deterministic-ids',
  generated_at: new Date().toISOString(),
  corpus_sha256_in: corpusSha,
  det_corpus_sha256: detSha,
  seed: SEED,
  det_corpus_bytes: detBytes.length,
  measurements: {
    det_raw_brotli_size: detRawBrotli.length,
    det_raw_ratio: Number(detRawRatio.toFixed(2)),
    det_two_stream_size: detNoIdsBrotli.length + detIdBrotli.length,
    det_two_stream_ratio: Number((detBytes.length / (detNoIdsBrotli.length + detIdBrotli.length)).toFixed(2)),
    det_regen_size: regenTotal,
    det_regen_ratio_vs_det: Number((detBytes.length / regenTotal).toFixed(2)),
    det_regen_ratio_vs_orig: Number((corpusBytes.length / regenTotal).toFixed(2)),
    det_strip_regen_size: stripRegenTotal,
    det_strip_regen_ratio_vs_det: Number((detBytes.length / stripRegenTotal).toFixed(2)),
    det_strip_regen_ratio_vs_orig: Number((corpusBytes.length / stripRegenTotal).toFixed(2)),
  },
  roundtrip_lossless_to_det_corpus: lossless,
  notes: 'Simulates uniqueRuntimeId modification by replacing random UUIDs with sha256(seed||index). The det-ID corpus is what the canonical corpus WOULD have been if uniqueRuntimeId had been deterministic. Compressing the det-corpus measures the regeneration ceiling. The "ratio vs orig" comparison shows what the headline number would be if we measured against the ORIGINAL corpus length (this is informational, since the det-corpus would simply have replaced the original).',
};
fs.writeFileSync(RECEIPT_FILE, JSON.stringify(receipt, null, 2));
console.log(`\nReceipt: ${RECEIPT_FILE}`);
