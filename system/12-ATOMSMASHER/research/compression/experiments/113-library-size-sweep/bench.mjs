// Experiment 113 — Formula library size sweep.
// Mine all deterministic field-pair edges. Sort by bytes-saved descending.
// Build M19+formula codec with TOP-N where N ∈ {10, 50, 200, 500, ALL}.
// Find the knee where extra formulas stop paying back recipe overhead.
//
// Fix: preserve original payload key order via a side-channel "shapeOrder" stream.
// Without that, eliding a key and re-inserting at decode breaks JSON byte-equality.

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

// Capture original payload key orders (needed for byte-exact reconstruction)
const payloadKeyOrders = detReceipts.map(r => {
  try {
    const p = JSON.parse(r.payload_json);
    if (p && typeof p === 'object' && !Array.isArray(p)) return Object.keys(p);
  } catch {}
  return null; // null payload, non-object, or unparseable
});

// === Flatten === (SCALAR fields only — non-scalars are not elision candidates)
const flat = detReceipts.map(r => {
  const o = { action: r.action, status: r.status, summary: r.summary, created_at: r.created_at, payload_json_raw: r.payload_json };
  try {
    const p = JSON.parse(r.payload_json);
    if (p && typeof p === 'object' && !Array.isArray(p)) {
      for (const [k, v] of Object.entries(p)) {
        if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) o[`payload.${k}`] = v;
        // non-scalar (object/array): SKIP — not safe to formula-elide (would need double-decode at restore)
      }
    }
  } catch {}
  return o;
});

const allFieldsSet = new Set();
for (const r of flat) for (const k of Object.keys(r)) allFieldsSet.add(k);
const FIELDS = [...allFieldsSet];

// === Mine deterministic edges ===
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
      if (conflict || support < 10) continue;
      let bBytesTotal = 0;
      for (const r of flat) if (a in r && b in r) bBytesTotal += JSON.stringify(r[b]).length + 1;
      let tableBytes = 0;
      for (const [k, v] of grp) tableBytes += k.length + v.length + 4;
      const recipeBytes = a.length + b.length + 6;
      const netSaved = bBytesTotal - tableBytes - recipeBytes;
      edges.push({ from: a, to: b, support, classes: grp.size, savedBytes: netSaved, table: grp });
    }
  }
  return edges.sort((x, y) => y.savedBytes - x.savedBytes);
}

console.log('Mining edges...');
const allEdges = mineEdges();
console.log(`Mined ${allEdges.length} edges.`);

function pickFormulas(edges, topN) {
  // Two-pass to ensure no formula's `from` is another formula's `to` (avoids chain-recovery issues).
  // Greedy by savedBytes, but enforce: claimedAsTo is also a usedAsFrom set; reject if `to` already used as from, or if `from` already claimed as to.
  const chosen = [];
  const claimedAsTo = new Set();
  const usedAsFrom = new Set();
  for (const e of edges) {
    if (chosen.length >= topN) break;
    if (claimedAsTo.has(e.to)) continue;
    if (usedAsFrom.has(e.to)) continue;  // would create chain
    if (claimedAsTo.has(e.from)) continue; // from is already elided -> chain
    if (e.from === 'payload_json_raw') continue; // can't use raw payload as a key after elision
    if (e.to === 'payload_json_raw') continue;
    if (['action', 'status', 'summary', 'created_at'].includes(e.to)) continue;
    chosen.push(e);
    claimedAsTo.add(e.to);
    usedAsFrom.add(e.from);
  }
  return chosen;
}

function encodeWithFormulas(formulas) {
  // Build per-formula table lookups indexed by "to" field name
  const formulasByTo = new Map();
  for (const f of formulas) formulasByTo.set(f.to, f);

  // For each receipt: per-key decision — elide ONLY when the field is exactly recoverable.
  // For payload.X, the formula's `from` must exist on this receipt AND tbl[fromVal] must equal current value.
  const minimal = detReceipts.map((r, i) => {
    const top = { action: r.action, status: r.status, summary: r.summary, created_at: r.created_at };
    let payloadKept = null;
    let payloadParsed = null;
    try { payloadParsed = JSON.parse(r.payload_json); } catch { top._praw = r.payload_json; return { top, payloadKept }; }
    if (payloadParsed === null) { top._pnull = 1; return { top, payloadKept }; }
    if (typeof payloadParsed !== 'object' || Array.isArray(payloadParsed)) { top._praw = r.payload_json; return { top, payloadKept }; }

    // flatRow: scalars only (matching mining)
    const view = { action: r.action, status: r.status, summary: r.summary, created_at: r.created_at, payload_json_raw: r.payload_json };
    for (const [k, v] of Object.entries(payloadParsed)) {
      if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) view[`payload.${k}`] = v;
    }

    payloadKept = {};
    for (const [k, v] of Object.entries(payloadParsed)) {
      const toName = `payload.${k}`;
      const f = formulasByTo.get(toName);
      if (f) {
        // Check current view matches the formula's prediction.
        if (!(f.from in view)) { payloadKept[k] = v; continue; }
        const av = JSON.stringify(view[f.from]);
        if (!f.table.has(av)) { payloadKept[k] = v; continue; }
        const predicted = f.table.get(av);
        const actual = JSON.stringify(v === null || ['string', 'number', 'boolean'].includes(typeof v) ? v : JSON.stringify(v));
        // We need the actual value in the format that mining stored it.
        // Mining stored: bv = JSON.stringify(r[b])  where r[b] is whatever was put into view[`payload.${k}`]
        // We already constructed view above with the same rule. So compare:
        const viewVal = view[toName];
        const actualBv = JSON.stringify(viewVal);
        if (actualBv === predicted) {
          // safe to elide
        } else {
          payloadKept[k] = v;
        }
      } else {
        payloadKept[k] = v;
      }
    }
    return { top, payloadKept };
  });

  const minLines = minimal.map(m => {
    const obj = { ...m.top };
    if (m.payloadKept !== null) obj._p = m.payloadKept;
    return JSON.stringify(obj);
  });
  const minBlob = brotli11(Buffer.from(minLines.join('\n') + '\n', 'utf8'));

  // Key-order side channel: a string per receipt giving the original payload key order.
  // Use unit separator \x1f between keys and \x1e between receipts.
  const orderStream = payloadKeyOrders.map(ko => ko ? ko.join('\x1f') : '').join('\x1e');
  const orderBlob = brotli11(Buffer.from(orderStream, 'utf8'));

  const recipe = formulas.map(f => ({ from: f.from, to: f.to, tbl: Object.fromEntries(f.table) }));
  const recipeBlob = brotli11(Buffer.from(JSON.stringify(recipe), 'utf8'));
  const seedR = brotli11(Buffer.from(JSON.stringify({ seed: SEED, n: N }), 'utf8'));
  return {
    total: minBlob.length + recipeBlob.length + seedR.length + orderBlob.length,
    minBlob, recipeBlob, seedR, orderBlob,
    parts: { minBlob: minBlob.length, recipeBlob: recipeBlob.length, seedR: seedR.length, orderBlob: orderBlob.length },
  };
}

function decodeAndVerify(enc, formulas) {
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
        if (av in f.tbl) {
          // tbl stores JSON.stringify(b); parse back to native type
          view[f.to] = JSON.parse(f.tbl[av]);
          changed = true;
        }
      }
    }

    const obj = {
      id: detId(seedDec.seed, i),
      action: view.action,
      status: view.status,
      summary: view.summary,
    };
    if (praw !== undefined) {
      obj.payload_json = praw;
    } else if (pnull) {
      obj.payload_json = null;
    } else {
      // Reconstruct payload in ORIGINAL key order
      const ko = orderArr[i];
      if (ko === null) {
        obj.payload_json = null;
      } else {
        const fullP = {};
        for (const k of ko) {
          if (payloadKept && k in payloadKept) fullP[k] = payloadKept[k];
          else if (`payload.${k}` in view) fullP[k] = view[`payload.${k}`];
          else {
            // Unrecoverable; bail (will sha-fail and surface the gap)
            fullP[k] = null;
          }
        }
        obj.payload_json = JSON.stringify(fullP);
      }
    }
    obj.created_at = view.created_at;
    out.push(obj);
  }
  const recJsonl = out.map(r => JSON.stringify(r)).join('\n') + '\n';
  return { sha: sha256(Buffer.from(recJsonl, 'utf8')), recJsonl };
}

const sizes = [10, 50, 200, 500, allEdges.length];
const results = [];
for (const N_TOP of sizes) {
  const formulas = pickFormulas(allEdges, N_TOP);
  const enc = encodeWithFormulas(formulas);
  const ratio = rawTotal / enc.total;
  const { sha, recJsonl } = decodeAndVerify(enc, formulas);
  const lossless = sha === detSha;
  if (!lossless && N_TOP === 10) {
    console.log("Chosen formulas (top 10):", formulas.map(f => `${f.from} -> ${f.to}`).join(", "));
    const orig = detBytes.toString('utf8');
    for (let i = 0; i < Math.min(orig.length, recJsonl.length); i++) {
      if (orig[i] !== recJsonl[i]) {
        console.log(`Diff at byte ${i}: orig...${orig.slice(Math.max(0, i-80), i+120)}... rec...${recJsonl.slice(Math.max(0, i-80), i+120)}...`);
        break;
      }
    }
    console.log(`Lengths: orig=${orig.length}, rec=${recJsonl.length}`);
  }
  results.push({ N: N_TOP, chosen: formulas.length, total: enc.total, ratio: Number(ratio.toFixed(3)), lossless, parts: enc.parts });
  console.log(`N=${N_TOP}: chosen=${formulas.length}, total=${enc.total}B, ratio=${ratio.toFixed(3)}x, lossless=${lossless}`);
}

let best = results[0];
for (const r of results) if (r.lossless && r.ratio > best.ratio) best = r;

const bestFormulas = pickFormulas(allEdges, best.N);
const netBytesSaved = bestFormulas.reduce((a, f) => a + f.savedBytes, 0);

const encode_ms = performance.now() - t0;
const summary = {
  experiment: '113-library-size-sweep',
  ratio: best.ratio,
  best_N: best.N,
  best_chosen: best.chosen,
  edges_used: best.chosen,
  net_bytes_saved: netBytesSaved,
  lossless: best.lossless,
  baseline_m19_ratio: 47.071,
  vs_m19_delta: Number((best.ratio - 47.071).toFixed(3)),
  total_edges_mined: allEdges.length,
  sweep: results,
  encode_ms: Number(encode_ms.toFixed(1)),
  notes: `Knee at N=${best.N}. Mined ${allEdges.length} deterministic edges total. Side-channel: payload-key-order stream (brotli'd) preserves byte-exact JSON.`,
};
fs.writeFileSync(path.join(ROOT, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
