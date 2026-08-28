// Hermes lease — bounded agentic execution contract.

/**
 * @typedef {Object} HermesLease
 * @property {string} id
 * @property {string} actor          — which LLM or agent holds this lease
 * @property {string[]} allowed      — allowedActions verbs
 * @property {string[]} forbidden    — forbiddenActions verbs
 * @property {string} targetProject
 * @property {'read_only'|'low'|'medium'|'high'|'destructive'|'production'} riskLevel
 * @property {number} expires_at
 * @property {boolean} requires_approval
 */

const DEFAULT_FORBIDDEN = ["destructive_write", "production_deploy", "scope_expansion", "egress_unbounded"];

let counter = 0;
function newId() { counter += 1; return `lease_${Date.now()}_${counter}`; }

/** Create a Hermes lease. */
export function grantLease({ actor, allowed = [], forbidden = [], targetProject, riskLevel = "low", ttl_ms = 600_000, requires_approval = false }) {
  const merged_forbidden = Array.from(new Set([...DEFAULT_FORBIDDEN, ...forbidden]));
  // overlap check — allowed cannot include any forbidden
  for (const a of allowed) {
    if (merged_forbidden.includes(a)) {
      throw new Error(`lease conflict: action "${a}" is both allowed and forbidden`);
    }
  }
  if (["high", "destructive", "production"].includes(riskLevel)) {
    requires_approval = true;
  }
  return {
    id: newId(),
    actor,
    allowed,
    forbidden: merged_forbidden,
    targetProject,
    riskLevel,
    expires_at: Date.now() + ttl_ms,
    requires_approval,
  };
}

/** Check whether a proposed action is permitted by the lease. */
export function checkAction(lease, action, { operator_approved = false } = {}) {
  if (Date.now() > lease.expires_at) return { allowed: false, reason: "lease_expired" };
  if (lease.forbidden.includes(action)) return { allowed: false, reason: `action_forbidden:${action}` };
  if (!lease.allowed.includes(action)) return { allowed: false, reason: `action_not_in_allowlist:${action}` };
  if (lease.requires_approval && !operator_approved) return { allowed: false, reason: "operator_approval_required" };
  return { allowed: true };
}
