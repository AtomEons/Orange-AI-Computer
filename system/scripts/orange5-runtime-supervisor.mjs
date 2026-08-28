#!/usr/bin/env bun

import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, resolve } from "node:path";
import { ensureRuntime } from "./orange5-runtime-control.mjs";

function resolveOrangeRoot() {
  if (process.env.ORANGE5_ROOT) return resolve(process.env.ORANGE5_ROOT);
  const executable = basename(process.execPath).toLowerCase();
  if (executable !== "bun.exe" && executable !== "bun") {
    return resolve(dirname(process.execPath), "..");
  }
  return resolve(import.meta.dir, "..");
}

const ROOT = resolveOrangeRoot();
const RECEIPT_DIR = resolve(ROOT, "10-RECEIPTS", "orange5-build", "runtime-logs");
const RECEIPT_PATH = resolve(RECEIPT_DIR, "orange5-runtime-supervisor-latest.json");
const ATTEMPT_PATH = resolve(RECEIPT_DIR, "orange5-runtime-supervisor-attempt-latest.json");
const LOCK_PATH = resolve(RECEIPT_DIR, "orange5-runtime-supervisor.lock");
const LOCK_MAX_AGE_MS = 12 * 60 * 1_000;

function now() { return new Date().toISOString(); }

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function readLockOwner() {
  try {
    const raw = readFileSync(LOCK_PATH, "utf8").trim();
    try { return JSON.parse(raw); }
    catch {
      return {
        schema: "orange5.runtime-supervisor.lock.legacy",
        pid: Number.parseInt(raw, 10) || 0,
        acquired_at_utc: statSync(LOCK_PATH).mtime.toISOString(),
      };
    }
  } catch { return null; }
}

function lockIsActive(owner) {
  if (!owner || !processIsAlive(Number(owner.pid))) return false;
  const acquiredAtMs = Date.parse(owner.acquired_at_utc || "");
  const ageMs = Date.now() - acquiredAtMs;
  return Number.isFinite(acquiredAtMs) && ageMs >= 0 && ageMs < LOCK_MAX_AGE_MS;
}

function acquireLock() {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(LOCK_PATH, "wx");
      const lock = {
        schema: "orange5.runtime-supervisor.lock.v1",
        pid: process.pid,
        token: randomUUID(),
        acquired_at_utc: now(),
        max_age_ms: LOCK_MAX_AGE_MS,
      };
      writeFileSync(fd, `${JSON.stringify(lock)}\n`, "utf8");
      return { fd, ...lock };
    } catch {
      const owner = readLockOwner();
      if (lockIsActive(owner)) return { owner };
      try { unlinkSync(LOCK_PATH); } catch {}
    }
  }
  return { owner: readLockOwner() };
}

function releaseLock(lock) {
  closeSync(lock.fd);
  const owner = readLockOwner();
  if (owner?.token === lock.token || (owner?.pid === process.pid && !owner?.token)) {
    try { unlinkSync(LOCK_PATH); } catch {}
  }
}

mkdirSync(RECEIPT_DIR, { recursive: true });
const lock = acquireLock();
if (!lock.fd) {
  writeFileSync(ATTEMPT_PATH, `${JSON.stringify({
    schema: "orange.receipt.runtime_supervisor.v2",
    status: "ALREADY_RUNNING",
    timestamp_utc: now(),
    runtime_engine: "bun-native-control",
    popup_surface: "none",
    powershell_runtime: false,
    active_owner: lock.owner || null,
    canonical_receipt_preserved: true,
  }, null, 2)}\n`, "utf8");
  process.exit(0);
}

try {
  let runtimeReceipt = null;
  let error = null;
  try { runtimeReceipt = await ensureRuntime(); } catch (caught) { error = caught?.stack || caught?.message || String(caught); }
  const green = runtimeReceipt?.status === "ORANGE5_RUNTIME_GREEN";
  const receipt = {
    schema: "orange.receipt.runtime_supervisor.v2",
    status: green ? "ORANGE5_STARTUP_CONTROL_COMPLETE" : "ORANGE5_STARTUP_CONTROL_NEEDS_ATTENTION",
    timestamp_utc: now(),
    runtime_engine: "bun-native-control",
    popup_surface: "none",
    powershell_runtime: false,
    repeating_powershell_task: false,
    model_residency_policy: "leased-on-demand",
    runtime_receipt: runtimeReceipt,
    error,
  };
  writeFileSync(RECEIPT_PATH, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  process.exitCode = green ? 0 : 1;
} finally {
  releaseLock(lock);
}
