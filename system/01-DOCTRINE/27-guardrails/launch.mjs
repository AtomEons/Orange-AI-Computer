// launch.mjs — Orange5 27-Guardrails daemon process wrapper.
//
// Boots server.mjs as a long-running Bun process, captures the PID into
// state/guardrails.pid, registers SIGTERM clean shutdown, and tees stdout +
// stderr into state/guardrails.log with 10 MB rotation. Refuses to start
// when the PID file claims a live process AND that PID actually answers on
// http://127.0.0.1:7460/healthz.
//
// CLI:
//   node launch.mjs start    Boot the daemon (no-op if already healthy).
//   node launch.mjs stop     SIGTERM the PID; wait up to 10 s; SIGKILL if needed.
//   node launch.mjs status   Print pid + healthz result as JSON; exit 0/1.
//   node launch.mjs tail     Tail the last 200 lines of guardrails.log.
//
// Design notes:
//   - We spawn `bun server.mjs` if `bun` is on PATH, else fall back to
//     `node server.mjs`. server.mjs is Bun-and-Node-compatible.
//   - We `detached: true` + `unref()` so the wrapper can exit while the
//     daemon keeps running. PID + log redirection are the durable handles.
//   - SIGTERM handler is installed on the WRAPPER so that `npm stop`-style
//     calls into the wrapper script clean up; the daemon's own SIGTERM
//     handler is the responsibility of server.mjs (Bun.serve / node:http
//     both honor it by default).
//   - Log rotation: at start, if guardrails.log >= 10 MB, rotate it to
//     guardrails.log.1 (overwriting any prior .1). Single-step rotation
//     is enough for a long-running daemon; deeper history lives in
//     state/runs.jsonl and the receipts ledger.
//   - Honesty: we DO NOT claim "healthy" until /healthz returns ok:true
//     within the 10 s startup probe window. Anything else returns an
//     honest gap status to stdout, no theater.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, statSync, renameSync, openSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = resolve(HERE, "state");
const PID_FILE = resolve(STATE_DIR, "guardrails.pid");
const LOG_FILE = resolve(STATE_DIR, "guardrails.log");
const LOG_ROTATED = resolve(STATE_DIR, "guardrails.log.1");
const LOG_MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const HOST = process.env.GUARDRAILS_HOST || "127.0.0.1";
const PORT = parseInt(process.env.GUARDRAILS_PORT || "7460", 10);
const HEALTHZ = `http://${HOST}:${PORT}/healthz`;
const STARTUP_TIMEOUT_MS = 10_000;
const STARTUP_POLL_MS = 250;
const STOP_GRACE_MS = 10_000;
const SERVER_FILE = resolve(HERE, "server.mjs");

// ---------------------------------------------------------------------------
// utilities

function ensureStateDir() {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
}

function readPidFile() {
  if (!existsSync(PID_FILE)) return null;
  try {
    const raw = readFileSync(PID_FILE, "utf8").trim();
    if (!raw) return null;
    const pid = parseInt(raw, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function writePidFile(pid) {
  writeFileSync(PID_FILE, String(pid) + "\n", "utf8");
}

function clearPidFile() {
  if (existsSync(PID_FILE)) {
    try { unlinkSync(PID_FILE); } catch { /* best-effort */ }
  }
}

/** True if the OS reports the PID is currently alive. */
function pidAlive(pid) {
  if (!pid) return false;
  try {
    // signal 0 = existence probe, no signal delivered
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = process exists but we lack rights — still alive
    if (err && err.code === "EPERM") return true;
    return false;
  }
}

/** GET /healthz with a hard timeout. Returns parsed JSON or null. */
async function probeHealthz(timeout_ms = 1500) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeout_ms);
    const r = await fetch(HEALTHZ, { signal: ctl.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

function maybeRotateLog() {
  try {
    if (!existsSync(LOG_FILE)) return;
    const st = statSync(LOG_FILE);
    if (st.size >= LOG_MAX_BYTES) {
      if (existsSync(LOG_ROTATED)) {
        try { unlinkSync(LOG_ROTATED); } catch { /* best-effort */ }
      }
      renameSync(LOG_FILE, LOG_ROTATED);
    }
  } catch (err) {
    // Log rotation failure is non-fatal — surface but keep going.
    process.stderr.write(`[launch] log rotation warning: ${err?.message || err}\n`);
  }
}

function which(cmd) {
  const isWin = process.platform === "win32";
  const probe = isWin
    ? spawnSync("where", [cmd], { encoding: "utf8" })
    : spawnSync("which", [cmd], { encoding: "utf8" });
  if (probe.status !== 0) return null;
  const line = (probe.stdout || "").split(/\r?\n/).find(Boolean);
  return line ? line.trim() : null;
}

function pickRuntime() {
  // Prefer Bun (server.mjs uses Bun.serve when available, else node:http).
  const bun = which("bun");
  if (bun) return { cmd: bun, label: "bun" };
  const node = which("node") || process.execPath;
  return { cmd: node, label: "node" };
}

// ---------------------------------------------------------------------------
// commands

async function cmdStart() {
  ensureStateDir();

  // Refusal rule: PID file claims live + PID actually answers /healthz.
  const claimedPid = readPidFile();
  if (claimedPid && pidAlive(claimedPid)) {
    const health = await probeHealthz();
    if (health && health.ok) {
      console.log(JSON.stringify({
        ok: true,
        action: "start",
        result: "already_running",
        pid: claimedPid,
        bound: `${HOST}:${PORT}`,
        health,
      }, null, 2));
      return 0;
    }
    // PID alive but not responding — stale daemon. Clear and continue.
    console.error(`[launch] PID ${claimedPid} alive but /healthz silent; treating PID file as stale`);
    clearPidFile();
  } else if (claimedPid) {
    // PID file present but process gone — clean it.
    clearPidFile();
  }

  maybeRotateLog();

  // Tee stdout + stderr into guardrails.log (append).
  const logFd = openSync(LOG_FILE, "a");
  const runtime = pickRuntime();

  const child = spawn(runtime.cmd, [SERVER_FILE], {
    cwd: HERE,
    env: {
      ...process.env,
      GUARDRAILS_HOST: HOST,
      GUARDRAILS_PORT: String(PORT),
    },
    detached: true,
    stdio: ["ignore", logFd, logFd],
    windowsHide: true,
  });

  if (!child.pid) {
    return fail("start", "spawn returned no PID", { runtime: runtime.label });
  }

  writePidFile(child.pid);
  child.unref();

  // Wrapper SIGTERM cleanup: if the OS sends SIGTERM to THIS wrapper before
  // we exit (rare — the wrapper is short-lived after detach), forward it
  // to the child so we don't leak the daemon.
  const forward = () => {
    try { process.kill(child.pid, "SIGTERM"); } catch { /* gone already */ }
    process.exit(0);
  };
  process.once("SIGTERM", forward);
  process.once("SIGINT", forward);

  // Startup probe: poll /healthz until ok or timeout.
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let health = null;
  while (Date.now() < deadline) {
    if (!pidAlive(child.pid)) {
      return fail("start", "daemon exited before becoming healthy", {
        pid: child.pid,
        runtime: runtime.label,
        log_tail: tailLogString(40),
      });
    }
    health = await probeHealthz(1000);
    if (health && health.ok) break;
    await sleep(STARTUP_POLL_MS);
  }

  if (!health || !health.ok) {
    return fail("start", "healthz did not return ok within timeout", {
      pid: child.pid,
      timeout_ms: STARTUP_TIMEOUT_MS,
      runtime: runtime.label,
      log_tail: tailLogString(40),
    });
  }

  console.log(JSON.stringify({
    ok: true,
    action: "start",
    result: "started",
    pid: child.pid,
    bound: `${HOST}:${PORT}`,
    runtime: runtime.label,
    health,
    log: LOG_FILE,
    pid_file: PID_FILE,
  }, null, 2));
  return 0;
}

async function cmdStop() {
  ensureStateDir();
  const pid = readPidFile();
  if (!pid) {
    console.log(JSON.stringify({
      ok: true,
      action: "stop",
      result: "no_pid_file",
    }, null, 2));
    return 0;
  }
  if (!pidAlive(pid)) {
    clearPidFile();
    console.log(JSON.stringify({
      ok: true,
      action: "stop",
      result: "pid_already_dead",
      pid,
    }, null, 2));
    return 0;
  }

  try { process.kill(pid, "SIGTERM"); } catch (err) {
    return fail("stop", `SIGTERM failed: ${err?.message || err}`, { pid });
  }

  const deadline = Date.now() + STOP_GRACE_MS;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) {
      clearPidFile();
      console.log(JSON.stringify({
        ok: true,
        action: "stop",
        result: "stopped",
        pid,
        signal: "SIGTERM",
      }, null, 2));
      return 0;
    }
    await sleep(200);
  }

  // Grace exceeded — escalate.
  try { process.kill(pid, "SIGKILL"); } catch { /* may have died in the gap */ }
  // brief wait to confirm
  await sleep(300);
  const stillAlive = pidAlive(pid);
  if (!stillAlive) clearPidFile();
  console.log(JSON.stringify({
    ok: !stillAlive,
    action: "stop",
    result: stillAlive ? "still_alive_after_sigkill" : "stopped_via_sigkill",
    pid,
    grace_ms: STOP_GRACE_MS,
  }, null, 2));
  return stillAlive ? 1 : 0;
}

async function cmdStatus() {
  ensureStateDir();
  const pid = readPidFile();
  const alive = pid ? pidAlive(pid) : false;
  const health = alive ? await probeHealthz(1500) : null;
  const ok = !!(pid && alive && health && health.ok);
  const result = {
    ok,
    action: "status",
    pid_file: PID_FILE,
    pid,
    pid_alive: alive,
    bound: `${HOST}:${PORT}`,
    health,
    log: LOG_FILE,
  };
  console.log(JSON.stringify(result, null, 2));
  return ok ? 0 : 1;
}

function cmdTail(lines = 200) {
  ensureStateDir();
  if (!existsSync(LOG_FILE)) {
    console.log(`[launch] no log file at ${LOG_FILE}`);
    return 0;
  }
  process.stdout.write(tailLogString(lines));
  return 0;
}

// ---------------------------------------------------------------------------
// helpers

function tailLogString(n) {
  try {
    if (!existsSync(LOG_FILE)) return "";
    const raw = readFileSync(LOG_FILE, "utf8");
    const arr = raw.split(/\r?\n/);
    return arr.slice(-n).join("\n");
  } catch (err) {
    return `[launch] tail error: ${err?.message || err}\n`;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function fail(action, reason, extra = {}) {
  console.error(JSON.stringify({
    ok: false,
    action,
    reason,
    ...extra,
  }, null, 2));
  return 1;
}

// ---------------------------------------------------------------------------
// dispatch

const cmd = (process.argv[2] || "").toLowerCase();
const arg2 = process.argv[3];

let code;
switch (cmd) {
  case "start":
    code = await cmdStart();
    break;
  case "stop":
    code = await cmdStop();
    break;
  case "status":
    code = await cmdStatus();
    break;
  case "tail": {
    const n = parseInt(arg2, 10);
    code = cmdTail(Number.isFinite(n) && n > 0 ? n : 200);
    break;
  }
  default:
    console.error(
      "usage: node launch.mjs start|stop|status|tail [N]\n" +
      "  start   boot server.mjs as detached daemon, write PID, tail log\n" +
      "  stop    SIGTERM the PID (10s grace, then SIGKILL)\n" +
      "  status  print pid + /healthz JSON; exit 0 if healthy, 1 otherwise\n" +
      "  tail N  print last N lines of state/guardrails.log (default 200)"
    );
    code = 2;
}
process.exit(code);
