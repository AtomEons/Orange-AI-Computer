// Experiment 117 — Per-formula recipe-overhead audit.

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
const detJsonl = detReceipts.map(r => JSON.stringify(r)).join('\n') + '\n';
const detBytes = Buffer.from(detJsonl, 'utf8');
const detSha = sha256(detBytes);
const rawTotal = detBytes.length;

const payloadKeyOrders = detReceipts.map(r => {
  try {
    const p = JSON.parse(r.payload_json);
    if (p && typeof p === 'object' && !Array.isArray(p)) return Object.keys(p);
  } catch {}
  return null;
});

const flat = detReceipts.map(r => {
  const o = { action: r.action, status: r.status, summary: r.summary, created_at: r.created_at, payload_json_raw: r.payload_json };
  try {
    const p = JSON.parse(r.payload_json);
    if (p && typeof p === 'object' && !Array.isArray(p)) {
      for (const [k, v] of Object.entries(p)) {
        if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) o[`payload.${k}`] = v;
        // scalar only
      }
    }
  } catch {}
  return o;
});

const allFieldsSet = new Set();
for (const r of flat) for (const k of Object.keys(r)) allFieldsSet.add(k);
const FIELDS = [...allFieldsSet];

function mineEdges() {
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

console.log('Mining edges...');
const allEdges = mineEdges();
console.log(`Mined ${allEdges.length} edges total.`);

function auditFormula(e) {
  let bBytesTotal = 0;
  for (const r of flat) if (e.from in r && e.to in r) bBytesTotal += JSON.stringify(r[e.to]).length + 1;
  const recipeStr = JSON.stringify({ from: e.from, to: e.to, tbl: Object.fromEntries(e.table) });
  const recipeBytes = brotli11(Buffer.from(recipeStr, 'utf8')).length;
  return { ...e, bytes_saved_raw: bBytesTotal, recipe_brotli: recipeBytes, net: bBytesTotal - recipeBytes };
}

const candidatesSorted = [...allEdges].sort((a, b) => b.support - a.support).slice(0, 1000);
const audited = [];
for (let i = 0; i < candidatesSorted.length; i++) {
  audited.push(auditFormula(candidatesSorted[i]));
  if (i % 100 === 0) console.log(`Audited ${i}/${candidatesSorted.length}`);
}

const positiveNet = audited.filter(a => a.net > 0).sort((a, b) => b.net - a.net);
const violators = audited.filter(a => a.net <= 0);

console.log(`Positive-net: ${positiveNet.length}, violators: ${violators.length}`);

function pickNonConflicting(sorted) {
  const chosen = [];
  const claimed = new Set();
  const usedAsFrom = new Set();
  for (const e of sorted) {
    if (claimed.has(e.to)) continue;
    if (usedAsFrom.has(e.to)) continue;
    if (claimed.has(e.from)) continue;
    if (e.from === 'payload_json_raw') continue;
    if (e.to === 'payload_json_raw') continue;
    if (['action', 'status', 'summary', 'created_at'].includes(e.to)) continue;
    chosen.push(e);
    claimed.add(e.to);
    usedAsFrom.add(e.from);
  }
  return chosen;
}

const filtered = pickNonConflicting(positiveNet);
console.log(`Non-conflicting positive-net: ${filtered.length}`);

function encodeWithFormulas(formulas) {
  const formulasByTo = new Map();
  for (const f of formulas) formulasByTo.set(f.to, f);

  const minimal = detReceipts.map(r => {
    const top = { action: r.action, status: r.status, summary: r.summary, created_at: r.created_at };
    let payloadKept = null;
    try {
      const p = JSON.parse(r.payload_json);
      if (p === null) top._pnull = 1;
      else if (typeof p === 'object' && !Array.isArray(p)) {
        // build a scalar view for this receipt
        const view = { action: r.action, status: r.status, summary: r.summary, created_at: r.created_at };
        for (const [k, v] of Object.entries(p)) {
          if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) view[`payload.${k}`] = v;
        }
        payloadKept = {};
        for (const [k, v] of Object.entries(p)) {
          const f = formulasByTo.get(`payload.${k}`);
          if (f && (v === null || ['string', 'number', 'boolean'].includes(typeof v))) {
            if (f.from in view) {
              const av = JSON.stringify(view[f.from]);
              if (f.table.has(av) && f.table.get(av) === JSON.stringify(v)) continue;
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
  const seedR = brotli11(Buffer.from(JSON.stringify({ seed: SEED, n: N }), 'utf8'));
  const orderStream = payloadKeyOrders.map(ko => ko ? ko.join('\x1f') : '').join('\x1e');
  const orderBlob = brotli11(Buffer.from(orderStream, 'utf8'));
  return { total: minBlob.length + recipeBlob.length + seedR.length + orderBlob.length, minBlob, recipeBlob, seedR, orderBlob };
}

function decodeAndVerify(enc) {
  const minLines = zlib.brotliDecompressSync(enc.minBlob).toString('utf8').split('\n').filter(Boolean);
  const recipe = JSON.parse(zlib.brotliDecompressSync(enc.recipeBlob).toString('utf8'));
  const seedDec = JSON.parse(zlib.brotliDecompressSync(enc.seedR).toString('utf8'));
  const orderStr = zlib.brotliDecompressSync(enc.orderBlob).toString('utf8');
  const orderArr = orderStr.split('\x1e').map(s => s === '' ? null : s.split('\x1f'));

  const out = [];
  for (let i = 0; i < N; i++) {
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

    const obj = {
      id: detId(seedDec.seed, i),
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
  const recJsonl = out.map(r => JSON.stringify(r)).join('\n') + '\n';
  return sha256(Buffer.from(recJsonl, 'utf8'));
}

const enc = encodeWithFormulas(filtered);
const ratio = rawTotal / enc.total;
const recSha = decodeAndVerify(enc);
const lossless = recSha === detSha;
const netBytes = rawTotal - enc.total;

console.log(`Filtered library ratio: ${ratio.toFixed(3)}x (lossless=${lossless})`);

const encode_ms = performance.now() - t0;
const summary = {
  experiment: '117-per-formula-audit',
  ratio: Number(ratio.toFixed(3)),
  audited: audited.length,
  positive_net: positiveNet.length,
  violators_law6: violators.length,
  edges_used: filtered.length,
  net_bytes_saved: netBytes,
  total: enc.total,
  lossless,
  baseline_m19_ratio: 47.071,
  vs_m19_delta: Number((ratio - 47.071).toFixed(3)),
  encode_ms: Number(encode_ms.toFixed(1)),
  top_5_by_net: positiveNet.slice(0, 5).map(e => ({ from: e.from, to: e.to, net: e.net, bytes_saved_raw: e.bytes_saved_raw, recipe_brotli: e.recipe_brotli })),
  notes: `Audited top ${audited.length} edges by support. ${violators.length} violated Law 6 (recipe>=savings). Filtered to ${filtered.length} non-conflicting positive-net formulas.`,
};
fs.writeFileSync(path.join(ROOT, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
