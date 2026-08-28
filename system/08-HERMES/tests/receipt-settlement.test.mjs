import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  SETTLEMENT_OUTCOMES,
  writePreActionSettlement,
} from "../src/pre-action/receipt-settlement.mjs";

const testRoots = new Set();

async function createTestRoot() {
  const root = await mkdtemp(join(tmpdir(), "orange5-hermes-receipt-settlement-"));
  testRoots.add(root);
  return root;
}

afterEach(async () => {
  await Promise.all([...testRoots].map((root) => rm(root, { recursive: true, force: true })));
  testRoots.clear();
});

describe("pre-action receipt settlement", () => {
  test("appends an idempotent terminal receipt without changing the source", async () => {
    const root = await createTestRoot();
    const sourcePath = resolve(root, "source", "proof-hermes-preaction.json");
    const settlementRoot = resolve(root, "settlements");
    const source = {
      schema: "orange5.receipt.v0",
      receipt_id: "proof:hermes-preaction",
      generated_at: "2026-08-27T00:00:00.000Z",
      actor: "orangefive-navigator",
      status: "pending",
      confidence: 1,
      hash_chain: 1,
      prior_receipt: null,
      lease_id: "lease-proof",
      action: "analyze.agent",
    };
    const sourceRaw = `${JSON.stringify(source, null, 2)}\n`;
    await mkdir(resolve(root, "source"), { recursive: true });
    await writeFile(sourcePath, sourceRaw, "utf8");

    const first = await writePreActionSettlement({
      receiptPath: sourcePath,
      outcome: SETTLEMENT_OUTCOMES.AUTHORIZED,
      reason: "All eight LOOM gates passed.",
      leaseId: source.lease_id,
      actionVerb: source.action,
      settlementRoot,
      now: new Date("2026-08-27T01:00:00.000Z"),
    });
    const second = await writePreActionSettlement({
      receiptPath: sourcePath,
      outcome: SETTLEMENT_OUTCOMES.AUTHORIZED,
      reason: "All eight LOOM gates passed.",
      leaseId: source.lease_id,
      actionVerb: source.action,
      settlementRoot,
      now: new Date("2026-08-27T01:01:00.000Z"),
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.path).toBe(first.path);
    expect(await readFile(sourcePath, "utf8")).toBe(sourceRaw);
    const settlement = JSON.parse(await readFile(first.path, "utf8"));
    expect(settlement.status).toBe("authorized");
    expect(settlement.prior_receipt).toBe(sourcePath);
    expect(settlement.hash_chain).toBe(2);
    expect(settlement.settlement.execution_claimed).toBe(false);
    expect(settlement.evidence[0]).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  test("refuses to settle a mismatched lease", async () => {
    const root = await createTestRoot();
    const sourcePath = resolve(root, "proof-hermes-preaction.json");
    await mkdir(root, { recursive: true });
    await writeFile(sourcePath, JSON.stringify({
      schema: "orange5.receipt.v0",
      receipt_id: "proof:hermes-preaction",
      generated_at: "2026-08-27T00:00:00.000Z",
      actor: "orangefive-navigator",
      status: "pending",
      confidence: 1,
      hash_chain: 1,
      prior_receipt: null,
      lease_id: "lease-real",
      action: "analyze.agent",
    }), "utf8");

    await expect(writePreActionSettlement({
      receiptPath: sourcePath,
      outcome: SETTLEMENT_OUTCOMES.REFUSED,
      reason: "Policy refused.",
      leaseId: "lease-wrong",
      settlementRoot: resolve(root, "settlements"),
    })).rejects.toThrow("lease mismatch");
  });
});
