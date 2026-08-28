// 22 — G-21 — Retry caps on all outbound calls.
//
// Online check. The outbound HTTP client publishes a registry of recent
// call families, each with a max-attempts cap and an observed retry count.
//
// state.outboundCalls : Array<{
//   id, host, attempts: number, max_attempts: number, ts, completed: boolean
// }>
//
// opts.defaultMaxAttempts : number — default 3
//
// A breach is:
//   - attempts > max_attempts (cap was bypassed), OR
//   - max_attempts > defaultMaxAttempts AND no override receipt id
//     present on the call (`override_receipt_id` field)

import { safe, result } from "../lib/check-util.mjs";

export const id = "G-21";
export const slug = "retry-caps-on-outbound";
export const severity = "block";

export const check = safe(async (state, opts) => {
  const def = Number.isFinite(opts.defaultMaxAttempts)
    ? opts.defaultMaxAttempts
    : 3;
  const calls = Array.isArray(state.outboundCalls) ? state.outboundCalls : [];
  const offenders = [];
  for (const c of calls) {
    if (!c) continue;
    if (typeof c.max_attempts !== "number" || c.max_attempts < 1) {
      offenders.push({ ...c, reason: "no_max_attempts_set" });
      continue;
    }
    if (c.attempts > c.max_attempts) {
      offenders.push({ ...c, reason: "attempts_exceeded_cap" });
      continue;
    }
    if (c.max_attempts > def && !c.override_receipt_id) {
      offenders.push({
        ...c,
        reason: "max_attempts_above_default_without_override_receipt",
        default_max_attempts: def,
      });
    }
  }
  if (offenders.length > 0) {
    return result(false, {
      reason: "retry_cap_violation",
      offenders: offenders.slice(0, 50),
      calls_checked: calls.length,
      default_max_attempts: def,
      receipt_trigger: "G21_RETRY_CAP_BYPASS",
    });
  }
  return result(true, {
    calls_checked: calls.length,
    default_max_attempts: def,
  });
});

export default check;
