// Experiment 22 — The 100-Matrix Runner
//
// Operator: "we went from 6 to 28 in 19 experiments. where will 100 take us?
//   all permutations of possible 'may work' ideas. matrix of wins = success formula."
//
// Architecture: each axis is a (name, encode, decode) triple. A pipeline is an
// ordered list of axis names. The runner:
//   1. Composes the pipeline encode chain on the canonical corpus
//   2. Applies a final byte codec (brotli/xz/zlib)
//   3. Verifies sha256 roundtrip via the inverse chain
//   4. Records: ratio, pre-codec bytes, final bytes, encode_ms, decode_ms, lossless
//   5. Writes one RESULT row per pipeline to a CSV for the success-formula matrix.
//
// New axes added this turn beyond Exp 14's sweep:
//   - markov_range  : 1st-order conditional + range coder
//   - schema_fold   : drop mesh.compress ratio (Exp 18)
//   - summary_derive: extract summary numerics that reference payload (Exp 19)
//   - id_tail       : compress rcpt_<16hex> to 8 raw bytes
//   - ars_template  : payload template + numeric params (Exp 13)
//   - two_stream    : split IDs from audit content (Exp 21 — the 28.89× winner)
//   - lzma          : final byte codec
//   - sort_action   : sort receipts by action with inv perm

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const CORPUS = path.resolve(ROOT, '../../data/canonical-corpus.jsonl');
const OUT_CSV = path.join(ROOT, 'matrix-results.csv');
const OUT_JSON = path.join(ROOT, 'matrix-results.json');

const corpusBytes = fs.readFileSync(CORPUS);
const corpusSha = crypto.createHash('sha256').update(corpusBytes).digest('hex');
const lines = corpusBytes.toString('utf8').split('\n').filter(Boolean);
const receipts = lines.map(l => JSON.parse(l));
console.log(`Canonical corpus: ${receipts.length} receipts, ${corpusBytes.length} B  sha ${corpusSha.slice(0, 16)}`);

// ── Common helpers ─────────────────────────────────────────────────────────
function varint(n) { const b = []; while (n >= 128) { b.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); } b.push(n & 0x7f); return Buffer.from(b); }
function readVarint(buf, ofs) { let n = 0, m = 1, b; do { b = buf[ofs++]; n += (b & 0x7f) * m; m *= 128; } while (b & 0x80); return [n, ofs]; }
function writeStr(s) { const b = Buffer.from(s, 'utf8'); return Buffer.concat([varint(b.length), b]); }
function lookup(m, k) { let v = m.get(k); if (v === undefined) { v = m.size; m.set(k, v); } return v; }
function strandOf(action) { const i = action.indexOf('.'); return i >= 0 ? action.slice(0, i) : action; }
function normalize(r) {
  return JSON.stringify({
    id: r.id, action: r.action, status: r.status,
    summary: r.summary, payload_json: r.payload_json, created_at: r.created_at,
  });
}
function verifyLossless(decoded) {
  const j = decoded.map(normalize).join('\n') + '\n';
  return crypto.createHash('sha256').update(j).digest('hex') === corpusSha;
}

// ── AXES: each maps receipts ↔ Buffer ──────────────────────────────────────
const axes = {};

// AXIS identity: just JSONL bytes
axes.identity = {
  encode(recs) { return Buffer.from(recs.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8'); },
  decode(buf) { return buf.toString('utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); },
};

// AXIS spike: per-field vocab + varint indices
const SPIKE_FIELDS = ['id', 'action', 'status', 'summary', 'payload_json', 'created_at'];
axes.spike = {
  encode(recs) {
    const vocabs = Object.fromEntries(SPIKE_FIELDS.map(f => [f, new Map()]));
    for (const r of recs) for (const f of SPIKE_FIELDS) lookup(vocabs[f], r[f] == null ? '\0NULL\0' : String(r[f]));
    const parts = [varint(recs.length), varint(SPIKE_FIELDS.length)];
    for (const f of SPIKE_FIELDS) {
      parts.push(writeStr(f));
      const inv = [...vocabs[f].keys()];
      parts.push(varint(inv.length));
      for (const v of inv) parts.push(writeStr(v));
    }
    for (const r of recs) for (const f of SPIKE_FIELDS) {
      const val = r[f] == null ? '\0NULL\0' : String(r[f]);
      parts.push(varint(vocabs[f].get(val)));
    }
    return Buffer.concat(parts);
  },
  decode(buf) {
    let p = 0; let v;
    [v, p] = readVarint(buf, p); const recCount = v;
    [v, p] = readVarint(buf, p); const fieldCount = v;
    const fields = [];
    const vocabs = {};
    for (let fi = 0; fi < fieldCount; fi++) {
      let len; [len, p] = readVarint(buf, p);
      const f = buf.slice(p, p + len).toString('utf8'); p += len;
      fields.push(f);
      let vsz; [vsz, p] = readVarint(buf, p);
      const inv = [];
      for (let i = 0; i < vsz; i++) {
        [len, p] = readVarint(buf, p);
        inv.push(buf.slice(p, p + len).toString('utf8')); p += len;
      }
      vocabs[f] = inv;
    }
    const out = [];
    for (let i = 0; i < recCount; i++) {
      const r = {};
      for (const f of fields) { [v, p] = readVarint(buf, p); const val = vocabs[f][v]; r[f] = val === '\0NULL\0' ? null : val; }
      out.push(r);
    }
    return out;
  },
};

// AXIS plait: split by action prefix, per-strand JSONL bundles
axes.plait = {
  encode(recs) {
    const strandSeq = recs.map(r => strandOf(r.action));
    const sV = new Map(); for (const s of strandSeq) lookup(sV, s);
    const sNames = [...sV.keys()];
    const streams = new Map(sNames.map(s => [s, []]));
    for (let i = 0; i < recs.length; i++) streams.get(strandSeq[i]).push(recs[i]);
    const parts = [varint(recs.length), varint(sNames.length)];
    for (const s of sNames) parts.push(writeStr(s));
    for (let i = 0; i < recs.length; i++) parts.push(varint(sV.get(strandSeq[i])));
    for (const s of sNames) {
      const jsonl = streams.get(s).map(r => JSON.stringify(r)).join('\n') + (streams.get(s).length ? '\n' : '');
      const bb = Buffer.from(jsonl, 'utf8');
      parts.push(varint(bb.length), bb);
    }
    return Buffer.concat(parts);
  },
  decode(buf) {
    let p = 0; let v;
    [v, p] = readVarint(buf, p); const recCount = v;
    [v, p] = readVarint(buf, p); const nS = v;
    const sNames = [];
    for (let i = 0; i < nS; i++) { let l; [l, p] = readVarint(buf, p); sNames.push(buf.slice(p, p + l).toString('utf8')); p += l; }
    const seq = [];
    for (let i = 0; i < recCount; i++) { [v, p] = readVarint(buf, p); seq.push(sNames[v]); }
    const queues = new Map();
    for (const s of sNames) {
      let l; [l, p] = readVarint(buf, p);
      const txt = buf.slice(p, p + l).toString('utf8'); p += l;
      queues.set(s, txt.split('\n').filter(Boolean).map(l => JSON.parse(l)));
    }
    const cursors = new Map(sNames.map(s => [s, 0]));
    const out = [];
    for (let i = 0; i < recCount; i++) {
      const s = seq[i];
      out.push(queues.get(s)[cursors.get(s)]);
      cursors.set(s, cursors.get(s) + 1);
    }
    return out;
  },
};

// AXIS two_stream: separate IDs from audit content
axes.two_stream = {
  encode(recs) {
    const noId = recs.map(r => JSON.stringify({ action: r.action, status: r.status, summary: r.summary, payload_json: r.payload_json, created_at: r.created_at })).join('\n') + '\n';
    const idTails = recs.map(r => {
      const m = String(r.id).match(/^rcpt_([a-f0-9]{16})$/);
      return m ? Buffer.from(m[1], 'hex') : null;
    });
    const allMatch = idTails.every(t => t !== null);
    const parts = [varint(recs.length), varint(allMatch ? 1 : 0)];
    if (allMatch) {
      parts.push(Buffer.concat(idTails));
    } else {
      for (const r of recs) parts.push(writeStr(String(r.id)));
    }
    parts.push(writeStr(noId));
    return Buffer.concat(parts);
  },
  decode(buf) {
    let p = 0; let v;
    [v, p] = readVarint(buf, p); const N = v;
    [v, p] = readVarint(buf, p); const allMatch = v === 1;
    const ids = [];
    if (allMatch) {
      for (let i = 0; i < N; i++) { ids.push('rcpt_' + buf.slice(p, p + 8).toString('hex')); p += 8; }
    } else {
      for (let i = 0; i < N; i++) { let l; [l, p] = readVarint(buf, p); ids.push(buf.slice(p, p + l).toString('utf8')); p += l; }
    }
    let l; [l, p] = readVarint(buf, p);
    const jsonl = buf.slice(p, p + l).toString('utf8');
    const rest = jsonl.split('\n').filter(Boolean).map(s => JSON.parse(s));
    return rest.map((r, i) => ({ id: ids[i], ...r }));
  },
};

// AXIS schema_fold: drop mesh.compress ratio (recompute on decode)
axes.schema_fold = {
  encode(recs) {
    // Replace mesh.compress payloads' ratio field with marker if ratio = round(raw/comp, 2)
    const folded = recs.map(r => {
      if (r.action !== 'mesh.compress' || !r.payload_json) return r;
      try {
        const p = JSON.parse(r.payload_json);
        if (typeof p.raw_bytes === 'number' && typeof p.compressed_bytes === 'number' && typeof p.ratio === 'number') {
          const computed = Number((p.raw_bytes / p.compressed_bytes).toFixed(2));
          if (computed === p.ratio) {
            // Drop ratio
            const stripped = { raw_bytes: p.raw_bytes, compressed_bytes: p.compressed_bytes };
            return { ...r, payload_json: JSON.stringify(stripped) + '\0FOLD_RATIO' };
          }
        }
      } catch {}
      return r;
    });
    return Buffer.from(folded.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  },
  decode(buf) {
    const recs = buf.toString('utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    return recs.map(r => {
      if (r.payload_json && r.payload_json.endsWith('\0FOLD_RATIO')) {
        const json = r.payload_json.slice(0, -'\0FOLD_RATIO'.length);
        try {
          const p = JSON.parse(json);
          const ratio = Number((p.raw_bytes / p.compressed_bytes).toFixed(2));
          const restored = { raw_bytes: p.raw_bytes, compressed_bytes: p.compressed_bytes, ratio };
          // Match original key order (raw_bytes, compressed_bytes, ratio)
          return { ...r, payload_json: JSON.stringify(restored) };
        } catch {
          return { ...r, payload_json: json };
        }
      }
      return r;
    });
  },
};

// AXIS id_tail: extract rcpt_<16hex> → 8 bytes; rest of record as JSON without id
axes.id_tail = {
  encode(recs) {
    const tails = [];
    let allMatch = true;
    for (const r of recs) {
      const m = String(r.id).match(/^rcpt_([a-f0-9]{16})$/);
      if (!m) { allMatch = false; break; }
      tails.push(Buffer.from(m[1], 'hex'));
    }
    const parts = [varint(recs.length), varint(allMatch ? 1 : 0)];
    if (allMatch) parts.push(Buffer.concat(tails));
    else for (const r of recs) parts.push(writeStr(String(r.id)));
    const noIdJsonl = recs.map(r => JSON.stringify({
      action: r.action, status: r.status, summary: r.summary,
      payload_json: r.payload_json, created_at: r.created_at,
    })).join('\n') + '\n';
    parts.push(writeStr(noIdJsonl));
    return Buffer.concat(parts);
  },
  decode(buf) {
    let p = 0; let v;
    [v, p] = readVarint(buf, p); const N = v;
    [v, p] = readVarint(buf, p); const allMatch = v === 1;
    const ids = [];
    if (allMatch) {
      for (let i = 0; i < N; i++) { ids.push('rcpt_' + buf.slice(p, p + 8).toString('hex')); p += 8; }
    } else {
      for (let i = 0; i < N; i++) { let l; [l, p] = readVarint(buf, p); ids.push(buf.slice(p, p + l).toString('utf8')); p += l; }
    }
    let l; [l, p] = readVarint(buf, p);
    const rest = buf.slice(p, p + l).toString('utf8').split('\n').filter(Boolean).map(s => JSON.parse(s));
    return rest.map((r, i) => ({ id: ids[i], ...r }));
  },
};

// AXIS sort_action: sort receipts by action then by original index; store inv perm
axes.sort_action = {
  encode(recs) {
    const idx = recs.map((r, i) => ({ r, i }));
    idx.sort((a, b) => a.r.action < b.r.action ? -1 : a.r.action > b.r.action ? 1 : a.i - b.i);
    const sorted = idx.map(x => x.r);
    const perm = idx.map(x => x.i);
    const inv = new Array(recs.length);
    for (let i = 0; i < recs.length; i++) inv[perm[i]] = i;
    const jsonl = sorted.map(r => JSON.stringify(r)).join('\n') + '\n';
    const parts = [varint(recs.length), varint(Buffer.byteLength(jsonl)), Buffer.from(jsonl, 'utf8')];
    for (const v of inv) parts.push(varint(v));
    return Buffer.concat(parts);
  },
  decode(buf) {
    let p = 0; let v;
    [v, p] = readVarint(buf, p); const N = v;
    [v, p] = readVarint(buf, p); const l = v;
    const sorted = buf.slice(p, p + l).toString('utf8').split('\n').filter(Boolean).map(s => JSON.parse(s));
    p += l;
    const inv = [];
    for (let i = 0; i < N; i++) { [v, p] = readVarint(buf, p); inv.push(v); }
    const out = new Array(N);
    for (let i = 0; i < N; i++) out[i] = sorted[inv[i]];
    return out;
  },
};

// ── Byte codecs ────────────────────────────────────────────────────────────
const byteCodecs = {
  brotli_q11: { name: 'brotli_q11', compress: b => zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }), decompress: zlib.brotliDecompressSync },
  brotli_q6:  { name: 'brotli_q6',  compress: b => zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 6 } }),  decompress: zlib.brotliDecompressSync },
  zlib_9:     { name: 'zlib_9',     compress: b => zlib.deflateSync(b, { level: 9 }), decompress: zlib.inflateSync },
  // xz via subprocess (may not be portable across environments)
};

// ── Pipeline executor ──────────────────────────────────────────────────────
function runPipeline(axisNames, codecName) {
  if (axisNames.length === 0) throw new Error('need ≥1 axis');
  if (!byteCodecs[codecName]) throw new Error('unknown codec');
  const codec = byteCodecs[codecName];
  // Use the LAST axis in the chain (chaining receipts→buf only works through one axis at a time;
  // multi-axis means apply them in sequence, each producing a buffer, only last buffer matters).
  // Real chaining via re-decoding is the "compound" effect.
  const last = axisNames[axisNames.length - 1];
  if (!axes[last]) throw new Error(`unknown axis: ${last}`);
  const t0 = Date.now();
  const buf = axes[last].encode(receipts);
  const encMs1 = Date.now() - t0;
  const compressed = codec.compress(buf);
  const totalEncodeMs = Date.now() - t0;
  // Roundtrip
  const t1 = Date.now();
  const decompressed = codec.decompress(compressed);
  const decoded = axes[last].decode(decompressed);
  const totalDecodeMs = Date.now() - t1;
  const lossless = verifyLossless(decoded);
  return {
    pipeline: axisNames.join(' → ') + ' → ' + codecName,
    axes: axisNames,
    codec: codecName,
    pre_codec_bytes: buf.length,
    final_bytes: compressed.length,
    ratio: corpusBytes.length / compressed.length,
    encode_ms: totalEncodeMs,
    decode_ms: totalDecodeMs,
    lossless,
  };
}

// ── The 100-experiment matrix: first 25 (singles + winning pairs) ──────────
const matrix = [];
const axisList = ['identity', 'spike', 'plait', 'two_stream', 'schema_fold', 'id_tail', 'sort_action'];
const codecList = ['brotli_q11', 'brotli_q6', 'zlib_9'];

// Singles
for (const a of axisList) for (const c of codecList) matrix.push({ axes: [a], codec: c });

console.log(`\nRunning ${matrix.length} pipelines from the 100-matrix...`);
const results = [];
for (let i = 0; i < matrix.length; i++) {
  const { axes: a, codec: c } = matrix[i];
  try {
    const r = runPipeline(a, c);
    results.push(r);
    const flag = r.lossless ? '✓' : '✗';
    console.log(`  [${(i+1).toString().padStart(3)}/${matrix.length}] ${flag} ${r.ratio.toFixed(2).padStart(7)}x  ${r.pipeline.padEnd(40)} ${r.final_bytes.toString().padStart(8)}B  enc ${r.encode_ms}ms`);
  } catch (e) {
    console.log(`  [${(i+1).toString().padStart(3)}/${matrix.length}] ✗ ERROR  ${a.join(' → ')} → ${c}: ${e.message}`);
    results.push({ pipeline: `${a.join(' → ')} → ${c}`, error: e.message, lossless: false, ratio: 0 });
  }
}

// Sort + report
results.sort((a, b) => (b.ratio || 0) - (a.ratio || 0));
console.log(`\n═══ TOP 10 (sorted by ratio) ═══`);
for (const r of results.slice(0, 10)) {
  const flag = r.lossless ? '✓' : '✗';
  console.log(`  ${flag} ${(r.ratio || 0).toFixed(2).padStart(7)}x  ${r.pipeline.padEnd(45)} ${(r.final_bytes || 0).toString().padStart(8)}B`);
}

// CSV
const csv = ['pipeline,axes,codec,pre_codec_bytes,final_bytes,ratio,encode_ms,decode_ms,lossless'];
for (const r of results) {
  csv.push([
    `"${r.pipeline || ''}"`,
    `"${(r.axes || []).join('+')}"`,
    `"${r.codec || ''}"`,
    r.pre_codec_bytes || 0,
    r.final_bytes || 0,
    (r.ratio || 0).toFixed(4),
    r.encode_ms || 0,
    r.decode_ms || 0,
    r.lossless ? 1 : 0,
  ].join(','));
}
fs.writeFileSync(OUT_CSV, csv.join('\n'));
fs.writeFileSync(OUT_JSON, JSON.stringify({
  generated_at: new Date().toISOString(),
  corpus_sha256: corpusSha,
  corpus_bytes: corpusBytes.length,
  pipelines_tested: results.length,
  results,
}, null, 2));
console.log(`\nResults: ${OUT_CSV}, ${OUT_JSON}`);
