// Exp E2 — AtomSmasher Round-trip of VS Emoji
// Question: does a VS-loaded emoji round-trip through SQLite TEXT,
// JSON.stringify/parse, and the M19 codec without corruption?
//
// Layers tested:
//   A. SQLite TEXT (bun:sqlite UTF-8 column round-trip)
//   B. JSON.stringify -> JSON.parse (transport / replay layer)
//   C. M19 codec (storage.exportCompressedAuditLog reverse-engineered decode)
//
// Mom's Law: real measurements, real receipts, no theater.

import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { Store } from '../../storage.mjs';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ============================================================
// Encoder / decoder (from experiment prompt — verbatim)
// ============================================================
function encodeVS(base, payload) {
  const parts = [base];
  for (const b of payload) {
    parts.push(b < 16 ? String.fromCodePoint(0xFE00 + b) : String.fromCodePoint(0xE0100 + b - 16));
  }
  return parts.join('');
}
function decodeVS(s) {
  const cps = [...s];
  const out = [];
  for (let i = 1; i < cps.length; i++) {
    const cp = cps[i].codePointAt(0);
    if (cp >= 0xFE00 && cp <= 0xFE0F) out.push(cp - 0xFE00);
    else if (cp >= 0xE0100 && cp <= 0xE01EF) out.push(cp - 0xE0100 + 16);
  }
  return Uint8Array.from(out);
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// ============================================================
// M19 decoder — mirror of storage.exportCompressedAuditLog().
// Reverses the "other receipts" path (Method 19 dedupe via shape vocab).
// Reads the length-prefix header, peels brotli x2 off the shapes blob,
// reconstructs the receipts, and returns them.
// ============================================================
function readVarintU(buf, offset) {
  let n = 0, shift = 0, i = offset;
  while (true) {
    const b = buf[i++];
    n += (b & 0x7f) * Math.pow(2, shift);
    if ((b & 0x80) === 0) break;
    shift += 7;
  }
  return { value: n, next: i };
}

function decodeM19(encoded) {
  if (encoded.length === 0) return [];
  // 1) parse header
  let off = 0;
  const h = readVarintU(encoded, off);
  off = h.next;
  const headerLen = h.value;
  const components = JSON.parse(encoded.slice(off, off + headerLen).toString('utf8'));
  off += headerLen;
  // 2) slice the component blobs in declared order
  const slice = (len) => { const b = encoded.slice(off, off + len); off += len; return b; };
  const meshTplBlob   = slice(components.meshTpl);
  const meshDataBlob  = slice(components.meshData);
  const shapesBlob    = slice(components.shapes);   // brotli x2
  const aIdxBlob      = slice(components.aIdx);
  const aVBlob        = slice(components.aV);
  const otherIdxBlob  = slice(components.otherIdx);
  // posBlob: positional class RLE — used to order mesh vs other; for the
  // "other-only" path (our experiment uses no mesh.compress receipts) it
  // collapses to one run of class 0.

  // 3) reverse the "other" path
  const shapesInner = zlib.brotliDecompressSync(shapesBlob);
  const strippedJsonl = zlib.brotliDecompressSync(shapesInner).toString('utf8');
  const strippedLines = strippedJsonl.split('\n').filter(s => s.length > 0);

  const actionVocabText = zlib.brotliDecompressSync(aVBlob).toString('utf8');
  const actionVocab = actionVocabText.split('\x02');
  const aIdxBytes = zlib.brotliDecompressSync(aIdxBlob);
  const actionStream = [];
  { let p = 0; while (p < aIdxBytes.length) { const r = readVarintU(aIdxBytes, p); actionStream.push(r.value); p = r.next; } }

  // Rebuild the sorted shape list (in B8-sorted order, matching encoder)
  const sortedShapes = strippedLines.map((rest, i) => {
    const restObj = JSON.parse(rest);
    const action = actionVocab[actionStream[i]];
    return { action, ...restObj };
  });

  // Decode the per-receipt index sequence (remappedIdx in encoder)
  const otherIdxBytes = zlib.brotliDecompressSync(otherIdxBlob);
  const remappedIdx = [];
  { let p = 0; while (p < otherIdxBytes.length) { const r = readVarintU(otherIdxBytes, p); remappedIdx.push(r.value); p = r.next; } }
  // Expand back to full receipt objects
  return remappedIdx.map(i => sortedShapes[i]);
}

// ============================================================
// Run the experiment
// ============================================================
const REPORT = [];
const out = (line) => { REPORT.push(line); };

out('=== Exp E2 — AtomSmasher Round-trip of VS Emoji ===');
out('');

// 1) Generate payload
const payload = crypto.randomBytes(256);
const payloadHex = sha256(payload);
out(`Payload: 256 random bytes, sha256 ${payloadHex}`);

// 2) Encode
const base = '🟢'; // 🟢 large green circle U+1F7E2
const encoded = encodeVS(base, payload);
const codepointCount = [...encoded].length;
const utf8Bytes = Buffer.byteLength(encoded, 'utf8');
out(`Encoded form: 🟢 + 256 VS = ${codepointCount} codepoints, ${utf8Bytes} UTF-8 bytes`);

// 3) Insert via Store (in-memory DB, fresh)
const store = new Store(':memory:');
const rid = store.insertReceipt('emoji.test', 'ok', encoded, { len: 256 });

// ============================================================
// Round-trip A — SQLite TEXT
// ============================================================
const rows = store.getReceiptsByAction('emoji.test');
const sqliteSummary = rows[0].summary;
const sqliteDecoded = decodeVS(sqliteSummary);
const sqliteHex = sha256(Buffer.from(sqliteDecoded));
const sqliteMatch = sqliteHex === payloadHex;
out(`SQLite TEXT round-trip:   ${sqliteMatch ? 'MATCH' : 'FAIL'}`);

// ============================================================
// Round-trip B — JSON.stringify/parse
// ============================================================
const jsonRound = JSON.parse(JSON.stringify(encoded));
const jsonDecoded = decodeVS(jsonRound);
const jsonHex = sha256(Buffer.from(jsonDecoded));
const jsonMatch = jsonHex === payloadHex;
out(`JSON stringify/parse:     ${jsonMatch ? 'MATCH' : 'FAIL'}`);

// ============================================================
// Round-trip C — M19 codec
// ============================================================
const exp = store.exportCompressedAuditLog();
let m19Match = false;
let m19FailMode = '';
try {
  const recovered = decodeM19(exp.encoded);
  const ours = recovered.find(r => r.action === 'emoji.test');
  if (!ours) {
    m19FailMode = 'receipt not present after M19 decode';
  } else {
    const m19Decoded = decodeVS(ours.summary);
    const m19Hex = sha256(Buffer.from(m19Decoded));
    m19Match = m19Hex === payloadHex;
    if (!m19Match) {
      m19FailMode = `summary sha mismatch: got ${m19Hex.slice(0,16)} vs ${payloadHex.slice(0,16)}`;
      // Diagnose where the corruption is
      const sqlSummary = sqliteSummary;
      if (ours.summary !== sqlSummary) {
        const sqlCps = [...sqlSummary];
        const m19Cps = [...ours.summary];
        if (sqlCps.length !== m19Cps.length) {
          m19FailMode += ` | codepoint count diff (sqlite=${sqlCps.length} m19=${m19Cps.length})`;
        } else {
          for (let i = 0; i < sqlCps.length; i++) {
            if (sqlCps[i] !== m19Cps[i]) {
              m19FailMode += ` | first diff at cp[${i}]: U+${sqlCps[i].codePointAt(0).toString(16)} vs U+${m19Cps[i].codePointAt(0).toString(16)}`;
              break;
            }
          }
        }
      }
    }
  }
} catch (e) {
  m19FailMode = `decoder threw: ${String(e?.message ?? e)}`;
}
out(`M19 codec round-trip:     ${m19Match ? 'MATCH' : 'FAIL'}${m19Match ? '' : '  [' + m19FailMode + ']'}`);

// ============================================================
// SQLite stored size — VS-encoded form vs raw 256B payload
// ============================================================
// Open a SECOND in-memory store and write the raw 256-byte payload as TEXT
// summary. Note: JSON-payload column gets stringified too, so we keep that
// equivalent across both rows by using the same `payload` argument.
const storeRaw = new Store(':memory:');
// Convert raw bytes to a Latin1 string so it can ride the TEXT column —
// SQLite TEXT is byte-blob in practice (no encoding enforced on bun:sqlite).
const rawAsLatin1 = Buffer.from(payload).toString('binary');
storeRaw.insertReceipt('emoji.test', 'ok', rawAsLatin1, { len: 256 });

const vsByteRow  = store.one("SELECT length(summary) AS chars, length(CAST(summary AS BLOB)) AS bytes FROM receipts WHERE action='emoji.test'");
const rawByteRow = storeRaw.one("SELECT length(summary) AS chars, length(CAST(summary AS BLOB)) AS bytes FROM receipts WHERE action='emoji.test'");

out(`SQLite stored size:       ${vsByteRow.bytes} bytes (vs raw 256B receipt ${rawByteRow.bytes} bytes)`);

// ============================================================
// Persist summary.json + emit one line for the operator
// ============================================================
const summary = {
  experiment: 'E2-emoji-roundtrip',
  bun_version: process.versions.bun || 'unknown',
  payload_sha256: payloadHex,
  base_glyph: '🟢',
  base_codepoint: 'U+1F7E2',
  encoded_codepoint_count: codepointCount,
  encoded_utf8_bytes: utf8Bytes,
  roundtrips: {
    sqlite_text:    { match: sqliteMatch, decoded_sha256: sqliteHex },
    json_stringify: { match: jsonMatch,   decoded_sha256: jsonHex },
    m19_codec:      { match: m19Match,    fail_mode: m19FailMode || null },
  },
  sqlite_stored_bytes_vs_encoded: vsByteRow.bytes,
  sqlite_stored_bytes_raw_256B:   rawByteRow.bytes,
  m19_export: {
    encoded_bytes: exp.encoded.length,
    original_jsonl_bytes: exp.originalBytes,
    ratio: exp.ratio,
    n_receipts: exp.n_receipts,
  },
  report_lines: REPORT,
};
const summaryPath = path.join(__dirname, 'summary.json');
const benchPath   = path.join(__dirname, 'bench.mjs');
writeFileSync(summaryPath, JSON.stringify(summary, null, 2));

// Print the canonical report block
console.log(REPORT.join('\n'));
console.log('');
console.log(`${benchPath} + ${summaryPath}`);

store.close();
storeRaw.close();
