// 24 — G-23 — Model routing is explicit, not implicit.
//
// Online check. Every model invocation must name `model_id`. The router
// rejects calls without it; this check audits recent calls and flags any
// missing-or-empty model_id.
//
// state.modelCalls : Array<{
//   id, model_id, caller, ts, lane?
// }>

import { safe, result } from "../lib/check-util.mjs";

export const id = "G-23";
export const slug = "explicit-model-routing";
export const severity = "block";

export const check = safe(async (state, _opts) => {
  const calls = Array.isArray(state.modelCalls) ? state.modelCalls : [];
  const offenders = [];
  for (const c of calls) {
    if (!c) continue;
    if (typeof c.model_id !== "string" || c.model_id.length === 0) {
      offenders.push({ id: c.id, caller: c.caller, ts: c.ts, lane: c.lane });
    }
  }
  if (offenders.length > 0) {
    return result(false, {
      reason: "implicit_model_route",
      offenders: offenders.slice(0, 50),
      calls_checked: calls.length,
      receipt_trigger: "G23_IMPLICIT_MODEL_ROUTE",
    });
  }
  return result(true, {
    calls_checked: calls.length,
    distinct_models: Array.from(new Set(calls.map((c) => c.model_id))),
  });
});

export default check;
