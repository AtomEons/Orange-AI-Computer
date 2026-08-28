#!/usr/bin/env node
// AE Flow scheduler — drives flow.tick() on a pressure-aware cadence.
//
// Doctrine:
//   - Tick every active_interval_ms (default 1s) when at least one current is pending or in_progress.
//   - Back off to idle_interval_ms (default 10s) after idle_threshold_ticks consecutive empty ticks.
//   - Reload config on SIGHUP. Graceful shutdown on SIGINT/SIGTERM.
//   - Heartbeat log every log_every_n_ticks. Drift detection if a tick is late by max_tick_drift_ms.
//   - One-writer rule: scheduler is the sole tick driver per state file.
//
// Receipts: scheduler does NOT write receipts directly. Flow's tick() persists state/flow.json.
// SQLite mirror (06-CONTROL-PLANE/receipts/orange5.db) is written by the receipts pipeline that
// consumes state deltas — kept out of the scheduler hot path on purpose.

import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFlow, tick, createPersistGate } from "./src/index.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, "scheduler.config.json");
const PID_PATH = join(__dirname, "state", "scheduler.pid");

const DEFAULTS = Object.freeze({
  active_interval_ms: 1000,
  idle_interval_ms: 10000,
  idle_threshold_ticks: 3,
  concurrency_cap: 3,
  max_tick_drift_ms: 5000,
  log_every_n_ticks: 60,
  shutdown_grace_ms: 2000,
  heartbeat_ms: 30000,
});

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) {
    log("warn", `config missing at ${CONFIG_PATH}, using defaults`);
    return { ...DEFAULTS };
  }
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    const merged = { ...DEFAULTS, ...raw };
    // Sanity floors — never below 100ms on active, never below 1s on idle.
    merged.active_interval_ms = Math.max(100, merged.active_interval_ms | 0);
    merged.idle_interval_ms = Math.max(1000, merged.idle_interval_ms | 0);
    merged.idle_threshold_ticks = Math.max(1, merged.idle_threshold_ticks | 0);
    merged.concurrency_cap = Math.max(1, merged.concurrency_cap | 0);
    // Heartbeat 0 disables forced saves entirely; otherwise floor at 1s.
    if (merged.heartbeat_ms !== 0) {
      merged.heartbeat_ms = Math.max(1000, merged.heartbeat_ms | 0);
    }
    return merged;
  } catch (err) {
    log("error", `config parse failed (${err.message}); using defaults`);
    return { ...DEFAULTS };
  }
}

function log(level, msg, extra) {
  const line = {
    ts: new Date().toISOString(),
    level,
    component: "ae-flow-scheduler",
    msg,
    ...(extra || {}),
  };
  const stream = level === "error" ? process.stderr : process.stdout;
  stream.write(JSON.stringify(line) + "\n");
}

function hasPendingWork(state) {
  for (const c of Object.values(state.currents)) {
    if (c.status === "pending" || c.status === "in_progress") return true;
  }
  return false;
}

function writePid() {
  try {
    mkdirSync(dirname(PID_PATH), { recursive: true });
    writeFileSync(PID_PATH, String(process.pid));
  } catch (err) {
    log("warn", `could not write pid file: ${err.message}`);
  }
}

function clearPid() {
  try {
    if (existsSync(PID_PATH)) writeFileSync(PID_PATH, "");
  } catch {
    // best-effort
  }
}

async function main() {
  let config = loadConfig();
  let stopping = false;
  let timer = null;
  let consecutiveEmpty = 0;
  let ticksSinceLog = 0;
  let lastScheduledAt = 0;

  const startedAt = Date.now();
  log("info", "scheduler starting", {
    pid: process.pid,
    node: process.version,
    config,
  });
  writePid();

  // Single shared state handle across ticks. Persist gate decides when
  // flow.tick() actually hits disk — dirty deltas OR heartbeat lapse.
  const state = createFlow({ persist: true });
  let persistGate = createPersistGate(state, { heartbeatMs: config.heartbeat_ms });

  const schedule = (delayMs) => {
    if (stopping) return;
    lastScheduledAt = Date.now();
    timer = setTimeout(runTick, delayMs);
    // Allow the process to exit if nothing else is pending (shouldn't matter — signals drive shutdown).
    if (typeof timer.unref === "function") timer.unref();
  };

  const runTick = () => {
    if (stopping) return;
    const scheduledAt = lastScheduledAt;
    const enteredAt = Date.now();
    const drift = enteredAt - scheduledAt;

    let nextDelay;
    try {
      const pendingBefore = hasPendingWork(state);
      tick(state, { concurrency_cap: config.concurrency_cap, persistGate });
      const pendingAfter = hasPendingWork(state);

      if (pendingAfter) {
        consecutiveEmpty = 0;
        nextDelay = config.active_interval_ms;
      } else {
        consecutiveEmpty += 1;
        nextDelay = consecutiveEmpty >= config.idle_threshold_ticks
          ? config.idle_interval_ms
          : config.active_interval_ms;
      }

      ticksSinceLog += 1;
      if (drift > config.max_tick_drift_ms) {
        log("warn", "tick drift exceeded", {
          drift_ms: drift,
          tick: state.tick,
        });
      }
      if (ticksSinceLog >= config.log_every_n_ticks) {
        log("info", "heartbeat", {
          tick: state.tick,
          pending_before: pendingBefore,
          pending_after: pendingAfter,
          consecutive_empty: consecutiveEmpty,
          next_delay_ms: nextDelay,
          uptime_s: Math.floor((Date.now() - startedAt) / 1000),
          persist: persistGate.snapshot(),
        });
        ticksSinceLog = 0;
      }
    } catch (err) {
      log("error", "tick failed", { error: err.message, stack: err.stack });
      // Fail-open: keep scheduling. Persistent failure becomes visible via stderr → systemd journal.
      nextDelay = config.active_interval_ms;
    }

    schedule(nextDelay);
  };

  const shutdown = (signal) => {
    if (stopping) return;
    stopping = true;
    log("info", "shutdown initiated", { signal });
    if (timer) clearTimeout(timer);
    // Give in-flight tick (if any) the grace window, then exit.
    setTimeout(() => {
      clearPid();
      log("info", "shutdown complete", {
        uptime_s: Math.floor((Date.now() - startedAt) / 1000),
        final_tick: state.tick,
      });
      process.exit(0);
    }, config.shutdown_grace_ms);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGHUP", () => {
    log("info", "SIGHUP — reloading config");
    config = loadConfig();
    // Rebuild the persist gate with the new heartbeat. State fingerprint
    // gets re-snapshotted off the live state, so we don't force a save
    // just because the operator HUP'd.
    persistGate = createPersistGate(state, { heartbeatMs: config.heartbeat_ms });
    log("info", "config reloaded", { config });
  });

  process.on("uncaughtException", (err) => {
    log("error", "uncaughtException", { error: err.message, stack: err.stack });
  });
  process.on("unhandledRejection", (reason) => {
    log("error", "unhandledRejection", { reason: String(reason) });
  });

  // Kick off the first tick on the active cadence.
  schedule(config.active_interval_ms);
}

main().catch((err) => {
  log("error", "scheduler failed to start", { error: err.message, stack: err.stack });
  process.exit(1);
});
