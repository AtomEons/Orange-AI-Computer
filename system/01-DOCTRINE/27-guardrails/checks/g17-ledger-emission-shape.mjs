// G17 — Ledger emission shape: every deliverable has zip + sha256 + ledger row.
//
// Check the most recent N ledger entries (if any ledger file exists) declare
// all three required keys. Soft pass if no ledger exists yet (early build).

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ORANGE5_ROOT } from "../lib/paths.mjs";

const LEDGER_CANDIDATES = [
  resolve(ORANGE5_ROOT, "10-RECEIPTS/ledger.jsonl"),
  resolve(ORANGE5_ROOT, "10-RECEIPTS/ledger.json"),
  resolve(ORANGE5_ROOT, "10-RECEIPTS/orange5-build/ledger.jsonl"),
];

export async function run() {
  const path = LEDGER_CANDIDATES.find((p) => existsSync(p));
  if (!path) {
    return { pass: true, details: { note: "no ledger yet", checked: LEDGER_CANDIDATES } };
  }
  const raw = readFileSync(path, "utf8").trim();
  if (!raw) return { pass: true, details: { note: "ledger empty", path } };

  const lines = raw.split(/\n/).filter(Boolean);
  const recent = lines.slice(-20);
  const offenders = [];
  for (const line of recent) {
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      offenders.push({ line: line.slice(0, 80), reason: "not_json" });
      continue;
    }
    const missing = [];
    if (!row.zip && !row.archive_path && !row.package) missing.push("zip");
    if (!row.sha256 && !row.hash) missing.push("sha256");
    if (!row.row_id && !row.id && !row.delivery_id) missing.push("row_id");
    if (missing.length > 0) {
      offenders.push({ id: row.id || row.row_id || null, missing });
    }
  }
  if (offenders.length > 0) {
    return {
      pass: false,
      details: {
        reason: "ledger rows missing required shape",
        path,
        offenders: offenders.slice(0, 5),
        examined: recent.length,
      },
    };
  }
  return { pass: true, details: { path, rows_examined: recent.length } };
}
