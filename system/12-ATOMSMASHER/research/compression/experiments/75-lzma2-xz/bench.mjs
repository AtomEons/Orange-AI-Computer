// Experiment 75 — LZMA2 (xz) vs brotli on canonical corpus
// Shell out to `xz -9 -e --lzma2=preset=9e`. Different algorithm class (range-coded).
// Hypothesis: xz beats brotli on text-heavy corpora with long repetitive runs.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const CORPUS = path.resolve(ROOT, '../../data/canonical-corpus.jsonl');

const corpusBytes = fs.readFileSync(CORPUS);
const lines = corpusBytes.toString('utf8').split('\n').filter(Boolean);
const receipts = lines.map(l => JSON.parse(l));
const N = receipts.length;
const SEED = 'orange5-receipt-stream-v1';

function detId(s, i) { return 'rcpt_' + crypto.createHash('sha256').update(s + '||' + i).digest('hex').slice(0, 16); }

const detReceipts = receipts.map((r, i) => ({ ...r, id: detId(SEED, i) }));
const detJsonl = detReceipts.map(r => JSON.stringify(r)).join('\n') + '\n';
const detBytes = Buffer.from(detJsonl, 'utf8');
const detSha = crypto.createHash('sha256').update(detBytes).digest('hex');

const TMP_IN = path.join(ROOT, 'tmp.in');
const TMP_XZ = path.join(ROOT, 'tmp.xz');
const TMP_OUT = path.join(ROOT, 'tmp.out');
fs.writeFileSync(TMP_IN, detBytes);

// === XZ encode (-9 -e --lzma2=preset=9e) ===
try { fs.unlinkSync(TMP_XZ); } catch {}
try { fs.unlinkSync(TMP_OUT); } catch {}
const t0 = process.hrtime.bigint();
// File-based encode: xz -k -9 -e tmp.in  → produces tmp.in.xz
fs.copyFileSync(TMP_IN, TMP_XZ + '.src');
const enc = spawnSync('xz', ['-k', '-9', '-e', '-f', TMP_XZ + '.src'], { stdio: ['ignore', 'pipe', 'pipe'] });
const t1 = process.hrtime.bigint();
if (enc.status !== 0) {
  console.error('xz encode failed (status ' + enc.status + '):', enc.stderr?.toString() || '');
  process.exit(1);
}
// xz wrote tmp.in.xz.xz when -f was used with a custom extension; with .src suffix it appends .xz
const ACTUAL_XZ = TMP_XZ + '.src.xz';
const xzBytes = fs.statSync(ACTUAL_XZ).size;
const encodeMs = Number(t1 - t0) / 1e6;

// === XZ decode (file-based) ===
const td0 = process.hrtime.bigint();
fs.copyFileSync(ACTUAL_XZ, TMP_OUT + '.xz');
const dec = spawnSync('xz', ['-d', '-k', '-f', TMP_OUT + '.xz'], { stdio: ['ignore', 'pipe', 'pipe'] });
const td1 = process.hrtime.bigint();
if (dec.status !== 0) {
  console.error('xz decode failed (status ' + dec.status + '):', dec.stderr?.toString() || '');
  process.exit(1);
}
const decodeMs = Number(td1 - td0) / 1e6;
const decBuf = fs.readFileSync(TMP_OUT);

const recSha = crypto.createHash('sha256').update(decBuf).digest('hex');
const lossless = recSha === detSha;

// === reference: brotli q11 on same bytes ===
const tb0 = process.hrtime.bigint();
const brOut = zlib.brotliCompressSync(detBytes, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } });
const tb1 = process.hrtime.bigint();
const brEncMs = Number(tb1 - tb0) / 1e6;

const ratio = detBytes.length / xzBytes;
const brRatio = detBytes.length / brOut.length;

console.log(`=== EXP 75: LZMA2 (xz -9 -e) vs brotli q11 ===`);
console.log(`Det bytes:    ${detBytes.length}`);
console.log(`xz size:      ${xzBytes}  ratio ${ratio.toFixed(3)}x`);
console.log(`brotli size:  ${brOut.length}  ratio ${brRatio.toFixed(3)}x  (reference, raw stream)`);
console.log(`vs M19 47.071: ${(ratio - 47.071).toFixed(3)}  (note: M19 uses decomposed/structured pipeline)`);
console.log(`encode_ms:    ${encodeMs.toFixed(1)}`);
console.log(`decode_ms:    ${decodeMs.toFixed(1)}`);
console.log(`brotli enc_ms (ref): ${brEncMs.toFixed(1)}`);
console.log(`Roundtrip:    ${lossless ? 'BYTE-EXACT' : 'MISMATCH'}`);

try { fs.unlinkSync(TMP_IN); } catch {}
try { fs.unlinkSync(TMP_XZ + '.src'); } catch {}
try { fs.unlinkSync(TMP_XZ + '.src.xz'); } catch {}
try { fs.unlinkSync(TMP_OUT); } catch {}
try { fs.unlinkSync(TMP_OUT + '.xz'); } catch {}

const summary = {
  experiment: '75-lzma2-xz',
  N,
  det_bytes: detBytes.length,
  xz_bytes: xzBytes,
  brotli_bytes: brOut.length,
  total: xzBytes,
  ratio: Number(ratio.toFixed(3)),
  brotli_ratio: Number(brRatio.toFixed(3)),
  delta_vs_m19: Number((ratio - 47.071).toFixed(3)),
  encode_ms: Number(encodeMs.toFixed(1)),
  decode_ms: Number(decodeMs.toFixed(1)),
  lossless,
  note: 'raw-corpus comparison: xz vs brotli on undecomposed JSONL; M19 47.07x uses a structured pipeline so this is an apples-to-oranges baseline check',
};
fs.writeFileSync(path.join(ROOT, 'summary.json'), JSON.stringify(summary, null, 2));
