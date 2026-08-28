import crypto from "node:crypto";
import { DESIRED_STATES, RUNTIME_PROFILE_SCHEMA, organByName } from "./schema.mjs";

export const RUNTIME_STATE_SCHEMA = "orange.runtime-state.v1";
export const RUNTIME_RECEIPT_SCHEMA = "orange.runtime-lifecycle-receipt.v1";

const ACTIVE_STATUSES = new Set(["launching", "running", "healthy", "degraded", "stopping"]);
const STARTABLE_STATUSES = new Set(["stopped", "backoff", "failed", "queued"]);

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function iso(at) {
  const date = at instanceof Date ? at : new Date(at ?? Date.now());
  if (!Number.isFinite(date.getTime())) throw new Error("runtime transition requires a valid timestamp");
  return date.toISOString();
}

function clone(value) {
  return structuredClone(value);
}

export function computeCrashBackoffMs(failureCount, backoff) {
  const count = Math.max(1, Math.trunc(Number(failureCount) || 1));
  return Math.min(backoff.maxMs, backoff.baseMs * (2 ** (count - 1)));
}

export function createRuntimeState(profile, at = 0) {
  if (profile?.schema !== RUNTIME_PROFILE_SCHEMA) throw new Error("valid runtime profile required");
  const timestamp = iso(at);
  return {
    schema: RUNTIME_STATE_SCHEMA,
    profile,
    revision: 0,
    updatedAt: timestamp,
    desired: Object.fromEntries(profile.organs.map((organ) => [organ.name, organ.desired])),
    observed: Object.fromEntries(profile.organs.map((organ) => [organ.name, {
      status: "stopped",
      pid: null,
      failureCount: 0,
      nextEligibleAt: null,
      lastExitCode: null,
      reason: "profile-initialized",
      transitionedAt: timestamp,
    }])),
  };
}

function receiptFor({ before, after, event, organ, at }) {
  const base = {
    schema: RUNTIME_RECEIPT_SCHEMA,
    profileId: after.profile.id,
    revision: after.revision,
    event: event.type,
    organ: organ?.name || null,
    desired: organ ? after.desired[organ.name] : null,
    fromStatus: organ ? before.observed[organ.name]?.status ?? null : null,
    toStatus: organ ? after.observed[organ.name]?.status ?? null : null,
    pid: organ ? after.observed[organ.name]?.pid ?? null : null,
    reason: String(event.reason || "unspecified"),
    resources: organ ? organ.resources : null,
    failureCount: organ ? after.observed[organ.name]?.failureCount ?? 0 : null,
    exitCode: event.type === "process.exited" && Number.isInteger(event.exitCode) ? event.exitCode : null,
    nextEligibleAt: organ ? after.observed[organ.name]?.nextEligibleAt ?? null : null,
    at,
  };
  return { ...base, receiptId: sha256(stableJson(base)) };
}

function requireStatus(current, allowed, type) {
  if (!allowed.includes(current.status)) {
    throw new Error(`${type} invalid while organ is ${current.status}`);
  }
}

export function transitionRuntimeState(state, event) {
  if (state?.schema !== RUNTIME_STATE_SCHEMA) throw new Error("valid runtime state required");
  if (!event || typeof event.type !== "string") throw new Error("runtime event type is required");
  const at = iso(event.at);
  const before = clone(state);
  const after = clone(state);
  const organ = event.organ ? organByName(state.profile, event.organ) : null;
  const current = organ ? after.observed[organ.name] : null;

  switch (event.type) {
    case "desired.changed": {
      if (!organ) throw new Error("desired.changed requires organ");
      if (!DESIRED_STATES.includes(event.desired)) throw new Error(`invalid desired state: ${event.desired}`);
      after.desired[organ.name] = event.desired;
      current.reason = String(event.reason || "operator-desired-state");
      break;
    }
    case "launch.requested":
      requireStatus(current, ["stopped", "backoff", "failed", "queued"], event.type);
      current.status = "launching";
      current.pid = null;
      current.reason = String(event.reason || "reconcile-start");
      break;
    case "launch.succeeded":
      requireStatus(current, ["launching"], event.type);
      if (!Number.isInteger(event.pid) || event.pid <= 0) throw new Error("launch.succeeded requires a positive pid");
      current.status = "running";
      current.pid = event.pid;
      current.nextEligibleAt = null;
      current.reason = String(event.reason || "process-spawned");
      break;
    case "health.passed":
      requireStatus(current, ["running", "healthy", "degraded"], event.type);
      current.status = "healthy";
      current.failureCount = event.resetFailures === false ? current.failureCount : 0;
      current.nextEligibleAt = null;
      current.reason = String(event.reason || "health-probe-passed");
      break;
    case "health.failed":
      requireStatus(current, ["running", "healthy", "degraded"], event.type);
      current.status = "degraded";
      current.reason = String(event.reason || "health-probe-failed");
      break;
    case "launch.failed":
      requireStatus(current, ["launching"], event.type);
      current.failureCount += 1;
      current.status = "backoff";
      current.pid = null;
      current.nextEligibleAt = new Date(new Date(at).getTime()
        + computeCrashBackoffMs(current.failureCount, state.profile.backoff)).toISOString();
      current.reason = String(event.reason || "spawn-failed");
      break;
    case "process.exited": {
      requireStatus(current, ["launching", "running", "healthy", "degraded", "stopping"], event.type);
      const expected = after.desired[organ.name] === "stopped" || current.status === "stopping" || event.expected === true;
      current.pid = null;
      current.lastExitCode = Number.isInteger(event.exitCode) ? event.exitCode : null;
      if (expected) {
        current.status = "stopped";
        current.nextEligibleAt = null;
      } else {
        current.failureCount += 1;
        current.status = "backoff";
        current.nextEligibleAt = new Date(new Date(at).getTime()
          + computeCrashBackoffMs(current.failureCount, state.profile.backoff)).toISOString();
      }
      current.reason = String(event.reason || (expected ? "expected-exit" : "unexpected-exit"));
      break;
    }
    case "stop.requested":
      requireStatus(current, ["launching", "running", "healthy", "degraded"], event.type);
      current.status = "stopping";
      current.reason = String(event.reason || "reconcile-stop");
      break;
    case "stop.completed":
      requireStatus(current, ["stopping"], event.type);
      current.status = "stopped";
      current.pid = null;
      current.nextEligibleAt = null;
      current.reason = String(event.reason || "owned-process-stopped");
      break;
    case "stop.failed":
      requireStatus(current, ["stopping"], event.type);
      current.status = "degraded";
      current.reason = String(event.reason || "owned-process-stop-failed");
      break;
    default:
      throw new Error(`unknown runtime event: ${event.type}`);
  }

  after.revision += 1;
  after.updatedAt = at;
  if (current) current.transitionedAt = at;
  const receipt = receiptFor({ before, after, event, organ, at });
  return { state: after, receipt };
}

function resourceUsage(state) {
  const usage = { memoryMb: 0, cpuUnits: 0, workerConcurrency: 0 };
  for (const organ of state.profile.organs) {
    if (!ACTIVE_STATUSES.has(state.observed[organ.name].status)) continue;
    usage.memoryMb += organ.resources.memoryMb;
    usage.cpuUnits += organ.resources.cpuUnits;
    usage.workerConcurrency += organ.resources.workerConcurrency;
  }
  return usage;
}

function fits(usage, resources, limits) {
  if (usage.memoryMb + resources.memoryMb > limits.maxMemoryMb) return "memory-limit";
  if (usage.cpuUnits + resources.cpuUnits > limits.maxCpuUnits) return "cpu-limit";
  if (usage.workerConcurrency + resources.workerConcurrency > limits.maxWorkerConcurrency) {
    return "worker-concurrency-limit";
  }
  return null;
}

export function planRuntimeReconciliation(state, at = Date.now()) {
  if (state?.schema !== RUNTIME_STATE_SCHEMA) throw new Error("valid runtime state required");
  const now = new Date(at);
  if (!Number.isFinite(now.getTime())) throw new Error("reconciliation requires a valid timestamp");
  const actions = [];
  const waits = [];
  const usage = resourceUsage(state);
  let starts = 0;

  const organs = [...state.profile.organs].sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name));
  for (const organ of organs) {
    const desired = state.desired[organ.name];
    const observed = state.observed[organ.name];
    if (desired === "stopped") {
      if (ACTIVE_STATUSES.has(observed.status) && observed.status !== "stopping") {
        actions.push({ type: "stop", organ: organ.name, pid: observed.pid, reason: "desired-stopped" });
      }
      continue;
    }
    if (!STARTABLE_STATUSES.has(observed.status)) continue;
    if (observed.nextEligibleAt && new Date(observed.nextEligibleAt) > now) {
      waits.push({ organ: organ.name, reason: "crash-backoff", nextEligibleAt: observed.nextEligibleAt });
      continue;
    }
    if (starts >= state.profile.limits.maxConcurrentStarts) {
      waits.push({ organ: organ.name, reason: "start-concurrency-limit" });
      continue;
    }
    const blockedBy = fits(usage, organ.resources, state.profile.limits);
    if (blockedBy) {
      waits.push({ organ: organ.name, reason: blockedBy });
      continue;
    }
    actions.push({ type: "start", organ: organ.name, reason: "desired-running" });
    usage.memoryMb += organ.resources.memoryMb;
    usage.cpuUnits += organ.resources.cpuUnits;
    usage.workerConcurrency += organ.resources.workerConcurrency;
    starts += 1;
  }

  return { actions, waits, reserved: usage };
}

export const __runtimeStateInternals = Object.freeze({ stableJson, sha256, resourceUsage, fits });
