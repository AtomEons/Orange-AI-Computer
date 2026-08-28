import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "bun:test";
import {
  EXPECTED_EXECUTION_PROFILES,
  runAeStaffLiveProof,
  validateOrangeReport,
} from "../scripts/ae-staff-live-proof.mjs";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PACK_ROOT = resolve(TEST_DIR, "..");
const ROSTER_PATH = join(PACK_ROOT, "config", "staff-roster.json");
const PROFILE_ROOT = join(PACK_ROOT, "config", "profiles");
const temporaryRoots = [];

function temporaryRoot() {
  const root = mkdtempSync(join(tmpdir(), "orange5-ae-staff-live-proof-"));
  temporaryRoots.push(root);
  return root;
}

function receiptHash(receipt) {
  const { receiptSha256, ...unsigned } = receipt;
  return createHash("sha256").update(JSON.stringify(unsigned)).digest("hex");
}

afterEach(() => {
  while (temporaryRoots.length) {
    rmSync(temporaryRoots.pop(), { recursive: true, force: true });
  }
});

describe("AE Staff live proof", () => {
  test("derives a passing receipt from all 50 observed deterministic dispatches", async () => {
    const receiptPath = join(temporaryRoot(), "ae-staff-live-proof.json");
    const { receipt, exitCode } = await runAeStaffLiveProof({ receiptPath });

    expect(exitCode).toBe(0);
    expect(receipt.status).toBe("PASS");
    expect(receipt.ok).toBeTrue();
    expect(receipt.blockers).toEqual([]);
    expect(receipt.checks).toHaveLength(5);
    expect(receipt.checks.every((check) => check.status === "PASS")).toBeTrue();
    expect(receipt.observations.roster.roleCount).toBe(50);
    expect(receipt.observations.roster.uniqueRoleCount).toBe(50);
    expect(receipt.observations.executionProfiles.mapped).toEqual(EXPECTED_EXECUTION_PROFILES);
    expect(receipt.observations.staffReactorHealth.activeCount).toBe(50);
    expect(receipt.observations.deterministicBroadcast.observedCount).toBe(50);
    expect(receipt.observations.deterministicBroadcast.dispatchedRoleIds).toHaveLength(50);
    expect(Object.keys(receipt.observations.deterministicBroadcast.reportSha256ByRole)).toHaveLength(50);
    expect(receipt.observations.selectedRoleDispatch.dispatchedRoleIds).toEqual(["test-harness-engineer"]);
    expect(receipt.observations.selectedRoleDispatch.validation.valid).toBeTrue();
    expect(receipt.claims.rosterObserved).toBeTrue();
    expect(receipt.claims.sevenProfileMappingObserved).toBeTrue();
    expect(receipt.claims.staffReactorRuntimeObserved).toBeTrue();
    expect(receipt.claims.deterministicBroadcastObserved).toBeTrue();
    expect(receipt.claims.selectedRoleDispatchObserved).toBeTrue();
    expect(receipt.claims.hermesGatewayOrModelInferenceObserved).toBeFalse();

    const persisted = JSON.parse(readFileSync(receiptPath, "utf8"));
    expect(persisted).toEqual(receipt);
    expect(receiptHash(persisted)).toBe(persisted.receiptSha256);
  });

  test("records a duplicate roster as failed and blocks runtime proof", async () => {
    const root = temporaryRoot();
    const invalidRosterPath = join(root, "duplicate-roster.json");
    const receiptPath = join(root, "failed-proof.json");
    const roster = JSON.parse(readFileSync(ROSTER_PATH, "utf8"));
    roster.roles.at(-1).id = roster.roles[0].id;
    writeFileSync(invalidRosterPath, `${JSON.stringify(roster, null, 2)}\n`, "utf8");

    const { receipt, exitCode } = await runAeStaffLiveProof({
      rosterPath: invalidRosterPath,
      profileRoot: PROFILE_ROOT,
      receiptPath,
    });

    expect(exitCode).toBe(1);
    expect(receipt.status).toBe("FAIL");
    expect(receipt.ok).toBeFalse();
    expect(receipt.checks.find((check) => check.id === "ae-staff-wave4-roster-50-unique")?.status).toBe("FAIL");
    expect(receipt.checks.find((check) => check.id === "ae-staff-wave4-staff-reactor-health")?.status).toBe("BLOCKED");
    expect(receipt.checks.find((check) => check.id === "ae-staff-wave4-all-50-observe-deterministic-broadcast")?.status).toBe("BLOCKED");
    expect(receipt.checks.find((check) => check.id === "ae-staff-wave4-selected-role-orange-report")?.status).toBe("BLOCKED");
    expect(receipt.claims.rosterObserved).toBeFalse();
    expect(receipt.claims.sevenProfileMappingObserved).toBeFalse();
    expect(receipt.claims.staffReactorRuntimeObserved).toBeFalse();
    expect(receipt.claims.deterministicBroadcastObserved).toBeFalse();
    expect(receipt.claims.selectedRoleDispatchObserved).toBeFalse();
    expect(JSON.parse(readFileSync(receiptPath, "utf8")).status).toBe("FAIL");
  });

  test("rejects schema-only reports as false green", () => {
    expect(validateOrangeReport({ schema: "orange.report.v1", status: "completed" }).valid).toBeFalse();
    expect(validateOrangeReport({
      schema: "orange.report.v1",
      orderId: "proof-order",
      status: "completed",
      confidence: 1,
      actionsTaken: ["Observed a deterministic dispatch."],
      evidence: [{ eventId: "proof-event" }],
      blockers: [],
      nextAction: "Return to the proof runner.",
      receiptPath: "C:/proof/receipt.json",
    }).valid).toBeTrue();
  });
});
