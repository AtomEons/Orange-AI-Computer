#!/usr/bin/env bun

import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StaffReactor } from "../../src/staff-reactor.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PACK_ROOT = resolve(SCRIPT_DIR, "..");
const DEFAULT_ROSTER_PATH = join(PACK_ROOT, "config", "staff-roster.json");
const DEFAULT_PROFILE_ROOT = join(PACK_ROOT, "config", "profiles");
const DEFAULT_RECEIPT_DIR = resolve(
  process.env.AE_STAFF_PROOF_RECEIPT_DIR
    || "C:/AtomEons/ai-box/hermes-product/data/receipts",
);
const DEFAULT_SELECTED_ROLE = "test-harness-engineer";
const BROADCAST_EVENT_ID = "ae-staff-live-proof-broadcast-v1";
const SELECTED_EVENT_ID = "ae-staff-live-proof-selected-dispatch-v1";

export const EXPECTED_EXECUTION_PROFILES = Object.freeze([
  "builder",
  "human-operator",
  "misfit",
  "navigator",
  "researcher",
  "reviewer",
  "visual",
]);

const REQUIRED_CHECKS = Object.freeze([
  "ae-staff-wave4-roster-50-unique",
  "ae-staff-wave4-seven-execution-profiles",
  "ae-staff-wave4-staff-reactor-health",
  "ae-staff-wave4-all-50-observe-deterministic-broadcast",
  "ae-staff-wave4-selected-role-orange-report",
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function stringArray(value) {
  return Array.isArray(value) && value.every(nonEmptyString);
}

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

function sameStrings(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function jsonSha256(value) {
  return sha256(JSON.stringify(value));
}

function errorMessage(error) {
  return error?.message || String(error);
}

function addCheck(checks, id, status, expected, observed) {
  if (!REQUIRED_CHECKS.includes(id)) throw new Error(`Unknown proof check: ${id}`);
  if (checks.some((check) => check.id === id)) throw new Error(`Duplicate proof check: ${id}`);
  checks.push({ id, status, expected, observed });
}

function blockedCheck(checks, id, reason) {
  addCheck(checks, id, "BLOCKED", "observed runtime evidence", { reason });
}

export function validateOrangeReport(report) {
  const errors = [];
  if (!isRecord(report)) return { valid: false, errors: ["report must be an object"] };
  if (report.schema !== "orange.report.v1") errors.push("schema must be orange.report.v1");
  if (!nonEmptyString(report.orderId)) errors.push("orderId must be a non-empty string");
  if (!["completed", "blocked", "needs_attention"].includes(report.status)) {
    errors.push("status must be completed, blocked, or needs_attention");
  }
  if (!Number.isFinite(report.confidence) || report.confidence < 0 || report.confidence > 1) {
    errors.push("confidence must be between 0 and 1");
  }
  if (!stringArray(report.actionsTaken)) errors.push("actionsTaken must be an array of non-empty strings");
  if (!Array.isArray(report.evidence)) errors.push("evidence must be an array");
  if (report.status === "completed" && Array.isArray(report.evidence) && report.evidence.length === 0) {
    errors.push("completed reports must contain evidence");
  }
  if (!stringArray(report.blockers)) errors.push("blockers must be an array of non-empty strings");
  if (!nonEmptyString(report.nextAction)) errors.push("nextAction must be a non-empty string");
  if (!nonEmptyString(report.receiptPath)) errors.push("receiptPath must be a non-empty string");
  return { valid: errors.length === 0, errors };
}

function makeDeterministicReport({ role, event, relevance, receiptPath }) {
  return {
    schema: "orange.report.v1",
    orderId: event.id,
    status: "completed",
    confidence: 1,
    actionsTaken: [`Observed deterministic StaffReactor event ${event.id} as ${role.id}.`],
    evidence: [{
      kind: "observed-deterministic-staff-event",
      eventId: event.id,
      roleId: role.id,
      executionProfile: role.archetype,
      relevance,
    }],
    blockers: [],
    nextAction: "Return the observation to the AE Staff live proof runner.",
    receiptPath,
    roleId: role.id,
    executionProfile: role.archetype,
  };
}

function defaultReceiptPath(receiptDir, startedAt, runId) {
  const stamp = startedAt.replace(/[:.]/g, "-");
  return join(receiptDir, `${stamp}-${runId}.json`);
}

function writeReceiptAtomically(path, receipt) {
  const target = resolve(path);
  if (existsSync(target)) throw new Error(`Refusing to overwrite existing receipt: ${target}`);
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    renameSync(temporary, target);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* no partial receipt to remove */ }
    throw error;
  }
  return target;
}

function profileObservation(profileRoot, roster) {
  const mapped = sortedUnique(roster.roles.map((role) => role.archetype).filter(nonEmptyString));
  const declared = Array.isArray(roster.organization?.executionProfiles)
    ? sortedUnique(roster.organization.executionProfiles.filter(nonEmptyString))
    : [];
  const directories = readdirSync(profileRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const requiredFiles = Object.fromEntries(EXPECTED_EXECUTION_PROFILES.map((profile) => [
    profile,
    Object.fromEntries(["config.yaml", "profile.json", "SOUL.md"].map((name) => [
      name,
      existsSync(join(profileRoot, profile, name)),
    ])),
  ]));
  const distribution = Object.fromEntries(mapped.map((profile) => [
    profile,
    roster.roles.filter((role) => role.archetype === profile).length,
  ]));
  const filesPresent = Object.values(requiredFiles)
    .every((files) => Object.values(files).every(Boolean));
  return {
    mapped,
    declared,
    directories,
    requiredFiles,
    distribution,
    organizationExecutionProfileCount: roster.organization?.executionProfileCount ?? null,
    pass: roster.organization?.executionProfileCount === 7
      && sameStrings(mapped, EXPECTED_EXECUTION_PROFILES)
      && sameStrings(declared, EXPECTED_EXECUTION_PROFILES)
      && sameStrings(directories, EXPECTED_EXECUTION_PROFILES)
      && filesPresent,
  };
}

function healthObservation(snapshot) {
  const activeCount = snapshot.readyCount + snapshot.runningCount;
  const roleIds = snapshot.roles.map((role) => role.id).sort();
  const offlineRoleIds = snapshot.roles
    .filter((role) => role.state === "offline")
    .map((role) => role.id)
    .sort();
  return {
    schema: snapshot.schema,
    status: snapshot.status,
    startedAt: snapshot.startedAt,
    roleCount: snapshot.roleCount,
    readyCount: snapshot.readyCount,
    runningCount: snapshot.runningCount,
    activeCount,
    queuedCount: snapshot.queuedCount,
    inferenceLimit: snapshot.inferenceLimit,
    toolLimit: snapshot.toolLimit,
    roleIds,
    offlineRoleIds,
    pass: snapshot.schema === "orange.hermes-staff-reactor.v1"
      && snapshot.status === "LIVE"
      && snapshot.roleCount === 50
      && snapshot.roles.length === 50
      && activeCount === 50
      && offlineRoleIds.length === 0
      && snapshot.inferenceLimit > 0
      && snapshot.inferenceLimit < snapshot.roleCount,
  };
}

function broadcastObservation(published, dispatches, rosterRoleIds) {
  const expectedRoleIds = [...rosterRoleIds].sort();
  const addressedRoleIds = published.addressed.map((entry) => entry.roleId).sort();
  const resultRoleIds = published.results.filter(Boolean).map((entry) => entry.roleId).sort();
  const eventDispatches = dispatches
    .filter((entry) => entry.eventId === BROADCAST_EVENT_ID)
    .sort((left, right) => left.roleId.localeCompare(right.roleId));
  const dispatchedRoleIds = eventDispatches.map((entry) => entry.roleId);
  const invalidReports = eventDispatches
    .map((entry) => ({ roleId: entry.roleId, ...validateOrangeReport(entry.report) }))
    .filter((entry) => !entry.valid)
    .map(({ roleId, errors }) => ({ roleId, errors }));
  const reportSha256ByRole = Object.fromEntries(eventDispatches.map((entry) => [
    entry.roleId,
    jsonSha256(entry.report),
  ]));
  const rolesWithMatchingEventTime = published.snapshot.roles
    .filter((role) => role.lastEventAt === published.event.createdAt)
    .length;
  const rolesHandledOnce = published.snapshot.roles.filter((role) => role.handled === 1).length;
  return {
    event: {
      id: published.event.id,
      broadcast: published.event.broadcast,
      requiresModel: published.event.requiresModel,
      createdAt: published.event.createdAt,
      sha256: jsonSha256(published.event),
    },
    observedCount: published.observedCount,
    addressedRoleIds,
    resultRoleIds,
    dispatchedRoleIds,
    invalidReports,
    reportSha256ByRole,
    rolesWithMatchingEventTime,
    rolesHandledOnce,
    snapshotReadyCount: published.snapshot.readyCount,
    pass: published.event.id === BROADCAST_EVENT_ID
      && published.event.broadcast === true
      && published.event.requiresModel === false
      && published.observedCount === 50
      && sameStrings(addressedRoleIds, expectedRoleIds)
      && sameStrings(resultRoleIds, expectedRoleIds)
      && sameStrings(dispatchedRoleIds, expectedRoleIds)
      && published.results.length === 50
      && published.results.every((entry) => entry?.ok === true)
      && invalidReports.length === 0
      && rolesWithMatchingEventTime === 50
      && rolesHandledOnce === 50
      && published.snapshot.readyCount === 50,
  };
}

function selectedDispatchObservation(published, dispatches, selectedRole) {
  const eventDispatches = dispatches.filter((entry) => entry.eventId === SELECTED_EVENT_ID);
  const selectedResult = published.results.find((entry) => entry?.roleId === selectedRole.id) || null;
  const report = selectedResult?.result || null;
  const validation = validateOrangeReport(report);
  return {
    event: {
      id: published.event.id,
      targetRoles: published.event.targetRoles,
      broadcast: published.event.broadcast,
      requiresModel: published.event.requiresModel,
      createdAt: published.event.createdAt,
      sha256: jsonSha256(published.event),
    },
    observedCount: published.observedCount,
    addressedRoleIds: published.addressed.map((entry) => entry.roleId),
    dispatchedRoleIds: eventDispatches.map((entry) => entry.roleId),
    selectedRoleId: selectedRole.id,
    expectedExecutionProfile: selectedRole.archetype,
    report,
    reportSha256: report ? jsonSha256(report) : null,
    validation,
    pass: published.event.id === SELECTED_EVENT_ID
      && published.event.broadcast === false
      && published.event.requiresModel === false
      && published.observedCount === 50
      && published.addressed.length === 1
      && published.addressed[0]?.roleId === selectedRole.id
      && published.results.length === 1
      && selectedResult?.ok === true
      && eventDispatches.length === 1
      && eventDispatches[0]?.roleId === selectedRole.id
      && report?.roleId === selectedRole.id
      && report?.executionProfile === selectedRole.archetype
      && validation.valid,
  };
}

export async function runAeStaffLiveProof(options = {}) {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const runId = `ae-staff-live-proof-${randomUUID()}`;
  const rosterPath = resolve(options.rosterPath || DEFAULT_ROSTER_PATH);
  const profileRoot = resolve(options.profileRoot || DEFAULT_PROFILE_ROOT);
  const selectedRoleId = options.selectedRoleId || DEFAULT_SELECTED_ROLE;
  const receiptPath = resolve(options.receiptPath || defaultReceiptPath(
    resolve(options.receiptDir || DEFAULT_RECEIPT_DIR),
    startedAt,
    runId,
  ));
  const checks = [];
  const observations = {
    roster: null,
    executionProfiles: null,
    staffReactorHealth: null,
    deterministicBroadcast: null,
    selectedRoleDispatch: null,
  };
  let roster = null;
  let rosterPass = false;

  try {
    const rosterRaw = readFileSync(rosterPath, "utf8");
    roster = JSON.parse(rosterRaw);
    const roles = Array.isArray(roster?.roles) ? roster.roles : [];
    const roleIds = roles.map((role) => role?.id);
    const validRoleIds = roleIds.filter(nonEmptyString);
    const foldedRoleIds = validRoleIds.map((id) => id.toLowerCase());
    const duplicateRoleIds = sortedUnique(validRoleIds.filter((id, index) => roleIds.indexOf(id) !== index));
    const caseFoldedDuplicateIds = sortedUnique(foldedRoleIds.filter((id, index) => foldedRoleIds.indexOf(id) !== index));
    rosterPass = roster?.schema === "orange5.hermes.staff-roster.v1"
      && roles.length === 50
      && validRoleIds.length === 50
      && new Set(roleIds).size === 50
      && new Set(foldedRoleIds).size === 50
      && roster.organization?.roleCount === 50
      && roster.organization?.logicalActionRoleCount === 50;
    observations.roster = {
      path: rosterPath,
      sha256: sha256(rosterRaw),
      schema: roster?.schema ?? null,
      roleCount: roles.length,
      uniqueRoleCount: new Set(validRoleIds).size,
      caseFoldedUniqueRoleCount: new Set(foldedRoleIds).size,
      organizationRoleCount: roster.organization?.roleCount ?? null,
      organizationLogicalActionRoleCount: roster.organization?.logicalActionRoleCount ?? null,
      duplicateRoleIds,
      caseFoldedDuplicateIds,
    };
    addCheck(
      checks,
      "ae-staff-wave4-roster-50-unique",
      rosterPass ? "PASS" : "FAIL",
      {
        schema: "orange5.hermes.staff-roster.v1",
        roleCount: 50,
        uniqueRoleCount: 50,
        caseFoldedUniqueRoleCount: 50,
      },
      observations.roster,
    );
  } catch (error) {
    observations.roster = { path: rosterPath, error: errorMessage(error) };
    addCheck(
      checks,
      "ae-staff-wave4-roster-50-unique",
      "FAIL",
      { roleCount: 50, uniqueRoleCount: 50 },
      observations.roster,
    );
  }

  if (rosterPass) {
    try {
      observations.executionProfiles = { profileRoot, ...profileObservation(profileRoot, roster) };
      addCheck(
        checks,
        "ae-staff-wave4-seven-execution-profiles",
        observations.executionProfiles.pass ? "PASS" : "FAIL",
        { profiles: EXPECTED_EXECUTION_PROFILES },
        observations.executionProfiles,
      );
    } catch (error) {
      observations.executionProfiles = { profileRoot, error: errorMessage(error) };
      addCheck(
        checks,
        "ae-staff-wave4-seven-execution-profiles",
        "FAIL",
        { profiles: EXPECTED_EXECUTION_PROFILES },
        observations.executionProfiles,
      );
    }
  } else {
    blockedCheck(checks, "ae-staff-wave4-seven-execution-profiles", "roster contract did not pass");
  }

  let reactor = null;
  const dispatches = [];
  if (rosterPass) {
    try {
      reactor = new StaffReactor({
        roster,
        inferenceLimit: Number(options.inferenceLimit || 8),
        toolLimit: Number(options.toolLimit || 32),
        dispatch: async ({ role, event, relevance, projectNow }) => {
          const report = makeDeterministicReport({ role, event, relevance, receiptPath });
          dispatches.push({
            eventId: event.id,
            roleId: role.id,
            executionProfile: role.archetype,
            projectId: projectNow.projectId,
            correlationId: projectNow.correlationId,
            report,
          });
          return report;
        },
      });
      observations.staffReactorHealth = healthObservation(reactor.start());
      addCheck(
        checks,
        "ae-staff-wave4-staff-reactor-health",
        observations.staffReactorHealth.pass ? "PASS" : "FAIL",
        { schema: "orange.hermes-staff-reactor.v1", status: "LIVE", activeRoleCount: 50 },
        observations.staffReactorHealth,
      );
    } catch (error) {
      observations.staffReactorHealth = { error: errorMessage(error) };
      addCheck(
        checks,
        "ae-staff-wave4-staff-reactor-health",
        "FAIL",
        { schema: "orange.hermes-staff-reactor.v1", status: "LIVE", activeRoleCount: 50 },
        observations.staffReactorHealth,
      );
      reactor = null;
    }
  } else {
    blockedCheck(checks, "ae-staff-wave4-staff-reactor-health", "roster contract did not pass");
  }

  if (reactor) {
    try {
      const published = await reactor.publish({
        id: BROADCAST_EVENT_ID,
        type: "proof.deterministic-broadcast",
        topic: "ae-staff-live-proof",
        summary: "Every AE Staff actor observes this deterministic tool-only proof event.",
        body: "No model, external tool, or artifact completion is claimed.",
        projectId: "orange5-wave4-ae-staff",
        correlationId: BROADCAST_EVENT_ID,
        authority: "operator-proof",
        commitments: ["all 50 observe", "no fake green"],
        sourceRefs: ["08-HERMES/product-integration/config/staff-roster.json"],
        broadcast: true,
        requiresModel: false,
      });
      observations.deterministicBroadcast = broadcastObservation(
        published,
        dispatches,
        roster.roles.map((role) => role.id),
      );
      addCheck(
        checks,
        "ae-staff-wave4-all-50-observe-deterministic-broadcast",
        observations.deterministicBroadcast.pass ? "PASS" : "FAIL",
        { observedCount: 50, addressedCount: 50, dispatchCount: 50, requiresModel: false },
        observations.deterministicBroadcast,
      );
    } catch (error) {
      observations.deterministicBroadcast = { eventId: BROADCAST_EVENT_ID, error: errorMessage(error) };
      addCheck(
        checks,
        "ae-staff-wave4-all-50-observe-deterministic-broadcast",
        "FAIL",
        { observedCount: 50, addressedCount: 50, dispatchCount: 50, requiresModel: false },
        observations.deterministicBroadcast,
      );
    }

    const selectedRole = roster.roles.find((role) => role.id === selectedRoleId);
    if (!selectedRole) {
      observations.selectedRoleDispatch = { selectedRoleId, error: "selected role is absent from the roster" };
      addCheck(
        checks,
        "ae-staff-wave4-selected-role-orange-report",
        "FAIL",
        { selectedRoleId, schema: "orange.report.v1" },
        observations.selectedRoleDispatch,
      );
    } else {
      try {
        const published = await reactor.publish({
          id: SELECTED_EVENT_ID,
          type: "proof.selected-role-dispatch",
          topic: "test harness proof",
          summary: `Dispatch one deterministic proof observation to ${selectedRole.id}.`,
          body: "Prove role targeting and the orange.report.v1 return contract without model inference.",
          projectId: "orange5-wave4-ae-staff",
          correlationId: SELECTED_EVENT_ID,
          authority: "operator-proof",
          targetRoles: [selectedRole.id],
          requiresModel: false,
          order: {
            schema: "orange.order.v1",
            orderId: SELECTED_EVENT_ID,
            action: "proof.observe",
            payload: { roleId: selectedRole.id, deterministic: true },
          },
        });
        observations.selectedRoleDispatch = selectedDispatchObservation(
          published,
          dispatches,
          selectedRole,
        );
        addCheck(
          checks,
          "ae-staff-wave4-selected-role-orange-report",
          observations.selectedRoleDispatch.pass ? "PASS" : "FAIL",
          {
            selectedRoleId: selectedRole.id,
            executionProfile: selectedRole.archetype,
            dispatchCount: 1,
            schema: "orange.report.v1",
          },
          observations.selectedRoleDispatch,
        );
      } catch (error) {
        observations.selectedRoleDispatch = {
          selectedRoleId: selectedRole.id,
          executionProfile: selectedRole.archetype,
          error: errorMessage(error),
        };
        addCheck(
          checks,
          "ae-staff-wave4-selected-role-orange-report",
          "FAIL",
          { selectedRoleId: selectedRole.id, schema: "orange.report.v1" },
          observations.selectedRoleDispatch,
        );
      }
    }
  } else {
    blockedCheck(
      checks,
      "ae-staff-wave4-all-50-observe-deterministic-broadcast",
      "StaffReactor did not start",
    );
    blockedCheck(
      checks,
      "ae-staff-wave4-selected-role-orange-report",
      "StaffReactor did not start",
    );
  }

  const checkIds = checks.map((check) => check.id);
  if (!sameStrings([...checkIds].sort(), [...REQUIRED_CHECKS].sort())) {
    throw new Error(`Proof check coverage mismatch: ${checkIds.join(", ")}`);
  }
  const blockers = checks.filter((check) => check.status !== "PASS").map((check) => check.id);
  const checkStatus = Object.fromEntries(checks.map((check) => [check.id, check.status]));
  const finishedAt = new Date().toISOString();
  const receiptCore = {
    schema: "orange5.hermes.ae-staff-live-proof.v1",
    receiptId: runId,
    status: blockers.length === 0 ? "PASS" : "FAIL",
    ok: blockers.length === 0,
    proofMode: "in-process-deterministic-staff-reactor",
    claims: {
      rosterObserved: checkStatus["ae-staff-wave4-roster-50-unique"] === "PASS",
      sevenProfileMappingObserved: checkStatus["ae-staff-wave4-seven-execution-profiles"] === "PASS",
      staffReactorRuntimeObserved: checkStatus["ae-staff-wave4-staff-reactor-health"] === "PASS",
      deterministicBroadcastObserved: checkStatus["ae-staff-wave4-all-50-observe-deterministic-broadcast"] === "PASS",
      selectedRoleDispatchObserved: checkStatus["ae-staff-wave4-selected-role-orange-report"] === "PASS",
      hermesGatewayOrModelInferenceObserved: false,
    },
    limitations: [
      "This receipt proves the in-process StaffReactor and deterministic dispatch contract.",
      "It does not claim a model-backed Hermes gateway inference or production artifact completion.",
    ],
    host: { hostname: hostname(), platform: platform(), bun: Bun.version },
    startedAt,
    finishedAt,
    elapsedMs: Date.now() - startedMs,
    selectedRoleId,
    sources: { rosterPath, profileRoot },
    checks,
    observations,
    blockers,
    receiptPath,
    hashAlgorithm: "sha256",
    hashCovers: "JSON.stringify(receipt object excluding receiptSha256)",
  };
  const receipt = { ...receiptCore, receiptSha256: jsonSha256(receiptCore) };
  writeReceiptAtomically(receiptPath, receipt);
  return { receipt, exitCode: receipt.ok ? 0 : 1 };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") return { help: true };
    const next = () => {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      return value;
    };
    if (arg === "--roster") options.rosterPath = next();
    else if (arg === "--profile-root") options.profileRoot = next();
    else if (arg === "--selected-role") options.selectedRoleId = next();
    else if (arg === "--receipt") options.receiptPath = next();
    else if (arg === "--receipt-dir") options.receiptDir = next();
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.receiptPath && options.receiptDir) {
    throw new Error("Use --receipt or --receipt-dir, not both");
  }
  return options;
}

function usage() {
  return [
    "Usage: bun ae-staff-live-proof.mjs [options]",
    "",
    "Options:",
    "  --roster <path>         Staff roster JSON path",
    "  --profile-root <path>   Hermes execution profile directory",
    "  --selected-role <id>    Role used for the targeted dispatch proof",
    "  --receipt <path>        Exact new receipt path",
    "  --receipt-dir <path>    Directory for a unique receipt filename",
    "  --help                  Show this help",
  ].join("\n");
}

if (import.meta.main) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(`${usage()}\n`);
    } else {
      const { receipt, exitCode } = await runAeStaffLiveProof(options);
      process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
      process.exitCode = exitCode;
    }
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      schema: "orange5.hermes.ae-staff-live-proof.v1",
      status: "ERROR",
      ok: false,
      error: errorMessage(error),
    }, null, 2)}\n`);
    process.exitCode = 2;
  }
}
