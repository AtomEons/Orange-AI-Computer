// live-smoke.mjs — real boot smoke test for the 27 guardrails daemon.
//
// Receipt #033 returned status=partial because the runtime daemon was
// scaffolding only — never smoke-tested live. This file closes that gap.
//
// What this test does (in order, against the actual on-disk state):
//   1. Spawn `node server.mjs` on an isolated test port and a temp state dir
//      so the live cockpit DB at state/guardrails.sqlite is never touched.
//   2. Poll GET /healthz until the daemon answers (real boot, not a mock).
//   3. GET /run?write=0 — assert the response carries all 27 guardrail_ids
//      from the registry (G01..G27) and that every result row has the
//      compact public shape (pass, severity, details, elapsed_ms).
//   4. Read the SQLite DB directly via better-sqlite3 and confirm the run
//      row + 27 guardrail_results rows are persisted under the run_id the
//      HTTP response returned. This is the "persistence" gate — not a mock,
//      not the in-memory return value, the actual DB on disk.
//   5. Capture the failing-rail set (guardrail_id -> {severity, details}).
//   6. SIGTERM the daemon. Wait for the child to exit.
//   7. Spawn a SECOND daemon process against the same temp state dir.
//   8. Hit GET /latest — assert it returns the SAME run_id as step 3 with
//      the SAME failing-rail set. This proves SQLite rehydrated previous
//      violations across the restart (no in-memory state was lost).
//   9. Tear down the second daemon and emit a JSON receipt to stdout.
//
// Quality posture: any check that returns red on the live registry is NOT
// treated as a test failure (those are real guardrail signals, not test
// bugs). The smoke test asserts the *structural* contract — daemon up,
// 27 ids present, SQLite chain intact, restart rehydrates — and reports
// the live red set honestly in the receipt.
//
// CLI:
//   node live-smoke.mjs
//   node live-smoke.mjs --port 7475          # pin a specific test port
//   node live-smoke.mjs --keep-state         # keep temp state for inspection
//   node live-smoke.mjs --json               # only emit receipt JSON
//
// Default port: an OS-assigned ephemeral port on 127.0.0.1 (see findFreePort).
// This avoids collisions with the live cockpit on :7460 and any stale daemons
// from earlier dev runs.
//
// Exit codes:
//   0  all structural gates pass (live red rails are fine; they're reported)
//   1  a structural gate failed (daemon didn't boot, ids missing, DB drift)
//   2  fatal harness error (spawn, fs, parse)
//
// This test does NOT touch:
//   - the live state/ dir (uses a per-run temp dir under os.tmpdir())
//   - the live Reality Flux lane (passes write=0 on /run)
//   - the live cockpit on :7460

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, existsSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");           // 27-guardrails/
const SERVER_PATH = resolve(REPO_ROOT, "server.mjs");

const ARGV = process.argv.slice(2);
const PORT_EXPLICIT = (() => {
  const i = ARGV.indexOf("--port");
  if (i >= 0 && ARGV[i + 1]) return parseInt(ARGV[i + 1], 10);
  if (process.env.GUARDRAILS_TEST_PORT)
    return parseInt(process.env.GUARDRAILS_TEST_PORT, 10);
  return null;
})();
const KEEP_STATE = ARGV.includes("--keep-state");
const JSON_ONLY = ARGV.includes("--json");

// Probe an OS-assigned free port on 127.0.0.1. Beats hardcoding because the
// live cockpit on :7460 (or stale daemons on :7461..7469 from earlier dev
// sessions) won't collide. Reused across both daemon boots so the rehydrate
// gate sees the same DB anchor.
async function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

// Use a unique temp state dir for this run so we never collide with the
// running daemon's live SQLite WAL. better-sqlite3 will create the DB on
// first write.
const STATE_DIR = KEEP_STATE
  ? resolve(REPO_ROOT, "state", `.live-smoke-${Date.now()}`)
  : mkdtempSync(resolve(tmpdir(), "orange5-guardrails-smoke-"));
mkdirSync(STATE_DIR, { recursive: true });
const DB_PATH = resolve(STATE_DIR, "guardrails.sqlite");
const SOUL_PATH = resolve(STATE_DIR, "soul-genome.json");
const CONTINUITY_DIR = resolve(STATE_DIR, "continuity");

// ---------------------------------------------------------------------------
// Tiny test harness
// ---------------------------------------------------------------------------

const gates = [];
let fatalErr = null;

function logLine(fd, msg) {
  try {
    writeSync(fd, msg);
  } catch {
    (fd === 1 ? process.stdout : process.stderr).write(msg);
  }
}

function gate(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then((evidence) => {
      gates.push({ name, pass: true, evidence: evidence ?? null });
      if (!JSON_ONLY) logLine(1, `ok   ${name}\n`);
    })
    .catch((err) => {
      gates.push({
        name,
        pass: false,
        error: String(err?.message || err),
      });
      if (!JSON_ONLY) logLine(2, `FAIL ${name}\n  ${err?.stack || err}\n`);
    });
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Daemon control
// ---------------------------------------------------------------------------

function spawnDaemon({ port, label }) {
  // Use node (not bun) — same runtime the cockpit smoke needs to cover.
  const env = {
    ...process.env,
    GUARDRAILS_HOST: "127.0.0.1",
    GUARDRAILS_PORT: String(port),
    // Redirect every persistence anchor at the temp dir.
    ORANGE5_GUARDRAILS_STATE: STATE_DIR,
    ORANGE5_GUARDRAILS_DB: DB_PATH,
    ORANGE5_SOUL_GENOME: SOUL_PATH,
    ORANGE5_CONTINUITY_DIR: CONTINUITY_DIR,
  };
  const child = spawn(process.execPath, [SERVER_PATH], {
    env,
    cwd: REPO_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const logs = { stdout: "", stderr: "", spawnErr: null };
  child.on("error", (e) => {
    logs.spawnErr = String(e?.message || e);
  });
  child.stdout?.on("data", (b) => {
    logs.stdout += b.toString("utf8");
  });
  child.stderr?.on("data", (b) => {
    logs.stderr += b.toString("utf8");
  });
  return { child, logs, label };
}

async function waitForHealthy({ port, timeout_ms = 20000, daemon = null }) {
  const deadline = Date.now() + timeout_ms;
  let lastErr = null;
  while (Date.now() < deadline) {
    // If the daemon already exited the wait is pointless — surface its logs.
    if (daemon?.child?.exitCode != null) {
      throw new Error(
        `daemon exited before becoming healthy (code=${daemon.child.exitCode})\n` +
          `--- stdout ---\n${daemon.logs.stdout}\n` +
          `--- stderr ---\n${daemon.logs.stderr}\n` +
          `--- spawnErr ---\n${daemon.logs.spawnErr ?? ""}`
      );
    }
    if (daemon?.logs?.spawnErr) {
      throw new Error(`spawn error: ${daemon.logs.spawnErr}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (res.ok) {
        const body = await res.json();
        if (body?.ok) return body;
      }
      lastErr = `status ${res.status}`;
    } catch (e) {
      lastErr = String(e?.message || e);
    }
    await sleep(150);
  }
  throw new Error(
    `daemon never became healthy on :${port} after ${timeout_ms}ms (last: ${lastErr})\n` +
      `--- daemon pid ---\n${daemon?.child?.pid ?? "none"}\n` +
      `--- daemon exitCode ---\n${daemon?.child?.exitCode ?? "still running"}\n` +
      `--- daemon stdout ---\n${daemon?.logs?.stdout ?? ""}\n` +
      `--- daemon stderr ---\n${daemon?.logs?.stderr ?? ""}\n` +
      `--- daemon spawnErr ---\n${daemon?.logs?.spawnErr ?? ""}`
  );
}

async function killDaemon(d) {
  if (!d?.child || d.child.exitCode != null) return;
  const exited = new Promise((resolve) => {
    d.child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  // On Windows SIGTERM is best-effort; child.kill() with no signal == SIGTERM
  // and Node translates it into a graceful close where possible.
  d.child.kill("SIGTERM");
  const t = setTimeout(() => {
    if (d.child.exitCode == null) d.child.kill("SIGKILL");
  }, 3000);
  const r = await exited;
  clearTimeout(t);
  return r;
}

// ---------------------------------------------------------------------------
// SQLite verification (read the file the daemon just wrote to)
// ---------------------------------------------------------------------------

async function readDbRun(run_id) {
  const Database = (await import("#sqlite")).default;
  const db = new Database(DB_PATH, { readonly: true });
  try {
    const run = db
      .prepare("SELECT * FROM runs WHERE run_id = ?")
      .get(run_id);
    const results = db
      .prepare(
        "SELECT guardrail_id, severity, pass, details FROM guardrail_results WHERE run_id = ? ORDER BY guardrail_id ASC"
      )
      .all(run_id);
    return {
      run,
      results: results.map((r) => ({
        ...r,
        pass: !!r.pass,
        details: safeParseJSON(r.details),
      })),
    };
  } finally {
    db.close();
  }
}

function safeParseJSON(s) {
  if (typeof s !== "string") return s;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

// ---------------------------------------------------------------------------
// Expected guardrail id set (G01..G27, registry-order)
// ---------------------------------------------------------------------------

const EXPECTED_IDS = Array.from({ length: 27 }, (_, i) => `G${String(i + 1).padStart(2, "0")}`);

// ---------------------------------------------------------------------------
// Main flow
// ---------------------------------------------------------------------------

let daemon1 = null;
let daemon2 = null;
let runResp = null;
let dbView1 = null;
let restartLatest = null;
let liveRedRails = [];
let PORT = null;

async function main() {
  // Pick a free port up-front. Same port is reused for both daemon boots so
  // the rehydrate path is exercised — the second daemon must read the SAME
  // SQLite file the first daemon wrote.
  PORT = PORT_EXPLICIT ?? (await findFreePort());

  // --------- BOOT 1 ---------
  daemon1 = spawnDaemon({ port: PORT, label: "boot1" });

  await gate("daemon boots and answers /healthz", async () => {
    const h = await waitForHealthy({ port: PORT, daemon: daemon1 });
    assert(h.service === "orange5-guardrails", `unexpected service: ${h.service}`);
    return { bound: h.bound, version: h.version };
  });

  // --------- /run ---------
  await gate("GET /run returns 200/207 with documented top-level shape", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/run?write=0`);
    assert([200, 207].includes(res.status), `unexpected status ${res.status}`);
    runResp = await res.json();
    for (const k of [
      "ok", "ran", "passed", "failed", "violations", "elapsed_ms",
      "run_id", "started_at", "finished_at", "results", "stop", "backend",
    ]) {
      assert(k in runResp, `missing top-level key ${k}`);
    }
    assert(typeof runResp.run_id === "string" && runResp.run_id.length > 0, "empty run_id");
    return { run_id: runResp.run_id, status: res.status };
  });

  await gate("response has all 27 guardrail_ids (G01..G27)", () => {
    assert(Array.isArray(runResp.results), "results not an array");
    assert(runResp.results.length === 27, `expected 27 results, got ${runResp.results.length}`);
    const ids = runResp.results.map((r) => r.guardrail_id).sort();
    const expected = [...EXPECTED_IDS].sort();
    for (let i = 0; i < 27; i++) {
      assert(
        ids[i] === expected[i],
        `id mismatch at slot ${i}: got ${ids[i]}, expected ${expected[i]}`
      );
    }
    return { ids: ids.length, unique: new Set(ids).size };
  });

  await gate("every result row carries pass/severity/details/elapsed_ms", () => {
    for (const r of runResp.results) {
      assert(typeof r.pass === "boolean", `${r.guardrail_id} pass not boolean`);
      assert(typeof r.severity === "string", `${r.guardrail_id} severity not string`);
      assert("details" in r, `${r.guardrail_id} missing details`);
      assert(typeof r.elapsed_ms === "number", `${r.guardrail_id} elapsed_ms not number`);
    }
    return { rows: runResp.results.length };
  });

  await gate("violations array matches results.filter(!pass) by id", () => {
    const violIds = new Set(runResp.violations.map((v) => v.guardrail_id));
    const failIds = new Set(runResp.results.filter((r) => !r.pass).map((r) => r.guardrail_id));
    assert(violIds.size === failIds.size, `violations(${violIds.size}) != failing(${failIds.size})`);
    for (const id of failIds) {
      assert(violIds.has(id), `failing ${id} missing from violations[]`);
    }
    // capture for receipt
    liveRedRails = runResp.violations.map((v) => ({
      guardrail_id: v.guardrail_id,
      severity: v.severity,
      reason: v.details?.reason ?? null,
    }));
    return { violations: violIds.size };
  });

  // --------- SQLite ---------
  await gate("SQLite backend was selected (not jsonl fallback)", () => {
    assert(
      runResp.backend === "sqlite",
      `expected sqlite backend, got ${JSON.stringify(runResp.backend)}`
    );
    assert(existsSync(DB_PATH), `db file not on disk: ${DB_PATH}`);
    return { db_path: DB_PATH, backend: runResp.backend };
  });

  await gate("SQLite has 1 run row + 27 guardrail_results rows for this run_id", async () => {
    dbView1 = await readDbRun(runResp.run_id);
    assert(dbView1.run, `run row missing for ${runResp.run_id}`);
    assert(
      dbView1.results.length === 27,
      `expected 27 result rows, got ${dbView1.results.length}`
    );
    const dbIds = dbView1.results.map((r) => r.guardrail_id).sort();
    for (let i = 0; i < 27; i++) {
      assert(dbIds[i] === EXPECTED_IDS[i], `db id slot ${i}: ${dbIds[i]} != ${EXPECTED_IDS[i]}`);
    }
    return { run_id: dbView1.run.run_id, rows: dbView1.results.length };
  });

  await gate("DB pass/severity per row matches HTTP response per row", () => {
    const httpById = new Map(runResp.results.map((r) => [r.guardrail_id, r]));
    for (const dbR of dbView1.results) {
      const httpR = httpById.get(dbR.guardrail_id);
      assert(httpR, `no http row for ${dbR.guardrail_id}`);
      assert(
        dbR.pass === httpR.pass,
        `${dbR.guardrail_id} pass drift: db=${dbR.pass} http=${httpR.pass}`
      );
      assert(
        dbR.severity === httpR.severity,
        `${dbR.guardrail_id} severity drift: db=${dbR.severity} http=${httpR.severity}`
      );
    }
    return { rows_compared: dbView1.results.length };
  });

  // --------- KILL ---------
  await gate("daemon exits cleanly on SIGTERM", async () => {
    const r = await killDaemon(daemon1);
    assert(r, "daemon never exited");
    // After exit the port should be free; we give the OS a beat to release.
    await sleep(250);
    return { exit_code: r.code, signal: r.signal };
  });

  // --------- BOOT 2 (same state dir) ---------
  daemon2 = spawnDaemon({ port: PORT, label: "boot2" });

  await gate("daemon restarts on same state dir and answers /healthz", async () => {
    const h = await waitForHealthy({ port: PORT, daemon: daemon2 });
    return { bound: h.bound, last_run_in_health: h.last_run?.run_id ?? null };
  });

  // --------- /latest ---------
  await gate("GET /latest rehydrates the previous run_id", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/latest`);
    assert(res.ok, `latest http status ${res.status}`);
    restartLatest = await res.json();
    assert(
      restartLatest?.run_id === runResp.run_id,
      `latest run_id drift: ${restartLatest?.run_id} != ${runResp.run_id}`
    );
    assert(
      Array.isArray(restartLatest.results) && restartLatest.results.length === 27,
      `latest results count = ${restartLatest.results?.length}`
    );
    return { run_id: restartLatest.run_id, results: restartLatest.results.length };
  });

  await gate("rehydrated failing-rail set matches the pre-restart set", () => {
    const before = new Set(runResp.violations.map((v) => v.guardrail_id));
    const after = new Set(
      restartLatest.results.filter((r) => !r.pass).map((r) => r.guardrail_id)
    );
    assert(
      before.size === after.size,
      `failing count drift: before=${before.size} after=${after.size}`
    );
    for (const id of before) {
      assert(after.has(id), `previously failing ${id} not rehydrated`);
    }
    return { failing_rehydrated: after.size };
  });

  // --------- Teardown ---------
  await gate("second daemon exits cleanly", async () => {
    const r = await killDaemon(daemon2);
    return { exit_code: r?.code, signal: r?.signal };
  });
}

// ---------------------------------------------------------------------------
// Emit receipt + exit
// ---------------------------------------------------------------------------

function emitReceipt() {
  const passed = gates.filter((g) => g.pass).length;
  const failed = gates.filter((g) => !g.pass).length;
  const receipt = {
    schema: "orange5.guardrails.live-smoke.v1",
    ts: new Date().toISOString(),
    port: PORT,
    state_dir: STATE_DIR,
    db_path: DB_PATH,
    structural: {
      gates_total: gates.length,
      passed,
      failed,
      ok: failed === 0 && !fatalErr,
    },
    live_red_rails: liveRedRails,
    run_id: runResp?.run_id ?? null,
    rehydrated_run_id: restartLatest?.run_id ?? null,
    gates,
    fatal: fatalErr ? String(fatalErr) : null,
  };
  // Use synchronous writeSync to fd 1 — process.stdout.write on Windows is
  // async over pipes and can be lost when we call process.exit() immediately
  // after. fs.writeSync is blocking and survives the exit race.
  const buf = Buffer.from(
    JSON_ONLY
      ? JSON.stringify(receipt, null, 2) + "\n"
      : `\n---\ngates: ${passed}/${gates.length} pass\n` +
          (liveRedRails.length
            ? `live red rails (honest signal, not a test failure): ${liveRedRails
                .map((r) => `${r.guardrail_id}(${r.severity})`)
                .join(", ")}\n`
            : "") +
          `receipt:\n${JSON.stringify(receipt, null, 2)}\n`,
    "utf8"
  );
  try {
    writeSync(1, buf);
  } catch {
    // fall back to process.stdout if fd 1 is closed for some reason
    process.stdout.write(buf);
  }
  return receipt;
}

async function cleanup() {
  // Always try to reap children we may have left.
  try { await killDaemon(daemon1); } catch {}
  try { await killDaemon(daemon2); } catch {}
  if (!KEEP_STATE) {
    try {
      rmSync(STATE_DIR, { recursive: true, force: true });
    } catch {
      // not fatal — temp dir cleanup is best-effort
    }
  }
}

main()
  .catch((err) => {
    fatalErr = err?.stack || err;
    if (!JSON_ONLY) logLine(2, `fatal: ${fatalErr}\n`);
  })
  .finally(async () => {
    // Emit the receipt BEFORE cleanup. cleanup() does fs and child-process
    // work on Windows that can throw without surfacing; we want the receipt
    // on disk no matter what.
    let receipt;
    try {
      receipt = emitReceipt();
    } catch (e) {
      logLine(2, `emitReceipt threw: ${e?.stack || e}\n`);
      process.exit(2);
    }
    try {
      await cleanup();
    } catch (e) {
      logLine(2, `cleanup threw (non-fatal): ${e?.message || e}\n`);
    }
    if (fatalErr) process.exit(2);
    process.exit(receipt.structural.ok ? 0 : 1);
  });
