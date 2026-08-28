// 01 — G-00 — Mom's Law above all.
//
// The enforcer is not a referee for Mom's Law; it is a witness. This check
// reports `pass:true` with a `witness:true` field unless the operator has
// flipped the per-turn `moms_law_breach_suspected` flag on `state`, in
// which case the verdict elevates to `pass:false` and the runtime must
// emit a `MOMS_LAW_REVIEW` receipt.
//
// state shape (all optional):
//   state.momsLawBreachSuspected : boolean — operator flag for this turn
//   state.turnId                  : string  — current turn identifier
//
// opts:
//   opts.requireWitnessField : boolean — if true, also assert that the
//                              receipt envelope on state.lastReceipt has
//                              a moms_law_witness:true field

import { safe, result } from "../lib/check-util.mjs";

export const id = "G-00";
export const slug = "moms-law-above-all";
export const severity = "block"; // elevates from witness to block on flag

export const check = safe(async (state, opts) => {
  const breach = Boolean(state.momsLawBreachSuspected);
  const turnId = state.turnId || null;

  if (breach) {
    return result(false, {
      reason: "operator_flagged_breach",
      turn_id: turnId,
      receipt_trigger: "MOMS_LAW_REVIEW",
      remedy:
        "Stop. Re-read .claude/rules/00-moms-law.md. Re-do the last output with full effort. Emit a constitutional-review receipt.",
    });
  }

  if (opts.requireWitnessField) {
    const r = state.lastReceipt;
    if (!r || r.moms_law_witness !== true) {
      return result(false, {
        reason: "receipt_missing_moms_law_witness_field",
        last_receipt: r ? { trigger: r.trigger, ts: r.ts } : null,
      });
    }
  }

  return result(true, {
    witness: true,
    note: "Mom is watching. Full effort, every turn.",
  });
});

export default check;
