// 23 — G-22 — Deterministic validators on every gate output.
//
// Online check. Every registered validator must declare `determinism:true`
// AND have passed the registrar's 3x repeat-call canary. If `state` carries
// `validatorRegistry` we audit it directly; if `state.runCanary` is a
// function, we exercise it once more here.
//
// state.validatorRegistry : Array<{
//   name, determinism: boolean,
//   canary_outputs: Array<string>,  // 3 hashes of canary outputs
// }>
// state.runCanary?(validator_name) : Promise<Array<string>>

import { safe, result, sha256OfString } from "../lib/check-util.mjs";

export const id = "G-22";
export const slug = "deterministic-validators";
export const severity = "block";

function allEqual(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return false;
  return arr.every((v) => v === arr[0]);
}

export const check = safe(async (state, _opts) => {
  const reg = Array.isArray(state.validatorRegistry)
    ? state.validatorRegistry
    : [];
  if (reg.length === 0) {
    return result(false, {
      reason: "empty_validator_registry",
      receipt_trigger: "G22_NONDETERMINISTIC_VALIDATOR",
      remedy:
        "The control plane has no validators registered. Register every gate validator through the registrar so the determinism canary runs.",
    });
  }
  const offenders = [];
  for (const v of reg) {
    if (!v) continue;
    if (v.determinism !== true) {
      offenders.push({
        name: v.name,
        reason: "determinism_flag_missing_or_false",
      });
      continue;
    }
    let outs = Array.isArray(v.canary_outputs) ? v.canary_outputs : null;
    if (!outs && typeof state.runCanary === "function") {
      const raw = await state.runCanary(v.name);
      outs = raw.map((s) => sha256OfString(JSON.stringify(s)));
    }
    if (!outs || outs.length < 3) {
      offenders.push({
        name: v.name,
        reason: "no_canary_outputs_recorded",
        observed: outs ? outs.length : 0,
      });
      continue;
    }
    if (!allEqual(outs)) {
      offenders.push({
        name: v.name,
        reason: "canary_outputs_differ",
        outputs: outs,
      });
    }
  }
  if (offenders.length > 0) {
    return result(false, {
      reason: "non_deterministic_validators",
      offenders,
      registry_size: reg.length,
      receipt_trigger: "G22_NONDETERMINISTIC_VALIDATOR",
    });
  }
  return result(true, { registry_size: reg.length });
});

export default check;
