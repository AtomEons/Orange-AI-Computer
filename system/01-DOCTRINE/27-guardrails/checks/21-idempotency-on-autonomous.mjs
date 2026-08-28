// 21 — G-20 — Idempotency on all autonomous actions.
//
// Online check. Every autonomous action must carry an idempotency_key,
// and the action store must dedupe duplicate keys.
//
// state.autonomousActions : Array<{
//   id, idempotency_key, name, ts, result_hash?
// }>
//
// Two failure modes:
//   - action without idempotency_key
//   - duplicate idempotency_key but with diverging result_hash
//     (a true dedupe would return the prior result; divergence means the
//     action ran twice with different outputs)

import { safe, result } from "../lib/check-util.mjs";

export const id = "G-20";
export const slug = "idempotency-on-autonomous";
export const severity = "block";

export const check = safe(async (state, _opts) => {
  const actions = Array.isArray(state.autonomousActions)
    ? state.autonomousActions
    : [];
  const missing = [];
  const dedupeFails = new Map(); // key -> Set<result_hash>

  for (const a of actions) {
    if (!a) continue;
    if (
      typeof a.idempotency_key !== "string" ||
      a.idempotency_key.length === 0
    ) {
      missing.push({ id: a.id, name: a.name, ts: a.ts });
      continue;
    }
    if (a.result_hash) {
      const s = dedupeFails.get(a.idempotency_key) || new Set();
      s.add(a.result_hash);
      dedupeFails.set(a.idempotency_key, s);
    }
  }

  const divergent = [];
  for (const [k, set] of dedupeFails) {
    if (set.size > 1) divergent.push({ key: k, distinct_results: set.size });
  }

  if (missing.length > 0 || divergent.length > 0) {
    return result(false, {
      reason: "idempotency_violation",
      missing_keys: missing.slice(0, 50),
      divergent_keys: divergent.slice(0, 50),
      actions_checked: actions.length,
      receipt_trigger: "G20_NON_IDEMPOTENT_ACTION",
    });
  }
  return result(true, { actions_checked: actions.length });
});

export default check;
