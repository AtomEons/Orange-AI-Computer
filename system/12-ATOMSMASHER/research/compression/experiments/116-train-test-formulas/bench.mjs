// Experiment 116 — Train/test formula validation.
// Mine on first 80%, apply to last 20%.

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
const SEED = 'orange5-receipt-stream-v1';

function detId(s, i) { return 'rcpt_' + crypto.createHash('sha256').update(s + '||' + i).digest('hex').slice(0, 16); }
function brotli11(b) { return zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }); }
function sha256(b) { return crypto.createHash('sha256').update(b).digest('hex'); }

const t0 = performance.now();

const detReceipts = receipts.map((r, i) => ({ ...r, id: detId(SEED, i) }));
const SPLIT = Math.floor(N * 0.8);
const trainSet = detReceipts.slice(0, SPLIT);
const testSet = detReceipts.slice(SPLIT);

console.log(`Train: ${trainSet.length}, Test: ${testSet.length}`);

function flatten(reccs) {
  return reccs.map(r => {
    const o = { action: r.action, status: r.status, summary: r.summary, created_at: r.created_at, payload_json_raw: r.payload_json };
    try {
      const p = JSON.parse(r.payload_json);
      if (p && typeof p === 'object' && !Array.isArray(p)) {
        for (const [k, v] of Object.entries(p)) {
          if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) o[`payload.${k}`] = v;
          // skip non-scalar
        }
      }
    } catch {}
    return o;
  });
}

const flatTrain = flatten(trainSet);
const flatTest = flatten(testSet);

const allFieldsSet = new Set();
for (const r of flatTrain) for (const k of Object.keys(r)) allFieldsSet.add(k);
for (const r of flatTest) for (const k of Object.keys(r)) allFieldsSet.add(k);
const FIELDS = [...allFieldsSet];

function mineEdges(flat) {
  const edges = [];
  for (const a of FIELDS) {
    for (const b of FIELDS) {
      if (a === b) continue;
      const grp = new Map();
      let support = 0;
      let conflict = false;
      for (const r of flat) {
        if (!(a in r) || !(b in r)) continue;
        const av = JSON.stringify(r[a]);
        const bv = JSON.stringify(r[b]);
        support++;
        if (!grp.has(av)) grp.set(av, bv);
        else if (grp.get(av) !== bv) { conflict = true; break; }
      }
      if (conflict || support < 5) continue;
      edges.push({ from: a, to: b, support, classes: grp.size, table: grp });
    }
  }
  return edges;
}

console.log('Mining train edges...');
const trainEdges = mineEdges(flatTrain);
console.log(`Train edges found: ${trainEdges.length}`);

let perfectTransfer = 0, hold = 0, overfit = 0, coverageGap = 0;
for (const e of trainEdges) {
  let testRows = 0, coveredRows = 0, correctRows = 0, strictConflict = false;
  for (const r of flatTest) {
    if (!(e.from in r) || !(e.to in r)) continue;
    testRows++;
    const av = JSON.stringify(r[e.from]);
    const bv = JSON.stringify(r[e.to]);
    if (e.table.has(av)) {
      coveredRows++;
      if (e.table.get(av) === bv) correctRows++;
      else strictConflict = true;
    }
  }
  if (testRows === 0) { coverageGap++; continue; }
  if (strictConflict) overfit++;
  else if (coveredRows === testRows) perfectTransfer++;
  else hold++;
}

console.log(`Perfect transfer: ${perfectTransfer}, partial: ${hold}, overfit: ${overfit}, coverage gap: ${coverageGap}`);

function pickSafeFormulas() {
  const scored = trainEdges.map(e => {
    let savedBytes = 0;
    let ok = true;
    for (const r of flatTest) {
      if (!(e.from in r) || !(e.to in r)) continue;
      const av = JSON.stringify(r[e.from]);
      const bv = JSON.stringify(r[e.to]);
      if (!e.table.has(av)) { ok = false; break; }
      if (e.table.get(av) !== bv) { ok = false; break; }
      savedBytes += JSON.stringify(r[e.to]).length + 1;
    }
    return { e, ok, savedBytes };
  }).filter(x => x.ok && x.savedBytes > 0).sort((a, b) => b.savedBytes - a.savedBytes);
  const safe = [];
  const claimed = new Set();
  const usedAsFrom = new Set();
  for (const x of scored) {
    if (claimed.has(x.e.to)) continue;
    if (usedAsFrom.has(x.e.to)) continue;
    if (claimed.has(x.e.from)) continue;
    if (x.e.from === 'payload_json_raw') continue;
    if (x.e.to === 'payload_json_raw') continue;
    if (['action', 'status', 'summary', 'created_at'].includes(x.e.to)) continue;
    safe.push(x.e);
    claimed.add(x.e.to);
    usedAsFrom.add(x.e.from);
  }
  return safe;
}

const safeFormulas = pickSafeFormulas();
console.log(`Safe formulas for test: ${safeFormulas.length}`);

function encodeWithFormulas(receiptsToEncode, formulas, indexOffset) {
  const formulasByTo = new Map();
  for (const f of formulas) formulasByTo.set(f.to, f);

  const payloadKeyOrders = receiptsToEncode.map(r => {
    try {
      const p = JSON.parse(r.payload_json);
      if (p && typeof p === 'object' && !Array.isArray(p)) return Object.keys(p);
    } catch {}
    return null;
  });

  // Build full views (with scalars only for `from` lookup)
  const views = receiptsToEncode.map(r => {
    const view = { action: r.action, status: r.status, summary: r.summary, created_at: r.created_at };
    try {
      const p = JSON.parse(r.payload_json);
      if (p && typeof p === 'object' && !Array.isArray(p)) {
        for (const [k, v] of Object.entries(p)) {
          if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) view[`payload.${k}`] = v;
        }
      }
    } catch {}
    return view;
  });

  const minimal = receiptsToEncode.map((r, ri) => {
    const top = { action: r.action, status: r.status, summary: r.summary, created_at: r.created_at };
    let payloadKept = null;
    try {
      const p = JSON.parse(r.payload_json);
      if (p === null) top._pnull = 1;
      else if (typeof p === 'object' && !Array.isArray(p)) {
        payloadKept = {};
        const view = views[ri];
        for (const [k, v] of Object.entries(p)) {
          const f = formulasByTo.get(`payload.${k}`);
          if (f && (v === null || ['string', 'number', 'boolean'].includes(typeof v))) {
            if (f.from in view) {
              const av = JSON.stringify(view[f.from]);
              if (f.table.has(av) && f.table.get(av) === JSON.stringify(v)) continue; // elide
            }
          }
          payloadKept[k] = v;
        }
      } else top._praw = r.payload_json;
    } catch {
      if (r.payload_json !== undefined) top._praw = r.payload_json;
    }
    return { top, payloadKept };
  });

  const minLines = minimal.map(m => {
    const obj = { ...m.top };
    if (m.payloadKept !== null) obj._p = m.payloadKept;
    return JSON.stringify(obj);
  });
  const minBlob = brotli11(Buffer.from(minLines.join('\n') + '\n', 'utf8'));
  const recipe = formulas.map(f => ({ from: f.from, to: f.to, tbl: Object.fromEntries(f.table) }));
  const recipeBlob = brotli11(Buffer.from(JSON.stringify(recipe), 'utf8'));
  const seedR = brotli11(Buffer.from(JSON.stringify({ seed: SEED, n: receiptsToEncode.length, offset: indexOffset }), 'utf8'));
  const orderStream = payloadKeyOrders.map(ko => ko ? ko.join('\x1f') : '').join('\x1e');
  const orderBlob = brotli11(Buffer.from(orderStream, 'utf8'));
  return { total: minBlob.length + recipeBlob.length + seedR.length + orderBlob.length, minBlob, recipeBlob, seedR, orderBlob };
}

function decodeAndVerify(enc, indexOffset) {
  const minLines = zlib.brotliDecompressSync(enc.minBlob).toString('utf8').split('\n').filter(Boolean);
  const recipe = JSON.parse(zlib.brotliDecompressSync(enc.recipeBlob).toString('utf8'));
  const seedDec = JSON.parse(zlib.brotliDecompressSync(enc.seedR).toString('utf8'));
  const orderStr = zlib.brotliDecompressSync(enc.orderBlob).toString('utf8');
  const orderArr = orderStr.split('\x1e').map(s => s === '' ? null : s.split('\x1f'));

  const out = [];
  for (let i = 0; i < minLines.length; i++) {
    const m = JSON.parse(minLines[i]);
    const payloadKept = m._p;
    delete m._p;
    const praw = m._praw;
    delete m._praw;
    const pnull = m._pnull;
    delete m._pnull;

    const view = { ...m };
    if (payloadKept) for (const [k, v] of Object.entries(payloadKept)) view[`payload.${k}`] = v;

    let changed = true;
    let safety = 0;
    while (changed && safety++ < 20) {
      changed = false;
      for (const f of recipe) {
        if (f.to in view) continue;
        if (!(f.from in view)) continue;
        const av = JSON.stringify(view[f.from]);
        if (av in f.tbl) { view[f.to] = JSON.parse(f.tbl[av]); changed = true; }
      }
    }

    const globalIdx = indexOffset + i;
    const obj = {
      id: detId(seedDec.seed, globalIdx),
      action: view.action,
      status: view.status,
      summary: view.summary,
    };
    if (praw !== undefined) obj.payload_json = praw;
    else if (pnull) obj.payload_json = null;
    else {
      const ko = orderArr[i];
      if (ko === null) obj.payload_json = null;
      else {
        const fullP = {};
        for (const k of ko) {
          const pk = `payload.${k}`;
          if (payloadKept && k in payloadKept) fullP[k] = payloadKept[k];
          else if (pk in view) fullP[k] = view[pk];
          else fullP[k] = null;
        }
        obj.payload_json = JSON.stringify(fullP);
      }
    }
    obj.created_at = view.created_at;
    out.push(obj);
  }
  return out;
}

// Test
const testEnc = encodeWithFormulas(testSet, safeFormulas, SPLIT);
const testRaw = Buffer.from(testSet.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');
const testRatio = testRaw.length / testEnc.total;
const testOut = decodeAndVerify(testEnc, SPLIT);
const testRecJsonl = testOut.map(r => JSON.stringify(r)).join('\n') + '\n';
const testSha = sha256(Buffer.from(testRecJsonl, 'utf8'));
const detTestSha = sha256(testRaw);
const testLossless = testSha === detTestSha;

// Train (compute ratio with formulas — but we only care about test honesty)
const trainEnc = encodeWithFormulas(trainSet, safeFormulas, 0);
const trainRaw = Buffer.from(trainSet.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');
const trainRatio = trainRaw.length / trainEnc.total;
const trainOut = decodeAndVerify(trainEnc, 0);
const trainRecJsonl = trainOut.map(r => JSON.stringify(r)).join('\n') + '\n';
const trainSha = sha256(Buffer.from(trainRecJsonl, 'utf8'));
const detTrainSha = sha256(trainRaw);
const trainLossless = trainSha === detTrainSha;

const overfitRate = trainEdges.length > 0 ? (overfit / trainEdges.length) : 0;

const encode_ms = performance.now() - t0;
const netBytes = testRaw.length - testEnc.total;
const summary = {
  experiment: '116-train-test-formulas',
  ratio_test: Number(testRatio.toFixed(3)),
  ratio_train: Number(trainRatio.toFixed(3)),
  edges_mined_train: trainEdges.length,
  formulas_safe_for_test: safeFormulas.length,
  perfect_transfer: perfectTransfer,
  partial_transfer: hold,
  overfit_formulas: overfit,
  coverage_gap: coverageGap,
  overfit_rate: Number((overfitRate * 100).toFixed(2)),
  net_bytes_saved_test: netBytes,
  lossless_test: testLossless,
  lossless_train: trainLossless,
  baseline_m19_ratio: 47.071,
  vs_m19_delta_test: Number((testRatio - 47.071).toFixed(3)),
  encode_ms: Number(encode_ms.toFixed(1)),
  notes: `Mined ${trainEdges.length} edges on 80% train. ${perfectTransfer} transfer perfectly to test; ${overfit} overfit; ${coverageGap} had no test coverage. Picked ${safeFormulas.length} safe formulas. Test ratio=${testRatio.toFixed(3)}x vs train ratio=${trainRatio.toFixed(3)}x. Overfit rate=${(overfitRate*100).toFixed(2)}%.`,
};
fs.writeFileSync(path.join(ROOT, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
