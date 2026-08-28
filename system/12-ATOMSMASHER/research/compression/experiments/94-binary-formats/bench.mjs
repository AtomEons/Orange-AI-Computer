// Experiment 94 — Format-specific binary encoding for detectable patterns.
// Detect UUIDs and rcpt_<hex16> ids in the raw JSONL bytes.
// Replace each occurrence with a binary marker (NUL + tag + varint(len) + raw bytes).
// Brotli the substituted byte stream. Reverse at decode. sha256 verify.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const CORPUS = path.resolve(ROOT, '../../data/canonical-corpus.jsonl');
const M19_BASELINE = 47.07;

const corpusBytes = fs.readFileSync(CORPUS);
const lines = corpusBytes.toString('utf8').split('\n').filter(Boolean);
const receipts = lines.map(l => JSON.parse(l));
const N = receipts.length;
const SEED = 'orange5-receipt-stream-v1';

function detId(s, i) { return 'rcpt_' + crypto.createHash('sha256').update(s + '||' + i).digest('hex').slice(0, 16); }
function brotli11(b) { return zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }); }
function varintU(n) { const b = []; while (n >= 128) { b.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); } b.push(n & 0x7f); return b; }
function readVarintU(buf, ofs) { let n = 0, m = 1, b; do { b = buf[ofs++]; n += (b & 0x7f) * m; m *= 128; } while (b & 0x80); return [n, ofs]; }

const detReceipts = receipts.map((r, i) => ({ ...r, id: detId(SEED, i) }));
const detJsonl = detReceipts.map(r => JSON.stringify(r)).join('\n') + '\n';
const detBytes = Buffer.from(detJsonl, 'utf8');
const detSha = crypto.createHash('sha256').update(detBytes).digest('hex');

const tStart = Date.now();

if (detBytes.indexOf(0) !== -1) {
  console.log('WARNING: NUL byte found in corpus, cannot use 0x00 marker safely. Aborting.');
  process.exit(1);
}

// Work in bytes — buffers throughout.
// Patterns to detect (operating on ascii-only ranges of utf-8 bytes):
//   - UUID: 8-4-4-4-12 hex pairs separated by '-'  (36 bytes ascii) → 16 raw bytes (-55.6%)
//   - rcpt_id: "rcpt_" + 16 hex chars (21 bytes ascii) → 8 raw bytes (-62%)
// Replace with marker: 0x00, tag(0x01 or 0x02), varint(len), bytes.

const HEX = new Uint8Array(256);
for (let i = 0; i < 256; i++) HEX[i] = 255;
for (let c = 48; c <= 57; c++) HEX[c] = c - 48;       // '0'..'9'
for (let c = 97; c <= 102; c++) HEX[c] = c - 97 + 10; // 'a'..'f'

function isHexByte(b) { return HEX[b] !== 255; }

const out = [];
const src = detBytes;
let i = 0;
let nUuid = 0, nRcpt = 0;

function isWordChar(b) {
  // [A-Za-z0-9_]
  return (b >= 48 && b <= 57) || (b >= 65 && b <= 90) || (b >= 97 && b <= 122) || b === 95;
}

while (i < src.length) {
  // Try UUID: 8 hex, '-', 4 hex, '-', 4 hex, '-', 4 hex, '-', 12 hex
  // Boundaries: preceding byte (or BOF) is NOT a word char; trailing byte (or EOF) is NOT a word char.
  let matched = false;

  // word boundary at start
  const beforeOk = i === 0 || !isWordChar(src[i - 1]);

  if (beforeOk) {
    // Try rcpt_<16 hex>
    if (i + 21 <= src.length && src[i] === 0x72 && src[i + 1] === 0x63 && src[i + 2] === 0x70 && src[i + 3] === 0x74 && src[i + 4] === 0x5f) {
      let ok = true;
      for (let k = 0; k < 16; k++) if (!isHexByte(src[i + 5 + k])) { ok = false; break; }
      if (ok && (i + 21 === src.length || !isWordChar(src[i + 21]))) {
        // pack 16 hex → 8 bytes
        const packed = Buffer.alloc(8);
        for (let k = 0; k < 8; k++) {
          packed[k] = (HEX[src[i + 5 + k * 2]] << 4) | HEX[src[i + 5 + k * 2 + 1]];
        }
        out.push(Buffer.from([0x00, 0x02, ...varintU(8)]));
        out.push(packed);
        i += 21;
        nRcpt++;
        matched = true;
      }
    }

    if (!matched && i + 36 <= src.length) {
      // UUID layout positions: hex 0..7, '-' 8, hex 9..12, '-' 13, hex 14..17, '-' 18, hex 19..22, '-' 23, hex 24..35
      const isDash = (idx) => src[i + idx] === 0x2d;
      if (isDash(8) && isDash(13) && isDash(18) && isDash(23)) {
        let ok = true;
        const hexPositions = [];
        for (let k = 0; k < 36; k++) if (k !== 8 && k !== 13 && k !== 18 && k !== 23) hexPositions.push(k);
        for (const k of hexPositions) if (!isHexByte(src[i + k])) { ok = false; break; }
        if (ok && (i + 36 === src.length || !isWordChar(src[i + 36]))) {
          // pack 32 hex → 16 bytes
          const packed = Buffer.alloc(16);
          let hi = 0;
          for (let kp = 0; kp < hexPositions.length; kp += 2) {
            packed[hi++] = (HEX[src[i + hexPositions[kp]]] << 4) | HEX[src[i + hexPositions[kp + 1]]];
          }
          out.push(Buffer.from([0x00, 0x01, ...varintU(16)]));
          out.push(packed);
          i += 36;
          nUuid++;
          matched = true;
        }
      }
    }
  }

  if (!matched) {
    // push raw byte
    out.push(src.slice(i, i + 1));
    i++;
  }
}

const subBuf = Buffer.concat(out);

const subBr = brotli11(subBuf);
const total = subBr.length;
const ratio = detBytes.length / total;

const encMs = Date.now() - tStart;
console.log(`=== EXP 94: Binary-Formats ===`);
console.log(`Original jsonl:    ${detBytes.length}`);
console.log(`UUIDs replaced:    ${nUuid}`);
console.log(`rcpt_ids replaced: ${nRcpt}`);
console.log(`After subst.:      ${subBuf.length}`);
console.log(`Brotli'd subst.:   ${subBr.length}`);
console.log(`Ratio:             ${ratio.toFixed(3)}x`);
console.log(`vs M19 (${M19_BASELINE}x): ${(ratio - M19_BASELINE).toFixed(3)}x`);

// ── Roundtrip ──
const tDecStart = Date.now();
const subDec = zlib.brotliDecompressSync(subBr);
const restoredParts = [];
let p = 0;
while (p < subDec.length) {
  const b = subDec[p];
  if (b === 0) {
    const tag = subDec[p + 1];
    const [len, no] = readVarintU(subDec, p + 2);
    const bytes = subDec.slice(no, no + len);
    if (tag === 1) {
      const h = bytes.toString('hex');
      const uuid = h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20, 32);
      restoredParts.push(Buffer.from(uuid, 'utf8'));
    } else if (tag === 2) {
      restoredParts.push(Buffer.from('rcpt_' + bytes.toString('hex'), 'utf8'));
    } else {
      console.log(`Unknown tag ${tag}`);
      process.exit(1);
    }
    p = no + len;
  } else {
    restoredParts.push(subDec.slice(p, p + 1));
    p++;
  }
}
const restored = Buffer.concat(restoredParts);
const recSha = crypto.createHash('sha256').update(restored).digest('hex');
const lossless = recSha === detSha;
const decMs = Date.now() - tDecStart;

console.log(`Enc ms: ${encMs}, Dec ms: ${decMs}`);
console.log(`Roundtrip: ${lossless ? 'BYTE-EXACT' : 'MISMATCH'}`);
if (!lossless) {
  for (let k = 0; k < Math.min(detBytes.length, restored.length); k++) {
    if (detBytes[k] !== restored[k]) {
      console.log(`First diff at byte ${k}:`);
      console.log(`  det: ...${detBytes.slice(Math.max(0, k - 60), k + 60).toString('utf8')}...`);
      console.log(`  rec: ...${restored.slice(Math.max(0, k - 60), k + 60).toString('utf8')}...`);
      break;
    }
  }
}

const summary = {
  experiment: '94-binary-formats',
  N,
  uuids_replaced: nUuid,
  rcpt_ids_replaced: nRcpt,
  raw_jsonl_bytes: detBytes.length,
  substituted_bytes: subBuf.length,
  bytes_saved_by_substitution: detBytes.length - subBuf.length,
  total_bytes: total,
  ratio: Number(ratio.toFixed(4)),
  vs_m19: Number((ratio - M19_BASELINE).toFixed(4)),
  enc_ms: encMs,
  dec_ms: decMs,
  lossless,
};
fs.writeFileSync(path.join(ROOT, 'summary.json'), JSON.stringify(summary, null, 2));
