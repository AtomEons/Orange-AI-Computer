#!/usr/bin/env node
// Orange5 endurance gate — real 7-day uptime monitor
// Path:    06-CONTROL-PLANE/receipts/endurance-7d-monitor.mjs
// Runtime: Node >= 20, better-sqlite3 (resolved via this dir's package.json)
//
// Doctrine: parks for 7 days (configurable) watching the LIVE Orange5 receipts
// store and the AE Flow scheduler. Unlike endurance-24h, this monitor never
// synthesizes events — it observes the operator's real system.
//
// What it watches at every check interval (default 5 min):
//   - SQLite receipts DB opens cleanly and countReceipts() returns.
//   - ingest_log has not accrued PARSE_ERROR or WATCH_ERROR rows since the
//     previous check.
//   - 05-FLOW/state/flow.json mtime is fresher than scheduler heartbeat_ms
//     + grace (default heartbeat 30s + 5s grace).
//   - This monitor's own RSS stays below budget.
//   - Free disk space on the receipts DB volume remains above floor.
//
// Failures are non-fatal during the run — they are counted and surfaced in
// the final receipt. The monitor only crashes on a programming error or a
// catastrophic infra failure (DB file deleted, etc.).
//
// Optionally writes interim checkpoint receipts every --checkpoint-hours
// (default 24h) so the operator gets visible heartbeats while the gate is
// still running. The final pass/fail receipt is always written at the end.
//
// CLI:
//   node endurance-7d-monitor.mjs                     # 7d real run, 5-min poll
//   node endurance-7d-monitor.mjs --duration 60s      # short smoke test
//   node endurance-7d-monitor.mjs --duration 6h       # 6-hour gate
//   node endurance-7d-monitor.mjs --interval 30s      # poll every 30s
//   node endurance-7d-monitor.mjs --checkpoint-hours 12  # checkpoint every 12h
//   node endurance-7d-monitor.mjs --db <path>         # override DB
//   node endurance-7d-monitor.mjs --flow-state <path> # override flow.json
//   node endurance-7d-monitor.mjs --out <dir>         # override receipt dir
//   node endurance-7d-monitor.mjs --rss-budget 256    # RSS ceiling in MiB
//   node endurance-7d-monitor.mjs --disk-floor 1024   # free-disk floor in MiB

import { existsSync, mkdirSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { promises as fsp } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  openDb,
  listReceipts,
  countReceipts,
  close as closeDb,
  defaultReceiptsDir,
  DEFAULT_DB_PATH,
} from "./db.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

const SCHEMA = "orange5.receipt.endurance-7d.v1";
const ACTOR = "endurance-7d-monitor";
const SOVEREIGN = "Atom McCree";

const DEFAULT_DURATION_MS = 7 * 86_400_000; // 7 days
const DEFAULT_INTERVAL_MS = 5 * 60_000;     // 5 min
const DEFAULT_CHECKPOINT_HOURS = 24;
const DEFAULT_FLOW_STALE_MS = 35_000;       // 30s heartbeat + 5s grace
const DEFAULT_RSS_BUDGET_MB = 256;
const DEFAULT_DISK_FLOOR_MB = 1024;

// Default flow state path resolves relative to this file. Layout:
//   06-CONTROL-PLANE/receipts/ -> ../../05-FLOW/state/flow.json
const DEFAULT_FLOW_STATE = resolve(__dirname, "..", "..", "05-FLOW", "state", "flow.json");

// ---------- CLI ------------------------------------------------------------

function parseDuration(s) {
  if (typeof s !== "string") throw new Error("duration must be a string like '7d', '6h', '60s'");
  const m = /^(\d+(?:\.\d+)?)([smhd])$/.exec(s.trim());
  if (!m) throw new Error(`bad duration '${s}', expected like '7d' / '6h' / '300s'`);
  const n = Number(m[1]);
  switch (m[2]) {
    case "s": return Math.round(n * 1_000);
    case "m": return Math.round(n * 60_000);
    case "h": return Math.round(n * 3_600_000);
    case "d": return Math.round(n * 86_400_000);
    default: throw new Error("unreachable");
  }
}

function parseArgs(argv) {
  const out = {
    durationMs: DEFAULT_DURATION_MS,
    intervalMs: DEFAULT_INTERVAL_MS,
    checkpointHours: DEFAULT_CHECKPOINT_HOURS,
    flowStaleMs: DEFAULT_FLOW_STALE_MS,
    rssBudgetMb: DEFAULT_RSS_BUDGET_MB,
    diskFloorMb: DEFAULT_DISK_FLOOR_MB,
    db: null,
    flowState: null,
    out: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--duration") out.durationMs = parseDuration(argv[++i]);
    else if (a === "--interval") out.intervalMs = parseDuration(argv[++i]);
    else if (a === "--checkpoint-hours") out.checkpointHours = Number(argv[++i]);
    else if (a === "--flow-stale-ms") out.flowStaleMs = Number(argv[++i]);
    else if (a === "--rss-budget") out.rssBudgetMb = Number(argv[++i]);
    else if (a === "--disk-floor") out.diskFloorMb = Number(argv[++i]);
    else if (a === "--db") out.db = argv[++i];
    else if (a === "--flow-state") out.flowState = argv[++i];
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--help" || a === "-h") {
      process.stdout.write(
        "orange5 endurance 7-day monitor\n" +
        "usage: node endurance-7d-monitor.mjs [--duration 7d] [--interval 5m]\n" +
        "                                     [--checkpoint-hours N] [--rss-budget MB]\n" +
        "                                     [--disk-floor MB] [--db <path>]\n" +
        "                                     [--flow-state <path>] [--out <dir>]\n"
      );
      process.exit(0);
    }
  }
  if (!Number.isFinite(out.durationMs) || out.durationMs <= 0) throw new Error("--duration must be > 0");
  if (!Number.isFinite(out.intervalMs) || out.intervalMs <= 0) throw new Error("--interval must be > 0");
  if (out.intervalMs > out.durationMs) throw new Error("--interval cannot exceed --duration");
  return out;
}

// ---------- probes ---------------------------------------------------------

/** Open DB read-only-ish; we only call counts and ingest_log queries. */
function probeDb(dbPath) {
  try {
    const db = openDb(dbPath);
    const rows = countReceipts(db);
    const errs = db.prepare(
      "SELECT COUNT(*) AS n FROM ingest_log WHERE event IN ('PARSE_ERROR', 'WATCH_ERROR')"
    ).get();
    closeDb(db);
    return { ok: true, rows, ingest_errors: errs.n };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function probeFlowState(flowStatePath, maxStaleMs) {
  if (!existsSync(flowStatePath)) {
    return { ok: false, error: `flow.json not found at ${flowStatePath}` };
  }
  try {
    const st = statSync(flowStatePath);
    const ageMs = Date.now() - st.mtimeMs;
    const raw = readFileSync(flowStatePath, "utf8");
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch (e) { return { ok: false, error: `parse: ${e.message}`, age_ms: ageMs }; }
    const fresh = ageMs <= maxStaleMs;
    return {
      ok: fresh,
      age_ms: ageMs,
      max_stale_ms: maxStaleMs,
      tick: parsed.tick ?? null,
      last_tick_at: parsed.last_tick_at ?? null,
      currents: Object.keys(parsed.currents || {}).length,
      agents: Object.keys(parsed.agents || {}).length,
      error: fresh ? null : `flow.json mtime ${Math.round(ageMs / 1000)}s old > max ${Math.round(maxStaleMs / 1000)}s`,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function probeDisk(dbPath) {
  try {
    // node:fs/promises.statfs is available on Node 18+; we use it conditionally.
    if (typeof fsp.statfs === "function") {
      const s = await fsp.statfs(dirname(dbPath));
      const freeBytes = (s.bavail ?? s.bfree) * s.bsize;
      return { ok: true, free_mib: Math.round(freeBytes / (1024 * 1024)) };
    }
    return { ok: true, free_mib: null, note: "statfs unavailable; disk floor skipped" };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function probeRss(budgetMb) {
  const rss = process.memoryUsage.rss();
  const mb = Math.round((rss / (1024 * 1024)) * 10) / 10;
  return { ok: mb <= budgetMb, rss_mib: mb, budget_mib: budgetMb };
}

// ---------- main loop ------------------------------------------------------

function nowIso() { return new Date().toISOString(); }

function log(msg) {
  process.stdout.write(`[endurance-7d ${nowIso()}] ${msg}\n`);
}

function sleep(ms) {
  return new Promise(res => setTimeout(res, Math.max(0, ms)));
}

function summarizeChecks(samples) {
  const counts = { db: 0, flow: 0, disk: 0, rss: 0 };
  let dbErr = 0, flowErr = 0, diskErr = 0, rssErr = 0;
  let maxRss = 0, minDiskFree = Infinity, maxFlowAge = 0;
  let firstRows = null, lastRows = null;
  let firstIngestErrs = null, lastIngestErrs = null;
  for (const s of samples) {
    counts.db += 1;
    counts.flow += 1;
    counts.disk += 1;
    counts.rss += 1;
    if (!s.db.ok) dbErr += 1;
    if (!s.flow.ok) flowErr += 1;
    if (!s.disk.ok) diskErr += 1;
    if (!s.rss.ok) rssErr += 1;
    if (s.rss.rss_mib > maxRss) maxRss = s.rss.rss_mib;
    if (s.disk.free_mib != null && s.disk.free_mib < minDiskFree) minDiskFree = s.disk.free_mib;
    if (s.flow.age_ms && s.flow.age_ms > maxFlowAge) maxFlowAge = s.flow.age_ms;
    if (s.db.ok) {
      if (firstRows == null) firstRows = s.db.rows;
      lastRows = s.db.rows;
      if (firstIngestErrs == null) firstIngestErrs = s.db.ingest_errors;
      lastIngestErrs = s.db.ingest_errors;
    }
  }
  return {
    samples: samples.length,
    db_failures: dbErr,
    flow_failures: flowErr,
    disk_failures: diskErr,
    rss_failures: rssErr,
    rss_max_mib: maxRss,
    disk_min_free_mib: Number.isFinite(minDiskFree) ? minDiskFree : null,
    flow_max_age_ms: maxFlowAge,
    rows_first: firstRows,
    rows_last: lastRows,
    rows_delta: firstRows != null && lastRows != null ? lastRows - firstRows : null,
    ingest_errors_first: firstIngestErrs,
    ingest_errors_last: lastIngestErrs,
    ingest_errors_delta: firstIngestErrs != null && lastIngestErrs != null ? lastIngestErrs - firstIngestErrs : null,
  };
}

function deriveChecks(summary, args) {
  return {
    db_always_reachable: summary.db_failures === 0,
    no_new_ingest_errors: (summary.ingest_errors_delta ?? 0) === 0,
    flow_always_fresh: summary.flow_failures === 0,
    rss_under_budget: summary.rss_max_mib <= args.rssBudgetMb,
    disk_above_floor: summary.disk_min_free_mib == null || summary.disk_min_free_mib >= args.diskFloorMb,
  };
}

function renderResultReceipt({ verdict, summary, checks, args, startedAt, endedAt, kind }) {
  const date = nowIso().slice(0, 10);
  const slug = kind === "checkpoint" ? "endurance-7d-checkpoint" : `endurance-7d-${verdict.toLowerCase()}`;
  const receiptId = `${date}-${slug}`;
  const lines = [
    `# Endurance 7d Monitor — ${verdict}${kind === "checkpoint" ? " (checkpoint)" : ""}`,
    "",
    `- **receipt_id:** ${receiptId}`,
    `- **generated_at:** ${nowIso()}`,
    `- **schema:** ${SCHEMA}`,
    `- **status:** ENDURANCE_7D_${verdict}${kind === "checkpoint" ? "_CHECKPOINT" : ""}`,
    `- **confidence:** ${verdict === "PASS" ? "0.95" : verdict === "RUNNING" ? "0.80" : "0.55"}`,
    `- **prior_receipt:** (none — endurance gates land independently)`,
    `- **hash_chain:** (off-chain; gate result)`,
    `- **actor:** ${ACTOR}`,
    `- **sovereign:** ${SOVEREIGN}`,
    "",
    "---",
    "",
    "## Window",
    "",
    `- Started: ${new Date(startedAt).toISOString()}`,
    `- ${kind === "checkpoint" ? "Checkpoint at" : "Ended"}: ${new Date(endedAt).toISOString()}`,
    `- Wall-clock: ${Math.round((endedAt - startedAt) / 1000)}s`,
    `- Configured duration: ${Math.round(args.durationMs / 1000)}s`,
    `- Poll interval: ${Math.round(args.intervalMs / 1000)}s`,
    "",
    "## Checks",
    "",
    "| Check | Result |",
    "|---|---|",
  ];
  for (const [k, v] of Object.entries(checks)) {
    lines.push(`| ${k} | ${v ? "PASS" : "FAIL"} |`);
  }
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push("| Field | Value |");
  lines.push("|---|---|");
  for (const [k, v] of Object.entries(summary)) {
    lines.push(`| ${k} | ${v} |`);
  }
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("## What was watched");
  lines.push("");
  lines.push(`- Receipts DB: \`${args.db || DEFAULT_DB_PATH}\``);
  lines.push(`- Flow state: \`${args.flowState || DEFAULT_FLOW_STATE}\``);
  lines.push(`- RSS budget: ${args.rssBudgetMb} MiB`);
  lines.push(`- Disk floor: ${args.diskFloorMb} MiB`);
  lines.push(`- Flow stale ceiling: ${args.flowStaleMs} ms`);
  lines.push("");
  lines.push("**Mom is watching. The system either held for 7 days or it did not. This is the truth of it.**");
  lines.push("");
  return { id: receiptId, markdown: lines.join("\n") };
}

async function run(args) {
  const outDir = resolve(args.out || defaultReceiptsDir());
  const dbPath = resolve(args.db || DEFAULT_DB_PATH);
  const flowState = resolve(args.flowState || DEFAULT_FLOW_STATE);

  log(`db:         ${dbPath}`);
  log(`flowState:  ${flowState}`);
  log(`out:        ${outDir}`);
  log(`duration:   ${Math.round(args.durationMs / 1000)}s`);
  log(`interval:   ${Math.round(args.intervalMs / 1000)}s`);
  log(`rssBudget:  ${args.rssBudgetMb} MiB`);
  log(`diskFloor:  ${args.diskFloorMb} MiB`);

  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  const startedAt = Date.now();
  const endAt = startedAt + args.durationMs;
  const checkpointMs = args.checkpointHours > 0 ? args.checkpointHours * 3_600_000 : null;
  let nextCheckpointAt = checkpointMs ? startedAt + checkpointMs : Infinity;

  const samples = [];
  let stopped = false;

  process.on("SIGINT", () => { log("SIGINT — stopping monitor early"); stopped = true; });
  process.on("SIGTERM", () => { log("SIGTERM — stopping monitor early"); stopped = true; });

  while (!stopped && Date.now() < endAt) {
    const sample = {
      ts: Date.now(),
      db: probeDb(dbPath),
      flow: probeFlowState(flowState, args.flowStaleMs),
      disk: await probeDisk(dbPath),
      rss: probeRss(args.rssBudgetMb),
    };
    samples.push(sample);

    log(`sample #${samples.length} db_rows=${sample.db.rows ?? "n/a"} ` +
        `ingest_err=${sample.db.ingest_errors ?? "n/a"} ` +
        `flow_age_s=${sample.flow.age_ms != null ? Math.round(sample.flow.age_ms / 1000) : "n/a"} ` +
        `rss_mib=${sample.rss.rss_mib} ` +
        `free_mib=${sample.disk.free_mib ?? "n/a"}`);

    if (Date.now() >= nextCheckpointAt) {
      const summary = summarizeChecks(samples);
      const checks = deriveChecks(summary, args);
      const verdict = Object.values(checks).every(Boolean) ? "RUNNING" : "DEGRADED";
      const { markdown } = renderResultReceipt({
        verdict, summary, checks, args,
        startedAt, endedAt: Date.now(), kind: "checkpoint",
      });
      const cpName = `${nowIso().slice(0, 10)}-endurance-7d-checkpoint-${samples.length}.md`;
      const cpPath = join(outDir, cpName);
      writeFileSync(cpPath, markdown, "utf8");
      log(`checkpoint: ${cpPath} verdict=${verdict}`);
      nextCheckpointAt = Date.now() + (checkpointMs ?? Infinity);
    }

    const sleepMs = Math.min(args.intervalMs, endAt - Date.now());
    if (sleepMs > 0) await sleep(sleepMs);
  }

  const endedAt = Date.now();
  const summary = summarizeChecks(samples);
  const checks = deriveChecks(summary, args);
  const verdict = Object.values(checks).every(Boolean) && samples.length > 0 ? "PASS" : "FAIL";

  log(`verdict: ${verdict}`);
  for (const [k, v] of Object.entries(checks)) log(`  ${v ? "PASS" : "FAIL"} ${k}`);

  const { id, markdown } = renderResultReceipt({
    verdict, summary, checks, args, startedAt, endedAt, kind: "final",
  });
  const receiptPath = join(outDir, `${id}.md`);
  writeFileSync(receiptPath, markdown, "utf8");
  log(`receipt: ${receiptPath}`);

  return { verdict, summary, checks, receiptPath, samples: samples.length };
}

const invokedDirectly = process.argv[1] && basename(process.argv[1]) === "endurance-7d-monitor.mjs";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await run(args);
  process.exit(result.verdict === "PASS" ? 0 : 2);
}

if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write(`[endurance-7d] fatal: ${err.stack || err.message}\n`);
    process.exit(1);
  });
}

export {
  parseArgs,
  parseDuration,
  probeDb,
  probeFlowState,
  probeDisk,
  probeRss,
  summarizeChecks,
  deriveChecks,
  renderResultReceipt,
  run,
};
