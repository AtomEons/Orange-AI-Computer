// epistemic-prior.mjs — the chain learns from its own scar tissue.
//
// AE Cobra's recall-engine surfaces prior mistakes by action-name string match.
// That answers "did this action fail before?" It cannot answer the question that
// actually matters:
//
//     "Claims that LOOKED like this one — how did they end?"
//
// Across AEyes-1, the tell was consistent and visible in hindsight: absolute
// language over a small sample was overturned within days, every time. A system
// holding its own history should be able to notice that about itself BEFORE
// making the same shape of claim again.
//
// This is not learning from a corpus. It is learning from THIS system's own
// documented failures — the most relevant training signal that exists, and the
// only one that is fully owned, fully auditable, and free.

import { loadChain, buildTrajectory, supersededClaims } from '../../../10-RECEIPTS/tools/trajectory.mjs';

export const EPISTEMIC_PRIOR_SCHEMA_ID = 'orange5.epistemic-prior.v1';

const ABSOLUTE = /\b(proves?|proven|perfect|certain|always|never|guaranteed|definitively|conclusively)\b/i;
const STRONG   = /\b(confirmed|demonstrates?|establishes?|ruled out|eliminates?)\b/i;
const HEDGED   = /\b(may|might|possibly|preliminary|unresolved|pending|appears|consistent with)\b/i;

/** claimShape — a structural fingerprint, deliberately coarse so it generalizes. */
export function claimShape(summary, meta = {}) {
  const t = String(summary || '');
  const n = meta.n ?? meta.sampleCount ?? null;
  return {
    strength: ABSOLUTE.test(t) ? 'absolute' : STRONG.test(t) ? 'strong' : HEDGED.test(t) ? 'hedged' : 'unmarked',
    sampleBand: n == null ? 'unknown' : n < 15 ? 'tiny' : n < 30 ? 'small' : n < 100 ? 'moderate' : 'large',
    domain: (meta.action || '').split('.')[0] || 'unknown',
  };
}

function shapeKey(s) { return `${s.strength}|${s.sampleBand}`; }

/**
 * epistemicPrior({ summary, meta, chainPath })
 * Returns how claims of THIS SHAPE have historically ended in this chain.
 */
export function epistemicPrior({ summary, meta = {}, chainPath, chain: injectedChain } = {}) {
  const chain = injectedChain || loadChain(chainPath);
  const traj = buildTrajectory(chain);
  const dead = supersededClaims(traj);
  const shape = claimShape(summary, meta);
  const key = shapeKey(shape);

  // Bucket every historical receipt by claim shape.
  const buckets = new Map();
  for (const node of traj.nodes.values()) {
    const s = claimShape(node.summary, { action: node.action, n: node.sample_n });
    const k = shapeKey(s);
    if (!buckets.has(k)) buckets.set(k, { total: 0, superseded: 0, examples: [] });
    const b = buckets.get(k);
    b.total++;
    if (node.superseded_by != null) {
      b.superseded++;
      if (b.examples.length < 3) {
        b.examples.push({ seq: node.seq, summary: String(node.summary || '').slice(0, 100), superseded_by: node.superseded_by });
      }
    }
  }

  const bucket = buckets.get(key) || { total: 0, superseded: 0, examples: [] };
  const rate = bucket.total > 0 ? bucket.superseded / bucket.total : null;

  // Penalty scales with observed supersession rate, damped by evidence volume
  // so a single early failure does not permanently condemn a shape.
  let penalty = 0, verdict = 'NO_PRIOR', advice = null;
  if (bucket.total >= 3 && rate != null) {
    const confidence = Math.min(1, bucket.total / 10);
    penalty = rate * confidence;
    if (rate >= 0.5) {
      verdict = 'HIGH_RISK_SHAPE';
      advice = `${bucket.superseded} of ${bucket.total} prior "${shape.strength}" claims at ${shape.sampleBand} sample size were later overturned. This system has a documented history of being wrong in exactly this shape. Soften the language, widen the sample, or state the interval.`;
    } else if (rate > 0) {
      verdict = 'CAUTION_SHAPE';
      advice = `${bucket.superseded} of ${bucket.total} prior claims of this shape were overturned.`;
    } else {
      verdict = 'CLEAN_SHAPE';
    }
  } else if (shape.strength === 'absolute' && shape.sampleBand === 'tiny') {
    // Cold-start guard: no history needed to know this shape is dangerous.
    verdict = 'HIGH_RISK_SHAPE'; penalty = 0.4;
    advice = 'absolute language at tiny sample size — historically the highest-risk shape in this chain, flagged even without prior instances.';
  }

  return {
    schema: EPISTEMIC_PRIOR_SCHEMA_ID,
    shape, shapeKey: key, verdict, penalty, advice,
    observed: { total: bucket.total, superseded: bucket.superseded, rate },
    examples: bucket.examples,
    chainSize: traj.size,
    totalSuperseded: dead.length,
  };
}

/** chainSelfAudit(chainPath) — the system's own track record, by claim shape. */
export function chainSelfAudit({ chainPath, chain: injectedChain } = {}) {
  const chain = injectedChain || loadChain(chainPath);
  const traj = buildTrajectory(chain);
  const buckets = new Map();
  for (const node of traj.nodes.values()) {
    const s = claimShape(node.summary, { action: node.action, n: node.sample_n });
    const k = shapeKey(s);
    if (!buckets.has(k)) buckets.set(k, { shape: s, total: 0, superseded: 0 });
    const b = buckets.get(k);
    b.total++;
    if (node.superseded_by != null) b.superseded++;
  }
  const rows = [...buckets.entries()].map(([k, b]) => ({
    shapeKey: k, strength: b.shape.strength, sampleBand: b.shape.sampleBand,
    total: b.total, superseded: b.superseded,
    supersession_rate: b.total > 0 ? b.superseded / b.total : 0,
  })).sort((a, b) => b.supersession_rate - a.supersession_rate || b.total - a.total);
  return {
    schema: EPISTEMIC_PRIOR_SCHEMA_ID,
    chainSize: traj.size,
    totalSuperseded: supersededClaims(traj).length,
    byShape: rows,
  };
}
