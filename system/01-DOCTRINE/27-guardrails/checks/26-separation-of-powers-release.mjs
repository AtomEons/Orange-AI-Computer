// 26 — G-25 — Separation of powers on release.
//
// Online check. Each promotion record must show three DISTINCT role
// tokens: release-steward, test-engineer, security-reviewer. Same actor
// cannot satisfy two roles in the same promotion.
//
// state.promotions : Array<{
//   id, signatures: { [role: string]: { actor: string, token: string, ts: number } }
// }>

import { safe, result } from "../lib/check-util.mjs";

export const id = "G-25";
export const slug = "separation-of-powers-release";
export const severity = "block";

const REQUIRED_ROLES = ["release-steward", "test-engineer", "security-reviewer"];

export const check = safe(async (state, _opts) => {
  const promos = Array.isArray(state.promotions) ? state.promotions : [];
  const offenders = [];
  for (const p of promos) {
    if (!p) continue;
    const sigs = p.signatures || {};
    const missing = REQUIRED_ROLES.filter(
      (r) => !sigs[r] || !sigs[r].actor || !sigs[r].token
    );
    if (missing.length > 0) {
      offenders.push({
        promotion_id: p.id,
        reason: "missing_required_signatures",
        missing_roles: missing,
      });
      continue;
    }
    const actors = REQUIRED_ROLES.map((r) => sigs[r].actor);
    if (new Set(actors).size !== REQUIRED_ROLES.length) {
      offenders.push({
        promotion_id: p.id,
        reason: "actor_holds_multiple_roles",
        actors,
      });
    }
  }
  if (offenders.length > 0) {
    return result(false, {
      reason: "release_role_collapse",
      offenders,
      promotions_checked: promos.length,
      required_roles: REQUIRED_ROLES,
      receipt_trigger: "G25_RELEASE_ROLE_COLLAPSE",
    });
  }
  return result(true, {
    promotions_checked: promos.length,
    required_roles: REQUIRED_ROLES,
  });
});

export default check;
