// moe-gate.mjs — Orange5 as the GATING NETWORK of a heterogeneous MoE.
//
// ── THE REFRAME ──────────────────────────────────────────────────────────
// router-least-action.mjs asks "which model is cheapest that can do this?"
// That is a 1-of-N switch. It was correct when an expert was a text endpoint.
//
// A Mixture-of-Experts is not a switch. It is:
//     gate -> sparse activation of top-k -> weighted combine
// plus load balancing so no expert collapses, and specialization that EMERGES
// from routing pressure rather than being declared up front.
//
// The frontier models are already internally MoE. The layer that does not exist
// yet is the one ABOVE them: a heterogeneous MoE whose experts are not FFN
// blocks but entire SYSTEMS — model + tools + context + memory + failure profile.
//
// The operator already runs one of these BY HAND: Opus, Kimi, GPT, routed by
// human judgement. This module is that gate, made explicit and trainable.
//
// ── THE ROUTING OBJECTIVE (the part nobody does) ──────────────────────────
// Standard MoE routes on predicted competence. That is the wrong objective for
// a heterogeneous ensemble of near-peers.
//
// Observed, in this project's own chain: an external expert (GPT) caught three
// substantive errors that had passed every procedural gate. Not because it was
// more capable — on those tasks it was a peer. Because it was wrong DIFFERENTLY.
//
// So the objective is BLIND-SPOT DECORRELATION:
//     route to the expert set whose failure modes are least correlated
//     ON THIS CLAIM SHAPE
// Two strong experts that fail together are worth less than one strong and one
// that fails elsewhere. Redundant competence catches nothing.
//
// ── THE AUXILIARY LOSS (the part that makes it trainable, free) ───────────
// A real MoE trains its gate with an aux loss. This one has a better signal than
// most systems ever get: the receipt chain. Every superseded receipt is a labeled
// example — this expert, this claim shape, was WRONG, and here is what corrected
// it. Hash-chained, auditable, owned outright, costing nothing to collect.
//
// The system's scar tissue is the gradient.

export const MOE_GATE_SCHEMA_ID = 'orange5.moe-gate.v1';

// ─────────────────────────────────────────────────────────────────────────
// EXPERT — a whole system, not a model name.
// ─────────────────────────────────────────────────────────────────────────
export function defineExpert({
  id, model, tools = [], contextWindow = null, modality = ['text'],
  costPerCall = 1, latencyMs = null,
  // failure profile: known biases. Seeded from doctrine, then CORRECTED by the
  // chain — measured supersession always overrides the declared prior.
  failureProfile = {},
  strengths = [], available = true,
}) {
  return {
    id, model, tools, contextWindow, modality, costPerCall, latencyMs,
    failureProfile, strengths, available,
  };
}

// Failure-mode axes. Two experts sharing an axis fail together and pairing them
// buys little. These are the axes on which THIS project actually got burned.
export const FAILURE_AXES = Object.freeze([
  'overclaims_on_small_n',      // absolute language at tiny sample
  'misses_selection_leakage',   // scores on the samples used to select
  'misses_confounds',           // attributes to category what scene explains
  'anchors_on_own_prior',       // defends a previous position past its evidence
  'sycophantic_to_operator',    // agrees because asked, not because true
  'context_truncation',         // silently drops the middle of long input
  'tool_result_overtrust',      // treats a tool result as ground truth
  'premature_convergence',      // stops exploring once one story fits
]);

/**
 * correlation(a, b) — how similarly two experts fail. 0 = independent, 1 = twins.
 * Jaccard over failure axes weighted by declared severity.
 */
export function failureCorrelation(a, b) {
  const aKeys = Object.keys(a.failureProfile || {});
  const bKeys = Object.keys(b.failureProfile || {});
  // An expert with NO declared profile must not appear perfectly decorrelated from
  // everyone — that would make "declare nothing" the winning strategy and the gate
  // would preferentially route to the least-characterised expert. Unknown is 0.5,
  // never 0. Ignorance is not evidence of independence.
  if (aKeys.length === 0 || bKeys.length === 0) return 0.5;
  const axes = new Set([...aKeys, ...bKeys]);
  let shared = 0, total = 0;
  for (const ax of axes) {
    const va = a.failureProfile?.[ax] ?? 0;
    const vb = b.failureProfile?.[ax] ?? 0;
    shared += Math.min(va, vb);
    total += Math.max(va, vb);
  }
  return total > 0 ? shared / total : 0;
}

/**
 * calibrationFromChain(chain, expertId, shapeKey)
 * Measured competence of an expert on a claim shape, learned from supersession.
 * This is the aux loss. No corpus, no labels bought — the chain already has them.
 */
export function calibrationFromChain(chain, expertId, shapeKey) {
  let total = 0, superseded = 0;
  const supersededSeqs = new Set();
  for (const r of chain) for (const s of (r.supersedes || [])) supersededSeqs.add(s);
  for (const r of chain) {
    if (r.expert_id !== expertId) continue;
    if (shapeKey && r.claim_shape !== shapeKey) continue;
    total++;
    if (supersededSeqs.has(r.seq)) superseded++;
  }
  if (total === 0) return { competence: null, n: 0, superseded: 0, source: 'no_history' };
  const rate = superseded / total;
  // Shrink toward 0.5 when evidence is thin — do not trust 1-of-1.
  const confidence = Math.min(1, total / 10);
  const competence = 0.5 + (1 - rate - 0.5) * confidence;
  return { competence, n: total, superseded, supersessionRate: rate, source: 'chain' };
}

/**
 * gate({ claimShape, order, experts, chain, k, budget })
 *
 * Sparse top-k activation over expert SYSTEMS, selected for decorrelated failure
 * rather than for redundant competence.
 */
export function gate({
  claimShape = null, order = {}, experts = [], chain = [],
  k = 2, budget = Infinity, requireDecorrelation = true,
} = {}) {
  const pool = experts.filter(e => e.available !== false);
  if (pool.length === 0) {
    return { schema: MOE_GATE_SCHEMA_ID, selected: [], reason: 'no available experts', degraded: true };
  }

  // 1. Score each expert's measured competence on THIS claim shape.
  const scored = pool.map(e => {
    const cal = calibrationFromChain(chain, e.id, claimShape);
    // Declared strengths are a weak prior; measured chain history dominates.
    const declaredFit = (e.strengths || []).some(s => String(order.action || '').includes(s)) ? 0.08 : 0;
    const competence = cal.competence == null ? 0.5 + declaredFit : cal.competence + declaredFit;
    return { expert: e, competence, calibration: cal };
  }).sort((a, b) => b.competence - a.competence);

  // 2. Take the strongest as the anchor.
  const selected = [scored[0]];
  let spend = scored[0].expert.costPerCall;

  // 3. Fill remaining slots by DECORRELATION, not by next-best competence.
  //    An expert that fails where the anchor fails adds confirmation, not coverage.
  while (selected.length < k && selected.length < scored.length) {
    let best = null, bestScore = -Infinity;
    for (const cand of scored) {
      if (selected.some(s => s.expert.id === cand.expert.id)) continue;
      if (spend + cand.expert.costPerCall > budget) continue;
      const maxCorr = Math.max(...selected.map(s => failureCorrelation(s.expert, cand.expert)));
      // decorrelation dominates; competence breaks ties
      const score = requireDecorrelation
        ? (1 - maxCorr) * 0.7 + cand.competence * 0.3
        : cand.competence;
      if (score > bestScore) { bestScore = score; best = { ...cand, decorrelation: 1 - maxCorr, gateScore: score }; }
    }
    if (!best) break;
    selected.push(best);
    spend += best.expert.costPerCall;
  }

  // 4. Combine weights — normalized measured competence.
  const totalComp = selected.reduce((s, x) => s + Math.max(0.01, x.competence), 0);
  const combine = selected.map(x => ({
    expertId: x.expert.id,
    weight: Math.max(0.01, x.competence) / totalComp,
    competence: x.competence,
    calibration: x.calibration,
    decorrelation: x.decorrelation ?? null,
  }));

  const pairCorrelation = selected.length > 1
    ? failureCorrelation(selected[0].expert, selected[1].expert) : null;

  return {
    schema: MOE_GATE_SCHEMA_ID,
    selected: selected.map(s => s.expert.id),
    combine,
    k: selected.length,
    claimShape,
    pairCorrelation,
    estimatedCost: spend,
    reason: selected.length > 1
      ? `anchor ${selected[0].expert.id} (competence ${selected[0].competence.toFixed(2)}) + decorrelated peer ${selected[1].expert.id} (failure correlation ${pairCorrelation?.toFixed(2)})`
      : `single expert ${selected[0].expert.id}; no decorrelated peer within budget`,
    degraded: selected.length < k,
  };
}

/**
 * loadBalance(chain, experts, window)
 * Classic MoE aux loss: prevent expert collapse. If routing concentrates, the
 * ensemble silently degenerates into the monolith it was meant to replace, and
 * the decorrelation benefit vanishes without any error being raised.
 */
export function loadBalance(chain = [], experts = [], window = 50) {
  const recent = chain.slice(-window);
  const counts = new Map(experts.map(e => [e.id, 0]));
  let attributed = 0;
  for (const r of recent) {
    if (r.expert_id && counts.has(r.expert_id)) { counts.set(r.expert_id, counts.get(r.expert_id) + 1); attributed++; }
  }
  if (attributed === 0) {
    return { balanced: true, note: 'no expert-attributed receipts in window', counts: Object.fromEntries(counts), attributed: 0 };
  }
  const ideal = attributed / experts.length;
  const rows = [...counts.entries()].map(([id, n]) => ({ id, n, share: n / attributed, deviation: (n - ideal) / ideal }));
  const collapsed = rows.filter(r => r.n === 0);
  const dominant = rows.filter(r => r.share > 0.7);
  return {
    balanced: collapsed.length === 0 && dominant.length === 0,
    counts: Object.fromEntries(counts), attributed, idealPerExpert: ideal, rows,
    collapsed: collapsed.map(r => r.id),
    dominant: dominant.map(r => r.id),
    warning: dominant.length > 0
      ? `expert ${dominant[0].id} took ${(dominant[0].share * 100).toFixed(0)}% of recent routes — ensemble is collapsing toward a monolith and decorrelation coverage is being lost`
      : collapsed.length > 0
        ? `expert(s) ${collapsed.map(r => r.id).join(', ')} never routed — specialization cannot emerge without traffic`
        : null,
  };
}

/**
 * auxLoss(chain, experts)
 * The training signal, stated plainly: per-expert supersession by claim shape.
 * This is what a gate would be fit against. Free, owned, auditable.
 */
export function auxLoss(chain = [], experts = []) {
  const supersededSeqs = new Set();
  for (const r of chain) for (const s of (r.supersedes || [])) supersededSeqs.add(s);

  const cells = new Map();
  for (const r of chain) {
    if (!r.expert_id) continue;
    const key = `${r.expert_id}|${r.claim_shape || 'unknown'}`;
    if (!cells.has(key)) cells.set(key, { expert: r.expert_id, shape: r.claim_shape || 'unknown', total: 0, wrong: 0 });
    const c = cells.get(key);
    c.total++;
    if (supersededSeqs.has(r.seq)) c.wrong++;
  }
  const rows = [...cells.values()].map(c => ({ ...c, loss: c.total > 0 ? c.wrong / c.total : 0 }))
    .sort((a, b) => b.loss - a.loss || b.total - a.total);
  const labeled = rows.reduce((s, r) => s + r.total, 0);
  return {
    schema: MOE_GATE_SCHEMA_ID,
    labeledExamples: labeled,
    cells: rows,
    meanLoss: rows.length ? rows.reduce((s, r) => s + r.loss, 0) / rows.length : null,
    note: labeled === 0
      ? 'chain carries no expert_id attribution yet — add expert_id + claim_shape to receipts and this becomes a live training signal at zero collection cost'
      : `${labeled} labeled examples available from own history`,
  };
}

export const __moeInternals = Object.freeze({ failureCorrelation, calibrationFromChain });
