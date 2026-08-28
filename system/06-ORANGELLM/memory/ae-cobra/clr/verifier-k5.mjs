// clr/verifier-k5.mjs — Phase-5 Claim-Level Reliability verifier (K=5).
//
// Doctrine (Æ Cobra Phase-5, replaces Night-1 K=1):
//   - The caller generates K=5 candidate AgentTurns per event and passes them
//     in as an array. This module scores each candidate on four dimensions,
//     takes the median of the 5 scores, and accepts when median >= threshold.
//   - Threshold default 0.50. Median 3-of-5 must clear threshold for acceptance
//     (median of 5 sorted ascending = index 2; if that score is >= threshold,
//     by definition at least 3 of the 5 are >= threshold).
//   - This is the verifier ONLY. The Promotion Gate and Bakeoff harness are
//     separate doctrine layers — see ../../04-CONTROL-PLANE/promotion-gate/
//     and the bakeoff harness for the 5-dimension head-to-head eval. Both
//     consume CLR-K5 results; neither is implemented here.
//
// Scoring dimensions (each clamped to [0, 1], then averaged):
//   1. anti_fluff             — penalize hedge phrases and fake-green words
//   2. grounding              — high-risk/destructive turns must cite files or commands
//   3. risk_vs_content        — risk level must match event_type & confidence
//   4. claim_verification     — claims that touch ground truth must align with
//                               the Reality lane and/or Hermes receipts passed
//                               in via context.reality_events / context.hermes_receipts
//
// Public API:
//   verifyCandidatesK5(candidates, { threshold = 0.5, context = {} }) ->
//     { scores: number[5], median: number, accepted: boolean, reasons: string[][],
//       per_candidate: Array<{score, accepted, reasons, dims}> }
//
// Inputs are AgentTurn JSON objects that have already passed
// schemas/agent-turn.schema.json validation. Verifier never mutates input.

const FAKE_GREEN = /\b(green_assumed|looks_ok|probably|should_work|fake_green|all good|seems fine)\b/i;
const FLUFF = /\b(in summary|to summarize|it is important to note|I hope this helps|might|maybe|perhaps|seems to|appears to|kind of|sort of|arguably)\b/i;
const DESTRUCTIVE_HINTS = /\b(rm -rf|drop table|truncate|force-push|--force|reset --hard|delete from|chmod 777|unlink)\b/i;
const PRODUCTION_HINTS = /\b(production|prod\b|main branch|origin\/main|release|deploy)\b/i;

function clamp01(x) {
  if (typeof x !== 'number' || Number.isNaN(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

function median5(scores) {
  // For K=5 the median is the 3rd element of the sorted array (index 2).
  // We assert length === 5 to keep doctrine honest.
  if (!Array.isArray(scores) || scores.length !== 5) {
    throw new Error(`CLR-K5 requires exactly 5 candidate scores, got ${scores?.length ?? 'non-array'}`);
  }
  const sorted = [...scores].sort((a, b) => a - b);
  return sorted[2];
}

// --- Dimension scorers --------------------------------------------------------

function scoreAntiFluff(turn) {
  const reasons = [];
  let score = 1.0;
  const prose = [turn.summary || '', turn.next_action || ''].join(' ');

  if (FAKE_GREEN.test(prose)) {
    score -= 0.8;
    reasons.push('fake-green word detected — auto-reject this dim');
  }

  const fluffHits = (prose.match(new RegExp(FLUFF.source, 'gi')) || []).length;
  if (fluffHits >= 3) {
    score -= 0.5;
    reasons.push(`fluff: ${fluffHits} hits`);
  } else if (fluffHits === 2) {
    score -= 0.25;
    reasons.push(`fluff: 2 hits`);
  } else if (fluffHits === 1) {
    score -= 0.1;
    reasons.push(`fluff: 1 hit (warn)`);
  }

  if (!turn.summary || turn.summary.trim().length < 3) {
    score -= 0.6;
    reasons.push('summary missing or too short');
  }

  return { score: clamp01(score), reasons };
}

function scoreGrounding(turn) {
  const reasons = [];
  let score = 1.0;
  const fileCount = (turn.files || []).length;
  const cmdCount = (turn.commands || []).length;
  const entCount = (turn.entities || []).length;

  if (turn.risk === 'high' && fileCount === 0 && cmdCount === 0) {
    score -= 0.6;
    reasons.push('high-risk turn cites no files and no commands');
  }

  // Decisions and receipts should cite something concrete.
  if (['decision', 'receipt'].includes(turn.event_type) &&
      fileCount === 0 && cmdCount === 0 && entCount === 0) {
    score -= 0.3;
    reasons.push(`${turn.event_type} cites no files/commands/entities`);
  }

  // Observation with zero anchors is acceptable only at low risk.
  if (turn.event_type === 'observation' &&
      fileCount === 0 && cmdCount === 0 && entCount === 0 &&
      turn.risk !== 'low') {
    score -= 0.2;
    reasons.push('observation with no anchors at non-low risk');
  }

  return { score: clamp01(score), reasons };
}

function scoreRiskVsContent(turn) {
  const reasons = [];
  let score = 1.0;
  const prose = [turn.summary || '', turn.next_action || ''].join(' ');

  // error/risk events should not assert near-certainty.
  if (['error', 'risk'].includes(turn.event_type) && turn.confidence > 0.9) {
    score -= 0.25;
    reasons.push(`${turn.event_type} event with implausibly high confidence ${turn.confidence}`);
  }

  // Destructive language at non-high risk is a mislabel.
  if (DESTRUCTIVE_HINTS.test(prose) && turn.risk !== 'high') {
    score -= 0.4;
    reasons.push('destructive language detected but risk not marked high');
  }

  // Production touches without high risk is suspicious for non-observation turns.
  if (PRODUCTION_HINTS.test(prose) &&
      turn.event_type !== 'observation' &&
      turn.risk === 'low') {
    score -= 0.2;
    reasons.push('production touch at low risk');
  }

  // Sub-floor confidence is itself a risk signal.
  if (typeof turn.confidence === 'number' && turn.confidence < 0.2) {
    score -= 0.2;
    reasons.push(`confidence ${turn.confidence} below floor`);
  }

  return { score: clamp01(score), reasons };
}

// Claim verification against the Reality lane + Hermes receipts.
// The caller can pass a context with:
//   context.reality_events  : Array<{ summary, files?, commands?, entities? }>
//   context.hermes_receipts : Array<{ kind, path?, files?, ok?, status? }>
// We look for token-level overlap between the candidate turn's anchors
// (files, commands, entities) and the reality/receipt corpus. If the
// candidate references something Reality has never seen, we penalize.
function scoreClaimVerification(turn, context = {}) {
  const reasons = [];
  let score = 1.0;
  const reality = Array.isArray(context.reality_events) ? context.reality_events : [];
  const receipts = Array.isArray(context.hermes_receipts) ? context.hermes_receipts : [];

  // Build the ground-truth anchor set from Reality + Hermes.
  const groundFiles = new Set();
  const groundCommands = new Set();
  const groundEntities = new Set();
  for (const ev of reality) {
    for (const f of ev.files || []) groundFiles.add(f);
    for (const c of ev.commands || []) groundCommands.add(c);
    for (const e of ev.entities || []) groundEntities.add(e);
  }
  for (const r of receipts) {
    if (r.path) groundFiles.add(r.path);
    for (const f of r.files || []) groundFiles.add(f);
  }

  // If we have NO ground truth at all, we cannot verify — return neutral 1.0
  // but mark the reason so the caller knows the dim was a no-op.
  const haveGround = groundFiles.size + groundCommands.size + groundEntities.size > 0;
  if (!haveGround) {
    reasons.push('no Reality/Hermes corpus available — claim-verification neutral');
    return { score: 1.0, reasons };
  }

  const turnFiles = turn.files || [];
  const turnCommands = turn.commands || [];

  // For Reality-lane turns we expect claims to be anchored. Unknown files
  // referenced by a Reality turn cost more than Thought-lane speculation.
  const isReality = turn.lane === 'reality';
  const filePenalty = isReality ? 0.2 : 0.1;
  const cmdPenalty = isReality ? 0.15 : 0.07;

  let unknownFiles = 0;
  for (const f of turnFiles) {
    if (!groundFiles.has(f)) unknownFiles++;
  }
  if (unknownFiles > 0 && turnFiles.length > 0) {
    const ratio = unknownFiles / turnFiles.length;
    score -= filePenalty * ratio;
    reasons.push(`${unknownFiles}/${turnFiles.length} files not in Reality/Hermes corpus`);
  }

  let unknownCmds = 0;
  for (const c of turnCommands) {
    if (!groundCommands.has(c)) unknownCmds++;
  }
  if (unknownCmds > 0 && turnCommands.length > 0) {
    const ratio = unknownCmds / turnCommands.length;
    score -= cmdPenalty * ratio;
    reasons.push(`${unknownCmds}/${turnCommands.length} commands not in Reality corpus`);
  }

  // A receipt-typed turn must reference a Hermes receipt path.
  if (turn.event_type === 'receipt' && receipts.length > 0) {
    const receiptPaths = new Set(receipts.map(r => r.path).filter(Boolean));
    const hits = turnFiles.filter(f => receiptPaths.has(f)).length;
    if (hits === 0) {
      score -= 0.3;
      reasons.push('receipt event does not reference any Hermes receipt path');
    }
  }

  // A failed-status receipt in context, with the candidate claiming success
  // language ("passed", "green", "ok"), is a contradiction.
  const failedReceipts = receipts.filter(r => r.ok === false || r.status === 'fail');
  if (failedReceipts.length > 0) {
    const successProse = /\b(passed|green|ok|success|completed)\b/i;
    const prose = [turn.summary || '', turn.next_action || ''].join(' ');
    if (successProse.test(prose) && turn.lane === 'reality') {
      score -= 0.4;
      reasons.push('Reality-lane success claim contradicts failed Hermes receipt');
    }
  }

  return { score: clamp01(score), reasons };
}

// --- Per-candidate scoring ----------------------------------------------------

export function scoreCandidate(turn, context = {}) {
  if (turn === null || typeof turn !== 'object') {
    throw new Error('scoreCandidate: turn must be an AgentTurn object');
  }
  const antiFluff = scoreAntiFluff(turn);
  const grounding = scoreGrounding(turn);
  const riskVs = scoreRiskVsContent(turn);
  const claim = scoreClaimVerification(turn, context);

  // Equal-weighted mean of the four dimensions. Doctrine: any dim can sink a
  // candidate, but no single dim auto-rejects (the Promotion Gate handles the
  // hard auto-rejects on fake-green words at the gate layer, not here).
  const dims = {
    anti_fluff: antiFluff.score,
    grounding: grounding.score,
    risk_vs_content: riskVs.score,
    claim_verification: claim.score,
  };
  const score = clamp01((dims.anti_fluff + dims.grounding + dims.risk_vs_content + dims.claim_verification) / 4);
  const reasons = [
    ...antiFluff.reasons.map(r => `anti_fluff: ${r}`),
    ...grounding.reasons.map(r => `grounding: ${r}`),
    ...riskVs.reasons.map(r => `risk_vs_content: ${r}`),
    ...claim.reasons.map(r => `claim_verification: ${r}`),
  ];
  return { score, dims, reasons };
}

// --- Public K=5 entry point ---------------------------------------------------

export function verifyCandidatesK5(candidates, options = {}) {
  const threshold = typeof options.threshold === 'number' ? options.threshold : 0.5;
  const context = options.context || {};

  if (!Array.isArray(candidates)) {
    throw new Error('verifyCandidatesK5: candidates must be an array');
  }
  if (candidates.length !== 5) {
    throw new Error(`CLR-K5 requires exactly 5 candidates, got ${candidates.length}`);
  }

  const per_candidate = candidates.map(c => {
    const r = scoreCandidate(c, context);
    return {
      score: r.score,
      accepted: r.score >= threshold,
      reasons: r.reasons,
      dims: r.dims,
    };
  });

  const scores = per_candidate.map(p => p.score);
  const median = median5(scores);
  const accepted = median >= threshold;
  const reasons = per_candidate.map(p => p.reasons);

  return {
    scores,
    median,
    accepted,
    reasons,
    per_candidate,
    threshold,
    k: 5,
  };
}

// Default export = the K=5 entry point. Named exports cover the helpers used
// by the bakeoff harness and the test suite.
export default verifyCandidatesK5;
