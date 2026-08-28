// belief-outcome.mjs — the Schism ledger read as a self-labelling corpus.
//
// THE IDEA
// THE_PATH §Phase-5 states the loop as: "surface the prior mistake BEFORE
// execution." That is the retrieval half. This is the other half, and it is
// bigger than the name suggests:
//
//     A Thought record at t0 that shares a topic surface with a self-verified
//     Reality record at t1 > t0 IS a labelled training example. Belief on the
//     left, outcome on the right, and the label was written by the world.
//
// Nobody annotated it. No reward model was trained. Time did the labelling as
// a byproduct of the operator doing his work. And because lane is assigned by
// ORIGIN (AE_COBRA_FOUNDATION_SPEC.md Pillar 2), a model cannot forge the
// right-hand side. That is a property RLHF does not have: the thing being
// graded cannot author its own grade.
//
// WHAT IT YIELDS
//   1. calibration()       — when this class of claim says "ok", how often did
//                            Reality agree? A measured curve, not a vibe.
//   2. expertCalibration() — the same per expert_id. This is the MoE routing
//                            signal that beats a declared competence profile:
//                            moe-gate.mjs currently scores experts on failure
//                            profiles that were HAND-DECLARED. Those are
//                            guesses. Confirmation rate is a measurement.
//   3. unverifiedClaims()  — beliefs that never met an outcome. Not failures;
//                            open exposure. The negative space.
//
// HONESTY (this is a heuristic, and saying so is the point)
//   * Pairing is by shared topic tokens + time order. It CAN mispair. Every
//     pair therefore carries its shared_tokens and a pairing score so a human
//     can audit any single verdict. This module never calls a pairing "proof."
//   * self_verified:false Reality (operator-reported, per reality-source.mjs)
//     is EXCLUDED by default. Include it only with an explicit flag, because a
//     model could otherwise influence its own grade through that channel.
//   * Small N is reported as small N. Every rate carries a Wilson 95% interval
//     and `sufficient:false` below minSample. A rate over 3 samples is noise
//     and this module says so rather than printing a confident number.
//
// Bun only. No deps. Offline-safe: an empty or missing ledger yields empty
// results and an explicit reason, never a throw and never a fabricated rate.

import { readFlux } from '../06-ORANGELLM/memory/ae-cobra/flux/reader.mjs';
import { _internal as RECALL } from '../06-ORANGELLM/memory/ae-cobra/recall-engine.mjs';

// Reuse the recall engine's tokenizer verbatim. If this module tokenised
// differently, "same topic" would mean two different things in one system.
const { recordTokens, bodyText, sharedCount } = RECALL;

export const SCHEMA = 'orange5.belief-outcome.v1';
const DAY_MS = 86_400_000;

/** Verdicts a belief/outcome pair can carry. */
export const VERDICT = Object.freeze({
  CONFIRMED: 'CONFIRMED',       // belief matched what Reality later showed
  CONTRADICTED: 'CONTRADICTED', // belief claimed success; Reality showed failure (or vice versa)
  UNRESOLVED: 'UNRESOLVED',     // no self-verified outcome ever met this belief
});

// ---------------------------------------------------------------------------
// Wilson score interval — the honest interval at small N. A naive p̂ over 4
// samples reads as certainty; Wilson does not.
// ---------------------------------------------------------------------------
export function wilson(successes, n, z = 1.96) {
  if (!n) return { p: null, lo: null, hi: null, n: 0 };
  const p = successes / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const m = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
  return { p, lo: Math.max(0, (c - m) / d), hi: Math.min(1, (c + m) / d), n };
}

// ---------------------------------------------------------------------------
// Claim reading. A Thought record asserts something about how a thing went.
// We read the assertion WITHOUT trusting it — that is the whole exercise.
// ---------------------------------------------------------------------------
function claimedSuccess(rec) {
  const b = rec?.body ?? {};
  if (b.is_mistake === true || b.overall_ok === false) return false;
  const s = String(b.status ?? '').toLowerCase();
  if (['error', 'halted', 'failed', 'fail', 'red'].includes(s)) return false;
  if (['ok', 'success', 'passed', 'green', 'planned'].includes(s)) return true;
  return null; // no claim about outcome — not a scorable belief
}

/** Did the world show success? Only ever read from a Reality record. */
function observedSuccess(rec) {
  const b = rec?.body ?? {};
  if (typeof b.passed === 'boolean') return b.passed;
  if (b.overall_ok === false || b.is_mistake === true) return false;
  if (typeof b.exit_code === 'number') return b.exit_code === 0;
  if (typeof b.missing_count === 'number') return b.missing_count === 0;
  if (/fail|missing|error/i.test(String(rec?.kind ?? ''))) return false;
  if (/pass|present/i.test(String(rec?.kind ?? ''))) return true;
  return null;
}

/** The class a belief belongs to — the unit calibration is computed over. */
function claimClass(rec) {
  const b = rec?.body ?? {};
  if (typeof b.action === 'string' && b.action) return b.action;
  const kind = String(rec?.kind ?? '');
  const colon = kind.indexOf(':');
  return colon >= 0 ? kind.slice(colon + 1) : (kind || 'unknown');
}

// ---------------------------------------------------------------------------
// PAIRING — the core operation.
// ---------------------------------------------------------------------------
/**
 * Join Thought beliefs to the self-verified Reality outcomes that later met them.
 *
 * @param {string}  a.fluxRoot
 * @param {number} [a.minShared=2]        topic tokens two records must share
 * @param {number} [a.windowMs=14d]       how long a belief stays open for an outcome
 * @param {boolean}[a.includeUnverified]  allow self_verified:false Reality (default false)
 * @param {number} [a.nowMs]
 */
export function pairBeliefsWithOutcomes({
  fluxRoot, minShared = 2, windowMs = 14 * DAY_MS,
  includeUnverified = false, nowMs = Date.now(), lookbackMs = 365 * DAY_MS,
} = {}) {
  const startMs = nowMs - lookbackMs;
  let beliefs = [], outcomes = [];
  try {
    beliefs = readFlux({ fluxRoot, lane: 'thought', startMs, endMs: nowMs });
    outcomes = readFlux({ fluxRoot, lane: 'reality', startMs, endMs: nowMs });
  } catch { /* offline-safe */ }

  const usable = outcomes.filter((r) => {
    if (!includeUnverified && r?.body?.self_verified !== true) return false;
    return observedSuccess(r) !== null;
  });

  // Pre-tokenise once. O(B·R) on a Night-1 ledger is fine (<100k records);
  // when the ledger grows past that, the binary .idx sidecar is the upgrade.
  const outTok = usable.map((r) => ({ rec: r, toks: recordTokens(r) }));

  const pairs = [];
  for (const belief of beliefs) {
    const claim = claimedSuccess(belief);
    if (claim === null) continue;               // asserts nothing scorable
    const bt = recordTokens(belief);
    if (bt.size === 0) continue;

    let best = null;
    for (const o of outTok) {
      if (o.rec.ts <= belief.ts) continue;                 // outcome must FOLLOW belief
      if (o.rec.ts - belief.ts > windowMs) continue;       // and land inside the window
      const shared = sharedCount(bt, o.toks);
      if (shared < minShared) continue;
      // earliest qualifying outcome wins; ties break on stronger overlap
      if (!best || o.rec.ts < best.rec.ts || (o.rec.ts === best.rec.ts && shared > best.shared)) {
        best = { rec: o.rec, shared, toks: o.toks };
      }
    }

    if (!best) {
      pairs.push({
        verdict: VERDICT.UNRESOLVED,
        class: claimClass(belief),
        belief: { ts: belief.ts, hash: belief.hash, origin: belief.origin, text: bodyText(belief), claimed: claim, expert_id: belief?.body?.expert_id ?? null },
        outcome: null, shared_tokens: [], pairing_score: 0,
      });
      continue;
    }

    const observed = observedSuccess(best.rec);
    const sharedToks = [...bt].filter((t) => best.toks.has(t)).sort().slice(0, 12);
    pairs.push({
      verdict: claim === observed ? VERDICT.CONFIRMED : VERDICT.CONTRADICTED,
      class: claimClass(belief),
      belief: { ts: belief.ts, hash: belief.hash, origin: belief.origin, text: bodyText(belief), claimed: claim, expert_id: belief?.body?.expert_id ?? null },
      outcome: { ts: best.rec.ts, hash: best.rec.hash, origin: best.rec.origin, kind: best.rec.kind, text: bodyText(best.rec), observed, self_verified: best.rec?.body?.self_verified === true },
      shared_tokens: sharedToks,
      // Reported so a human can audit any single verdict. NOT a probability.
      pairing_score: Number((best.shared / Math.max(1, Math.min(bt.size, best.toks.size))).toFixed(3)),
      lag_ms: best.rec.ts - belief.ts,
    });
  }

  pairs.sort((a, b) => a.belief.ts - b.belief.ts);
  return {
    schema: SCHEMA,
    beliefsScanned: beliefs.length,
    outcomesUsable: usable.length,
    outcomesTotal: outcomes.length,
    pairs,
    pairingMethod: `shared topic tokens >= ${minShared}, earliest outcome within ${Math.round(windowMs / DAY_MS)}d`,
    caveat: 'Pairing is heuristic. Audit any verdict via its shared_tokens and both record hashes before acting on it.',
    ...(usable.length === 0 ? { blocked: outcomes.length === 0 ? 'REALITY_LANE_EMPTY' : 'NO_SELF_VERIFIED_OUTCOMES' } : {}),
  };
}

// ---------------------------------------------------------------------------
// CALIBRATION — the measured curve.
// ---------------------------------------------------------------------------
/**
 * Per-class confirmation rate. `sufficient:false` below minSample — a rate over
 * three samples is noise, and printing it without that flag would be theatre.
 */
export function calibration({ minSample = 8, staleLagMs = 2 * DAY_MS, ...opts } = {}) {
  const paired = pairBeliefsWithOutcomes(opts);

  // ── The independence correction ──────────────────────────────────────────
  // 23 beliefs graded by ONE observation is not 23 trials. Wilson over the
  // belief count would imply an evidence base that does not exist. We therefore
  // carry TWO numbers, because they answer two different questions:
  //
  //   beliefRate  — of the claims made, what share did the world confirm?
  //                 (a fact about the CLAIMS; n = beliefs)
  //   evidenceCI  — how confident may we be about the WORLD?
  //                 (n = DISTINCT outcome records; never more than we observed)
  //
  // Collapsing these was the defect this correction exists to prevent.
  // ─────────────────────────────────────────────────────────────────────────
  const summarise = (pairs) => {
    const resolved = pairs.filter((p) => p.verdict !== VERDICT.UNRESOLVED);
    const confirmed = resolved.filter((p) => p.verdict === VERDICT.CONFIRMED).length;
    const n = resolved.length;

    // distinct outcome records actually consulted
    const outcomeHashes = new Set(resolved.map((p) => p.outcome?.hash).filter(Boolean));
    const distinct = outcomeHashes.size;

    // per distinct outcome: did the beliefs it graded agree with it?
    const byOutcome = new Map();
    for (const p of resolved) {
      const h = p.outcome?.hash; if (!h) continue;
      const e = byOutcome.get(h) ?? { confirmed: 0, total: 0 };
      e.total++; if (p.verdict === VERDICT.CONFIRMED) e.confirmed++;
      byOutcome.set(h, e);
    }
    // one vote per outcome — majority of the beliefs it graded
    const outcomeVotes = [...byOutcome.values()].filter((e) => e.confirmed * 2 > e.total).length;

    const beliefW = wilson(confirmed, n);
    const evidenceW = wilson(outcomeVotes, distinct);
    const reuse = distinct ? n / distinct : 0;
    const lags = resolved.map((p) => p.lag_ms ?? 0).sort((a, b) => a - b);
    const medianLagMs = lags.length ? lags[Math.floor(lags.length / 2)] : 0;

    return {
      n, confirmed, contradicted: n - confirmed,
      beliefRate: beliefW.p,
      beliefCI95: [beliefW.lo, beliefW.hi],
      distinctOutcomes: distinct,
      outcomeReuse: Number(reuse.toFixed(2)),
      independent: reuse <= 1.5,
      evidenceCI95: [evidenceW.lo, evidenceW.hi],
      medianLagMs,
      stale: medianLagMs > staleLagMs,
      // A rate is trustworthy only when there is enough INDEPENDENT evidence.
      sufficient: distinct >= minSample,
    };
  };

  const byClass = new Map();
  for (const p of paired.pairs) {
    if (p.verdict === VERDICT.UNRESOLVED) continue;
    (byClass.get(p.class) ?? byClass.set(p.class, []).get(p.class)).push(p);
  }
  const classes = [...byClass.entries()]
    .map(([cls, pairs]) => ({ class: cls, ...summarise(pairs) }))
    .sort((a, b) => b.n - a.n || a.class.localeCompare(b.class));

  const overall = summarise(paired.pairs);
  const resolved = overall.n;

  const warnings = [];
  if (!overall.independent && resolved > 0) {
    warnings.push(`OUTCOME_REUSE: ${resolved} belief(s) graded by only ${overall.distinctOutcomes} distinct observation(s) (reuse ${overall.outcomeReuse}×). beliefRate describes the claims; it is NOT ${resolved} independent trials. Judge confidence by evidenceCI95.`);
  }
  if (overall.stale) {
    warnings.push(`STALE_PAIRING: median lag ${Math.round(overall.medianLagMs / DAY_MS)}d between belief and outcome. The system may have changed in between; a distant outcome is weak evidence about an old belief.`);
  }
  if (resolved > 0 && overall.distinctOutcomes < minSample) {
    warnings.push(`THIN_EVIDENCE: ${overall.distinctOutcomes} distinct observation(s), need ${minSample} to calibrate. Run more observers.`);
  }

  return {
    schema: SCHEMA,
    overall,
    classes,
    resolved,
    unresolved: paired.pairs.length - resolved,
    beliefsScanned: paired.beliefsScanned,
    outcomesUsable: paired.outcomesUsable,
    minSample,
    warnings,
    ...(paired.blocked ? { blocked: paired.blocked } : {}),
    verdict: paired.blocked
      ? 'NOT_YET_MEASURABLE — the Reality lane has no self-verified outcomes to grade beliefs against.'
      : overall.sufficient
        ? 'MEASURED'
        : `INSUFFICIENT_EVIDENCE — ${resolved} belief(s) but only ${overall.distinctOutcomes} distinct observation(s); need ${minSample}. Findings reported, rate NOT calibrated.`,
  };
}

/**
 * The MoE routing signal. Confirmation rate per expert_id, measured on this
 * operator's own work, updated every time an observer runs — no training run.
 *
 * moe-gate.mjs currently scores experts on failure profiles that were declared
 * by hand. This replaces a guess with a measurement. Experts below minSample
 * are returned with `sufficient:false` and MUST NOT be routed on yet.
 */
export function expertCalibration({ minSample = 8, ...opts } = {}) {
  const paired = pairBeliefsWithOutcomes(opts);
  const byExpert = new Map();
  for (const p of paired.pairs) {
    const id = p.belief.expert_id;
    if (!id || p.verdict === VERDICT.UNRESOLVED) continue;
    const e = byExpert.get(id) ?? { expert_id: id, confirmed: 0, contradicted: 0, classes: new Set(), outcomes: new Set() };
    if (p.verdict === VERDICT.CONFIRMED) e.confirmed++; else e.contradicted++;
    e.classes.add(p.class);
    if (p.outcome?.hash) e.outcomes.add(p.outcome.hash);
    byExpert.set(id, e);
  }
  const experts = [...byExpert.values()].map((e) => {
    const n = e.confirmed + e.contradicted;
    const distinct = e.outcomes.size;
    const w = wilson(e.confirmed, n);
    // Sufficiency is judged on DISTINCT observations, never on belief count.
    // An expert that asserted the same thing 40 times, checked once, has n=1
    // of evidence. Routing on 40 would be routing on an echo.
    const sufficient = distinct >= minSample;
    return {
      expert_id: e.expert_id,
      n, confirmed: e.confirmed, contradicted: e.contradicted,
      distinctOutcomes: distinct,
      outcomeReuse: distinct ? Number((n / distinct).toFixed(2)) : 0,
      confirmationRate: w.p, ci95: [w.lo, w.hi],
      classes: [...e.classes].sort(),
      sufficient,
      // Route on the Wilson LOWER bound over DISTINCT evidence — never the
      // point estimate, never the belief count. An expert with 3/3 must not
      // outrank one with 40/44, and one echo repeated 40× must not outrank
      // 40 real checks.
      routingScore: sufficient ? wilson(e.confirmed, distinct).lo : null,
    };
  }).sort((a, b) => (b.routingScore ?? -1) - (a.routingScore ?? -1) || b.distinctOutcomes - a.distinctOutcomes);

  const echoed = experts.filter((e) => e.outcomeReuse > 1.5);
  return {
    schema: SCHEMA, experts,
    routable: experts.filter((e) => e.sufficient).length,
    minSample,
    note: 'routingScore is the Wilson lower bound over DISTINCT observations. Belief count never sets sufficiency — repeating a claim is not evidence for it.',
    ...(echoed.length ? { warning: `OUTCOME_REUSE on ${echoed.map((e) => e.expert_id).join(', ')} — these experts' claims were graded by few distinct observations. Do not route on them yet.` } : {}),
    ...(paired.blocked ? { blocked: paired.blocked } : {}),
  };
}

/**
 * Beliefs that never met an outcome. Not failures — open exposure. This is the
 * negative space: things asserted that the world was never asked to confirm.
 */
export function unverifiedClaims({ limit = 50, ...opts } = {}) {
  const paired = pairBeliefsWithOutcomes(opts);
  const open = paired.pairs
    .filter((p) => p.verdict === VERDICT.UNRESOLVED)
    .sort((a, b) => b.belief.ts - a.belief.ts)
    .slice(0, limit);
  return {
    schema: SCHEMA,
    count: open.length,
    totalBeliefs: paired.beliefsScanned,
    claims: open.map((p) => ({
      ts: p.belief.ts, when: new Date(p.belief.ts).toISOString(),
      class: p.class, origin: p.belief.origin, text: p.belief.text,
      claimed: p.belief.claimed, hash: p.belief.hash,
    })),
    note: 'An unverified claim is not a wrong claim. It is a claim nothing has checked.',
  };
}
