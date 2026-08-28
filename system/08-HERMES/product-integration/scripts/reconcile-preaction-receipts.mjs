#!/usr/bin/env bun
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  SETTLEMENT_OUTCOMES,
  defaultSettlementRoot,
  writePreActionSettlement,
} from "../../src/pre-action/receipt-settlement.mjs";

const argv = process.argv.slice(2);
const value = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
};

const apply = argv.includes("--apply");
const sourceRoot = resolve(value(
  "--source",
  "C:/AtomEons/Orange5/10-RECEIPTS/orange5-build",
));
const settlementRoot = resolve(value("--settlement-root", defaultSettlementRoot()));
const minAgeMinutes = Number(value("--min-age-minutes", "5"));
if (!Number.isFinite(minAgeMinutes) || minAgeMinutes < 0) {
  throw new Error("--min-age-minutes must be a non-negative number");
}

const now = Date.now();
const existingBySource = new Map();
try {
  for (const name of await readdir(settlementRoot)) {
    if (!name.endsWith("-settlement.json")) continue;
    const path = join(settlementRoot, name);
    try {
      const record = JSON.parse(await readFile(path, "utf8"));
      if (record?.settlement?.source_path) existingBySource.set(record.settlement.source_path, path);
    } catch {
      // A malformed settlement remains visible on disk and is not trusted.
    }
  }
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
const names = (await readdir(sourceRoot))
  .filter((name) => name.endsWith("-hermes-preaction.json"))
  .sort();
const candidates = [];
const skipped = [];

for (const name of names) {
  const path = join(sourceRoot, name);
  try {
    const raw = await readFile(path, "utf8");
    const receipt = JSON.parse(raw);
    const fileStat = await stat(path);
    const generatedMs = Date.parse(receipt.generated_at);
    const ageMs = now - (Number.isFinite(generatedMs) ? generatedMs : fileStat.mtimeMs);
    if (existingBySource.has(path)) {
      skipped.push({ path, reason: "already-settled", settlement: existingBySource.get(path) });
    } else if (receipt.schema !== "orange5.receipt.v0" || receipt.status !== "pending") {
      skipped.push({ path, reason: "not-pending-preaction" });
    } else if (ageMs < minAgeMinutes * 60_000) {
      skipped.push({ path, reason: "not-stale", ageMinutes: ageMs / 60_000 });
    } else {
      candidates.push({ path, receipt, ageMinutes: ageMs / 60_000 });
    }
  } catch (error) {
    skipped.push({ path, reason: `unreadable:${error.message}` });
  }
}

const settlements = [];
let reconciliationReceipt = null;
if (apply) {
  for (const candidate of candidates) {
    const result = await writePreActionSettlement({
      receiptPath: candidate.path,
      outcome: SETTLEMENT_OUTCOMES.CLOSED_UNRESOLVED,
      reason: "Legacy pre-action authorization receipt had no terminal settlement; closed without inferring authorization or execution.",
      leaseId: candidate.receipt.lease_id,
      actionVerb: candidate.receipt.action,
      actor: "orangefive-hermes-reconciler",
      evidence: [`legacy_age_minutes:${Math.floor(candidate.ageMinutes)}`],
      settlementRoot,
    });
    settlements.push({
      source: candidate.path,
      settlement: result.path,
      created: result.created,
      sourceSha256: result.sourceSha256,
      outcome: result.record.status,
    });
  }
  await mkdir(settlementRoot, { recursive: true });
  reconciliationReceipt = join(
    settlementRoot,
    `reconciliation-${new Date().toISOString().replace(/[-:.]/g, "").replace("Z", "Z")}.json`,
  );
  const terminalPaths = [
    ...existingBySource.values(),
    ...settlements.map((item) => item.settlement),
  ].sort();
  const summary = {
    schema: "orange5.receipt.v0",
    receipt_id: `hermes-preaction-reconciliation:${Date.now()}`,
    generated_at: new Date().toISOString(),
    actor: "orangefive-hermes-reconciler",
    status: "closed",
    confidence: 1,
    prior_receipt: null,
    hash_chain: 1,
    actions: ["Closed stale pending pre-action receipts with append-only terminal settlements."],
    evidence: terminalPaths,
    blockers: [],
    next_action: "Use the terminal settlement, not the preserved pending source, for lifecycle state.",
    reconciliation: {
      source_root: sourceRoot,
      settlement_root: settlementRoot,
      scanned: names.length,
      newly_settled: settlements.length,
      previously_settled: existingBySource.size,
      terminal_settlements: terminalPaths.length,
      source_receipts_modified: 0,
      source_receipts_deleted: 0,
    },
  };
  await writeFile(reconciliationReceipt, `${JSON.stringify(summary, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
}

console.log(JSON.stringify({
  schema: "orange5.hermes-preaction-reconciliation.v1",
  status: apply ? "CLOSED" : "DRY_RUN",
  sourceRoot,
  settlementRoot,
  minAgeMinutes,
  scanned: names.length,
  stalePending: candidates.length,
  alreadySettled: existingBySource.size,
  settled: settlements.length,
  reconciliationReceipt,
  candidates: candidates.map(({ path, receipt, ageMinutes }) => ({
    path,
    receiptId: receipt.receipt_id,
    leaseId: receipt.lease_id,
    action: receipt.action,
    ageMinutes: Math.floor(ageMinutes),
  })),
  settlements,
  skipped,
}, null, 2));
