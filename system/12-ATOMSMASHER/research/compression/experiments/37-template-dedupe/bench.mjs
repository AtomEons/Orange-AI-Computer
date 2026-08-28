// Experiment 37 — Template-level dedupe codec (Method 4)
//
// Method 1 (Exp 36): 34.20× via receipt-shape dedupe (3,132 unique receipts).
//
// Method 4: dedupe at TEMPLATE level (numbers replaced by sentinel).
// Numerics + timestamps stored as separate streams. Result: fewer unique
// templates (1,116 according to Exp 35) → more compression.

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
const N = receipts.length;
console.log(`Original corpus: ${corpusBytes.length} B, ${N} receipts`);

const SEED = 'orange5-receipt-stream-v1';
function detId(s, i) { return 'rcpt_' + crypto.createHash('sha256').update(s + '||' + i).digest('hex').slice(0, 16); }

const detReceipts = receipts.map((r, i) => ({ ...r, id: detId(SEED, i) }));
const detJsonl = detReceipts.map(r => JSON.stringify(r)).join('\n') + '\n';
const detBytes = Buffer.from(detJsonl, 'utf8');
const detSha = crypto.createHash('sha256').update(detBytes).digest('hex');

const brotli11 = b => zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } });
function varintU(n) { const b = []; while (n >= 128) { b.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); } b.push(n & 0x7f); return b; }
function readVarintU(buf, ofs) { let n = 0, m = 1, b; do { b = buf[ofs++]; n += (b & 0x7f) * m; m *= 128; } while (b & 0x80); return [n, ofs]; }

// ── Build per-receipt: (template, summary_nums, payload_nums, created_at) ──
const NUM_RE = /-?\d+(?:\.\d+)?(?:e-?\d+)?/g;
const SENTINEL = '\x01';

function templatize(s) {
  if (s == null) return { tpl: '\0NULL\0', nums: [] };
  const nums = [];
  const tpl = String(s).replace(NUM_RE, m => { nums.push(m); return SENTINEL; });
  return { tpl, nums };
}
function untemplatize(tpl, nums) {
  if (tpl === '\0NULL\0') return null;
  let i = 0;
  return tpl.replace(new RegExp(SENTINEL, 'g'), () => nums[i++]);
}

// For each receipt, build:
//   - template_key = JSON of receipt with summary/payload_json templatized, id stripped, created_at templatized
//   - sum_nums, pay_nums, created_at
const recDecomp = detReceipts.map(r => {
  const sT = templatize(r.summary);
  const pT = templatize(r.payload_json);
  return {
    tpl_obj: {
      action: r.action,
      status: r.status,
      summary_tpl: sT.tpl,
      payload_tpl: pT.tpl,
    },
    sum_nums: sT.nums,
    pay_nums: pT.nums,
    created_at: r.created_at,
  };
});

// Dedupe templates
const tplVocab = new Map();
const tplList = [];
const tplIdSeq = [];
for (const d of recDecomp) {
  const key = JSON.stringify(d.tpl_obj);
  if (!tplVocab.has(key)) { tplVocab.set(key, tplList.length); tplList.push(d.tpl_obj); }
  tplIdSeq.push(tplVocab.get(key));
}
console.log(`Unique (action, status, sum_tpl, pay_tpl) combinations: ${tplList.length}`);

// Encode templates dict
const tplDictJsonl = tplList.map(t => JSON.stringify(t)).join('\n') + '\n';
const tplDictBrotli = brotli11(Buffer.from(tplDictJsonl, 'utf8'));

// Encode template-id sequence
const tplIdBytes = Buffer.from(tplIdSeq.flatMap(varintU));
const tplIdBrotli = brotli11(tplIdBytes);

// Encode created_at sequence (with vocab)
const caVocab = new Map();
for (const ca of recDecomp.map(d => d.created_at)) if (!caVocab.has(ca)) caVocab.set(ca, caVocab.size);
const caIdSeq = recDecomp.map(d => caVocab.get(d.created_at));
const caIdBytes = Buffer.from(caIdSeq.flatMap(varintU));
const caDictBytes = Buffer.from([...caVocab.keys()].join('\x02'), 'utf8');
const caIdBrotli = brotli11(caIdBytes);
const caDictBrotli = brotli11(caDictBytes);

// Encode sum_nums + pay_nums (per-receipt arrays as varint-prefixed lists)
const sumNumsBytes = [];
for (const d of recDecomp) {
  sumNumsBytes.push(...varintU(d.sum_nums.length));
  // Store each as a length-prefixed string
  for (const n of d.sum_nums) {
    sumNumsBytes.push(...varintU(n.length));
    for (const c of Buffer.from(n, 'utf8')) sumNumsBytes.push(c);
  }
}
const sumNumsBrotli = brotli11(Buffer.from(sumNumsBytes));

const payNumsBytes = [];
for (const d of recDecomp) {
  payNumsBytes.push(...varintU(d.pay_nums.length));
  for (const n of d.pay_nums) {
    payNumsBytes.push(...varintU(n.length));
    for (const c of Buffer.from(n, 'utf8')) payNumsBytes.push(c);
  }
}
const payNumsBrotli = brotli11(Buffer.from(payNumsBytes));

// Seed
const seedR = Buffer.from(JSON.stringify({ seed: SEED, n: N }), 'utf8');
const seedBrotli = brotli11(seedR);

const total = tplDictBrotli.length + tplIdBrotli.length + caIdBrotli.length + caDictBrotli.length + sumNumsBrotli.length + payNumsBrotli.length + seedBrotli.length;
const ratio = detBytes.length / total;
console.log(`\n=== METHOD 4: template-level dedupe ===`);
console.log(`Template dict brotli:    ${tplDictBrotli.length.toString().padStart(7)} B`);
console.log(`Template-id seq brotli:  ${tplIdBrotli.length.toString().padStart(7)} B`);
console.log(`Created_at id seq:       ${caIdBrotli.length.toString().padStart(7)} B`);
console.log(`Created_at dict:         ${caDictBrotli.length.toString().padStart(7)} B`);
console.log(`Summary nums brotli:     ${sumNumsBrotli.length.toString().padStart(7)} B`);
console.log(`Payload nums brotli:     ${payNumsBrotli.length.toString().padStart(7)} B`);
console.log(`Seed recipe:             ${seedBrotli.length.toString().padStart(7)} B`);
console.log(`Total:                   ${total.toString().padStart(7)} B`);
console.log(`Ratio:                   ${ratio.toFixed(2)}x`);

// ── ROUNDTRIP ──
// Decode each stream
const tplDictDec = zlib.brotliDecompressSync(tplDictBrotli).toString('utf8').split('\n').filter(Boolean).map(JSON.parse);
const tplIdDec = (() => { const r = []; let o = 0; while (o < tplIdBytes.length) { const [v, n] = readVarintU(tplIdBytes, o); r.push(v); o = n; } return r; })();
const caIdDec = (() => { const r = []; let o = 0; while (o < caIdBytes.length) { const [v, n] = readVarintU(caIdBytes, o); r.push(v); o = n; } return r; })();
const caDictDec = zlib.brotliDecompressSync(caDictBrotli).toString('utf8').split('\x02');

const sumNumsDec = []; {
  const b = Buffer.from(sumNumsBytes);
  let ofs = 0;
  for (let i = 0; i < N; i++) {
    const [len, n1] = readVarintU(b, ofs); ofs = n1;
    const nums = [];
    for (let j = 0; j < len; j++) {
      const [slen, nofs] = readVarintU(b, ofs); ofs = nofs;
      nums.push(b.slice(ofs, ofs + slen).toString('utf8'));
      ofs += slen;
    }
    sumNumsDec.push(nums);
  }
}
const payNumsDec = []; {
  const b = Buffer.from(payNumsBytes);
  let ofs = 0;
  for (let i = 0; i < N; i++) {
    const [len, n1] = readVarintU(b, ofs); ofs = n1;
    const nums = [];
    for (let j = 0; j < len; j++) {
      const [slen, nofs] = readVarintU(b, ofs); ofs = nofs;
      nums.push(b.slice(ofs, ofs + slen).toString('utf8'));
      ofs += slen;
    }
    payNumsDec.push(nums);
  }
}
const seedDec = JSON.parse(zlib.brotliDecompressSync(seedBrotli).toString('utf8'));

// Reconstruct each receipt
const reconst = [];
for (let i = 0; i < N; i++) {
  const tplObj = tplDictDec[tplIdDec[i]];
  const ca = caDictDec[caIdDec[i]];
  const summary = untemplatize(tplObj.summary_tpl, sumNumsDec[i]);
  const payload_json = untemplatize(tplObj.payload_tpl, payNumsDec[i]);
  reconst.push({
    id: detId(seedDec.seed, i),
    action: tplObj.action,
    status: tplObj.status,
    summary,
    payload_json,
    created_at: ca,
  });
}

const recJsonl = reconst.map(r => JSON.stringify(r)).join('\n') + '\n';
const recSha = crypto.createHash('sha256').update(recJsonl).digest('hex');
const lossless = recSha === detSha;
console.log(`\nRoundtrip: ${lossless ? '✓ BYTE-EXACT vs det' : '✗ MISMATCH'}`);
if (!lossless) {
  const det = detBytes.toString('utf8');
  for (let i = 0; i < Math.min(det.length, recJsonl.length); i++) {
    if (det[i] !== recJsonl[i]) {
      console.log(`First diff at byte ${i}:`);
      console.log(`  det: ...${det.slice(Math.max(0, i-80), i+80)}...`);
      console.log(`  rec: ...${recJsonl.slice(Math.max(0, i-80), i+80)}...`);
      break;
    }
  }
}

console.log(`\nvs Method 1 (Exp 36, 34.20x): ${ratio > 34.20 ? `BEATS by +${(ratio-34.20).toFixed(2)}x` : `below by ${(34.20-ratio).toFixed(2)}x`}`);

const out = {
  experiment: '37-template-dedupe',
  generated_at: new Date().toISOString(),
  unique_templates: tplList.length,
  components: {
    tpl_dict_brotli: tplDictBrotli.length,
    tpl_id_brotli: tplIdBrotli.length,
    ca_id_brotli: caIdBrotli.length,
    ca_dict_brotli: caDictBrotli.length,
    sum_nums_brotli: sumNumsBrotli.length,
    pay_nums_brotli: payNumsBrotli.length,
    seed_brotli: seedBrotli.length,
  },
  total,
  ratio: Number(ratio.toFixed(2)),
  roundtrip_lossless: lossless,
};
fs.writeFileSync(RECEIPT_FILE, JSON.stringify(out, null, 2));
console.log(`\nReceipt: ${RECEIPT_FILE}`);
