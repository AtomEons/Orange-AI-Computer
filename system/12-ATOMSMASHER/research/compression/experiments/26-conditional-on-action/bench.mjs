// Experiment 26 — Conditional encoding ON ACTION
//
// Insight: in our corpus, summary_tpl and payload_tpl are HIGHLY dependent
// on action (each action has its own template family). H(summary_tpl) ≈ 3.6
// bits/sym in isolation but H(summary_tpl|action) should be much smaller.
//
// Build conditional range coders where the context is action[i], not
// summary_tpl[i-1]. Measure achieved bits/sym and ratios.

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

const NUM_RE = /-?\d+(?:\.\d+)?(?:e-?\d+)?/g;
const PH = '';

function templatize(s) {
  if (s == null) return '\0NULL\0';
  return String(s).replace(NUM_RE, PH);
}

const actions = receipts.map(r => r.action);
const summaryTpls = receipts.map(r => templatize(r.summary));
const payloadTpls = receipts.map(r => templatize(r.payload_json));
const statuses = receipts.map(r => r.status);
const createdAts = receipts.map(r => r.created_at);

function vocab(arr) {
  const m = new Map();
  for (const x of arr) if (!m.has(x)) m.set(x, m.size);
  return m;
}

const aV = vocab(actions);
const sV = vocab(summaryTpls);
const pV = vocab(payloadTpls);
const stV = vocab(statuses);
const cV = vocab(createdAts);

console.log(`Vocabs: action=${aV.size}, summary_tpl=${sV.size}, payload_tpl=${pV.size}, status=${stV.size}, created_at=${cV.size}`);

// ── Conditional entropy H(Y|X) ──────────────────────────────────────────────
function condEntropy(xs, ys) {
  const counts = new Map(); // x → Map(y → count)
  const xTot = new Map();
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i], y = ys[i];
    if (!counts.has(x)) counts.set(x, new Map());
    counts.get(x).set(y, (counts.get(x).get(y) || 0) + 1);
    xTot.set(x, (xTot.get(x) || 0) + 1);
  }
  const total = xs.length;
  let H = 0;
  for (const [x, m] of counts) {
    const p_x = xTot.get(x) / total;
    let H_local = 0;
    const tot = xTot.get(x);
    for (const c of m.values()) {
      const p = c / tot;
      H_local -= p * Math.log2(p);
    }
    H += p_x * H_local;
  }
  return H;
}

// Marginal entropy H(X)
function entropy(xs) {
  const counts = new Map();
  for (const x of xs) counts.set(x, (counts.get(x) || 0) + 1);
  let H = 0;
  const total = xs.length;
  for (const c of counts.values()) {
    const p = c / total;
    H -= p * Math.log2(p);
  }
  return H;
}

console.log(`\n=== Marginal & Conditional Entropy (bits/sym) ===`);
const H_action = entropy(actions);
const H_status = entropy(statuses);
const H_createdAt = entropy(createdAts);
const H_summaryTpl = entropy(summaryTpls);
const H_payloadTpl = entropy(payloadTpls);

const H_summary_given_action = condEntropy(actions, summaryTpls);
const H_payload_given_action = condEntropy(actions, payloadTpls);
const H_status_given_action = condEntropy(actions, statuses);
const H_createdAt_given_action = condEntropy(actions, createdAts);
const H_summary_given_action_prev_summary = (function() {
  // 2D context: (action[i], summary[i-1])
  const xs = [], ys = [];
  for (let i = 1; i < actions.length; i++) {
    xs.push(actions[i] + '\x00' + summaryTpls[i - 1]);
    ys.push(summaryTpls[i]);
  }
  return condEntropy(xs, ys);
})();

console.log(`H(action)              = ${H_action.toFixed(3)}`);
console.log(`H(status)              = ${H_status.toFixed(3)}, H(status|action)   = ${H_status_given_action.toFixed(3)}`);
console.log(`H(created_at)          = ${H_createdAt.toFixed(3)}, H(created_at|action) = ${H_createdAt_given_action.toFixed(3)}`);
console.log(`H(summary_tpl)         = ${H_summaryTpl.toFixed(3)}, H(summary_tpl|action) = ${H_summary_given_action.toFixed(3)} (save ${(H_summaryTpl - H_summary_given_action).toFixed(2)} bits/sym)`);
console.log(`H(payload_tpl)         = ${H_payloadTpl.toFixed(3)}, H(payload_tpl|action) = ${H_payload_given_action.toFixed(3)} (save ${(H_payloadTpl - H_payload_given_action).toFixed(2)} bits/sym)`);
console.log(`H(summary_tpl|action, prev_summary_tpl) = ${H_summary_given_action_prev_summary.toFixed(3)}`);

// Total bits/sym for these 5 fields under different schemes
const indep_bits = H_action + H_status + H_createdAt + H_summaryTpl + H_payloadTpl;
const cond_bits = H_action + H_status_given_action + H_createdAt_given_action + H_summary_given_action + H_payload_given_action;
console.log(`\nIndependent encoding total: ${indep_bits.toFixed(3)} bits/sym → ${(indep_bits * receipts.length / 8).toFixed(0)} B`);
console.log(`Conditional-on-action total: ${cond_bits.toFixed(3)} bits/sym → ${(cond_bits * receipts.length / 8).toFixed(0)} B`);
console.log(`Savings: ${(indep_bits - cond_bits).toFixed(3)} bits/sym = ${((indep_bits - cond_bits) * receipts.length / 8).toFixed(0)} B`);

// ── Range coder ────────────────────────────────────────────────────────────
const TOP = 0xFFFFFFFF >>> 0, HALF = 0x80000000 >>> 0, QTR = 0x40000000 >>> 0, TQTR = 0xC0000000 >>> 0;
function encode(symbols, V, cumFn) {
  let low = 0, high = TOP, pending = 0;
  const bits = [];
  function emit(b) { bits.push(b); }
  function epw(b) { emit(b); for (let i = 0; i < pending; i++) emit(1 - b); pending = 0; }
  for (let i = 0; i < symbols.length; i++) {
    const cum = cumFn(i, symbols);
    const sym = symbols[i];
    const cumTot = cum[V];
    const rng = (high - low + 1);
    high = (low + Math.floor((rng * cum[sym + 1]) / cumTot) - 1) >>> 0;
    low = (low + Math.floor((rng * cum[sym]) / cumTot)) >>> 0;
    while (true) {
      if (high < HALF) epw(0);
      else if (low >= HALF) { epw(1); low = (low - HALF) >>> 0; high = (high - HALF) >>> 0; }
      else if (low >= QTR && high < TQTR) { pending++; low = (low - QTR) >>> 0; high = (high - QTR) >>> 0; }
      else break;
      low = (low << 1) >>> 0;
      high = ((high << 1) | 1) >>> 0;
    }
  }
  pending++;
  if (low < QTR) epw(0); else epw(1);
  const out = Buffer.alloc(Math.ceil(bits.length / 8));
  for (let i = 0; i < bits.length; i++) if (bits[i]) out[i >> 3] |= 1 << (7 - (i & 7));
  return { bytes: out, nBits: bits.length };
}

// Build per-context cum tables (V values + Laplace +1)
function buildCondModel(contexts, syms, V) {
  // contexts[i] is the context for syms[i]
  const counts = new Map(); // ctx → Map(sym → count)
  for (let i = 0; i < syms.length; i++) {
    const ctx = contexts[i];
    if (!counts.has(ctx)) counts.set(ctx, new Map());
    counts.get(ctx).set(syms[i], (counts.get(ctx).get(syms[i]) || 0) + 1);
  }
  const cumByCtx = new Map();
  for (const [ctx, m] of counts) {
    const cum = new Array(V + 1).fill(0);
    for (let s = 0; s < V; s++) cum[s + 1] = cum[s] + ((m.get(s) || 0) + 1);
    cumByCtx.set(ctx, cum);
  }
  const iidCum = new Array(V + 1).fill(0);
  for (let s = 0; s < V; s++) iidCum[s + 1] = iidCum[s] + 1;
  return { cumByCtx, iidCum };
}

// ── Encode each field with action[i] as context (where applicable) ─────────
const aIds = actions.map(a => aV.get(a));
const sIds = summaryTpls.map(s => sV.get(s));
const pIds = payloadTpls.map(p => pV.get(p));
const stIds = statuses.map(s => stV.get(s));
const cIds = createdAts.map(c => cV.get(c));

// Action: 1st-order Markov on its own history (no external context)
function actionMarkov(aIds, V) {
  const counts = new Map();
  for (let i = 1; i < aIds.length; i++) {
    const prev = aIds[i - 1];
    if (!counts.has(prev)) counts.set(prev, new Map());
    counts.get(prev).set(aIds[i], (counts.get(prev).get(aIds[i]) || 0) + 1);
  }
  const cumByCtx = new Map();
  for (const [prev, m] of counts) {
    const cum = new Array(V + 1).fill(0);
    for (let s = 0; s < V; s++) cum[s + 1] = cum[s] + ((m.get(s) || 0) + 1);
    cumByCtx.set(prev, cum);
  }
  const iidCum = new Array(V + 1).fill(0);
  for (let s = 0; s < V; s++) iidCum[s + 1] = iidCum[s] + 1;
  return { cumByCtx, iidCum };
}

const aModel = actionMarkov(aIds, aV.size);
const actionEnc = encode(aIds, aV.size, (i, syms) => {
  if (i === 0) return aModel.iidCum;
  const prev = syms[i - 1];
  return aModel.cumByCtx.get(prev) || aModel.iidCum;
});

// Status: conditional on action[i]
const stModel = buildCondModel(aIds, stIds, stV.size);
const statusEnc = encode(stIds, stV.size, (i) => stModel.cumByCtx.get(aIds[i]) || stModel.iidCum);

// Created_at: conditional on action[i]
const cModel = buildCondModel(aIds, cIds, cV.size);
const createdAtEnc = encode(cIds, cV.size, (i) => cModel.cumByCtx.get(aIds[i]) || cModel.iidCum);

// Summary_tpl: conditional on action[i]
const sModel = buildCondModel(aIds, sIds, sV.size);
const summaryTplEnc = encode(sIds, sV.size, (i) => sModel.cumByCtx.get(aIds[i]) || sModel.iidCum);

// Payload_tpl: conditional on action[i]
const pModel = buildCondModel(aIds, pIds, pV.size);
const payloadTplEnc = encode(pIds, pV.size, (i) => pModel.cumByCtx.get(aIds[i]) || pModel.iidCum);

console.log(`\n=== Encoded sizes (conditional on action) ===`);
console.log(`action       ${actionEnc.bytes.length.toString().padStart(7)} B (${(actionEnc.nBits/aIds.length).toFixed(3)} bps, theoretical ${H_action.toFixed(3)})`);
console.log(`status       ${statusEnc.bytes.length.toString().padStart(7)} B (${(statusEnc.nBits/stIds.length).toFixed(3)} bps, theoretical ${H_status_given_action.toFixed(3)})`);
console.log(`created_at   ${createdAtEnc.bytes.length.toString().padStart(7)} B (${(createdAtEnc.nBits/cIds.length).toFixed(3)} bps, theoretical ${H_createdAt_given_action.toFixed(3)})`);
console.log(`summary_tpl  ${summaryTplEnc.bytes.length.toString().padStart(7)} B (${(summaryTplEnc.nBits/sIds.length).toFixed(3)} bps, theoretical ${H_summary_given_action.toFixed(3)})`);
console.log(`payload_tpl  ${payloadTplEnc.bytes.length.toString().padStart(7)} B (${(payloadTplEnc.nBits/pIds.length).toFixed(3)} bps, theoretical ${H_payload_given_action.toFixed(3)})`);

const total5fields = actionEnc.bytes.length + statusEnc.bytes.length + createdAtEnc.bytes.length + summaryTplEnc.bytes.length + payloadTplEnc.bytes.length;
console.log(`\nTotal data 5 fields: ${total5fields} B`);

// Raw 5-field bytes
const raw5fields = actions.reduce((s, a) => s + a.length + 4, 0) +  // "action":"..."
  statuses.reduce((s, x) => s + x.length + 4, 0) +
  createdAts.reduce((s, x) => s + x.length + 4, 0) +
  summaryTpls.reduce((s, x) => s + x.length + 4, 0) +
  payloadTpls.reduce((s, x) => s + x.length + 4, 0);
console.log(`Raw 5-field bytes: ${raw5fields}`);
console.log(`Data-only ratio for 5 fields: ${(raw5fields / total5fields).toFixed(2)}x`);

// Save the receipt
const receipt = {
  experiment: '26-conditional-on-action',
  generated_at: new Date().toISOString(),
  corpus_sha256_in: corpusSha,
  entropies: {
    H_action, H_status, H_createdAt, H_summaryTpl, H_payloadTpl,
    H_status_given_action, H_createdAt_given_action,
    H_summary_given_action, H_payload_given_action,
    H_summary_given_action_prev_summary,
  },
  independent_total_bps: Number(indep_bits.toFixed(3)),
  conditional_total_bps: Number(cond_bits.toFixed(3)),
  savings_bps: Number((indep_bits - cond_bits).toFixed(3)),
  savings_bytes: Math.round((indep_bits - cond_bits) * receipts.length / 8),
  encoded_sizes: {
    action: actionEnc.bytes.length,
    status: statusEnc.bytes.length,
    created_at: createdAtEnc.bytes.length,
    summary_tpl: summaryTplEnc.bytes.length,
    payload_tpl: payloadTplEnc.bytes.length,
  },
  total_5fields_bytes: total5fields,
  raw_5fields_bytes: raw5fields,
  data_only_5field_ratio: Number((raw5fields / total5fields).toFixed(2)),
};
fs.writeFileSync(RECEIPT_FILE, JSON.stringify(receipt, null, 2));
console.log(`\nReceipt: ${RECEIPT_FILE}`);
