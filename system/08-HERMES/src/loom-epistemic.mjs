// loom-epistemic.mjs — the EPISTEMIC crossing gate.
//
// Orange5's existing LOOM gate (loom-fastpath.mjs) asks: "did you follow the process?"
//   schema valid · lease scope · Human-Final-Stop · no-fake-green
//
// This gate asks a different question: "does your evidence actually support your claim?"
//
// WHY THIS EXISTS — provenance, honestly stated:
//   Across the AEyes-1 Orange Campaign (spine seq 141-173), three substantive
//   conclusions were WRONG while passing every procedural gate. Code ran. Tests
//   were green. Receipts hash-chained. Conclusions were false. Each was caught by
//   an external auditor (GPT) relayed by the operator BY HAND, days later.
//
//   The three failures, and the check that would have caught each:
//     seq 160  "GENUINE_POS_NEG_FEATURE_OVERLAP"  -> STRENGTH_MISMATCH + SAMPLE_POWER
//     seq 170  "tier2 PERFECT discrimination"     -> CONFOUND_UNRULED + SAMPLE_POWER
//     L9-L11   inflated TPR (delta 0.40)          -> SELECTION_LEAKAGE
//
// Mom's Law: this gate exists because "green" is not "true", and receipts that
// record a false conclusion faithfully are still receipts of a false conclusion.
//
// Signature mirrors evaluateGates(action, lease, crossing) so it composes into the
// same spine chain position without rewriting the existing organ.

export const EPISTEMIC_SCHEMA_ID = 'orange5.loom.epistemic.v1';

// Claim-strength lexicon. Strong words demand strong evidence.
const STRENGTH_WORDS = {
  absolute: ['proves', 'proven', 'perfect', 'certain', 'always', 'never', 'guaranteed', 'definitively', 'conclusively'],
  strong:   ['confirmed', 'demonstrates', 'establishes', 'shows that', 'ruled out', 'eliminates'],
  moderate: ['suggests', 'indicates', 'supports', 'consistent with', 'evidence for'],
  hedged:   ['may', 'might', 'possibly', 'preliminary', 'unresolved', 'pending', 'not yet', 'appears'],
};

function claimStrength(text) {
  const t = String(text || '').toLowerCase();
  for (const w of STRENGTH_WORDS.absolute) if (t.includes(w)) return { tier: 'absolute', rank: 4, matched: w };
  for (const w of STRENGTH_WORDS.strong)   if (t.includes(w)) return { tier: 'strong',   rank: 3, matched: w };
  for (const w of STRENGTH_WORDS.moderate) if (t.includes(w)) return { tier: 'moderate', rank: 2, matched: w };
  for (const w of STRENGTH_WORDS.hedged)   if (t.includes(w)) return { tier: 'hedged',   rank: 1, matched: w };
  return { tier: 'unmarked', rank: 2, matched: null };
}

// ─────────────────────────────────────────────────────────────────────────
// CHECK 1 — SAMPLE_POWER
// A claimed rate bound is unresolvable when one error already breaches it.
// Caught: FPR <= 0.10 asserted against 10 negatives. 1 error = exactly 0.10.
// The test demanded a perfect score while reporting a threshold.
// ─────────────────────────────────────────────────────────────────────────
function checkSamplePower(evidence) {
  const findings = [];
  for (const [metric, spec] of Object.entries(evidence.rateBounds || {})) {
    const n = spec.n;
    const bound = spec.bound;
    if (!Number.isFinite(n) || !Number.isFinite(bound) || n <= 0) continue;
    const oneErrorRate = 1 / n;
    if (oneErrorRate > bound) {
      findings.push({
        check: 'SAMPLE_POWER', severity: 'BLOCK', metric,
        detail: `${metric} <= ${bound} asserted over n=${n}; a single error is ${oneErrorRate.toFixed(3)} which already breaches the bound. The constraint silently demands a perfect score.`,
        remedy: `raise n to >= ${Math.ceil(1 / bound)} so the bound is resolvable, or restate the bound as "zero errors observed at n=${n}".`,
      });
    } else if (oneErrorRate > bound * 0.5) {
      findings.push({
        check: 'SAMPLE_POWER', severity: 'WARN', metric,
        detail: `${metric} <= ${bound} over n=${n}; one error is ${oneErrorRate.toFixed(3)} — over half the entire budget. Resolution is coarse.`,
        remedy: `n >= ${Math.ceil(2 / bound)} gives at least 2 errors of headroom.`,
      });
    }
  }
  return findings;
}

// ─────────────────────────────────────────────────────────────────────────
// CHECK 2 — SELECTION_LEAKAGE
// Any data-dependent choice made on samples later used to score is leakage.
// Caught: lane AUC atlas built on full Bank D, then top-K lane selection scored
// by leave-one-out over that SAME Bank D. Inflated TPR by 0.40.
// ─────────────────────────────────────────────────────────────────────────
function checkSelectionLeakage(evidence) {
  const findings = [];
  const sel = evidence.selectionSet;
  const evl = evidence.evaluationSet;
  const params = evidence.dataDependentParams || [];
  if (!Array.isArray(sel) || !Array.isArray(evl) || params.length === 0) {
    if (params.length > 0) {
      findings.push({
        check: 'SELECTION_LEAKAGE', severity: 'WARN',
        detail: `${params.length} data-dependent parameter(s) declared (${params.join(', ')}) but selectionSet/evaluationSet not both declared. Leakage cannot be ruled out.`,
        remedy: 'declare evidence.selectionSet and evidence.evaluationSet as id arrays.',
      });
    }
    return findings;
  }
  const evalIds = new Set(evl);
  const overlap = sel.filter(id => evalIds.has(id));
  if (overlap.length > 0) {
    findings.push({
      check: 'SELECTION_LEAKAGE', severity: 'BLOCK',
      detail: `${overlap.length}/${evl.length} evaluation samples were also used to select [${params.join(', ')}]. Reported performance is optimistically biased, not held-out.`,
      overlapSample: overlap.slice(0, 5),
      remedy: 'move every data-dependent selection inside the training fold (nested evaluation), then re-report.',
    });
  }
  return findings;
}

// ─────────────────────────────────────────────────────────────────────────
// CHECK 3 — CONFOUND_UNRULED
// A discrimination claim about object identity must control the nuisance axes
// that co-vary with the label. Caught: "oranges vs apples PERFECT" where the
// orange images were fruit close-ups and the apple images were orchard scenes.
// The separator may have been scene structure, not category.
// ─────────────────────────────────────────────────────────────────────────
const IDENTITY_CLAIM = /\b(discriminat|separat|distinguish|recogni[sz]|classif|identif)/i;

function checkConfoundUnruled(claim, evidence) {
  const findings = [];
  const text = `${claim.statement || ''} ${claim.summary || ''}`;
  if (!IDENTITY_CLAIM.test(text)) return findings;

  const declared = new Set(evidence.confoundsControlled || []);
  const NUISANCE_AXES = ['background', 'scene', 'scale', 'framing', 'illumination', 'source_domain', 'capture_device'];
  const uncontrolled = NUISANCE_AXES.filter(a => !declared.has(a));

  if (evidence.classesSceneMatched === true) return findings;

  if (evidence.classesSceneMatched === false) {
    findings.push({
      check: 'CONFOUND_UNRULED', severity: 'BLOCK',
      detail: `identity-discrimination claim with classesSceneMatched=false. Classes differ on nuisance axes as well as category, so the separator may be scene structure rather than object identity.`,
      uncontrolled,
      remedy: 'add same-scene/different-category and same-category/different-scene pairs, then re-test.',
    });
    return findings;
  }

  if (uncontrolled.length >= 4) {
    findings.push({
      check: 'CONFOUND_UNRULED', severity: 'WARN',
      detail: `identity-discrimination claim with ${uncontrolled.length} nuisance axes undeclared: ${uncontrolled.join(', ')}. Cannot attribute separation to category evidence.`,
      remedy: 'declare evidence.confoundsControlled, or set evidence.classesSceneMatched once scene-matched pairs exist.',
    });
  }
  return findings;
}

// ─────────────────────────────────────────────────────────────────────────
// CHECK 4 — ABSTENTION_MASK
// A system that abstains on nearly everything can post a flawless error rate
// while recognizing nothing. Coverage must be reported alongside accuracy.
// ─────────────────────────────────────────────────────────────────────────
function checkAbstentionMask(evidence) {
  const findings = [];
  const cov = evidence.coverage;
  if (!Number.isFinite(cov)) {
    if (Number.isFinite(evidence.observedTPR) || Number.isFinite(evidence.observedFPR)) {
      findings.push({
        check: 'ABSTENTION_MASK', severity: 'WARN',
        detail: 'accuracy rates reported without coverage. A high-abstention system can post excellent rates while deciding almost nothing.',
        remedy: 'report evidence.coverage = decided / total alongside every rate.',
      });
    }
    return findings;
  }
  if (cov < 0.5) {
    findings.push({
      check: 'ABSTENTION_MASK', severity: 'BLOCK',
      detail: `coverage ${cov.toFixed(2)} — the system declines on ${((1 - cov) * 100).toFixed(0)}% of cases. Reported rates describe a small decided minority and do not characterize operating behavior.`,
      remedy: 'report rates conditioned on coverage, or state the result as an abstention finding rather than a recognition result.',
    });
  }
  return findings;
}

// ─────────────────────────────────────────────────────────────────────────
// CHECK 5 — STRENGTH_MISMATCH
// Absolute language requires evidence that can bear it: adequate n, and a
// confidence interval narrow enough to exclude the alternative.
// ─────────────────────────────────────────────────────────────────────────
function checkStrengthMismatch(claim, evidence) {
  const findings = [];
  const text = `${claim.statement || ''} ${claim.summary || ''}`;
  const strength = claimStrength(text);
  if (strength.rank < 3) return findings;

  const n = evidence.n ?? evidence.sampleCount;
  if (Number.isFinite(n) && n < 30 && strength.rank === 4) {
    findings.push({
      check: 'STRENGTH_MISMATCH', severity: 'BLOCK',
      detail: `absolute claim ("${strength.matched}") over n=${n}. At this sample size the interval cannot exclude ordinary alternatives.`,
      remedy: `soften to "${n} of ${n} observed, CI [..]", or raise n.`,
    });
  } else if (Number.isFinite(n) && n < 15 && strength.rank === 3) {
    findings.push({
      check: 'STRENGTH_MISMATCH', severity: 'WARN',
      detail: `strong claim ("${strength.matched}") over n=${n}. State the interval so the reader can see the true precision.`,
      remedy: 'attach a Wilson interval and prefer "consistent with" phrasing.',
    });
  }

  const ci = evidence.primaryCI;
  if (Array.isArray(ci) && ci.length === 2 && Number.isFinite(ci[0]) && Number.isFinite(ci[1])) {
    const width = ci[1] - ci[0];
    if (width > 0.4 && strength.rank >= 3) {
      findings.push({
        check: 'STRENGTH_MISMATCH', severity: 'BLOCK',
        detail: `claim tier "${strength.tier}" with 95% CI [${ci[0].toFixed(2)}, ${ci[1].toFixed(2)}] — width ${width.toFixed(2)}. The interval spans too much to support this language.`,
        remedy: 'report the interval in the claim itself and drop the strong verb.',
      });
    }
  }
  return findings;
}

// ─────────────────────────────────────────────────────────────────────────
// CHECK 6 — SUPERSESSION_CONFLICT
// A new claim that contradicts a live prior receipt must say so explicitly.
// Otherwise the chain holds two mutually exclusive truths, both unmarked.
// ─────────────────────────────────────────────────────────────────────────
function checkSupersessionConflict(claim, chainContext) {
  const findings = [];
  const priors = chainContext?.relatedPriorClaims || [];
  if (priors.length === 0) return findings;
  const declaredSupersedes = new Set(claim.supersedes || []);
  for (const prior of priors) {
    if (prior.superseded) continue;
    if (prior.contradicts !== true) continue;
    if (declaredSupersedes.has(prior.seq)) continue;
    findings.push({
      check: 'SUPERSESSION_CONFLICT', severity: 'BLOCK',
      detail: `contradicts live receipt seq ${prior.seq} ("${String(prior.summary || '').slice(0, 90)}") without declaring supersession. The chain would hold both as current.`,
      remedy: `add claim.supersedes = [${prior.seq}] with a stated reason, or reconcile the two.`,
    });
  }
  return findings;
}

/**
 * evaluateEpistemicGates(claim, evidence, chainContext)
 *
 * @param claim  { statement, summary, supersedes?[] }
 * @param evidence {
 *     n, sampleCount, coverage, observedTPR, observedFPR, primaryCI:[lo,hi],
 *     rateBounds: { FPR: {bound, n}, ... },
 *     selectionSet:[ids], evaluationSet:[ids], dataDependentParams:[names],
 *     confoundsControlled:[axes], classesSceneMatched: bool
 * }
 * @param chainContext { relatedPriorClaims: [{seq, summary, contradicts, superseded}] }
 * @returns { schema, passed, blocks[], warns[], findings[], first_fail, epistemicScore }
 */
export function evaluateEpistemicGates(claim = {}, evidence = {}, chainContext = {}) {
  const findings = [
    ...checkSamplePower(evidence),
    ...checkSelectionLeakage(evidence),
    ...checkConfoundUnruled(claim, evidence),
    ...checkAbstentionMask(evidence),
    ...checkStrengthMismatch(claim, evidence),
    ...checkSupersessionConflict(claim, chainContext),
  ];
  const blocks = findings.filter(f => f.severity === 'BLOCK');
  const warns  = findings.filter(f => f.severity === 'WARN');
  return {
    schema: EPISTEMIC_SCHEMA_ID,
    passed: blocks.length === 0,
    blocks, warns, findings,
    first_fail: blocks[0] ? { reason: `${blocks[0].check}: ${blocks[0].detail}`, check: blocks[0].check } : null,
    // 1.0 clean; each block costs 0.25, each warn 0.08. A claim's evidential health.
    epistemicScore: Math.max(0, 1 - blocks.length * 0.25 - warns.length * 0.08),
  };
}

export const __epistemicInternals = Object.freeze({
  claimStrength, checkSamplePower, checkSelectionLeakage, checkConfoundUnruled,
  checkAbstentionMask, checkStrengthMismatch, checkSupersessionConflict, STRENGTH_WORDS,
});
