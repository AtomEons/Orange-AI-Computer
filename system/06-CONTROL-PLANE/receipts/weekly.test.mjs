#!/usr/bin/env node
// Weekly summarizer tests
// Path: 06-CONTROL-PLANE/receipts/weekly.test.mjs
//
// Covers: date math (TZ-aware Friday detection, week numbering, next-fire
// targeting across DST), aggregation correctness, markdown rendering,
// hash-chain assignment, and end-to-end run against an in-memory SQLite.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

import { openDb, applySchema, upsertReceipt, close as closeDb } from "./db.mjs";
import {
  weekNumber,
  fridayOnOrBeforeNY,
  nextFridayTarget,
  nyParts,
  aggregate,
  fetchWeek,
  renderMarkdown,
  chainOrdinal,
  nextHashChainOrdinal,
  buildAndWrite,
  receiptDayPrefix,
} from "./weekly.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log(`  PASS ${msg}`); }
  else { fail++; console.log(`  FAIL ${msg}`); }
}

// Remove a temp db and its WAL sidecars. closeDb() (db.mjs) already checkpoints
// and forces statement finalization so the OS handle is released before we get
// here; deleting the -wal/-shm names too keeps temp clean if a checkpoint left
// an empty sidecar behind.
function rmDb(dbPath) {
  for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    if (existsSync(p)) rmSync(p, { force: true });
  }
}

// ---------- date math ------------------------------------------------------

// Test 1: weekNumber anchored at 2026-06-26.
{
  assert(weekNumber("2026-06-26") === 1, "anchor Friday is week 1");
  assert(weekNumber("2026-07-03") === 2, "next Friday is week 2");
  assert(weekNumber("2027-06-25") === 53, "one year later is week ~53");
  assert(weekNumber("2026-06-19") === 0, "before-anchor is week 0");
}

// Test 2: fridayOnOrBeforeNY rolls back from any weekday to Friday.
//   Anchor: pick wall-clock noon UTC on a known Friday → Wednesday cases.
{
  const noonFridayUtc = Date.UTC(2026, 5, 26, 16, 0, 0); // 26 Jun 2026 16:00 UTC = noon ET
  assert(fridayOnOrBeforeNY(noonFridayUtc) === "2026-06-26", "Friday noon → same Friday");
  const noonSatUtc   = noonFridayUtc + 1 * 86_400_000;
  assert(fridayOnOrBeforeNY(noonSatUtc) === "2026-06-26", "Saturday → prior Friday");
  const noonSunUtc   = noonFridayUtc + 2 * 86_400_000;
  assert(fridayOnOrBeforeNY(noonSunUtc) === "2026-06-26", "Sunday → prior Friday");
  const noonThuUtc   = noonFridayUtc - 1 * 86_400_000;
  assert(fridayOnOrBeforeNY(noonThuUtc) === "2026-06-19", "Thursday → previous Friday");
}

// Test 3: nextFridayTarget lands on Friday 23:55 America/New_York.
{
  const monday = Date.UTC(2026, 5, 22, 16, 0, 0); // Mon 22 Jun 2026 noon ET
  const t = nextFridayTarget(monday);
  const p = nyParts(t);
  assert(p.weekday === 5, `next target lands on Friday (got weekday ${p.weekday})`);
  assert(p.hour === 23 && p.minute === 55, `target hour/minute = 23:55 (got ${p.hour}:${p.minute})`);
  assert(t > monday, "target is strictly after now");

  // From Friday 22:00 ET, the next target is THIS Friday 23:55.
  const fridayBefore = Date.UTC(2026, 5, 26, 2, 0, 0); // Fri 26 Jun 2026 22:00 ET (DST = UTC-4)
  const t2 = nextFridayTarget(fridayBefore);
  const p2 = nyParts(t2);
  assert(p2.weekday === 5 && p2.day === 26, "from Fri 22:00 ET → same Fri 23:55 ET");

  // From Friday 23:56 ET (1 minute after target), the next fire is the FOLLOWING Friday (July 3).
  const fridayAfter = Date.UTC(2026, 5, 27, 3, 56, 0); // Sat 27 Jun 03:56 UTC = Fri 26 Jun 23:56 ET
  const t3 = nextFridayTarget(fridayAfter);
  const p3 = nyParts(t3);
  assert(p3.weekday === 5 && p3.month === 7 && p3.day === 3,
    `after Fri target → next Fri 2026-07-03 (got ${p3.year}-${p3.month}-${p3.day})`);
  assert(t3 > fridayAfter, "next-Friday target is strictly later");
}

// Test 4: DST-aware. Spring-forward Sunday in 2026 is March 8.
//   Wed before should land on Friday March 13 23:55 ET.
{
  const wedBeforeDst = Date.UTC(2026, 2, 4, 17, 0, 0); // Wed 4 Mar 2026 noon ET (UTC-5)
  const tDst = nextFridayTarget(wedBeforeDst);
  const pDst = nyParts(tDst);
  assert(pDst.weekday === 5 && pDst.hour === 23 && pDst.minute === 55,
    `pre-DST Wed → Fri 23:55 ET (got weekday ${pDst.weekday}, ${pDst.hour}:${pDst.minute})`);
}

// ---------- aggregate ------------------------------------------------------

// Test 5: aggregate buckets correctly.
{
  const rows = [
    { receipt_id: "2026-06-24-a", generated_at: "2026-06-24T10:00:00Z", status: "X", actor: "claude", confidence: 0.9, hash_chain: "#001" },
    { receipt_id: "2026-06-24-b", generated_at: "2026-06-24T11:00:00Z", status: "X", actor: "atom",   confidence: 0.5, hash_chain: "#002" },
    { receipt_id: "2026-06-25-c", generated_at: null,                   status: "Y", actor: "claude", confidence: 0.95, hash_chain: "#003" },
    { receipt_id: "2026-06-25-d", generated_at: null,                   status: null,actor: null,    confidence: null, hash_chain: null  },
  ];
  const agg = aggregate(rows);
  assert(agg.total === 4, "total counted");
  assert(agg.byDay.get("2026-06-24").length === 2, "2 rows on 06-24");
  assert(agg.byDay.get("2026-06-25").length === 2, "2 rows on 06-25 (receipt_id fallback)");
  assert(agg.byStatus.get("X") === 2, "status X = 2");
  assert(agg.byStatus.get("(unset)") === 1, "(unset) status counted");
  assert(agg.confidence.n === 3, "3 confidence-bearing");
  assert(Math.abs(agg.confidence.mean - (0.9 + 0.5 + 0.95) / 3) < 1e-9, "confidence mean");
  assert(agg.confidence.low.length === 1 && agg.confidence.low[0].id === "2026-06-24-b", "low-confidence flagged");
  assert(agg.hashChain.length === 3, "3 with hash chain");
  assert(agg.hashChain[0].hash_chain === "#001", "hash chain sorted by ordinal");
  assert(agg.noHashChain.length === 1, "1 missing hash chain");
}

// ---------- chainOrdinal ---------------------------------------------------

// Test 6: chainOrdinal parses #NNN and bare digits.
{
  assert(chainOrdinal("#021") === 21, "#021 parses");
  assert(chainOrdinal("21") === 21, "bare digits parse");
  assert(chainOrdinal("#021 — note") === 21, "trailing text ignored");
  assert(chainOrdinal(null) === null, "null returns null");
  assert(chainOrdinal("") === null, "empty returns null");
  assert(chainOrdinal("abc") === null, "non-numeric returns null");
}

// ---------- receiptDayPrefix ----------------------------------------------

// Test 7: receiptDayPrefix prefers generated_at, falls back to receipt_id.
{
  assert(receiptDayPrefix({ generated_at: "2026-06-24T10:00:00Z", receipt_id: "2026-06-23-x" }) === "2026-06-24",
    "generated_at wins");
  assert(receiptDayPrefix({ generated_at: null, receipt_id: "2026-06-23-x" }) === "2026-06-23",
    "receipt_id fallback");
  assert(receiptDayPrefix({ generated_at: "not-a-date", receipt_id: "2026-06-23-x" }) === "2026-06-23",
    "malformed generated_at → receipt_id fallback");
  assert(receiptDayPrefix({ generated_at: null, receipt_id: "no-date-here" }) === null,
    "no date anywhere → null");
}

// ---------- end-to-end: in-memory DB + buildAndWrite ----------------------

// Test 8: feed an in-memory DB, run buildAndWrite, verify markdown lands.
{
  const tmpDb = join(tmpdir(), `orange5-weekly-test-${process.pid}.db`);
  const tmpOut = join(tmpdir(), `orange5-weekly-test-out-${process.pid}`);
  if (existsSync(tmpDb)) rmSync(tmpDb, { force: true });
  if (existsSync(tmpOut)) rmSync(tmpOut, { recursive: true, force: true });
  mkdirSync(tmpOut, { recursive: true });

  try {
    const db = openDb(tmpDb);
    // Insert two rows for week-ending 2026-06-26 and one for prior week.
    const rows = [
      { receipt_id: "2026-06-23-alpha", generated_at: "2026-06-23T10:00:00Z", schema: "x", status: "OK", confidence: 0.8, confidence_raw: "0.8", prior_receipt: null, hash_chain: "#001", actor: "claude", sovereign: "atom", markdown_path: "/x/a.md", sha256: "a".repeat(64), body_json: "{}", file_mtime_ms: 1 },
      { receipt_id: "2026-06-24-beta",  generated_at: "2026-06-24T10:00:00Z", schema: "x", status: "OK", confidence: 0.9, confidence_raw: "0.9", prior_receipt: null, hash_chain: "#002", actor: "claude", sovereign: "atom", markdown_path: "/x/b.md", sha256: "b".repeat(64), body_json: "{}", file_mtime_ms: 2 },
      { receipt_id: "2026-06-15-gamma", generated_at: "2026-06-15T10:00:00Z", schema: "x", status: "OK", confidence: 0.5, confidence_raw: "0.5", prior_receipt: null, hash_chain: "#000", actor: "claude", sovereign: "atom", markdown_path: "/x/g.md", sha256: "c".repeat(64), body_json: "{}", file_mtime_ms: 3 },
    ];
    for (const r of rows) upsertReceipt(db, r);

    const result = buildAndWrite({ db, outDir: tmpOut, fridayIso: "2026-06-26", dryRun: false });
    assert(result.written === true, "file written");
    assert(result.rows === 2, `2 rows in window (got ${result.rows})`);
    assert(existsSync(result.path), "markdown file exists at expected path");

    const content = readFileSync(result.path, "utf8");
    assert(content.includes("Week 1"), "week number embedded");
    assert(content.includes("2026-06-24-beta"), "row receipt_id appears in chain table");
    assert(!content.includes("2026-06-15-gamma"), "prior-week row excluded");
    assert(content.includes("**hash_chain:** #003"), "next hash chain = #003");
    assert(content.includes("**prior_receipt:** 2026-06-24-beta"), "prior_receipt = highest chain ordinal");

    closeDb(db);
  } finally {
    rmDb(tmpDb);
    if (existsSync(tmpOut)) rmSync(tmpOut, { recursive: true, force: true });
  }
}

// Test 9: nextHashChainOrdinal handles missing chains.
{
  const tmpDb = join(tmpdir(), `orange5-weekly-test-chain-${process.pid}.db`);
  if (existsSync(tmpDb)) rmSync(tmpDb, { force: true });
  try {
    const db = openDb(tmpDb);
    upsertReceipt(db, { receipt_id: "x1", generated_at: "2026-06-01", schema: "x", status: "OK", confidence: 1.0, confidence_raw: "1.0", prior_receipt: null, hash_chain: null, actor: null, sovereign: null, markdown_path: "/x/x1.md", sha256: "1".repeat(64), body_json: "{}", file_mtime_ms: 1 });
    assert(nextHashChainOrdinal(db) === "#001", "no chains yet → #001");
    upsertReceipt(db, { receipt_id: "x2", generated_at: "2026-06-02", schema: "x", status: "OK", confidence: 1.0, confidence_raw: "1.0", prior_receipt: null, hash_chain: "#017", actor: null, sovereign: null, markdown_path: "/x/x2.md", sha256: "2".repeat(64), body_json: "{}", file_mtime_ms: 2 });
    assert(nextHashChainOrdinal(db) === "#018", "max=17 → #018");
    closeDb(db);
  } finally {
    rmDb(tmpDb);
  }
}

// Test 10: renderMarkdown is stable for the empty-week case.
{
  const md = renderMarkdown({
    weekN: 99,
    fridayIso: "2099-12-25",
    weekStartIso: "2099-12-19",
    agg: aggregate([]),
    priorReceiptId: null,
    hashChainNext: "#999",
  });
  assert(md.includes("Week 99"), "empty week renders");
  assert(md.includes("No receipts landed this week"), "empty marker present");
  assert(md.includes("**hash_chain:** #999"), "hash chain rendered");
  assert(md.includes("**prior_receipt:** (none in window)"), "prior_receipt blank label");
}

console.log(`\n[weekly tests] ${pass} passed / ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
