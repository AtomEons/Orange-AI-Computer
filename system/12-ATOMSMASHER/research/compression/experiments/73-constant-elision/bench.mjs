// Experiment 73 — Frequency-rank constant field elision.
//
// HYPOTHESIS: Strip fields that are constant across the entire corpus,
// store one copy in a header, brotli the stripped lines.
//
// PROBE FINDINGS on canonical-corpus.jsonl (6,224 receipts):
//   - Top-level fields: NONE are 100% constant.
//     status is 6223 "ok" + 1 "error" (99.984%, not strictly constant).
//     id, action, summary, payload_json, created_at all vary.
//   - Payload-json fields: NONE are present in every receipt with a constant value.
//     Payloads are action-keyed, so no global payload constant exists.
//
// So per the strict hypothesis there is nothing to strip.
// We run TWO passes:
//   (A) STRICT — strip only 100%-constant fields → strips 0 → equals raw-brotli.
//   (B) EXTENDED — strip status from all rows AND emit a tiny exception list
//       (row indices + values for the few non-"ok" rows).
//       Lossless via exception reinsert with original key order.
//
// Key-order preservation: original order is
//   id, action, status, summary, payload_json, created_at
// We always reinsert by manual string concatenation in that order.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const CORPUS = path.resolve(ROOT, '../../data/canonical-corpus.jsonl');

const corpusBytes = fs.readFileSync(CORPUS);
const corpusSha = crypto.createHash('sha256').update(corpusBytes).digest('hex');
const RAW = corpusBytes.length;
console.log(`Loaded ${RAW} bytes, sha ${corpusSha.slice(0, 16)}…`);

const lines = corpusBytes.toString('utf8').split('\n');
// canonical-corpus.jsonl ends with newline — last element of split is ''.
const trailingEmpty = lines[lines.length - 1] === '';
if (trailingEmpty) lines.pop();
const N = lines.length;
console.log(`Receipts: ${N}, trailing newline: ${trailingEmpty}`);

// ---------------- Pass A: strict constant elision (baseline-equivalent) ----------------
// Probe shows zero strict constants. We still execute the pass to keep the bench honest.
function passStrict() {
  // No fields stripped, so the stripped corpus IS the raw corpus.
  const joined = lines.join('\n') + (trailingEmpty ? '\n' : '');
  const t0 = performance.now();
  const compressed = zlib.brotliCompressSync(Buffer.from(joined, 'utf8'), {
    params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 },
  });
  const encMs = performance.now() - t0;

  const t1 = performance.now();
  const decompressed = zlib.brotliDecompressSync(compressed);
  const decMs = performance.now() - t1;

  const sha = crypto.createHash('sha256').update(decompressed).digest('hex');
  return {
    name: 'strict (raw-jsonl brotli baseline)',
    compressedTotal: compressed.length,
    ratio: RAW / compressed.length,
    encMs, decMs,
    lossless: sha === corpusSha,
  };
}

// ---------------- Pass B: extended near-constant elision ----------------
// Strip "status" from every line, capture exceptions {rowIndex, value}.
// Stripped line format: rebuild as
//   {"id":"…","action":"…","summary":"…","payload_json":"…","created_at":"…"}
// preserving original order minus "status".
//
// Header layout (uncompressed varint-tagged stream, then brotli'd):
//   header = {
//     "majority": "ok",
//     "exceptions": [[rowIdx, value], ...],
//     "trailing_newline": true|false,
//     "n": N
//   }
// We store header as JSON, brotli it.
// Total compressed = brotli(stripped_jsonl) + brotli(header) + 4-byte length prefix for split.

function buildStripped() {
  // Parse each line and rebuild without "status", capturing exceptions.
  const stripped = new Array(N);
  const exceptions = []; // [idx, value]
  const MAJORITY = 'ok';
  for (let i = 0; i < N; i++) {
    const r = JSON.parse(lines[i]);
    if (r.status !== MAJORITY) {
      exceptions.push([i, r.status]);
    }
    // Manually concat in order: id, action, [status omitted], summary, payload_json, created_at.
    // We use JSON.stringify on each value so we preserve exact escape semantics.
    const sId = JSON.stringify(r.id);
    const sAction = JSON.stringify(r.action);
    const sSummary = JSON.stringify(r.summary);
    const sPayload = JSON.stringify(r.payload_json);
    const sCreated = JSON.stringify(r.created_at);
    stripped[i] =
      '{"id":' + sId +
      ',"action":' + sAction +
      ',"summary":' + sSummary +
      ',"payload_json":' + sPayload +
      ',"created_at":' + sCreated + '}';
  }
  return { stripped, exceptions, majority: MAJORITY };
}

function reconstruct(stripped, exceptions, majority, trailingNewline) {
  // Build a Set of exception row indices for fast lookup.
  const exMap = new Map();
  for (const [i, v] of exceptions) exMap.set(i, v);
  const out = new Array(stripped.length);
  for (let i = 0; i < stripped.length; i++) {
    const sLine = stripped[i];
    // sLine starts with `{"id":...,"action":"<action>",` and we need to insert
    // `,"status":"<value>"` immediately after the action field.
    // The first two fields are id and action. We find the position right
    // after the action value (i.e. right before `,"summary"`).
    // Safer: just splice by string search on `,"summary":`.
    const splitAt = sLine.indexOf(',"summary":');
    if (splitAt < 0) throw new Error(`reconstruct: missing summary marker at row ${i}`);
    const statusVal = exMap.has(i) ? exMap.get(i) : majority;
    const inserted =
      sLine.slice(0, splitAt) +
      ',"status":' + JSON.stringify(statusVal) +
      sLine.slice(splitAt);
    out[i] = inserted;
  }
  return out.join('\n') + (trailingNewline ? '\n' : '');
}

function passExtended() {
  const t0 = performance.now();
  const { stripped, exceptions, majority } = buildStripped();
  const strippedJsonl = stripped.join('\n') + (trailingEmpty ? '\n' : '');
  const headerObj = {
    majority,
    exceptions,
    trailing_newline: trailingEmpty,
    n: N,
    schema_version: 1,
  };
  const headerJson = JSON.stringify(headerObj);

  const brotliOpts = { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } };
  const cBody = zlib.brotliCompressSync(Buffer.from(strippedJsonl, 'utf8'), brotliOpts);
  const cHeader = zlib.brotliCompressSync(Buffer.from(headerJson, 'utf8'), brotliOpts);

  // Pack: [4-byte BE header length][cHeader][cBody]
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(cHeader.length, 0);
  const blob = Buffer.concat([lenBuf, cHeader, cBody]);
  const encMs = performance.now() - t0;

  // Decode
  const t1 = performance.now();
  const hLen = blob.readUInt32BE(0);
  const hSlice = blob.slice(4, 4 + hLen);
  const bSlice = blob.slice(4 + hLen);
  const headerDecoded = JSON.parse(zlib.brotliDecompressSync(hSlice).toString('utf8'));
  const bodyDecoded = zlib.brotliDecompressSync(bSlice).toString('utf8');

  // Split body back into lines
  const bodyHadTrailing = bodyDecoded.endsWith('\n');
  const bodyLines = bodyDecoded.split('\n');
  if (bodyHadTrailing && bodyLines[bodyLines.length - 1] === '') bodyLines.pop();
  if (bodyLines.length !== headerDecoded.n) {
    throw new Error(`row count mismatch: body ${bodyLines.length} vs header ${headerDecoded.n}`);
  }
  const reconstructed = reconstruct(
    bodyLines,
    headerDecoded.exceptions,
    headerDecoded.majority,
    headerDecoded.trailing_newline,
  );
  const decMs = performance.now() - t1;

  const reSha = crypto.createHash('sha256').update(Buffer.from(reconstructed, 'utf8')).digest('hex');
  return {
    name: 'extended (strip status; 1-exception list)',
    compressedTotal: blob.length,
    ratio: RAW / blob.length,
    encMs, decMs,
    lossless: reSha === corpusSha,
    cHeader: cHeader.length,
    cBody: cBody.length,
    exceptions: exceptions.length,
    headerJsonLen: headerJson.length,
  };
}

// Run both passes
const A = passStrict();
const B = passExtended();

console.log('\n--- Pass A: strict (no stripping = raw-brotli baseline) ---');
console.log(`  compressed: ${A.compressedTotal} B`);
console.log(`  ratio:      ${A.ratio.toFixed(4)}x`);
console.log(`  enc/dec ms: ${A.encMs.toFixed(1)} / ${A.decMs.toFixed(1)}`);
console.log(`  lossless:   ${A.lossless}`);

console.log('\n--- Pass B: extended (strip status field; encode 1 exception) ---');
console.log(`  exceptions: ${B.exceptions} rows`);
console.log(`  cHeader:    ${B.cHeader} B (raw header JSON ${B.headerJsonLen} B)`);
console.log(`  cBody:      ${B.cBody} B`);
console.log(`  total:      ${B.compressedTotal} B`);
console.log(`  ratio:      ${B.ratio.toFixed(4)}x`);
console.log(`  enc/dec ms: ${B.encMs.toFixed(1)} / ${B.decMs.toFixed(1)}`);
console.log(`  lossless:   ${B.lossless}`);

const delta = B.compressedTotal - A.compressedTotal;
const deltaPct = (delta / A.compressedTotal * 100).toFixed(2);
console.log(`\n--- Delta B vs A ---`);
console.log(`  Δbytes: ${delta} (${deltaPct}%)`);
console.log(`  ratio Δ: ${(B.ratio - A.ratio).toFixed(4)}x`);

// Write summary.json — primary deliverable uses Pass B (the actual elision experiment).
const M19 = 47.07;
const summary = {
  experiment: '73-constant-elision',
  ratio: B.ratio,
  encode_ms: B.encMs,
  decode_ms: B.decMs,
  lossless: B.lossless,
  notes:
    `Probe found 0 strictly-constant top-level fields and 0 strictly-constant payload fields ` +
    `(status was 6223 "ok" + 1 "error", not strictly constant). ` +
    `Pass A (strict, strip nothing) = raw-jsonl-brotli baseline: ${A.ratio.toFixed(4)}x. ` +
    `Pass B (extended near-constant: strip status, encode 1-row exception list): ${B.ratio.toFixed(4)}x. ` +
    `Delta vs raw-brotli: ${(B.ratio - A.ratio).toFixed(4)}x (${deltaPct}% size change). ` +
    `Baseline Method 19: ${M19}x — extended pass is ${(B.ratio - M19).toFixed(2)}x ${B.ratio > M19 ? 'better' : 'worse'}. ` +
    `Exceptions: ${B.exceptions}. Header compressed: ${B.cHeader} B. ` +
    `Lossless verified via sha256(reinsert-in-original-key-order).`,
  detail: {
    pass_a_strict: {
      stripped: 0,
      compressed_total: A.compressedTotal,
      ratio: A.ratio,
      encode_ms: A.encMs,
      decode_ms: A.decMs,
      lossless: A.lossless,
    },
    pass_b_extended: {
      stripped: ['status'],
      exceptions: B.exceptions,
      header_compressed: B.cHeader,
      body_compressed: B.cBody,
      compressed_total: B.compressedTotal,
      ratio: B.ratio,
      encode_ms: B.encMs,
      decode_ms: B.decMs,
      lossless: B.lossless,
    },
    raw_brotli_baseline_ratio: A.ratio,
    method_19_baseline_ratio: M19,
    delta_vs_raw_brotli_bytes: delta,
    delta_vs_raw_brotli_pct: parseFloat(deltaPct),
    corpus_sha256: corpusSha,
    receipts: N,
    raw_bytes: RAW,
  },
};

fs.writeFileSync(path.join(ROOT, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(`\nWrote summary.json`);
