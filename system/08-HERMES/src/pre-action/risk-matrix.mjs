// 08-HERMES/src/pre-action/risk-matrix.mjs
//
// Pure deterministic risk matrix for the Hermes pre-action middleware.
//
// Maps (action_verb, target_project, lease_risk_level, evidence_hint) to a
// verdict { required_second_opinion, blocking, effective_risk, ... } that the
// caller (Wave 3-04 Hermes middleware) uses to decide whether to invoke
// the AE Misfit second-opinion gate at 04-CONTROL-PLANE/misfit/second-opinion.mjs.
//
// Doctrine anchor (Wave 2 #027 + Wave 3-04 + this workflow):
//   - low:      no second-opinion required; falls through to LOOM 8 gates
//   - medium:   second-opinion advisory (logged, non-blocking)
//   - high:     second-opinion blocking (REFUSE blocks; CONFIRM proceeds)
//   - critical: second-opinion + human approval BOTH required
//
// Mom's Law: the matrix is pure. No clock, no fs, no env reads, no rand.
// Same inputs → same verdict. Forever.
//
// Schema: orange5.hermes.risk-matrix.v0
// Sovereign: Atom McCree

// ----------------------------------------------------------------------------
// Constants

export const SCHEMA = "orange5.hermes.risk-matrix.v0";

// Canonical risk ladder. Order matters: index = severity rank.
export const RISK_LADDER = ["low", "medium", "high", "critical"];

// Intrinsic risk of each action verb. The lease.risk_level can only RAISE
// this floor (never lower it). The matrix is a max-of-floors, not a vote.
//
// Required by the spec:
//   production_deploy = critical
//   schema_migration  = high
//   destructive_write = critical
//   file_create       = low
//   query_only        = low
export const ACTION_VERB_RISK = Object.freeze({
  // Read-shaped
  query_only: "low",
  read_file: "low",
  list_dir: "low",
  grep: "low",

  // Write-shaped (non-destructive)
  file_create: "low",
  file_append: "low",
  file_edit: "medium",

  // Structural / state-changing
  schema_migration: "high",
  config_change: "medium",
  branch_create: "low",
  push_branch: "high",
  merge_branch: "high",

  // Destructive
  destructive_write: "critical",
  file_delete: "high",
  table_drop: "critical",

  // Deploy / release
  production_deploy: "critical",
  staging_deploy: "high",

  // External / network side effects
  external_api_call: "medium",
  send_email: "medium",
  payment_charge: "critical",
});

// Projects with a known production posture get an extra bump on write-shaped
// verbs. Read-only verbs are untouched. Unknown projects = neutral.
const PRODUCTION_PROJECTS = new Set([
  "orange5-prod",
  "atomeons-prod",
  "skilski-live",
  "atomeons-payments",
]);

// Evidence hints can shift severity by one rung in either direction. They
// never cross the critical ceiling downward (critical stays critical unless
// the hint is "verified_with_human_signoff", which moves it to high).
const EVIDENCE_HINTS = Object.freeze({
  verified_with_human_signoff: -2,  // human in loop already → can drop two
  verified: -1,                     // receipts present, signed
  unverified: 0,                    // neutral
  missing: +1,                      // no evidence → bump up
  contradicted: +2,                 // active red flag
});

// Read-shaped verbs that should never be bumped by project sensitivity.
const READ_SHAPED_VERBS = new Set(["query_only", "read_file", "list_dir", "grep"]);

// ----------------------------------------------------------------------------
// Helpers (pure)

function rankOf(level) {
  const idx = RISK_LADDER.indexOf(String(level || "").toLowerCase());
  return idx < 0 ? 0 : idx;
}

function levelAt(rank) {
  if (rank < 0) return RISK_LADDER[0];
  if (rank >= RISK_LADDER.length) return RISK_LADDER[RISK_LADDER.length - 1];
  return RISK_LADDER[rank];
}

function intrinsicRiskOf(verb) {
  if (typeof verb !== "string") return "medium";
  const v = verb.trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(ACTION_VERB_RISK, v)) {
    return ACTION_VERB_RISK[v];
  }
  // Unknown verbs are treated as MEDIUM by default — not low. Surprise verbs
  // must earn a low rating, not get it by accident. Mom's Law on unknowns.
  return "medium";
}

function evidenceDelta(hint) {
  if (typeof hint !== "string") return 0;
  const h = hint.trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(EVIDENCE_HINTS, h)) {
    return EVIDENCE_HINTS[h];
  }
  return 0;
}

function isProductionProject(targetProject) {
  if (typeof targetProject !== "string") return false;
  return PRODUCTION_PROJECTS.has(targetProject.trim().toLowerCase());
}

// ----------------------------------------------------------------------------
// Verdict mapping

/**
 * Map an effective risk level to a deterministic verdict.
 * Pure: same input → same output.
 *
 * @param {string} effectiveRisk one of RISK_LADDER values
 * @returns {{
 *   required_second_opinion: boolean,
 *   blocking: boolean,
 *   advisory: boolean,
 *   requires_human_approval: boolean,
 * }}
 */
export function verdictForLevel(effectiveRisk) {
  switch (effectiveRisk) {
    case "low":
      return {
        required_second_opinion: false,
        blocking: false,
        advisory: false,
        requires_human_approval: false,
      };
    case "medium":
      return {
        required_second_opinion: true,
        blocking: false,
        advisory: true,
        requires_human_approval: false,
      };
    case "high":
      return {
        required_second_opinion: true,
        blocking: true,
        advisory: false,
        requires_human_approval: false,
      };
    case "critical":
      return {
        required_second_opinion: true,
        blocking: true,
        advisory: false,
        requires_human_approval: true,
      };
    default:
      // Defensive: unknown level treats as high. Pure, no throw.
      return {
        required_second_opinion: true,
        blocking: true,
        advisory: false,
        requires_human_approval: false,
      };
  }
}

// ----------------------------------------------------------------------------
// Public API

/**
 * Compute the deterministic risk verdict for a proposed Hermes action.
 *
 * @param {Object} input
 * @param {string} input.action_verb     - e.g. "production_deploy", "file_create", "query_only"
 * @param {string} [input.target_project] - e.g. "orange5", "skilski-live"
 * @param {string} [input.lease_risk_level] - the lease's declared risk_level; raises floor
 * @param {string} [input.evidence_hint]    - one of EVIDENCE_HINTS keys, or omitted
 *
 * @returns {{
 *   schema: string,
 *   effective_risk: 'low'|'medium'|'high'|'critical',
 *   required_second_opinion: boolean,
 *   blocking: boolean,
 *   advisory: boolean,
 *   requires_human_approval: boolean,
 *   inputs: { action_verb: string, target_project: string|null, lease_risk_level: string|null, evidence_hint: string|null },
 *   factors: { intrinsic: string, lease_floor: string, project_bump: number, evidence_delta: number },
 *   reason: string,
 * }}
 */
export function evaluateRisk(input = {}) {
  const action_verb = typeof input.action_verb === "string" ? input.action_verb.trim().toLowerCase() : "";
  const target_project = typeof input.target_project === "string" ? input.target_project.trim().toLowerCase() : null;
  const lease_risk_level = typeof input.lease_risk_level === "string" ? input.lease_risk_level.trim().toLowerCase() : null;
  const evidence_hint = typeof input.evidence_hint === "string" ? input.evidence_hint.trim().toLowerCase() : null;

  // 1. Intrinsic risk from the verb (the action's own gravity).
  const intrinsic = intrinsicRiskOf(action_verb);

  // 2. Lease floor: the lease's declared risk can only raise the floor.
  const leaseFloor = lease_risk_level || "low";

  // 3. Take the max of intrinsic and lease floor.
  let rank = Math.max(rankOf(intrinsic), rankOf(leaseFloor));

  // 4. Project bump: production projects add +1 for write-shaped verbs.
  let project_bump = 0;
  if (isProductionProject(target_project) && !READ_SHAPED_VERBS.has(action_verb)) {
    project_bump = 1;
    rank += 1;
  }

  // 5. Evidence delta: verified evidence can drop one rung; missing bumps up.
  const evidence_delta = evidenceDelta(evidence_hint);
  rank += evidence_delta;

  // 6. Clamp to ladder.
  if (rank < 0) rank = 0;
  if (rank >= RISK_LADDER.length) rank = RISK_LADDER.length - 1;

  const effective_risk = levelAt(rank);
  const verdict = verdictForLevel(effective_risk);

  const reasonParts = [
    `verb=${action_verb || "(missing)"} intrinsic=${intrinsic}`,
    `lease_floor=${leaseFloor}`,
  ];
  if (project_bump) reasonParts.push(`prod_project_bump=+${project_bump}`);
  if (evidence_delta) reasonParts.push(`evidence_delta=${evidence_delta >= 0 ? "+" : ""}${evidence_delta}`);
  reasonParts.push(`-> ${effective_risk}`);

  return {
    schema: SCHEMA,
    effective_risk,
    required_second_opinion: verdict.required_second_opinion,
    blocking: verdict.blocking,
    advisory: verdict.advisory,
    requires_human_approval: verdict.requires_human_approval,
    inputs: {
      action_verb: action_verb || "",
      target_project,
      lease_risk_level,
      evidence_hint,
    },
    factors: {
      intrinsic,
      lease_floor: leaseFloor,
      project_bump,
      evidence_delta,
    },
    reason: reasonParts.join(" | "),
  };
}

// Convenience export: many callers will prefer positional args matching the
// workflow spec wording: (action_verb, target_project, lease_risk_level, evidence_hint).
export function evaluateRiskPositional(action_verb, target_project, lease_risk_level, evidence_hint) {
  return evaluateRisk({ action_verb, target_project, lease_risk_level, evidence_hint });
}

// ----------------------------------------------------------------------------
// Internals exposed for tests / inspection.

export const __internals = Object.freeze({
  SCHEMA,
  RISK_LADDER,
  ACTION_VERB_RISK,
  PRODUCTION_PROJECTS,
  EVIDENCE_HINTS,
  READ_SHAPED_VERBS,
  rankOf,
  levelAt,
  intrinsicRiskOf,
  evidenceDelta,
  isProductionProject,
});
