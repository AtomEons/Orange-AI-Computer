// 25 — G-24 — No silent fall-back from Orange3 / Orangebox routing.
//
// Online check. The harness shim records every `Workflow` / parallel
// `Agent` spawn it has wrapped. A wrapped call is OK; an unwrapped call
// is a breach unless the operator typed an explicit override token into
// the current turn.
//
// state.parallelSpawns : Array<{
//   id, kind: "workflow"|"agent_parallel",
//   wrapped: boolean,
//   operator_override_token: string|null,
//   ts
// }>
// state.operatorOverrideTokens : Set<string> | string[] — tokens
//   currently authorized by the operator ("run direct" → opaque token)

import { safe, result } from "../lib/check-util.mjs";

export const id = "G-24";
export const slug = "no-silent-routing-bypass";
export const severity = "block";

export const check = safe(async (state, _opts) => {
  const spawns = Array.isArray(state.parallelSpawns) ? state.parallelSpawns : [];
  const authorized =
    state.operatorOverrideTokens instanceof Set
      ? state.operatorOverrideTokens
      : new Set(Array.isArray(state.operatorOverrideTokens)
          ? state.operatorOverrideTokens
          : []);

  const offenders = [];
  for (const s of spawns) {
    if (!s) continue;
    if (s.wrapped) continue;
    if (
      s.operator_override_token &&
      authorized.has(s.operator_override_token)
    ) {
      continue;
    }
    offenders.push({
      id: s.id,
      kind: s.kind,
      ts: s.ts,
      operator_override_token: s.operator_override_token || null,
      reason: s.operator_override_token
        ? "override_token_not_authorized_in_session"
        : "unwrapped_spawn_without_override",
    });
  }
  if (offenders.length > 0) {
    return result(false, {
      reason: "routing_bypass",
      offenders: offenders.slice(0, 50),
      spawns_checked: spawns.length,
      receipt_trigger: "G24_ROUTING_BYPASS",
      remedy:
        "Route an orange.order.v1 through the OrangeFive spine and OrangeBrain gateway. For a one-shot bypass, have the operator type 'run direct' and capture the token they hand you.",
    });
  }
  return result(true, { spawns_checked: spawns.length });
});

export default check;
