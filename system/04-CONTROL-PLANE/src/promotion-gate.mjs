// PR-12 — no-fake-green promotion gate.
// Refuses to promote a candidate without: receipt path + bakeoff result + operator approval flag.

export const PROMOTION_RULES = {
  receipt_required: true,
  bakeoff_required: true,
  operator_approval_required_for: ["high", "destructive", "production"],
  forbid_words_in_status: ["green_assumed", "should_work", "looks_ok", "probably", "fake_green"],
};

/**
 * Decide promote / reject / hold.
 * @param {Object} candidate
 * @returns {{ verdict: 'promote'|'reject'|'hold', reasons: string[] }}
 */
export function evaluatePromotion(candidate) {
  const reasons = [];

  if (!candidate.receipt_path) reasons.push("missing receipt_path");
  if (!candidate.bakeoff || !candidate.bakeoff.result) reasons.push("missing bakeoff result");

  if (candidate.bakeoff?.result === "fail") reasons.push("bakeoff result = fail");

  const status = (candidate.status || "").toLowerCase();
  for (const w of PROMOTION_RULES.forbid_words_in_status) {
    if (status.includes(w)) reasons.push(`status contains forbidden word "${w}" (fake-green guard)`);
  }

  const risk = candidate.risk_level || "low";
  if (PROMOTION_RULES.operator_approval_required_for.includes(risk) && !candidate.operator_approved) {
    reasons.push(`risk_level=${risk} requires operator_approved=true`);
  }

  if (reasons.length === 0) return { verdict: "promote", reasons: [] };
  if (reasons.some(r => r.includes("bakeoff result = fail"))) return { verdict: "reject", reasons };
  return { verdict: "hold", reasons };
}
