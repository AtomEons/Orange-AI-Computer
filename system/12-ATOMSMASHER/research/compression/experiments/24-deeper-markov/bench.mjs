// Experiment 24 — Deeper Markov: 2nd/3rd order + Markov on every small-vocab field
//
// Build on Exp 16 (1st-order action: 43.33× data-only). Now:
//   - 2nd-order Markov range coder on action col (theoretical bound 51.93×)
//   - 3rd-order Markov range coder on action col (theoretical bound 60.91×)
//   - Markov range coder on status (V=2), created_at (V=35), summary_template_id, payload_template_id
//   - Compare achieved bits/symbol to theoretical conditional entropy bounds

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const CORPUS = path.resolve(ROOT, '../../data/canonical-corpus.jsonl');
const RECEIPT_FILE = path.join(ROOT, 'RECEIPT.json');
const RESULT_FILE = path.join(ROOT, 'RESULT.md');

const corpusBytes = fs.readFileSync(CORPUS);
const corpusSha = crypto.createHash('sha256').update(corpusBytes).digest('hex');
const lines = corpusBytes.toString('utf8').split('\n').filter(Boolean);
const receipts = lines.map(l => JSON.parse(l));
const N = receipts.length;

const NUMBER_RE = /-?\d+(?:\.\d+)?(?:e-?\d+)?/g;
const PH = '';

function templatize(s) {
  if (s == null) return '\0NULL\0';
  return String(s).replace(NUMBER_RE, PH);
}

// Build sequences for each field
const seqs = {
  action: receipts.map(r => r.action),
  status: receipts.map(r => r.status),
  created_at: receipts.map(r => r.created_at),
  summary_tpl: receipts.map(r => templatize(r.summary)),
  payload_tpl: receipts.map(r => templatize(r.payload_json)),
};

console.log(`Field sequences:`);
for (const [name, seq] of Object.entries(seqs)) {
  const v = new Set(seq).size;
  console.log(`  ${name.padEnd(14)} V=${v.toString().padStart(5)}`);
}

// ── Compute conditional entropy at orders 0, 1, 2, 3 for each field ────────
function entropyAtOrder(seq, order) {
  // Build context → counts(next)
  const contexts = new Map();
  const ctxTotals = new Map();
  for (let i = order; i < seq.length; i++) {
    const ctx = seq.slice(i - order, i).join('\x00');
    const cur = seq[i];
    if (!contexts.has(ctx)) contexts.set(ctx, new Map());
    contexts.get(ctx).set(cur, (contexts.get(ctx).get(cur) || 0) + 1);
    ctxTotals.set(ctx, (ctxTotals.get(ctx) || 0) + 1);
  }
  let H = 0;
  const total = seq.length - order;
  for (const [ctx, m] of contexts) {
    const p_ctx = ctxTotals.get(ctx) / total;
    let H_local = 0;
    const tot = ctxTotals.get(ctx);
    for (const c of m.values()) {
      const p = c / tot;
      H_local -= p * Math.log2(p);
    }
    H += p_ctx * H_local;
  }
  return H;
}

console.log(`\n=== Conditional entropy bounds (bits/sym) ===`);
console.log(`${'field'.padEnd(14)} ${'H(X)'.padStart(8)} ${'H(X|1)'.padStart(8)} ${'H(X|2)'.padStart(8)} ${'H(X|3)'.padStart(8)} ${'ratio_floor'.padStart(12)}`);
const entropies = {};
let totalBitsLow = 0; // theoretical floor at 3rd order across all fields
for (const [name, seq] of Object.entries(seqs)) {
  const H0 = entropyAtOrder(seq, 0);
  const H1 = entropyAtOrder(seq, 1);
  const H2 = entropyAtOrder(seq, 2);
  const H3 = entropyAtOrder(seq, 3);
  entropies[name] = { H0, H1, H2, H3 };
  const rawBytes = seq.reduce((s, v) => s + String(v).length, 0) + seq.length;
  const boundBytes3 = Math.ceil(H3 * seq.length / 8);
  totalBitsLow += H3 * seq.length;
  const ratio = rawBytes / boundBytes3;
  console.log(`${name.padEnd(14)} ${H0.toFixed(3).padStart(8)} ${H1.toFixed(3).padStart(8)} ${H2.toFixed(3).padStart(8)} ${H3.toFixed(3).padStart(8)} ${ratio.toFixed(2).padStart(11)}x`);
}

const totalRawBytes = Object.values(seqs).reduce((s, seq) =>
  s + seq.reduce((t, v) => t + String(v).length, 0) + seq.length, 0);
const totalBytesAt3rdOrder = Math.ceil(totalBitsLow / 8);
console.log(`\nTotal raw field bytes:           ${totalRawBytes.toLocaleString()}`);
console.log(`Total at 3rd-order Markov floor: ${totalBytesAt3rdOrder.toLocaleString()}`);
console.log(`Combined Markov-3 floor ratio:   ${(totalRawBytes / totalBytesAt3rdOrder).toFixed(2)}x (across these fields)`);

// ── Range coder (same as Exp 16) ───────────────────────────────────────────
function lookup(m, k) { let v = m.get(k); if (v === undefined) { v = m.size; m.set(k, v); } return v; }
function arithmeticCode(symbols, V, cumFn) {
  const TOP = 0xFFFFFFFF >>> 0, HALF = 0x80000000 >>> 0, QTR = 0x40000000 >>> 0, TQTR = 0xC0000000 >>> 0;
  let low = 0, high = TOP, pending = 0;
  const outBits = [];
  function emit(b) { outBits.push(b); }
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
  return { nBits: outBits.length };
}

// Build Markov model + range-code each field, report achieved bits/symbol
function buildModelAtOrder(symbols, V, order) {
  // Context = previous `order` symbols joined; for i < order, use shorter context (or IID)
  const ctxCounts = new Map();
  const ctxTotals = new Map();
  for (let i = 0; i < symbols.length; i++) {
    const ctx = order === 0 || i < order ? '' : symbols.slice(i - order, i).join('\x00');
    const cur = symbols[i];
    if (!ctxCounts.has(ctx)) ctxCounts.set(ctx, new Map());
    ctxCounts.get(ctx).set(cur, (ctxCounts.get(ctx).get(cur) || 0) + 1);
    ctxTotals.set(ctx, (ctxTotals.get(ctx) || 0) + 1);
  }
  // Cumulative tables with Laplace +1 smoothing
  const cumByCtx = new Map();
  for (const [ctx, m] of ctxCounts) {
    const cum = new Array(V + 1).fill(0);
    for (let s = 0; s < V; s++) cum[s + 1] = cum[s] + ((m.get(s) || 0) + 1);
    cumByCtx.set(ctx, cum);
  }
  // Default IID cum for unseen contexts (Laplace start)
  const iidCum = new Array(V + 1).fill(0);
  for (let s = 0; s < V; s++) iidCum[s + 1] = iidCum[s] + 1;
  return { cumByCtx, iidCum };
}

console.log(`\n=== Range coder achieved bits/symbol per (field, order) ===`);
console.log(`${'field'.padEnd(14)} ${'order'.padStart(5)} ${'V'.padStart(5)} ${'bits/sym'.padStart(10)} ${'theoretical'.padStart(12)} ${'gap_%'.padStart(8)}`);
const results = {};
for (const [name, rawSeq] of Object.entries(seqs)) {
  // Build vocab + id sequence
  const vocab = new Map();
  for (const v of rawSeq) lookup(vocab, v);
  const V = vocab.size;
  const idSeq = rawSeq.map(v => vocab.get(v));
  results[name] = { V, by_order: {} };

  for (const order of [0, 1, 2, 3]) {
    if (order > 0 && order >= rawSeq.length) continue;
    const model = buildModelAtOrder(idSeq, V, order);
    const cumFn = (i, syms) => {
      if (order === 0 || i < order) return model.iidCum;
      const ctx = syms.slice(i - order, i).join('\x00');
      return model.cumByCtx.get(ctx) || model.iidCum;
    };
    const { nBits } = arithmeticCode(idSeq, V, cumFn);
    const bps = nBits / idSeq.length;
    const theory = entropies[name][`H${order}`];
    const gap = ((bps - theory) / Math.max(0.001, theory)) * 100;
    results[name].by_order[order] = { achieved_bps: Number(bps.toFixed(4)), theoretical_bps: Number(theory.toFixed(4)), gap_pct: Number(gap.toFixed(1)), n_bits: nBits };
    console.log(`${name.padEnd(14)} ${order.toString().padStart(5)} ${V.toString().padStart(5)} ${bps.toFixed(3).padStart(10)} ${theory.toFixed(3).padStart(12)} ${gap.toFixed(1).padStart(8)}`);
  }
}

// ── Compute combined bit budget at best order for each field ───────────────
console.log(`\n=== Best achieved combined bit cost across fields ===`);
let totalAchievedBits = 0;
for (const [name, info] of Object.entries(results)) {
  // Pick lowest-bps order for this field
  let best = null;
  for (const [order, r] of Object.entries(info.by_order)) {
    if (!best || r.achieved_bps < best.achieved_bps) best = { order, ...r };
  }
  console.log(`  ${name.padEnd(14)} best=order${best.order}, ${best.achieved_bps.toFixed(3)} bits/sym × ${seqs[name].length} = ${(best.achieved_bps * seqs[name].length / 8).toFixed(0)} B`);
  totalAchievedBits += best.achieved_bps * seqs[name].length;
}
const totalAchievedBytes = Math.ceil(totalAchievedBits / 8);
console.log(`\nTotal achieved bytes (sum of best-order per field): ${totalAchievedBytes.toLocaleString()}`);
console.log(`vs raw field bytes:                                  ${totalRawBytes.toLocaleString()}`);
console.log(`Combined deeper-Markov ratio:                        ${(totalRawBytes / totalAchievedBytes).toFixed(2)}x  (data-only, model overhead extra)`);

const receipt = {
  experiment: '24-deeper-markov',
  generated_at: new Date().toISOString(),
  corpus_sha256_in: corpusSha,
  field_entropies: entropies,
  field_range_coder_results: results,
  total_raw_field_bytes: totalRawBytes,
  total_3rd_order_floor_bytes: totalBytesAt3rdOrder,
  theoretical_3rd_order_combined_ratio: Number((totalRawBytes / totalBytesAt3rdOrder).toFixed(2)),
  total_achieved_combined_bytes: totalAchievedBytes,
  achieved_combined_data_ratio: Number((totalRawBytes / totalAchievedBytes).toFixed(2)),
};
fs.writeFileSync(RECEIPT_FILE, JSON.stringify(receipt, null, 2));
console.log(`\nReceipt: ${RECEIPT_FILE}`);
