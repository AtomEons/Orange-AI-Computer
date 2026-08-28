#!/usr/bin/env node
// Endurance gate tests — exercise the pure pieces of endurance-24h and
// endurance-7d-monitor without the wall-clock cost of a full run.
//
// What's covered:
//   - 24h event synthesis is deterministic for a fixed seed
//   - 24h event count matches hours * events_per_hour (within ±1)
//   - 24h synthesized event timestamps are strictly within the sim window
//   - Receipt rendering produces parseable frontmatter that round-trips SHA
//   - 7d duration parser handles s/m/h/d
//   - 7d check derivation flips PASS → FAIL correctly per check
//   - 7d result receipt is well-formed markdown

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  synthesizeEvents,
  makeRng,
  renderReceiptMd,
  rowFromReceipt,
  renderResultReceipt as renderResultReceipt24,
  run as run24,
  parseArgs as parseArgs24,
} from "./endurance-24h.mjs";

import {
  parseDuration,
  summarizeChecks,
  deriveChecks,
  renderResultReceipt as renderResultReceipt7,
  parseArgs as parseArgs7,
} from "./endurance-7d-monitor.mjs";

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log(`  PASS ${msg}`); }
  else { fail++; console.log(`  FAIL ${msg}`); }
}

// ---------- 24h: event synthesis ------------------------------------------

// Test 1: deterministic across runs for fixed seed.
{
  const a = synthesizeEvents({ hours: 24, eventsPerHour: 12, seed: 42 });
  const b = synthesizeEvents({ hours: 24, eventsPerHour: 12, seed: 42 });
  assert(a.length === b.length, `same length (${a.length}, ${b.length})`);
  let allEqual = true;
  for (let i = 0; i < a.length; i++) {
    if (a[i].ts !== b[i].ts || a[i].seq !== b[i].seq || a[i].status !== b[i].status) {
      allEqual = false;
      break;
    }
  }
  assert(allEqual, "fully deterministic for fixed seed");
}

// Test 2: count matches and timestamps stay in window.
{
  const evts = synthesizeEvents({ hours: 24, eventsPerHour: 12, seed: 1 });
  assert(evts.length === 24 * 12, `288 events for 24h × 12/h (got ${evts.length})`);
  const minTs = evts[0].ts;
  const maxTs = evts[evts.length - 1].ts;
  const windowMs = 24 * 3_600_000;
  assert(maxTs - minTs <= windowMs + 1000, `span ≤ 24h (got ${(maxTs - minTs) / 3_600_000}h)`);
  let sorted = true;
  for (let i = 1; i < evts.length; i++) {
    if (evts[i].ts < evts[i - 1].ts) { sorted = false; break; }
  }
  assert(sorted, "events sorted ascending by ts");
}

// Test 3: different seeds produce different streams.
{
  const a = synthesizeEvents({ hours: 24, eventsPerHour: 12, seed: 1 });
  const b = synthesizeEvents({ hours: 24, eventsPerHour: 12, seed: 2 });
  let identical = true;
  for (let i = 0; i < a.length; i++) {
    if (a[i].ts !== b[i].ts || a[i].status !== b[i].status) { identical = false; break; }
  }
  assert(!identical, "different seeds → different streams");
}

// Test 4: PRNG is repeatable.
{
  const r1 = makeRng(7);
  const r2 = makeRng(7);
  for (let i = 0; i < 100; i++) {
    if (r1() !== r2()) { assert(false, "PRNG diverged at i=" + i); break; }
  }
  assert(true, "PRNG stays in sync across 100 draws");
}

// ---------- 24h: receipt rendering ----------------------------------------

// Test 5: renderReceiptMd produces parseable frontmatter.
{
  const evt = synthesizeEvents({ hours: 24, eventsPerHour: 12, seed: 1 })[0];
  const { id, markdown } = renderReceiptMd(evt);
  assert(id.length > 0 && id.endsWith("000001"), `receipt_id present and zero-padded (got ${id})`);
  assert(markdown.includes(`- **receipt_id:** ${id}`), "frontmatter receipt_id row present");
  assert(markdown.includes("- **schema:** orange5.receipt.endurance.v1"), "schema row present");
  assert(markdown.includes("**actor:** endurance-24h"), "actor row present");
  assert(markdown.includes("**sovereign:** Atom McCree"), "sovereign row present");
}

// Test 6: row sha matches markdown bytes.
{
  const evt = synthesizeEvents({ hours: 24, eventsPerHour: 12, seed: 1 })[0];
  const { id, markdown } = renderReceiptMd(evt);
  const row = rowFromReceipt({ id, markdown, evt, mdPath: "/tmp/x.md" });
  const expected = createHash("sha256").update(markdown).digest("hex");
  assert(row.sha256 === expected, "row sha256 matches markdown digest");
  assert(row.file_mtime_ms === evt.ts, "mtime = event ts");
}

// ---------- 24h: full run smoke -------------------------------------------

// Test 7: run() at very high speedup produces a PASS receipt and exits cleanly.
{
  const outDir = mkdtempSync(join(tmpdir(), "endurance-test-out-"));
  try {
    const args = parseArgs24(["--hours", "1", "--speedup", "100000", "--out", outDir, "--seed", "11", "--events-per-hour", "6"]);
    const result = await run24(args);
    assert(result.verdict === "PASS", `verdict PASS (got ${result.verdict})`);
    assert(existsSync(result.receiptPath), "result receipt written");
    const body = readFileSync(result.receiptPath, "utf8");
    assert(body.includes("Endurance 24h"), "body has title");
    assert(body.includes("PASS"), "body has verdict");
    assert(result.metrics.events_total === 6, `6 events (got ${result.metrics.events_total})`);
    assert(result.metrics.parse_errors === 0, "no parse errors");
    assert(result.metrics.sha_mismatches === 0, "sha integrity intact");
    assert(result.metrics.idempotency_ok === true, "idempotency intact");
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

// ---------- 7d: duration parser -------------------------------------------

// Test 8: parseDuration handles all units.
{
  assert(parseDuration("30s") === 30_000, "30s = 30000ms");
  assert(parseDuration("5m") === 300_000, "5m = 300000ms");
  assert(parseDuration("2h") === 7_200_000, "2h = 7200000ms");
  assert(parseDuration("7d") === 7 * 86_400_000, "7d = 604800000ms");
  assert(parseDuration("1.5h") === 5_400_000, "1.5h = 5400000ms");

  let threw = false;
  try { parseDuration("seven days"); } catch { threw = true; }
  assert(threw, "non-numeric throws");
  threw = false;
  try { parseDuration("5x"); } catch { threw = true; }
  assert(threw, "unknown unit throws");
}

// ---------- 7d: check derivation ------------------------------------------

// Test 9: summarizeChecks counts properly and tracks min/max.
{
  const samples = [
    { db: { ok: true, rows: 10, ingest_errors: 0 }, flow: { ok: true, age_ms: 1000 }, disk: { ok: true, free_mib: 5000 }, rss: { ok: true, rss_mib: 50 } },
    { db: { ok: true, rows: 12, ingest_errors: 0 }, flow: { ok: true, age_ms: 5000 }, disk: { ok: true, free_mib: 4900 }, rss: { ok: true, rss_mib: 60 } },
    { db: { ok: false, error: "x" }, flow: { ok: false, age_ms: 100000, error: "stale" }, disk: { ok: true, free_mib: 4800 }, rss: { ok: true, rss_mib: 55 } },
    { db: { ok: true, rows: 15, ingest_errors: 2 }, flow: { ok: true, age_ms: 2000 }, disk: { ok: true, free_mib: 4700 }, rss: { ok: false, rss_mib: 300 } },
  ];
  const s = summarizeChecks(samples);
  assert(s.samples === 4, "4 samples");
  assert(s.db_failures === 1, "1 db failure");
  assert(s.flow_failures === 1, "1 flow failure");
  assert(s.rss_failures === 1, "1 rss failure");
  assert(s.rss_max_mib === 300, "rss max = 300");
  assert(s.disk_min_free_mib === 4700, "disk min free = 4700");
  assert(s.flow_max_age_ms === 100000, "flow max age = 100000");
  assert(s.rows_first === 10, "rows first = 10");
  assert(s.rows_last === 15, "rows last = 15");
  assert(s.rows_delta === 5, "rows delta = 5");
  assert(s.ingest_errors_delta === 2, "ingest errors delta = 2");
}

// Test 10: deriveChecks flips per check.
{
  const summary = {
    samples: 10,
    db_failures: 0,
    flow_failures: 0,
    disk_failures: 0,
    rss_failures: 0,
    rss_max_mib: 100,
    disk_min_free_mib: 5000,
    flow_max_age_ms: 5000,
    rows_first: 10,
    rows_last: 12,
    rows_delta: 2,
    ingest_errors_first: 0,
    ingest_errors_last: 0,
    ingest_errors_delta: 0,
  };
  const argsOk = { rssBudgetMb: 256, diskFloorMb: 1024 };
  const checksOk = deriveChecks(summary, argsOk);
  assert(Object.values(checksOk).every(Boolean), "all-green summary → all PASS");

  // Flip rss budget.
  const checksFailRss = deriveChecks(summary, { rssBudgetMb: 50, diskFloorMb: 1024 });
  assert(checksFailRss.rss_under_budget === false, "rss flipped on tight budget");
  // Flip disk floor.
  const checksFailDisk = deriveChecks(summary, { rssBudgetMb: 256, diskFloorMb: 10000 });
  assert(checksFailDisk.disk_above_floor === false, "disk flipped on high floor");
  // Flip ingest errors.
  const checksFailIng = deriveChecks({ ...summary, ingest_errors_delta: 3 }, argsOk);
  assert(checksFailIng.no_new_ingest_errors === false, "ingest errors flip");

  // Null disk free → still PASS (statfs unavailable).
  const checksNullDisk = deriveChecks({ ...summary, disk_min_free_mib: null }, argsOk);
  assert(checksNullDisk.disk_above_floor === true, "null disk free passes (skip)");
}

// ---------- 7d: receipt rendering -----------------------------------------

// Test 11: renderResultReceipt produces well-formed markdown.
{
  const summary = { samples: 100, db_failures: 0, flow_failures: 0, disk_failures: 0, rss_failures: 0, rss_max_mib: 80, disk_min_free_mib: 5000, flow_max_age_ms: 4000, rows_first: 35, rows_last: 38, rows_delta: 3, ingest_errors_first: 0, ingest_errors_last: 0, ingest_errors_delta: 0 };
  const checks = { db_always_reachable: true, no_new_ingest_errors: true, flow_always_fresh: true, rss_under_budget: true, disk_above_floor: true };
  const args = { durationMs: 7 * 86_400_000, intervalMs: 300_000, rssBudgetMb: 256, diskFloorMb: 1024, flowStaleMs: 35_000 };
  const startedAt = Date.UTC(2026, 5, 24, 0, 0, 0);
  const endedAt = startedAt + 7 * 86_400_000;

  const { id, markdown } = renderResultReceipt7({
    verdict: "PASS", summary, checks, args, startedAt, endedAt, kind: "final",
  });
  assert(id.endsWith("-endurance-7d-pass"), `id has correct slug (got ${id})`);
  assert(markdown.includes("**status:** ENDURANCE_7D_PASS"), "status line present");
  assert(markdown.includes("| db_always_reachable | PASS |"), "checks table row");
  assert(markdown.includes("| samples | 100 |"), "summary table row");

  // Checkpoint variant should use different slug.
  const cp = renderResultReceipt7({
    verdict: "RUNNING", summary, checks, args, startedAt, endedAt, kind: "checkpoint",
  });
  assert(cp.id.endsWith("-endurance-7d-checkpoint"), "checkpoint slug");
  assert(cp.markdown.includes("(checkpoint)"), "checkpoint marker in title");
}

console.log(`\n[endurance tests] ${pass} passed / ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
