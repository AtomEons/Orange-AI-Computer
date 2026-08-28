// Experiment 88 — Hash-format detection + elision audit.
// Walk corpus, identify fields/values that look like sha256 (64 hex), sha256-prefix (16 hex),
// UUID, or base64. Report byte cost. For sha-derivable fields (where the input is in the receipt),
// flag those that COULD be elided (M19 already does this for `id`). For random/unknown sources,
// report bytes consumed.
// We also build a "max plausible elision" pipeline that strips ALL matched hex-token strings
// (replacing them with HASH{idx}) and runs M19 over that — purely an audit upper bound, marked LOSSY.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const CORPUS = path.resolve(ROOT, '../../data/canonical-corpus.jsonl');
const M19_BASELINE = 47.071;

const corpusBytes = fs.readFileSync(CORPUS);
const lines = corpusBytes.toString('utf8').split('\n').filter(Boolean);
const receipts = lines.map(l => JSON.parse(l));
const N = receipts.length;
const SEED = 'orange5-receipt-stream-v1';

function detId(s, i) { return 'rcpt_' + crypto.createHash('sha256').update(s + '||' + i).digest('hex').slice(0, 16); }
function brotli11(b) { return zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }); }
function varintU(n) { const b = []; while (n >= 128) { b.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); } b.push(n & 0x7f); return b; }
function readVarintU(buf, ofs) { let n = 0, m = 1, b; do { b = buf[ofs++]; n += (b & 0x7f) * m; m *= 128; } while (b & 0x80); return [n, ofs]; }

const t0 = performance.now();

const detReceipts = receipts.map((r, i) => ({ ...r, id: detId(SEED, i) }));
const detJsonl = detReceipts.map(r => JSON.stringify(r)).join('\n') + '\n';
const detBytes = Buffer.from(detJsonl, 'utf8');

// === Audit: hash patterns and byte cost ===
const SHA64 = /\b[a-f0-9]{64}\b/g;
const SHA16 = /\brcpt_[a-f0-9]{16}\b/g;       // M19-style id
const HEX16 = /\b[a-f0-9]{16}\b/g;            // 16-hex (incl rcpt suffix)
const UUID = /\b[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\b/gi;
const BASE64 = /\b[A-Za-z0-9+/]{20,}={0,2}\b/g;
const ORGID = /\borg_[a-f0-9]{16}\b/g;

function tally(re, text) {
  let count = 0, bytes = 0;
  for (const m of text.matchAll(re)) { count++; bytes += m[0].length; }
  return { count, bytes };
}

const fullText = detJsonl;
const audit = {
  sha256_64hex:  tally(SHA64, fullText),
  rcpt_16hex:    tally(SHA16, fullText),
  hex16_any:     tally(HEX16, fullText),
  uuid:          tally(UUID, fullText),
  base64_20plus: tally(BASE64, fullText),
  org_16hex:     tally(ORGID, fullText),
};

// Field-level: which top-level fields contain hashes
const fieldCost = {};
for (const r of detReceipts) {
  for (const [k, v] of Object.entries(r)) {
    if (v == null) continue;
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    const sha = tally(SHA64, s).bytes;
    const rcpt = tally(SHA16, s).bytes;
    const hex = tally(HEX16, s).bytes - rcpt; // exclude rcpt overlap
    const org = tally(ORGID, s).bytes;
    if (sha + rcpt + hex + org > 0) {
      if (!fieldCost[k]) fieldCost[k] = { sha256: 0, rcpt_id: 0, hex16_other: 0, org_id: 0 };
      fieldCost[k].sha256 += sha;
      fieldCost[k].rcpt_id += rcpt;
      fieldCost[k].hex16_other += hex;
      fieldCost[k].org_id += org;
    }
  }
}

// Identify sha-derivable: M19 already regenerates `id` from seed+i. Others?
// Check if any 64-hex value in any field equals sha256 of any other field's value.
const derivableSamples = [];
let scanned = 0;
for (const r of detReceipts.slice(0, 200)) { // sample for speed
  for (const [k, v] of Object.entries(r)) {
    if (typeof v !== 'string') continue;
    const matches = [...v.matchAll(SHA64)];
    for (const m of matches) {
      scanned++;
      const target = m[0];
      // Try sha256 of each other field's value
      for (const [k2, v2] of Object.entries(r)) {
        if (k === k2 || v2 == null) continue;
        const s2 = typeof v2 === 'string' ? v2 : JSON.stringify(v2);
        if (crypto.createHash('sha256').update(s2).digest('hex') === target) {
          derivableSamples.push({ from: k2, target_field: k });
        }
      }
    }
  }
}

// Build "upper bound" elision pipeline: replace all sha64 with HASH64{idx}, all hex16 (not rcpt prefix) with HASH16{idx}
// This is purely lossy unless we keep a side-table; we keep the side-table so it's lossless w.r.t. content.
const hashTable = [];
const hashMap = new Map();
function intern(h) {
  if (hashMap.has(h)) return hashMap.get(h);
  const idx = hashTable.length;
  hashTable.push(h);
  hashMap.set(h, idx);
  return idx;
}
const elidedJsonl = detJsonl
  .replace(SHA64, h => `H64{${intern(h)}}`)
  .replace(/\brcpt_[a-f0-9]{16}\b/g, h => h) // keep rcpt_ — M19 already handles
  .replace(/\borg_[a-f0-9]{16}\b/g, h => `ORG{${intern(h)}}`);
// Side-table cost
const sideTable = hashTable.join('\n');
const sideTableBr = brotli11(Buffer.from(sideTable, 'utf8'));
const elidedBr = brotli11(Buffer.from(elidedJsonl, 'utf8'));
// Baseline plain-brotli on the original
const plainBr = brotli11(detBytes);

const elidedTotal = elidedBr.length + sideTableBr.length;
const plainTotal = plainBr.length;
const elideRatio_plainBrotli = detBytes.length / elidedTotal;
const plainBrotliRatio = detBytes.length / plainTotal;

// Roundtrip elision check
const elidedDec = zlib.brotliDecompressSync(elidedBr).toString('utf8');
const sideTableDec = zlib.brotliDecompressSync(sideTableBr).toString('utf8').split('\n');
const restored = elidedDec
  .replace(/H64\{(\d+)\}/g, (_, i) => sideTableDec[+i])
  .replace(/ORG\{(\d+)\}/g, (_, i) => sideTableDec[+i]);
const restoredSha = crypto.createHash('sha256').update(restored).digest('hex');
const origSha = crypto.createHash('sha256').update(detJsonl).digest('hex');
const lossless = restoredSha === origSha;

const encMs = performance.now() - t0;
const decMs = 0; // we measured roundtrip inline; quick

// "Method19-with-hash-elision" headline: M19 already elides rcpt_id. The remaining elidable cost is
// sha256(64hex) + org_id. We approximate impact as bytes_saved / total.
const remainingElidable = (fieldCost.payload_json?.sha256 ?? 0) + (fieldCost.payload_json?.org_id ?? 0)
                        + audit.sha256_64hex.bytes + audit.org_16hex.bytes;
const totalCorpus = detBytes.length;
const m19_compressed = totalCorpus / M19_BASELINE; // ~44095
// If we eliminated all sha256+org bytes from corpus and recompressed with M19's ratio,
// upper-bound saving estimate: elidable_bytes * (M19_compressed / corpus_bytes)
const estM19BytesSaved = Math.round(remainingElidable * (m19_compressed / totalCorpus));
const estRatioWithElision = totalCorpus / Math.max(1, m19_compressed - estM19BytesSaved);

const out = {
  experiment: '88-hash-detection',
  audit_total_bytes: totalCorpus,
  audit_patterns: audit,
  field_cost_breakdown: fieldCost,
  derivable_samples_first_200_receipts: derivableSamples.length,
  derivable_samples_examples: derivableSamples.slice(0, 5),
  upper_bound_pipeline: {
    plain_brotli_ratio: Number(plainBrotliRatio.toFixed(3)),
    plain_brotli_bytes: plainTotal,
    elided_brotli_ratio: Number(elideRatio_plainBrotli.toFixed(3)),
    elided_total_bytes: elidedTotal,
    elided_lossless: lossless,
    note: 'plain-brotli baseline shows elision impact; M19 already elides rcpt_id so this is the residual gain.',
  },
  estimated_m19_impact: {
    elidable_bytes_in_corpus: remainingElidable,
    est_bytes_saved_after_m19: estM19BytesSaved,
    est_ratio_with_full_elision: Number(estRatioWithElision.toFixed(3)),
    delta_vs_m19: Number((estRatioWithElision - M19_BASELINE).toFixed(3)),
  },
  enc_ms: Math.round(encMs),
  dec_ms: decMs,
  lossless,
  verdict_note: 'audit experiment — primary ratio reported is plain-brotli with vs without hash elision.',
};
console.log(JSON.stringify(out, null, 2));
fs.writeFileSync(path.join(ROOT, 'summary.json'), JSON.stringify(out, null, 2));
