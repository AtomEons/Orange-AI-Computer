import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const HERMES_ROOT = resolve(MODULE_DIR, "../..");

export const SETTLEMENT_OUTCOMES = Object.freeze({
  AUTHORIZED: "authorized",
  REFUSED: "refused",
  CLOSED_UNRESOLVED: "closed_unresolved",
});

export function defaultSettlementRoot() {
  if (process.env.HERMES_PREACTION_SETTLEMENT_ROOT) {
    return resolve(process.env.HERMES_PREACTION_SETTLEMENT_ROOT);
  }
  if (process.env.HERMES_TEST_MODE === "1") {
    return resolve(HERMES_ROOT, "tests/.fixtures/preaction-settlements");
  }
  return resolve(HERMES_ROOT, "receipts/pre-action");
}

function safeStem(value) {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 180);
}

function validateSource(receipt, sourcePath) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    throw new Error(`pre-action receipt must be a JSON object: ${sourcePath}`);
  }
  if (receipt.schema !== "orange5.receipt.v0") {
    throw new Error(`unsupported pre-action receipt schema at ${sourcePath}`);
  }
  if (receipt.status !== "pending") {
    throw new Error(`pre-action receipt is not pending: ${sourcePath}`);
  }
  if (typeof receipt.receipt_id !== "string" || !receipt.receipt_id) {
    throw new Error(`pre-action receipt has no receipt_id: ${sourcePath}`);
  }
  if (!Number.isInteger(receipt.hash_chain) || receipt.hash_chain < 1) {
    throw new Error(`pre-action receipt has invalid hash_chain: ${sourcePath}`);
  }
}

export async function writePreActionSettlement({
  receiptPath,
  outcome,
  reason,
  leaseId,
  actionVerb,
  actor,
  evidence = [],
  settlementRoot = defaultSettlementRoot(),
  now = new Date(),
}) {
  if (!Object.values(SETTLEMENT_OUTCOMES).includes(outcome)) {
    throw new Error(`unsupported pre-action settlement outcome: ${outcome}`);
  }
  if (typeof reason !== "string" || !reason.trim()) {
    throw new Error("pre-action settlement reason is required");
  }

  const sourcePath = isAbsolute(receiptPath) ? receiptPath : resolve(receiptPath);
  const sourceRaw = await readFile(sourcePath, "utf8");
  const source = JSON.parse(sourceRaw);
  validateSource(source, sourcePath);

  if (leaseId && source.lease_id !== leaseId) {
    throw new Error(`pre-action lease mismatch at ${sourcePath}`);
  }
  if (actionVerb && source.action !== actionVerb) {
    throw new Error(`pre-action action mismatch at ${sourcePath}`);
  }

  const sourceSha256 = createHash("sha256").update(sourceRaw).digest("hex");
  const root = resolve(settlementRoot);
  const outputPath = join(
    root,
    `${safeStem(basename(sourcePath, ".json"))}-${sourceSha256.slice(0, 16)}-settlement.json`,
  );
  const terminalActor = actor || source.actor || "orangefive-hermes";
  const record = {
    schema: "orange5.receipt.v0",
    receipt_id: `${source.receipt_id}:settlement`,
    generated_at: now.toISOString(),
    actor: terminalActor,
    status: outcome,
    confidence: 1,
    prior_receipt: sourcePath,
    hash_chain: source.hash_chain + 1,
    lease_id: source.lease_id || leaseId || null,
    action: source.action || actionVerb || null,
    actions: ["Preserved the pre-action receipt and appended a terminal settlement."],
    evidence: [`sha256:${sourceSha256}`, ...evidence.map(String)],
    blockers: outcome === SETTLEMENT_OUTCOMES.AUTHORIZED ? [] : [reason],
    next_action: outcome === SETTLEMENT_OUTCOMES.AUTHORIZED
      ? "Execution still requires a separate canonical Orange receipt."
      : "Do not infer execution from the pre-action receipt.",
    settlement: {
      schema: "orange5.hermes-preaction-settlement.v1",
      outcome,
      reason: reason.trim(),
      source_path: sourcePath,
      source_sha256: sourceSha256,
      source_status: source.status,
      execution_claimed: false,
    },
  };

  await mkdir(root, { recursive: true });
  try {
    await writeFile(outputPath, `${JSON.stringify(record, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    return { created: true, path: outputPath, sourcePath, sourceSha256, record };
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = JSON.parse(await readFile(outputPath, "utf8"));
    if (
      existing?.settlement?.source_sha256 !== sourceSha256 ||
      existing?.settlement?.outcome !== outcome
    ) {
      throw new Error(`conflicting pre-action settlement already exists: ${outputPath}`);
    }
    return { created: false, path: outputPath, sourcePath, sourceSha256, record: existing };
  }
}

