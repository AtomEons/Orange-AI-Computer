// recall-confidence.mjs — Æ Cobra recall-ext #6: confidence score on a recall answer.
//
// WHY. Every other recall surface returns FACTS (events, threads, clusters) but
// says nothing about how much to TRUST the answer. A recall built on a single
// stale thought-lane guess deserves less trust than one corroborated by three
// recent reality receipts. Mom's Law forbids fake-green: an answer should carry
// an honest confidence so the operator (and the spine) know when to lean on it
// and when to go verify. This module computes that confidence.
//
// WHAT IT SCORES. Given a recall RESULT (the object any engine/ext function
// returned) plus the records it was drawn from, confidence ∈ [0,1] is a bounded
// blend of deterministic evidence signals:
//   * EVIDENCE      more supporting records → higher (saturating, diminishing)
//   * GROUND-TRUTH  reality-lane support outweighs thought-lane (spec: reality
//                   overrides thought); a reality-only answer is firmer than a
//                   thought-only guess
//   * CORROBORATION agreement across BOTH lanes (a thought followed through on
//                   reality) is the strongest signal
//   * RECENCY       fresher supporting evidence → higher (half-life decay)
//   * INTEGRITY     records carrying a receipt id / hash-chain link are firmer
//                   than bodiless ones
//   * AMBIGUITY     an explicit ok:false / empty result, or a query that hit many
//                   equally-weak candidates, pulls confidence DOWN
//
// The output is a number, a human band (high/medium/low/none), and the signal
// breakdown (Mom's Law — the score shows its work, never a bare number).
//
// This is NOT a probability from a model. It is a transparent, reproducible
// heuristic over evidence already on the ledger. Weights are named constants.
//
// HONESTY. No model, no network. Reuses engine _internal for tokenization/lane
// facts; modifies neither engine nor reader.
//
// EMPTY-SAFE. No records / ok:false result / undefined input → confidence 0,
// band "none", never throws.
//
// CLI:
//   bun recall-ext/recall-confidence.mjs score --project "AE Cobra" --flux-root <dir>
//   bun recall-ext/recall-confidence.mjs score --phrase "an hour ago"  --flux-root <dir>

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildDualIndex, resolveTimeQuery, projectState, _internal,
} from '../recall-engine.mjs';

const { bodyText } = _internal;

const DAY_MS = 86_400_000;
const REALITY = 'reality';
const THOUGHT = 'thought';

// Named signal weights (blend to ≤1 before ambiguity penalties). Every knob
// documented; the composite is reconstructable from these + the inputs.
// Weights sum to 1.0 (0.34+0.22+0.26+0.12+0.06). corroborationMax is set
// deliberately ABOVE realityMax so that cross-lane corroboration (a hypothesis
// borne out on the reality lane) strictly outranks the same number of records on
// one lane only — independent agreement across the two lanes is the strongest
// evidence Cobra has, stronger than volume on a single lane.
export const CONF_WEIGHTS = {
  evidenceMax: 0.34,      // saturating evidence-volume contribution
  realityMax: 0.22,       // fraction of support that is ground-truth reality
  corroborationMax: 0.26, // both-lanes agreement (deliberately > realityMax)
  recencyMax: 0.12,       // freshness of supporting evidence
  integrityMax: 0.06,     // receipt-id / hash presence
};

// Saturating evidence curve: 0 → 0, grows fast then flattens (diminishing
// returns). n/(n+k) with k=3 → 1 rec≈0.25, 3≈0.5, 9≈0.75 of the max.
function evidenceCurve(n, k = 3) {
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n / (n + k);
}

function recencyWeight(ageMs, halfLifeMs) {
  if (!Number.isFinite(ageMs) || ageMs <= 0) return 1;
  if (!Number.isFinite(halfLifeMs) || halfLifeMs <= 0) return 1;
  return Math.pow(0.5, ageMs / halfLifeMs);
}

// ===========================================================================
// scoreEvidence — the core: score a confidence from an explicit set of supporting
// records + a small context describing the answer.
//
// supporting: Array of records (live record shape) the answer rests on.
// ctx: {
//   ok            — the underlying result's ok flag (false → hard low confidence)
//   answered      — did the answer actually return something? (count>0/found/etc.)
//   nowMs, halfLifeDays (14)
//   ambiguityCandidates — # of roughly-equal weak candidates (>1 lowers conf)
// }
//
// Returns { confidence, band, signals:{...}, reasons:[...] }. Never throws.
// ===========================================================================
export function scoreEvidence(supporting, ctx = {}) {
  const {
    ok = true,
    answered = undefined,
    nowMs = Date.now(),
    halfLifeDays = 14,
    ambiguityCandidates = 0,
  } = ctx;

  const recs = Array.isArray(supporting) ? supporting.filter((r) => r && typeof r === 'object') : [];
  const reasons = [];

  // Hard floors first.
  if (ok === false) {
    return band0('result.ok is false (no confident answer)', { ok: false, n: recs.length });
  }
  const didAnswer = answered === undefined ? recs.length > 0 : !!answered;
  if (!didAnswer || recs.length === 0) {
    return band0('empty answer — nothing to be confident about', { ok, n: recs.length });
  }

  const n = recs.length;
  const realN = recs.filter((r) => r.lane === REALITY).length;
  const thoughtN = recs.filter((r) => r.lane === THOUGHT).length;
  const halfLifeMs = Math.max(1, halfLifeDays) * DAY_MS;

  // 1. evidence volume.
  const sEvidence = CONF_WEIGHTS.evidenceMax * evidenceCurve(n);
  reasons.push(`evidence: ${n} supporting record(s)`);

  // 2. ground-truth reality share.
  const realFrac = n ? realN / n : 0;
  const sReality = CONF_WEIGHTS.realityMax * realFrac;
  if (realN) reasons.push(`ground-truth: ${realN}/${n} on the reality lane`);
  else reasons.push('caution: entirely thought-lane (hypothesis, not observed)');

  // 3. corroboration across BOTH lanes.
  const bothLanes = realN > 0 && thoughtN > 0;
  const sCorrob = bothLanes ? CONF_WEIGHTS.corroborationMax * Math.min(1, Math.min(realN, thoughtN) / 2) : 0;
  if (bothLanes) reasons.push(`corroborated across lanes (reality ${realN} + thought ${thoughtN})`);

  // 4. recency of the freshest supporting record.
  const newest = recs.reduce((mx, r) => Number.isFinite(r.ts) && r.ts > mx ? r.ts : mx, -Infinity);
  const freshW = Number.isFinite(newest) ? recencyWeight(nowMs - newest, halfLifeMs) : 0;
  const sRecency = CONF_WEIGHTS.recencyMax * freshW;
  if (Number.isFinite(newest)) {
    const ageD = Math.floor((nowMs - newest) / DAY_MS);
    reasons.push(`freshest evidence ~${ageD}d old`);
  }

  // 5. integrity — share of records carrying a hash/receipt id.
  const withHash = recs.filter((r) => (r.hash || r.receipt_id)).length;
  const sIntegrity = CONF_WEIGHTS.integrityMax * (n ? withHash / n : 0);

  let confidence = sEvidence + sReality + sCorrob + sRecency + sIntegrity;

  // Ambiguity penalty — many equally-weak candidates means the answer is not
  // well-separated. Multiplicative shrink toward 0 as candidates grow.
  if (ambiguityCandidates && ambiguityCandidates > 1) {
    const shrink = 1 / Math.log2(ambiguityCandidates + 2); // 2→0.5, 6→~0.35
    confidence *= shrink;
    reasons.push(`ambiguity: ${ambiguityCandidates} comparable candidates (confidence shrunk)`);
  }

  confidence = clamp01(confidence);
  return {
    confidence: round4(confidence),
    band: bandOf(confidence),
    signals: {
      evidence: round4(sEvidence),
      reality: round4(sReality),
      corroboration: round4(sCorrob),
      recency: round4(sRecency),
      integrity: round4(sIntegrity),
      counts: { total: n, reality: realN, thought: thoughtN, with_receipt: withHash },
    },
    reasons,
  };
}

function band0(reason, extra) {
  return { confidence: 0, band: 'none', signals: { evidence: 0, reality: 0, corroboration: 0, recency: 0, integrity: 0, counts: { total: extra?.n || 0, reality: 0, thought: 0, with_receipt: 0 } }, reasons: [reason] };
}

function bandOf(c) {
  if (c >= 0.66) return 'high';
  if (c >= 0.4) return 'medium';
  if (c > 0) return 'low';
  return 'none';
}

// ===========================================================================
// Convenience recallers that produce BOTH an answer and its confidence, so a
// caller gets a self-rated recall in one call. Each gathers the supporting
// records itself and hands them to scoreEvidence.
// ===========================================================================

// confidenceForProject — projectState + a confidence over the records that
// answer touches (reality + thought hits on the project).
export function confidenceForProject({ fluxRoot, project, nowMs = Date.now(), lookbackMs = 365 * DAY_MS } = {}) {
  const ps = projectState({ fluxRoot, project, nowMs, lookbackMs });
  if (ps.ok === false) return { ok: false, reason: ps.reason, project: ps.project, confidence: 0, band: 'none' };

  // Re-collect the supporting live records (with lane/hash) from the dual index,
  // matching the same names projectState surfaced.
  const idx = buildDualIndex({ fluxRoot, startMs: Math.max(0, nowMs - lookbackMs), endMs: nowMs });
  const wanted = new Set([...ps.reality, ...ps.thought].map((r) => r.receipt_id).filter(Boolean));
  const supporting = [...idx.reality, ...idx.thought].map((e) => e.rec).filter((r) => wanted.has(r.hash));

  const conf = scoreEvidence(supporting, {
    ok: ps.ok,
    answered: ps.found,
    nowMs,
    // If the "latest" is a hypothesis (thought), treat as slightly more ambiguous.
    ambiguityCandidates: ps.latest_is_hypothesis ? 2 : 0,
  });

  return { ok: true, project: ps.project, found: ps.found, answer: ps, ...conf };
}

// confidenceForTime — resolveTimeQuery + a confidence over the events it returned.
export function confidenceForTime({ fluxRoot, phrase, fromMs, toMs, nowMs = Date.now() } = {}) {
  const tq = resolveTimeQuery({ fluxRoot, phrase, fromMs, toMs, nowMs });
  if (tq.ok === false) return { ok: false, reason: tq.reason, phrase: tq.phrase ?? phrase ?? null, confidence: 0, band: 'none' };

  // The events are projections (carry receipt_id + lane + ts) — score directly.
  const conf = scoreEvidence(tq.events, { ok: tq.ok, answered: tq.count > 0, nowMs });
  return { ok: true, phrase: tq.phrase ?? phrase ?? null, count: tq.count, answer: tq, ...conf };
}

function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
function round4(n) { return Math.round(n * 1e4) / 1e4; }

export const _internal_conf = { scoreEvidence, evidenceCurve, recencyWeight, bandOf, CONF_WEIGHTS };

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseCliArgs(argv) {
  const a = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith('--')) a.flags[t.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    else a._.push(t);
  }
  return a;
}

function cliMain(argv) {
  const a = parseCliArgs(argv);
  const cmd = a._[0];
  const fluxRoot = a.flags['flux-root'] || process.env.AE_FLUX_ROOT;
  let out;
  switch (cmd) {
    case 'score':
      if (a.flags.project) out = confidenceForProject({ fluxRoot, project: a.flags.project });
      else if (a.flags.phrase) out = confidenceForTime({ fluxRoot, phrase: a.flags.phrase });
      else { process.stderr.write('score needs --project <name> or --phrase "<time>"\n'); process.exit(1); }
      break;
    default:
      process.stderr.write(
        'Æ Cobra recall-ext recall-confidence — confidence score on a recall answer.\n\n' +
        'Usage:\n' +
        '  bun recall-ext/recall-confidence.mjs score --project "<name>"      [--flux-root <dir>]\n' +
        '  bun recall-ext/recall-confidence.mjs score --phrase "an hour ago"  [--flux-root <dir>]\n'
      );
      process.exit(a._.length ? 1 : 0);
  }
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  process.exit(out && out.ok === false ? 1 : 0);
}

const isDirect = (() => {
  try { return process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]); }
  catch { return false; }
})();

if (isDirect) {
  try { cliMain(process.argv.slice(2)); }
  catch (e) { process.stderr.write(`fatal: ${e.stack || e.message}\n`); process.exit(1); }
}
