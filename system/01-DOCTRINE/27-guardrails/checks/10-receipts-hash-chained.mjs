// 10 — G-09 — Receipts are hash-chained (prev_hash → sha256 → this_hash).
//
// Online check. Given a window of recent receipts, verify the chain.
//
// state.recentReceipts : Array<{
//   id: number,
//   ts: number,
//   prev_hash: string,
//   this_hash: string,
//   body: object | string  // canonical JSON or stringified
// }>
//
// For each row i > 0: row[i].prev_hash must === row[i-1].this_hash, and
// sha256(row[i].prev_hash + canonical(body)) must === row[i].this_hash.

import { safe, result, sha256OfString } from "../lib/check-util.mjs";

export const id = "G-09";
export const slug = "receipts-hash-chained";
export const severity = "block";

function canonical(body) {
  if (typeof body === "string") return body;
  if (body === null || body === undefined) return "";
  // Deterministic stringification: sort keys recursively.
  const sortKeys = (v) => {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v && typeof v === "object") {
      const out = {};
      for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(sortKeys(body));
}

export const check = safe(async (state, _opts) => {
  const rows = Array.isArray(state.recentReceipts)
    ? state.recentReceipts
    : null;
  if (!rows) {
    return result(false, {
      reason: "no_receipt_window",
      receipt_trigger: "G09_RECEIPT_CHAIN_BREAK",
      remedy:
        "Pass state.recentReceipts (the tail of 10-RECEIPTS/ledger.db). The chain cannot be witnessed without rows.",
    });
  }
  if (rows.length === 0) {
    return result(true, { rows_checked: 0, note: "empty_window" });
  }

  const breaks = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const prev = i === 0 ? null : rows[i - 1];
    if (prev && r.prev_hash !== prev.this_hash) {
      breaks.push({
        index: i,
        id: r.id,
        reason: "prev_hash_mismatch",
        observed_prev_hash: r.prev_hash,
        expected_prev_hash: prev.this_hash,
      });
      continue;
    }
    const expected = sha256OfString(
      (r.prev_hash || "") + canonical(r.body)
    );
    if (expected !== r.this_hash) {
      breaks.push({
        index: i,
        id: r.id,
        reason: "this_hash_mismatch",
        observed_this_hash: r.this_hash,
        recomputed_this_hash: expected,
      });
    }
  }

  if (breaks.length > 0) {
    return result(false, {
      reason: "chain_break",
      rows_checked: rows.length,
      breaks,
      receipt_trigger: "G09_RECEIPT_CHAIN_BREAK",
    });
  }

  return result(true, {
    rows_checked: rows.length,
    head_hash: rows[rows.length - 1].this_hash,
    tail_hash: rows[0].this_hash,
  });
});

export default check;
