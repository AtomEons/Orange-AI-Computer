// least-action/router.mjs
//
// AtomSmasher module #6 — Least-action Router.
//
// Purpose:
//   Pick the minimum-energy path through the model superstack for each
//   request. "Energy" here is a deliberate, named cost function — not a
//   metaphor. The router scores every eligible tier (reflex, heavy, frontier)
//   on a single dimensionless action S, and returns the tier that minimizes
//   S subject to hard constraints (risk floor, latency ceiling). Same inputs
//   in -> same decision out. No randomness. No model call inside the router.
//
// Doctrine:
//   - The router is a CLASSIFIER, not a coin flip. Given identical
//     (intent_complexity, risk_level, latency_budget_ms, capabilities),
//     the chosen tier and the full per-tier scorecard are byte-identical
//     across calls. We hash the decision frame and ship the hash as
//     `decision_id` so any caller can prove which path they took.
//   - Three canonical tiers in this version, in increasing capability and
//     cost:
//        reflex   — Smart Skinny (local distilled / on-device class).
//                   Cheap, fast, low ceiling. Best for trivial reflex tasks
//                   where complexity is low and risk is low.
//        heavy    — OrangeLLM-fatty (mid-tier hosted, fine-tuned).
//                   Balanced. Best for typical requests with moderate
//                   complexity / moderate risk.
//        frontier — BYO (operator-supplied frontier model: Claude Opus,
//                   GPT-5 class, etc.). Highest ceiling, highest cost,
//                   highest latency. Best for high-complexity / high-risk.
//   - The router does NOT execute the chosen model. It returns a decision
//     envelope. The gateway / dispatcher is responsible for actually
//     routing the call to the chosen tier.
//   - Hard constraints precede optimization. A tier whose typical latency
//     exceeds the latency budget is HARD-INELIGIBLE — the router will not
//     pick it even if its action score is lowest. Similarly, a tier whose
//     capability ceiling is below the request's risk_level is hard-
//     ineligible. Hard ineligibility is recorded with a reason; the
//     downstream consumer can see exactly why a tier was excluded.
//   - Tie-breaks are deterministic: cheaper-tier wins on action ties
//     (reflex < heavy < frontier). This is the Mom's Law direction —
//     when in doubt, spend less.
//   - Anti-fluff: the router refuses inputs that omit a required dimension.
//     There is no "guess reasonable defaults" mode. If the caller cannot
//     state intent_complexity, risk_level, or latency_budget_ms, the router
//     emits a structured error frame and selects nothing.
//
// Action function S(tier; req):
//
//     S = w_lat * (lat_p50_ms / latency_budget_ms)
//       + w_cap * (1 - capability_headroom)
//       + w_cost * cost_per_call_usd_normalized
//       - w_fit * fit_score
//
//   where:
//     - w_lat, w_cap, w_cost, w_fit are fixed published weights (see
//       WEIGHTS below). Changing them changes the router; we treat the
//       weights as part of the public contract.
//     - lat_p50_ms is the tier's nameplate p50 latency.
//     - capability_headroom = (tier_ceiling - request_demand) /
//       max(tier_ceiling, request_demand). Positive = tier overshoots
//       request; negative = tier undershoots (already hard-ineligible).
//     - cost_per_call_usd_normalized = cost / max_cost_across_tiers, in [0,1].
//     - fit_score is the tier's published task-fit prior for this
//       (intent_complexity, risk_level) bucket — a small lookup, not magic.
//
//   Lower S = less action = preferred path.
//
// What this file does NOT do:
//   - It does not maintain a learned model. The TIER table is hand-curated
//     and versioned. If we later want a learned router, it goes in a
//     sibling module and feeds this one as a fit_score input.
//   - It does not log decisions. Persistence belongs to the gateway route
//     (atomsmasher-least-action.mjs) and the Receipts module.
//   - It does not execute the chosen tier. It returns the envelope only.
//
// Exports:
//   route(request, opts?)      -> RouteDecision frame
//   validate(decision)         -> {valid, errors}
//   TIERS                      -> frozen canonical tier table
//   WEIGHTS                    -> frozen action weights
//   ROUTE_SCHEMA_ID
//   __internals                -> exposed helpers for tests

import crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const ROUTE_SCHEMA_ID = 'orange5.atomsmasher.least-action-route.v0';

// Canonical tier table. Hand-curated v0. Fields:
//   id            — stable string id used in decision frames
//   label         — human label for logs
//   class         — 'reflex' | 'heavy' | 'frontier'
//   nameplate     — descriptive name of the underlying model class
//   ceiling       — capability ceiling on a 0-10 scale. The router's
//                   request_demand (derived from complexity + risk) must be
//                   <= ceiling, else the tier is hard-ineligible.
//   lat_p50_ms    — nameplate median latency for a typical short turn
//   lat_p99_ms    — nameplate p99 latency. Used only for diagnostics; the
//                   hard constraint is on p50.
//   cost_per_call_usd — nameplate cost per typical call
//   fit_priors    — per-bucket fit scores in [0,1]. Higher = better fit.
//                   Buckets are indexed by (complexity_bucket, risk_bucket)
//                   where each is 'low' | 'mid' | 'high'. Hand-tuned so
//                   reflex wins low/low, heavy wins mid/mid, frontier wins
//                   high/high. The router does not interpolate; it bucketizes.
export const TIERS = Object.freeze([
  Object.freeze({
    id: 'reflex',
    label: 'Smart Skinny (local distilled)',
    class: 'reflex',
    nameplate: 'smart-skinny-v0',
    ceiling: 4,
    lat_p50_ms: 80,
    lat_p99_ms: 250,
    cost_per_call_usd: 0.00005,
    fit_priors: Object.freeze({
      'low|low':    0.95,
      'low|mid':    0.70,
      'low|high':   0.30,
      'mid|low':    0.65,
      'mid|mid':    0.40,
      'mid|high':   0.15,
      'high|low':   0.25,
      'high|mid':   0.10,
      'high|high':  0.05,
    }),
  }),
  Object.freeze({
    id: 'heavy',
    label: 'OrangeLLM-fatty (mid-tier hosted)',
    class: 'heavy',
    nameplate: 'orangellm-fatty-v0',
    ceiling: 7,
    lat_p50_ms: 1200,
    lat_p99_ms: 4500,
    cost_per_call_usd: 0.004,
    fit_priors: Object.freeze({
      'low|low':    0.55,
      'low|mid':    0.75,
      'low|high':   0.60,
      'mid|low':    0.80,
      'mid|mid':    0.90,
      'mid|high':   0.80,
      'high|low':   0.55,
      'high|mid':   0.70,
      'high|high':  0.55,
    }),
  }),
  Object.freeze({
    id: 'frontier',
    label: 'BYO frontier (Opus / GPT-5 class)',
    class: 'frontier',
    nameplate: 'byo-frontier',
    ceiling: 10,
    lat_p50_ms: 3500,
    lat_p99_ms: 18000,
    cost_per_call_usd: 0.05,
    fit_priors: Object.freeze({
      'low|low':    0.20,
      'low|mid':    0.45,
      'low|high':   0.70,
      'mid|low':    0.40,
      'mid|mid':    0.65,
      'mid|high':   0.85,
      'high|low':   0.65,
      'high|mid':   0.85,
      'high|high':  0.98,
    }),
  }),
]);

// Action weights. Published as part of the contract. Sum is not required
// to be 1.0 — the weights are dimensional scales, not a probability mix.
export const WEIGHTS = Object.freeze({
  lat:  1.0,   // penalty for using more of the latency budget
  cap:  0.6,   // penalty for capability undershoot (kept small; hard
               // ineligibility already handles severe undershoot)
  cost: 0.4,   // penalty for spending more dollars
  fit:  1.5,   // reward for matching the (complexity, risk) bucket
});

// Latency safety factor. A tier is hard-ineligible if its p50 latency
// exceeds latency_budget_ms * LAT_SAFETY. Default 0.8 — leave headroom
// for the p50->actual variance.
const LAT_SAFETY = 0.8;

// Risk -> minimum required capability ceiling. A request at risk_level=N
// requires a tier with ceiling >= N. This is the "no shipping a high-risk
// decision through Smart Skinny" rule.
function riskToMinCeiling(risk_level) {
  // risk_level is on 0-10. Min ceiling = ceil(risk_level). Risk 0-4 fits
  // reflex; 5-7 needs heavy; 8-10 needs frontier.
  if (!Number.isFinite(risk_level) || risk_level < 0) return 0;
  return Math.ceil(risk_level);
}

// Complexity -> demand. Identity on a 0-10 scale, clamped.
function complexityToDemand(intent_complexity) {
  if (!Number.isFinite(intent_complexity)) return 0;
  return Math.max(0, Math.min(10, intent_complexity));
}

function bucket(x) {
  if (x <= 3) return 'low';
  if (x <= 6) return 'mid';
  return 'high';
}

// ---------------------------------------------------------------------------
// Canonical JSON + hashing (same convention as sibling AtomSmasher modules)
// ---------------------------------------------------------------------------

function canonicalStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalStringify).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalStringify(value[k])).join(',') + '}';
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

function validateRequest(req) {
  const errors = [];
  if (req == null || typeof req !== 'object' || Array.isArray(req)) {
    return { valid: false, errors: ['request must be a non-null object'] };
  }
  for (const field of ['intent_complexity', 'risk_level', 'latency_budget_ms']) {
    if (!(field in req)) {
      errors.push(`missing required field: ${field}`);
      continue;
    }
    const v = req[field];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      errors.push(`${field} must be a finite number`);
    }
  }
  if (errors.length) return { valid: false, errors };

  if (req.intent_complexity < 0 || req.intent_complexity > 10) {
    errors.push('intent_complexity must be in [0, 10]');
  }
  if (req.risk_level < 0 || req.risk_level > 10) {
    errors.push('risk_level must be in [0, 10]');
  }
  if (req.latency_budget_ms < 0) {
    errors.push('latency_budget_ms must be >= 0');
  }
  // capabilities is optional; if present, must be string[]
  if ('capabilities' in req) {
    if (!Array.isArray(req.capabilities) ||
        !req.capabilities.every((c) => typeof c === 'string')) {
      errors.push('capabilities, when supplied, must be an array of strings');
    }
  }
  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Eligibility + scoring
// ---------------------------------------------------------------------------

/**
 * Determine eligibility for a single tier against the request. Returns
 * { eligible, reasons } where reasons is an array — empty when eligible.
 * Hard-ineligible reasons short-circuit scoring.
 */
function eligibility(tier, req, demand, minCeiling) {
  const reasons = [];
  if (tier.ceiling < minCeiling) {
    reasons.push(
      `ceiling_below_risk: tier.ceiling=${tier.ceiling} < min_required=${minCeiling} ` +
      `(risk_level=${req.risk_level})`,
    );
  }
  if (tier.ceiling < demand) {
    reasons.push(
      `ceiling_below_complexity: tier.ceiling=${tier.ceiling} < demand=${demand}`,
    );
  }
  const latLimit = req.latency_budget_ms * LAT_SAFETY;
  if (tier.lat_p50_ms > latLimit) {
    reasons.push(
      `latency_exceeds_budget: tier.lat_p50_ms=${tier.lat_p50_ms} > ` +
      `budget*${LAT_SAFETY}=${latLimit.toFixed(1)}`,
    );
  }
  return { eligible: reasons.length === 0, reasons };
}

/**
 * Compute the action score S for a tier. Lower S = preferred path.
 * Returns the score AND the named components, so the decision frame can
 * carry a full audit of how the number was assembled.
 */
function actionFor(tier, req, demand, maxCost) {
  const lat_term = WEIGHTS.lat *
    (tier.lat_p50_ms / Math.max(1, req.latency_budget_ms));

  // capability headroom — positive means tier overshoots, which is mildly
  // wasteful; negative means undershoots (caught by hard ineligibility).
  // We use (ceiling - demand) / max(ceiling, demand) so the term is bounded.
  const denom = Math.max(tier.ceiling, demand, 1);
  const headroom = (tier.ceiling - demand) / denom;
  // Penalty grows when headroom is large (overshoot) OR when headroom is
  // negative (undershoot). We use |1 - clamp(headroom, 0, 1)| inverted:
  //   tier exactly matches demand -> headroom = 0   -> penalty 1
  //   tier 2x demand              -> headroom ~ .5  -> penalty 0.5
  //   tier == demand              -> headroom = 0   -> penalty 1
  // We want to softly prefer "just enough" capability. Use
  //   cap_penalty = max(0, 1 - max(0, headroom))
  // so undershoots and exact-fits are penalized equally (1.0) and large
  // overshoots are penalized less (closer to 0).
  // NOTE: we accept that this term is intentionally small — the dominant
  // capability check is the hard ineligibility gate above.
  const cap_term = WEIGHTS.cap *
    Math.max(0, 1 - Math.max(0, headroom));

  const cost_norm = maxCost > 0 ? tier.cost_per_call_usd / maxCost : 0;
  const cost_term = WEIGHTS.cost * cost_norm;

  const key = bucket(req.intent_complexity) + '|' + bucket(req.risk_level);
  const fit_score = tier.fit_priors[key] ?? 0;
  const fit_term = WEIGHTS.fit * fit_score;

  const S = lat_term + cap_term + cost_term - fit_term;

  return {
    score: S,
    components: {
      lat_term,
      cap_term,
      cost_term,
      fit_term,
      fit_score,
      headroom,
      bucket_key: key,
    },
  };
}

// ---------------------------------------------------------------------------
// route()
// ---------------------------------------------------------------------------

/**
 * Pick the least-action tier for the request.
 *
 * @param {Object} request
 * @param {number} request.intent_complexity   0-10
 * @param {number} request.risk_level          0-10
 * @param {number} request.latency_budget_ms   >=0
 * @param {string[]} [request.capabilities]    optional declared capability ids
 * @param {Object} [opts]
 * @param {number} [opts.ts]                   unix ms — test override
 * @returns {Object} RouteDecision frame
 */
export function route(request, opts = {}) {
  const v = validateRequest(request);
  if (!v.valid) {
    return {
      schema: ROUTE_SCHEMA_ID,
      decision_id: null,
      error: 'invalid_request',
      errors: v.errors,
      created_at: new Date(typeof opts.ts === 'number' ? opts.ts : Date.now()).toISOString(),
    };
  }

  const demand = complexityToDemand(request.intent_complexity);
  const minCeiling = riskToMinCeiling(request.risk_level);

  // Normalize cost denominator across the full tier table — using the
  // table max (not just the eligible-subset max) keeps the cost term
  // comparable across requests with different eligibility shapes.
  const maxCost = TIERS.reduce((m, t) => Math.max(m, t.cost_per_call_usd), 0);

  // 1) Score every tier; mark ineligible ones with reasons.
  const scorecard = TIERS.map((tier) => {
    const elig = eligibility(tier, request, demand, minCeiling);
    if (!elig.eligible) {
      return {
        tier_id: tier.id,
        label: tier.label,
        class: tier.class,
        nameplate: tier.nameplate,
        eligible: false,
        reasons: elig.reasons,
        action: null,
        components: null,
      };
    }
    const a = actionFor(tier, request, demand, maxCost);
    return {
      tier_id: tier.id,
      label: tier.label,
      class: tier.class,
      nameplate: tier.nameplate,
      eligible: true,
      reasons: [],
      action: a.score,
      components: a.components,
    };
  });

  // 2) Among eligible, pick the lowest action. Tie-break: cheaper tier
  // (reflex < heavy < frontier) by index in TIERS.
  const eligible = scorecard.filter((s) => s.eligible);
  let chosen = null;
  let route_reason = null;
  if (eligible.length === 0) {
    route_reason = 'no_eligible_tier';
  } else {
    // Sort by (action asc, TIERS index asc)
    const indexOf = new Map(TIERS.map((t, i) => [t.id, i]));
    eligible.sort((a, b) => {
      if (a.action !== b.action) return a.action - b.action;
      return indexOf.get(a.tier_id) - indexOf.get(b.tier_id);
    });
    chosen = eligible[0];
    route_reason = 'least_action';
  }

  // 3) Assemble the decision frame.
  const structured = {
    request: {
      intent_complexity: request.intent_complexity,
      risk_level: request.risk_level,
      latency_budget_ms: request.latency_budget_ms,
      capabilities: Array.isArray(request.capabilities)
        ? [...request.capabilities].sort()
        : [],
    },
    derived: {
      demand,
      min_ceiling: minCeiling,
      bucket_key: bucket(request.intent_complexity) + '|' + bucket(request.risk_level),
      lat_safety: LAT_SAFETY,
      max_cost_in_table: maxCost,
    },
    weights: { ...WEIGHTS },
    scorecard,
    chosen_tier: chosen ? chosen.tier_id : null,
    route_reason,
  };

  const decision_id = sha256(canonicalStringify(structured));
  const created_at = new Date(typeof opts.ts === 'number' ? opts.ts : Date.now()).toISOString();

  return {
    schema: ROUTE_SCHEMA_ID,
    decision_id,
    request: structured.request,
    derived: structured.derived,
    weights: structured.weights,
    scorecard: structured.scorecard,
    chosen_tier: structured.chosen_tier,
    route_reason: structured.route_reason,
    created_at,
  };
}

// ---------------------------------------------------------------------------
// validate()
// ---------------------------------------------------------------------------

/**
 * Validate a RouteDecision frame, including decision_id integrity.
 *
 * @param {unknown} decision
 * @returns {{valid: boolean, errors: string[]}}
 */
export function validate(decision) {
  const errors = [];
  if (decision == null || typeof decision !== 'object' || Array.isArray(decision)) {
    return { valid: false, errors: ['decision must be a non-null object'] };
  }
  if (decision.schema !== ROUTE_SCHEMA_ID) {
    errors.push(`schema must be '${ROUTE_SCHEMA_ID}', got '${decision.schema}'`);
  }
  // Error frames are valid as long as they declare the schema, an error
  // string, an errors[] list, and created_at.
  if ('error' in decision) {
    if (typeof decision.error !== 'string') errors.push('error must be a string');
    if (!Array.isArray(decision.errors)) errors.push('errors must be an array');
    if (typeof decision.created_at !== 'string' ||
        Number.isNaN(Date.parse(decision.created_at))) {
      errors.push('created_at must be parseable ISO 8601 string');
    }
    return { valid: errors.length === 0, errors };
  }

  for (const f of ['decision_id', 'request', 'derived', 'weights', 'scorecard',
                   'route_reason', 'created_at']) {
    if (!(f in decision)) errors.push(`missing required field: ${f}`);
  }
  if (!('chosen_tier' in decision)) errors.push('missing required field: chosen_tier');
  if (errors.length) return { valid: false, errors };

  if (!/^[a-f0-9]{64}$/.test(decision.decision_id || '')) {
    errors.push('decision_id must be 64-char lowercase hex (sha256)');
  }
  if (!Array.isArray(decision.scorecard)) {
    errors.push('scorecard must be an array');
  }
  if (decision.chosen_tier !== null &&
      !TIERS.some((t) => t.id === decision.chosen_tier)) {
    errors.push(`chosen_tier '${decision.chosen_tier}' is not a known tier id`);
  }
  if (typeof decision.created_at !== 'string' ||
      Number.isNaN(Date.parse(decision.created_at))) {
    errors.push('created_at must be parseable ISO 8601 string');
  }
  if (errors.length) return { valid: false, errors };

  // decision_id integrity — recompute over the structured slots only.
  const structured = {
    request: decision.request,
    derived: decision.derived,
    weights: decision.weights,
    scorecard: decision.scorecard,
    chosen_tier: decision.chosen_tier,
    route_reason: decision.route_reason,
  };
  const expectedId = sha256(canonicalStringify(structured));
  if (expectedId !== decision.decision_id) {
    errors.push(
      `decision_id integrity: expected ${expectedId}, got ${decision.decision_id} ` +
      `(frame tampered or canonicalization drift)`,
    );
  }

  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Internals for downstream tooling / tests
// ---------------------------------------------------------------------------

export const __internals = Object.freeze({
  canonicalStringify,
  sha256,
  validateRequest,
  eligibility,
  actionFor,
  complexityToDemand,
  riskToMinCeiling,
  bucket,
  LAT_SAFETY,
});
