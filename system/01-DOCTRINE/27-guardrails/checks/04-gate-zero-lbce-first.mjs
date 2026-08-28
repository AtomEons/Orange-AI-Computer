// 04 — G-03 — Gate 0 is LatticeIntegrityGate (LBCE), first in every gate chain.
//
// Online check. The runtime maintains a registry of gate chains in
// `state.gateChains` — an object keyed by chain-id, value is an array of
// gate symbols in execution order.
//
// Invariant: for every chain, chain[0] === "LatticeIntegrityGate".
// Empty chains are themselves a violation: a gateless action path is a
// constitutional reorder by omission.
//
// state.gateChains : { [chainId: string]: string[] }
//
// opts:
//   opts.expectedGate0 : string — override (default "LatticeIntegrityGate")

import { safe, result } from "../lib/check-util.mjs";

export const id = "G-03";
export const slug = "gate-zero-lbce-first";
export const severity = "block";

export const check = safe(async (state, opts) => {
  const expected = opts.expectedGate0 || "LatticeIntegrityGate";
  const chains = state.gateChains;

  if (!chains || typeof chains !== "object") {
    return result(false, {
      reason: "no_gate_chain_registry",
      receipt_trigger: "G03_GATE0_REORDERED",
      remedy:
        "The control plane has no gate chain registry to audit. Register every chain through `online_checks.assertGate0Lbce` before any action dispatch.",
    });
  }

  const offenders = [];
  const chainIds = Object.keys(chains);
  for (const id of chainIds) {
    const chain = chains[id];
    if (!Array.isArray(chain) || chain.length === 0) {
      offenders.push({ chain_id: id, problem: "empty_or_invalid" });
      continue;
    }
    if (chain[0] !== expected) {
      offenders.push({
        chain_id: id,
        problem: "wrong_gate_0",
        observed_gate_0: chain[0],
        expected_gate_0: expected,
        full_chain: chain,
      });
    }
  }

  if (offenders.length > 0) {
    return result(false, {
      reason: "gate_zero_violation",
      offenders,
      chain_count: chainIds.length,
      receipt_trigger: "G03_GATE0_REORDERED",
    });
  }

  return result(true, {
    chain_count: chainIds.length,
    gate_0: expected,
  });
});

export default check;
