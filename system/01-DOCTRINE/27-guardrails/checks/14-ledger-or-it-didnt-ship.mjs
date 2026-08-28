// 14 — G-13 — Ledger-or-it-didn't-ship.
//
// Online check. A deliverable claiming `shipped` must present all four
// fields, all verified:
//   - zip_path        : exists on disk
//   - sha256          : matches sha256 of zip_path
//   - ledger_row_id   : present in 10-RECEIPTS/ledger.db (caller must
//                       provide a `state.ledgerHasRow(id)` predicate or
//                       a `state.ledgerRowIds` Set/Array we can look up)
//   - present_files   : non-empty array of files actually present
//
// state.deliverable : {
//   id, zip_path, sha256, ledger_row_id, present_files, claimed_status
// }
// state.ledgerRowIds : Set<number> | Array<number>   (optional)

import {
  safe,
  result,
  fileExists,
  sha256OfFile,
} from "../lib/check-util.mjs";

export const id = "G-13";
export const slug = "ledger-or-it-didnt-ship";
export const severity = "block";

export const check = safe(async (state, _opts) => {
  const d = state.deliverable;
  if (!d) {
    return result(false, {
      reason: "no_deliverable_supplied",
      receipt_trigger: "G13_DELIVERABLE_WITHOUT_LEDGER",
    });
  }
  if (d.claimed_status !== "shipped") {
    return result(true, {
      note: "claim_is_not_shipped",
      claimed_status: d.claimed_status,
    });
  }
  const missing = [];
  for (const k of ["zip_path", "sha256", "ledger_row_id", "present_files"]) {
    if (d[k] === undefined || d[k] === null || d[k] === "") missing.push(k);
  }
  if (missing.length > 0) {
    return result(false, {
      reason: "missing_emission_fields",
      missing,
      receipt_trigger: "G13_DELIVERABLE_WITHOUT_LEDGER",
    });
  }
  if (!fileExists(d.zip_path)) {
    return result(false, {
      reason: "zip_not_on_disk",
      zip_path: d.zip_path,
      receipt_trigger: "G13_DELIVERABLE_WITHOUT_LEDGER",
    });
  }
  const observed = sha256OfFile(d.zip_path);
  if (observed !== d.sha256) {
    return result(false, {
      reason: "sha256_mismatch",
      claimed_sha256: d.sha256,
      observed_sha256: observed,
      zip_path: d.zip_path,
      receipt_trigger: "G13_DELIVERABLE_WITHOUT_LEDGER",
    });
  }
  if (!Array.isArray(d.present_files) || d.present_files.length === 0) {
    return result(false, {
      reason: "present_files_empty",
      receipt_trigger: "G13_DELIVERABLE_WITHOUT_LEDGER",
    });
  }

  const ledger = state.ledgerRowIds;
  let ledgerOk = null;
  if (typeof state.ledgerHasRow === "function") {
    ledgerOk = Boolean(state.ledgerHasRow(d.ledger_row_id));
  } else if (ledger instanceof Set) {
    ledgerOk = ledger.has(d.ledger_row_id);
  } else if (Array.isArray(ledger)) {
    ledgerOk = ledger.includes(d.ledger_row_id);
  }
  if (ledgerOk === false) {
    return result(false, {
      reason: "ledger_row_not_found",
      ledger_row_id: d.ledger_row_id,
      receipt_trigger: "G13_DELIVERABLE_WITHOUT_LEDGER",
    });
  }

  return result(true, {
    zip_path: d.zip_path,
    sha256: d.sha256,
    ledger_row_id: d.ledger_row_id,
    present_files_count: d.present_files.length,
    ledger_lookup_performed: ledgerOk !== null,
  });
});

export default check;
