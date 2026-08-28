// Experiment 70: MessagePack -> brotli pipeline
import fs from 'node:fs';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const CORPUS = '../../data/canonical-corpus.jsonl';
const KEYS = ['id', 'action', 'status', 'summary', 'payload_json', 'created_at'];

// ---- Verify canonical key order on first 10 lines ----
const raw = fs.readFileSync(CORPUS);
const rawSize = raw.length; // 2,075,585
const text = raw.toString('utf8');
const lines = text.split('\n').filter(l => l.length > 0);

function detectKeyOrder(line) {
  // strip the JSON; capture keys in order of appearance
  const re = /"([^"]+)"\s*:/g;
  const out = [];
  let m;
  while ((m = re.exec(line)) !== null) {
    // only top-level keys (ignore payload_json's inner keys by depth)
    out.push(m[1]);
  }
  return out;
}

// Simpler: walk the JSON tokens for top-level keys only
function topLevelKeys(line) {
  const obj = JSON.parse(line);
  return Object.keys(obj);
}

let keyOrderConsistent = true;
for (let i = 0; i < Math.min(10, lines.length); i++) {
  const k = topLevelKeys(lines[i]);
  if (k.length !== KEYS.length || k.some((x, j) => x !== KEYS[j])) {
    keyOrderConsistent = false;
    console.error('Key order mismatch on line', i, k);
    break;
  }
}
if (!keyOrderConsistent) {
  console.error('Aborting: key order not canonical');
  process.exit(1);
}

// ---- Inline MessagePack encoder (minimal subset we need) ----
// We only need: str, fixmap (6 entries), float-not-needed, ints not needed (all our values are strings).
// All 6 fields in our corpus are strings. So we can hardcode a string-only encoder.
// But to be safe, support: nil, str, fixmap, plus length-prefix varint for outer framing.

function encStr(s) {
  const buf = Buffer.from(s, 'utf8');
  const n = buf.length;
  let head;
  if (n <= 31) {
    head = Buffer.from([0xa0 | n]); // fixstr
  } else if (n <= 0xff) {
    head = Buffer.from([0xd9, n]); // str8
  } else if (n <= 0xffff) {
    head = Buffer.alloc(3);
    head[0] = 0xda;
    head.writeUInt16BE(n, 1);
  } else {
    head = Buffer.alloc(5);
    head[0] = 0xdb;
    head.writeUInt32BE(n, 1);
  }
  return Buffer.concat([head, buf]);
}

function encMap6(obj) {
  // fixmap with 6 entries: 0x80 | 6 = 0x86
  const parts = [Buffer.from([0x86])];
  for (const k of KEYS) {
    parts.push(encStr(k));
    parts.push(encStr(obj[k]));
  }
  return Buffer.concat(parts);
}

// Varint (LEB128 unsigned) for record length prefix
function encVarint(n) {
  const bytes = [];
  while (n >= 0x80) {
    bytes.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  bytes.push(n & 0x7f);
  return Buffer.from(bytes);
}

function decVarint(buf, offset) {
  let result = 0;
  let shift = 0;
  let i = offset;
  while (true) {
    const b = buf[i];
    i++;
    result |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
  }
  return [result, i];
}

// ---- MessagePack decoder (mirror subset) ----
function decStr(buf, offset) {
  const b = buf[offset];
  let len, hdr;
  if ((b & 0xe0) === 0xa0) {
    len = b & 0x1f;
    hdr = 1;
  } else if (b === 0xd9) {
    len = buf[offset + 1];
    hdr = 2;
  } else if (b === 0xda) {
    len = buf.readUInt16BE(offset + 1);
    hdr = 3;
  } else if (b === 0xdb) {
    len = buf.readUInt32BE(offset + 1);
    hdr = 5;
  } else {
    throw new Error('Not a string at offset ' + offset + ' byte=0x' + b.toString(16));
  }
  const s = buf.toString('utf8', offset + hdr, offset + hdr + len);
  return [s, offset + hdr + len];
}

function decMap6(buf, offset) {
  if (buf[offset] !== 0x86) throw new Error('Expected fixmap6 at ' + offset);
  let p = offset + 1;
  const obj = {};
  for (let i = 0; i < 6; i++) {
    let k, v;
    [k, p] = decStr(buf, p);
    [v, p] = decStr(buf, p);
    obj[k] = v;
  }
  return [obj, p];
}

// ---- Encode corpus ----
const t0 = performance.now();
const records = [];
for (const line of lines) {
  const obj = JSON.parse(line);
  records.push(obj);
}

// Serialize each record to msgpack, prefix with varint length, concat
const msgpackParts = [];
for (const obj of records) {
  const enc = encMap6(obj);
  msgpackParts.push(encVarint(enc.length));
  msgpackParts.push(enc);
}
const msgpackBlob = Buffer.concat(msgpackParts);
const msgpackSize = msgpackBlob.length;

// Brotli q11 over the msgpack blob
const brotliCompressed = zlib.brotliCompressSync(msgpackBlob, {
  params: {
    [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
    [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_GENERIC,
  },
});
const compressedSize = brotliCompressed.length;
const encodeMs = performance.now() - t0;

// Baseline: raw JSONL -> brotli q11
const t1 = performance.now();
const rawBrotli = zlib.brotliCompressSync(raw, {
  params: {
    [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
    [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
  },
});
const rawBrotliMs = performance.now() - t1;
const rawBrotliSize = rawBrotli.length;

// ---- Decode + roundtrip ----
const td0 = performance.now();
const decompressed = zlib.brotliDecompressSync(brotliCompressed);
const reconstructed = [];
let p = 0;
while (p < decompressed.length) {
  let recLen;
  [recLen, p] = decVarint(decompressed, p);
  const recEnd = p + recLen;
  let obj;
  [obj, p] = decMap6(decompressed, p);
  if (p !== recEnd) throw new Error('Record length mismatch: got ' + p + ' expected ' + recEnd);
  reconstructed.push(obj);
}
const decodeMs = performance.now() - td0;

// Re-emit JSON in canonical key order and concat as JSONL
function canonicalJson(obj) {
  // emit keys in KEYS order, using JSON.stringify on each value to handle escaping
  const parts = [];
  for (const k of KEYS) {
    parts.push(JSON.stringify(k) + ':' + JSON.stringify(obj[k]));
  }
  return '{' + parts.join(',') + '}';
}

const reemitted = reconstructed.map(canonicalJson).join('\n') + '\n';
const reemittedBuf = Buffer.from(reemitted, 'utf8');

// Sha check: compare reemitted to raw
const rawSha = crypto.createHash('sha256').update(raw).digest('hex');
const reemittedSha = crypto.createHash('sha256').update(reemittedBuf).digest('hex');
const lossless = rawSha === reemittedSha;

// Also: did sizes match?
const sizeMatch = reemittedBuf.length === raw.length;

// ---- Compute ratios ----
const ratio = rawSize / compressedSize;
const msgpackOnlyRatio = rawSize / msgpackSize;
const rawBrotliRatio = rawSize / rawBrotliSize;

const summary = {
  experiment: '70-msgpack-brotli',
  ratio: Number(ratio.toFixed(4)),
  encode_ms: Number(encodeMs.toFixed(2)),
  decode_ms: Number(decodeMs.toFixed(2)),
  lossless,
  notes: `msgpack-only ratio: ${msgpackOnlyRatio.toFixed(2)}, raw-jsonl-brotli ratio: ${rawBrotliRatio.toFixed(2)}, raw_size=${rawSize}, msgpack_size=${msgpackSize}, brotli_size=${compressedSize}, raw_brotli_size=${rawBrotliSize}, raw_brotli_ms=${rawBrotliMs.toFixed(2)}, size_match=${sizeMatch}, raw_sha=${rawSha.slice(0, 12)}, reemit_sha=${reemittedSha.slice(0, 12)}, records=${records.length}`,
};

fs.writeFileSync('summary.json', JSON.stringify(summary, null, 2));

console.log(JSON.stringify(summary, null, 2));
console.log('---');
console.log('ratio:', ratio.toFixed(4) + 'x');
console.log('msgpack-only ratio:', msgpackOnlyRatio.toFixed(2) + 'x');
console.log('raw-jsonl-brotli ratio:', rawBrotliRatio.toFixed(2) + 'x');
console.log('lossless:', lossless);
console.log('encode ms:', encodeMs.toFixed(2));
console.log('decode ms:', decodeMs.toFixed(2));
