// Experiment 100 — Field-pair conditional entropy table.
// For every field pair (A, B) in receipts, compute H(B | A, action).
// Identify pairs where H(B | A, action) ≈ 0 — deterministic dependencies.
// Output top-20 lowest-entropy pairs (high mutual info / strong derivability).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const CORPUS = path.resolve(ROOT, '../../data/canonical-corpus.jsonl');
const SEED = 'orange5-receipt-stream-v1';

const corpusBytes = fs.readFileSync(CORPUS);
const lines = corpusBytes.toString('utf8').split('\n').filter(Boolean);
const receipts = lines.map(l => JSON.parse(l));
function detId(s, i) { return 'rcpt_' + crypto.createHash('sha256').update(s + '||' + i).digest('hex').slice(0, 16); }
const detReceipts = receipts.map((r, i) => ({ ...r, id: detId(SEED, i) }));
console.log(`Receipts: ${detReceipts.length}`);

// Flatten each receipt into a field map: top-level + parsed payload_json shallow fields.
function flatten(r) {
  const m = new Map();
  m.set('id', r.id);
  m.set('action', r.action);
  m.set('status', r.status);
  m.set('summary', r.summary);
  m.set('created_at', r.created_at);
  m.set('payload_json', r.payload_json);
  if (r.payload_json) {
    try {
      const p = JSON.parse(r.payload_json);
      if (p && typeof p === 'object' && !Array.isArray(p)) {
        for (const [k, v] of Object.entries(p)) {
          m.set('payload.' + k, v === null || typeof v === 'object' ? JSON.stringify(v) : String(v));
        }
      }
    } catch { /* not json */ }
  }
  return m;
}

const flats = detReceipts.map(flatten);
// Discover field set
const fields = new Set();
for (const m of flats) for (const k of m.keys()) fields.add(k);
const fieldList = [...fields].sort();
console.log(`Discovered fields (n=${fieldList.length}): ${fieldList.join(', ')}`);

// For each receipt, ensure missing fields map to a sentinel "<MISSING>"
const MISSING = '\0MISSING\0';
function getOr(m, k) { return m.has(k) ? (m.get(k) === null ? '\0NULL\0' : m.get(k)) : MISSING; }

// Compute H(B | A, action) for every ordered pair A != B (not 'action' as B is allowed; but we condition on action always).
// pair-key context = action || \x1f || A; outcome = B.
const totalRows = flats.length;

function H_BconditionedOn_A_and_action(A, B) {
  // Build map ctx -> { sum, outcomes: Map(outcomeStr -> cnt) }
  const ctxMap = new Map();
  for (let i = 0; i < totalRows; i++) {
    const m = flats[i];
    const act = String(getOr(m, 'action'));
    const a = String(getOr(m, A));
    const b = String(getOr(m, B));
    const ctx = act + '\x1f' + a;
    let e = ctxMap.get(ctx);
    if (!e) { e = { sum: 0, outcomes: new Map() }; ctxMap.set(ctx, e); }
    e.sum++;
    e.outcomes.set(b, (e.outcomes.get(b) || 0) + 1);
  }
  let H = 0;
  for (const e of ctxMap.values()) {
    const pc = e.sum / totalRows;
    let Hbc = 0;
    for (const cnt of e.outcomes.values()) {
      const pxc = cnt / e.sum;
      Hbc -= pxc * Math.log2(pxc);
    }
    H += pc * Hbc;
  }
  return { H_bits: H, contexts: ctxMap.size };
}

// Cardinality of B in the corpus (size of outcome space)
function uniqueCount(field) {
  const s = new Set();
  for (const m of flats) s.add(String(getOr(m, field)));
  return s.size;
}
const cardB = new Map();
for (const f of fieldList) cardB.set(f, uniqueCount(f));

// H(B) unconditional
function H_unconditional(B) {
  const cnt = new Map();
  for (const m of flats) {
    const b = String(getOr(m, B));
    cnt.set(b, (cnt.get(b) || 0) + 1);
  }
  let H = 0;
  for (const c of cnt.values()) {
    const p = c / totalRows;
    H -= p * Math.log2(p);
  }
  return H;
}
const Hb_uncond = new Map();
for (const f of fieldList) Hb_uncond.set(f, H_unconditional(f));

console.log('\nUnconditional H(field) and cardinality:');
for (const f of fieldList) console.log(`  ${f}: card=${cardB.get(f)}, H=${Hb_uncond.get(f).toFixed(4)} bits`);

// Pair sweep
const pairs = [];
for (const A of fieldList) {
  for (const B of fieldList) {
    if (A === B) continue;
    // Skip pairs where B has only 1 unique value (already trivially predictable, H_uncond=0)
    if (cardB.get(B) <= 1) continue;
    const { H_bits, contexts } = H_BconditionedOn_A_and_action(A, B);
    const Hb = Hb_uncond.get(B);
    const mi = Math.max(0, Hb - H_bits);
    pairs.push({ A, B, H_B_given_A_action: H_bits, H_B_uncond: Hb, mutual_info: mi, mi_reduction_pct: Hb > 0 ? (mi/Hb*100) : 0, contexts });
  }
}
// Sort by H_B_given_A_action ascending (most deterministic first), break ties by higher MI reduction
pairs.sort((x, y) => x.H_B_given_A_action - y.H_B_given_A_action || y.mi_reduction_pct - x.mi_reduction_pct);

const TOP = 20;
console.log(`\nTop ${TOP} lowest-entropy pairs (H(B | A, action)) — candidates for derivable-field elimination:`);
console.log('rank | A → B | H(B|A,act) | H(B) | MI red% | contexts');
const top = pairs.slice(0, TOP);
for (let i = 0; i < top.length; i++) {
  const p = top[i];
  console.log(`${String(i+1).padStart(2)}  | ${p.A} → ${p.B} | ${p.H_B_given_A_action.toFixed(4)} | ${p.H_B_uncond.toFixed(4)} | ${p.mi_reduction_pct.toFixed(1)}% | ${p.contexts}`);
}

// Identify zero-entropy pairs (truly deterministic)
const zeroPairs = pairs.filter(p => p.H_B_given_A_action < 1e-9);
console.log(`\nZero-entropy (deterministic) pairs: ${zeroPairs.length}`);

const summary = {
  experiment: '100-field-pair-entropy',
  receipts: totalRows,
  fields: fieldList,
  field_cardinality: Object.fromEntries(cardB),
  H_unconditional: Object.fromEntries([...Hb_uncond].map(([k,v]) => [k, Number(v.toFixed(4))])),
  top_20_lowest_conditional_entropy: top.map(p => ({
    A: p.A, B: p.B,
    H_B_given_A_action_bits: Number(p.H_B_given_A_action.toFixed(6)),
    H_B_uncond_bits: Number(p.H_B_uncond.toFixed(4)),
    mutual_info_bits: Number(p.mutual_info.toFixed(4)),
    mi_reduction_pct: Number(p.mi_reduction_pct.toFixed(2)),
    contexts: p.contexts,
  })),
  deterministic_pairs_zero_entropy_count: zeroPairs.length,
  deterministic_pairs: zeroPairs.map(p => ({ A: p.A, B: p.B, contexts: p.contexts })),
  top_3_derivable: top.slice(0, 3).map(p => `${p.A}→${p.B}`),
};
fs.writeFileSync(path.join(ROOT, 'summary.json'), JSON.stringify(summary, null, 2));
console.log('\nWrote summary.json');
