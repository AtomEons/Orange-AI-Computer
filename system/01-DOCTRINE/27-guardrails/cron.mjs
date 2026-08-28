// cron.mjs — Orange5 27 Constitutional Guardrails scheduler daemon.
//
// V1 (2026-06-24). Turns the 27-guardrails surface from STATIC scaffolding
// into a LIVE daemon:
//
//   (a) Full 27-check sweep every 15 minutes (default; override with
//       GUARDRAILS_CRON_INTERVAL_MS). The first sweep fires `kickoff_delay_ms`
//       after process start (default 2s) so boot is never blocked by a sweep.
//   (b) On-demand /run endpoint (HTTP, loopback-only) for AECommand Center,
//       cockpit, Gate-0 LBCE pre-check, and operator console.
//   (c) Every sweep persists into the SAME SQLite the doctrine layer already
//       owns (state/guardrails.sqlite via lib/db.mjs recordRun). last_run +
//       last_violations are read back through lib/db.mjs latestRun().
//   (d) Reality-Flux emission DEDUPES against last_run: only NEW violations
//       (guardrail_id + violation-fingerprint) since the last persisted run
//       are shipped. Repeating the same failure every 15 minutes does not
//       spam Flux; a NEW failing rail, or a failing rail that briefly went
//       green and re-broke, does.
//   (e) Process-lifetime telemetry: cron emits a CRON_TICK log line per
//       sweep with run_id, ok, ran/passed/failed, new_violations, elapsed_ms.
//       The cockpit can tail state/guardrails.log to render a live banner.
//
// Run modes (all use the same module):
//
//   bun  01-DOCTRINE/27-guardrails/cron.mjs        # daemon (cron + HTTP)
//   node 01-DOCTRINE/27-guardrails/cron.mjs        # daemon (cron + HTTP)
//   node 01-DOCTRINE/27-guardrails/cron.mjs --once # one sweep, exit 0/1
//   node 01-DOCTRINE/27-guardrails/cron.mjs --no-http   # cron only
//
// HTTP surface (port = GUARDRAILS_CRON_PORT, default 7461 — sibling to the
// existing 7460 in server.mjs; cron is a SEPARATE process so the two can
// run independently and neither blocks the other):
//
//   GET /healthz        — { ok, uptime_s, last_tick_at, last_run_id,
//                            failures_last_run, total_ticks }
//   GET /run            — fire sweep NOW, return public envelope. ?write=0
//                          to skip Flux. Operator-gated only by loopback bind.
//   GET /last           — pass-through to lib/db.latestRun()
//   GET /violations     — last-run violations, decorated with new_since_prev
//                          boolean per row.
//
// Loopback ONLY. Process exits non-zero on bind failure. No external network.

import { createServer } from "node:http";
import { randomUUID, createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { runGuardrails } from "./runtime.mjs";
import { latestRun } from "./lib/db.mjs";
import { writeViolationsToFlux } from "./lib/flux-client.mjs";
import { STATE_DIR } from "./lib/paths.mjs";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const HOST = process.env.GUARDRAILS_CRON_HOST || "127.0.0.1";
const PORT = parseInt(process.env.GUARDRAILS_CRON_PORT || "7461", 10);
const INTERVAL_MS = parseInt(
  process.env.GUARDRAILS_CRON_INTERVAL_MS || String(15 * 60 * 1000),
  10
);
const KICKOFF_DELAY_MS = parseInt(
  process.env.GUARDRAILS_CRON_KICKOFF_DELAY_MS || "2000",
  10
);
const TIMEOUT_PER_CHECK_MS = parseInt(
  process.env.GUARDRAILS_TIMEOUT_PER_CHECK_MS || "5000",
  10
);
const ENABLE_HTTP = process.argv.indexOf("--no-http") === -1;
const RUN_ONCE = process.argv.indexOf("--once") !== -1;

const LOG_PATH = resolve(STATE_DIR, "guardrails.log");

// ---------------------------------------------------------------------------
// Logging — line-oriented to state/guardrails.log so the cockpit can tail.
// ---------------------------------------------------------------------------

function ensureDir(p) {
  try { mkdirSync(dirname(p), { recursive: true }); } catch {}
}

function log(level, msg, fields = {}) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    ...fields,
  });
  // Stderr keeps the structured log stream clean of any JSON envelope that
  // --once writes to stdout. The daemon's stdout is unused so this is also
  // harmless under detached spawn (launch.mjs redirects both fds to the
  // same log file). Cockpit consumers should tail state/guardrails.log.
  // eslint-disable-next-line no-console
  console.error(line);
  try {
    ensureDir(LOG_PATH);
    appendFileSync(LOG_PATH, line + "\n", "utf8");
  } catch {
    // Never fail a sweep on a log write.
  }
}

// ---------------------------------------------------------------------------
// Violation fingerprinting (for new-since-prev dedupe to Flux)
// ---------------------------------------------------------------------------
//
// A violation's identity = (guardrail_id, sev, stable digest of details).
// We stringify details with a stable key order; missing details collapse to
// the empty object. The fingerprint is sha256(JSON) truncated to 16 hex chars
// — collisions are vanishingly unlikely at our scale, and the run_id is the
// secondary key.

function stableStringify(obj) {
  if (obj === null || obj === undefined) return "null";
  if (typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return "[" + obj.map(stableStringify).join(",") + "]";
  const keys = Object.keys(obj).sort();
  return (
    "{" +
    keys.map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",") +
    "}"
  );
}

function violationFingerprint(v) {
  const details = v?.details ?? null;
  // Some checks return error strings that include a timing suffix
  // ("timeout after 5000ms"). Strip the numeric part so the same rule
  // tripping in two sweeps still hashes the same.
  let normalized = details;
  if (typeof details === "object" && details && typeof details.error === "string") {
    normalized = {
      ...details,
      error: details.error.replace(/\d+ms/g, "Nms"),
    };
  }
  const payload = stableStringify({
    id: v.guardrail_id,
    sev: v.severity,
    details: normalized,
  });
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

function fingerprintSetFromRun(run) {
  // run from latestRun() has rows in results; details may be a JSON string
  // when read back from SQLite. Decode best-effort.
  const set = new Set();
  if (!run || !Array.isArray(run.results)) return set;
  for (const r of run.results) {
    if (r.pass) continue;
    let details = r.details;
    if (typeof details === "string") {
      try { details = JSON.parse(details); } catch { /* leave as string */ }
    }
    set.add(
      violationFingerprint({
        guardrail_id: r.guardrail_id,
        severity: r.severity,
        details,
      })
    );
  }
  return set;
}

// ---------------------------------------------------------------------------
// Sweep core
// ---------------------------------------------------------------------------

const STATE = {
  started_at: Date.now(),
  total_ticks: 0,
  last_tick_at: null,
  last_run_id: null,
  last_ok: null,
  last_failed: 0,
  last_new_violation_count: 0,
  in_flight: false,
  // We hold the previous run's fingerprint set in memory so the dedupe is
  // fast and survives even if SQLite read-back is slow. Bootstrapped from
  // disk on first sweep.
  prev_fingerprints: null,
};

async function bootstrapPrevFingerprints() {
  if (STATE.prev_fingerprints) return;
  try {
    const prev = await latestRun();
    STATE.prev_fingerprints = fingerprintSetFromRun(prev);
    log("info", "cron.bootstrap.prev_fingerprints", {
      count: STATE.prev_fingerprints.size,
      have_prev_run: !!prev,
      prev_run_id: prev?.run_id || null,
    });
  } catch (err) {
    STATE.prev_fingerprints = new Set();
    log("warn", "cron.bootstrap.prev_fingerprints.failed", {
      error: String(err?.message || err),
    });
  }
}

async function sweep({ source, writeFlux = true } = {}) {
  if (STATE.in_flight) {
    return {
      ok: false,
      reason: "sweep_already_in_flight",
      started_at: STATE.last_tick_at,
    };
  }
  await bootstrapPrevFingerprints();
  STATE.in_flight = true;
  const tickId = randomUUID().slice(0, 8);
  const t0 = Date.now();
  try {
    log("info", "cron.tick.start", {
      tick_id: tickId,
      source,
      total_ticks: STATE.total_ticks,
    });

    // Run the full sweep WITHOUT letting runtime.mjs ship to Flux directly
    // — cron owns dedupe, so we re-emit ourselves only on NEW violations.
    const out = await runGuardrails({
      timeout_ms_per_check: TIMEOUT_PER_CHECK_MS,
      write_to_flux: false,
      persist: true,
    });

    // Build new-since-prev set
    const currentFingerprints = new Map();
    for (const v of out.violations || []) {
      currentFingerprints.set(violationFingerprint(v), v);
    }
    const prevSet = STATE.prev_fingerprints || new Set();
    const newViolations = [];
    for (const [fp, v] of currentFingerprints.entries()) {
      if (!prevSet.has(fp)) newViolations.push({ ...v, fingerprint: fp });
    }

    // Decorate per-result with new_since_prev
    const decoratedResults = (out.results || []).map((r) => {
      if (r.pass) return { ...r, new_since_prev: false };
      const fp = violationFingerprint({
        guardrail_id: r.guardrail_id,
        severity: r.severity,
        details:
          typeof r.details === "string"
            ? (() => { try { return JSON.parse(r.details); } catch { return r.details; } })()
            : r.details,
      });
      return { ...r, fingerprint: fp, new_since_prev: !prevSet.has(fp) };
    });

    // Flux emission — ONLY on new violations
    let fluxResult = null;
    if (writeFlux && newViolations.length > 0) {
      fluxResult = await writeViolationsToFlux({
        run_id: out.run_id,
        violations: newViolations.map((v) => ({
          ...v,
          origin: "guardrails",
          new_since_prev: true,
        })),
        ok: out.ok,
        elapsed_ms: out.elapsed_ms,
      }).catch((err) => ({ ok: false, detail: String(err?.message || err) }));
    } else if (writeFlux) {
      fluxResult = { ok: true, wrote: 0, source: "deduped_noop" };
    }

    // Advance prev set
    STATE.prev_fingerprints = new Set(currentFingerprints.keys());
    STATE.total_ticks += 1;
    STATE.last_tick_at = Date.now();
    STATE.last_run_id = out.run_id;
    STATE.last_ok = out.ok;
    STATE.last_failed = out.failed;
    STATE.last_new_violation_count = newViolations.length;

    log("info", "cron.tick.done", {
      tick_id: tickId,
      source,
      run_id: out.run_id,
      ok: out.ok,
      ran: out.ran,
      passed: out.passed,
      failed: out.failed,
      new_violations: newViolations.length,
      stop_level: out.stop,
      elapsed_ms: out.elapsed_ms,
      tick_elapsed_ms: Date.now() - t0,
      flux: fluxResult ? { ok: fluxResult.ok, wrote: fluxResult.wrote ?? 0, source: fluxResult.source || null } : null,
    });

    return {
      ok: out.ok,
      ran: out.ran,
      passed: out.passed,
      failed: out.failed,
      violations: out.violations,
      new_violations: newViolations,
      elapsed_ms: out.elapsed_ms,
      run_id: out.run_id,
      stop: out.stop,
      backend: out.backend,
      flux: fluxResult,
      results: decoratedResults,
      tick_id: tickId,
      tick_elapsed_ms: Date.now() - t0,
    };
  } catch (err) {
    log("error", "cron.tick.fatal", {
      tick_id: tickId,
      source,
      error: String(err?.stack || err?.message || err),
    });
    return {
      ok: false,
      reason: "sweep_threw",
      error: String(err?.message || err),
      tick_id: tickId,
    };
  } finally {
    STATE.in_flight = false;
  }
}

// ---------------------------------------------------------------------------
// HTTP surface
// ---------------------------------------------------------------------------

function jsonRes(res, body, status = 200) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body, null, 2));
}

async function handleHttp(req, res) {
  // Loopback enforcement defense-in-depth (binding HOST=127.0.0.1 already
  // limits this, but we check the socket too for paranoia).
  const remote = req.socket?.remoteAddress || "";
  if (remote && !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote)) {
    return jsonRes(res, { ok: false, reason: "loopback_only" }, 403);
  }
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const path = url.pathname;
  const method = (req.method || "GET").toUpperCase();

  if (method === "GET" && path === "/healthz") {
    return jsonRes(res, {
      ok: true,
      service: "orange5-guardrails-cron",
      version: "1.0.0",
      bound: `${HOST}:${PORT}`,
      now: Date.now(),
      uptime_s: Math.round((Date.now() - STATE.started_at) / 1000),
      interval_ms: INTERVAL_MS,
      last_tick_at: STATE.last_tick_at,
      last_run_id: STATE.last_run_id,
      last_ok: STATE.last_ok,
      last_failed: STATE.last_failed,
      last_new_violation_count: STATE.last_new_violation_count,
      total_ticks: STATE.total_ticks,
      in_flight: STATE.in_flight,
    });
  }

  if (method === "GET" && path === "/run") {
    const writeFlux = url.searchParams.get("write") !== "0";
    const result = await sweep({ source: "http_run", writeFlux });
    const status = result.stop ? 207 : result.ok ? 200 : 200;
    return jsonRes(res, result, status);
  }

  if (method === "GET" && path === "/last") {
    const last = await latestRun().catch(() => null);
    return jsonRes(res, last ?? { ok: true, last_run: null });
  }

  if (method === "GET" && path === "/violations") {
    const last = await latestRun().catch(() => null);
    if (!last) return jsonRes(res, { ok: true, violations: [] });
    const prevSet = STATE.prev_fingerprints || new Set();
    const violations = (last.results || [])
      .filter((r) => !r.pass)
      .map((r) => {
        let details = r.details;
        if (typeof details === "string") {
          try { details = JSON.parse(details); } catch {}
        }
        const fp = violationFingerprint({
          guardrail_id: r.guardrail_id,
          severity: r.severity,
          details,
        });
        return {
          guardrail_id: r.guardrail_id,
          severity: r.severity,
          details,
          fingerprint: fp,
          // After a sweep, prev_fingerprints == current — so this flag is
          // "still tripped since last sweep" rather than "new in this sweep".
          // For "new in this sweep" semantics, the /run response's
          // new_violations[] is authoritative.
          present_in_prev_set: prevSet.has(fp),
        };
      });
    return jsonRes(res, {
      ok: last.ok,
      run_id: last.run_id,
      finished_at: last.finished_at,
      count: violations.length,
      violations,
    });
  }

  return jsonRes(res, { ok: false, reason: "not_found", path }, 404);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function main() {
  if (RUN_ONCE) {
    const result = await sweep({ source: "cli_once" });
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    process.exit(result.stop || !result.ok ? 1 : 0);
    return;
  }

  // Bootstrap prev fingerprints from SQLite so the FIRST cron tick can dedupe
  // against the most recent persisted run rather than firing a Flux storm
  // of "new" violations that are not actually new.
  await bootstrapPrevFingerprints();

  // HTTP server
  if (ENABLE_HTTP) {
    const server = createServer((req, res) => {
      handleHttp(req, res).catch((err) => {
        log("error", "http.handler.threw", { error: String(err?.message || err) });
        try {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: String(err?.message || err) }));
        } catch {}
      });
    });
    server.on("error", (err) => {
      log("fatal", "http.bind.failed", {
        host: HOST,
        port: PORT,
        error: String(err?.message || err),
      });
      process.exit(2);
    });
    server.listen(PORT, HOST, () => {
      log("info", "cron.http.listening", { host: HOST, port: PORT });
    });
  }

  // Cron loop
  log("info", "cron.boot", {
    interval_ms: INTERVAL_MS,
    kickoff_delay_ms: KICKOFF_DELAY_MS,
    timeout_per_check_ms: TIMEOUT_PER_CHECK_MS,
    http: ENABLE_HTTP ? `${HOST}:${PORT}` : "disabled",
  });

  setTimeout(() => {
    // Kickoff sweep
    sweep({ source: "cron_kickoff" }).catch((err) =>
      log("error", "cron.kickoff.threw", { error: String(err?.message || err) })
    );
    // Then every INTERVAL_MS
    setInterval(() => {
      sweep({ source: "cron_tick" }).catch((err) =>
        log("error", "cron.tick.threw", { error: String(err?.message || err) })
      );
    }, INTERVAL_MS);
  }, KICKOFF_DELAY_MS);

  // Graceful shutdown
  const shutdown = (sig) => {
    log("info", "cron.shutdown", { signal: sig });
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  log("fatal", "cron.main.threw", { error: String(err?.stack || err?.message || err) });
  process.exit(2);
});
