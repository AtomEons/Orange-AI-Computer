#!/usr/bin/env node
// Orange5 — Continuity Packet Loader tests
// Path: 04-CONTROL-PLANE/tests/continuity-loader.test.mjs
//
// Deterministic. No network. No Reality Flux daemon required. We inject a
// fake adapter and a temp filesystem root. Mom's Law: every test name is
// the assertion in plain English, and a failure prints what was expected
// vs what was got — no "all green" without an evidence line.

import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

import {
  loadLatest,
  validateAndNormalize,
  findLatestLocalPacket,
  extractPacketCandidates,
  todayIso,
  dayShift,
  latestHandler,
  routes,
} from "../continuity/loader.mjs";

// ------------------------------------------------------------------ harness

let pass = 0, fail = 0;
function ok(cond, name, detail = "") {
  if (cond) {
    pass++;
    console.log(`  PASS ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail ? " :: " + detail : ""}`);
  }
}
function eq(actual, expected, name) {
  ok(
    actual === expected,
    name,
    `expected=${JSON.stringify(expected)} got=${JSON.stringify(actual)}`,
  );
}

// ------------------------------------------------------------------ fixtures

const TMP_ROOT = mkdtempSync(join(tmpdir(), "orange5-cont-"));
const DIR_A = join(TMP_ROOT, "guardrails");
const DIR_B = join(TMP_ROOT, "doctrine");
mkdirSync(DIR_A, { recursive: true });
mkdirSync(DIR_B, { recursive: true });

const VALID_PACKET_NEW_SCHEMA = {
  schema: "orange5.continuity-packet.v1",
  date: "2026-06-23",
  progress: ["wrote loader", "wired gateway route"],
  open_blockers: ["cobra unreachable on test box"],
  tomorrow_first_action: "smoke-test the gateway mount",
  notes: null,
  guardrails_summary: { run_id: "r-1", ok: true, violations: 0 },
};

const VALID_PACKET_OLD_SCHEMA = {
  schema_version: "orange5.continuity-packet.v0",
  date: "2026-06-22",
  today_progress: ["older shape"],
  open_blockers: [],
  tomorrows_first_action: "carry on",
};

writeFileSync(
  join(DIR_A, "2026-06-23.json"),
  JSON.stringify(VALID_PACKET_NEW_SCHEMA),
);
writeFileSync(
  join(DIR_B, "continuity_2026-06-22.json"),
  JSON.stringify(VALID_PACKET_OLD_SCHEMA),
);

// A deliberately malformed packet — wrong field types.
const BAD_PACKET = {
  schema: "orange5.continuity-packet.v1",
  date: "2026-06-21",
  progress: "not-an-array",
  open_blockers: [],
  tomorrow_first_action: null,
};
writeFileSync(join(DIR_A, "2026-06-21.json"), JSON.stringify(BAD_PACKET));

// ------------------------------------------------------------------ tests

// pure helpers
ok(/^\d{4}-\d{2}-\d{2}$/.test(todayIso()), "todayIso returns YYYY-MM-DD");
eq(dayShift("2026-06-24", -1), "2026-06-23", "dayShift -1 day");
eq(dayShift("2026-03-01", -1), "2026-02-28", "dayShift across month boundary");

// validateAndNormalize — new schema
{
  const v = validateAndNormalize(VALID_PACKET_NEW_SCHEMA);
  ok(v.ok, "validateAndNormalize accepts new-schema packet");
  eq(v.normalized.date, "2026-06-23", "new-schema date preserved");
  eq(v.normalized.progress.length, 2, "new-schema progress preserved");
}

// validateAndNormalize — old/alt schema (the one G-18 expects)
{
  const v = validateAndNormalize(VALID_PACKET_OLD_SCHEMA);
  ok(v.ok, "validateAndNormalize accepts old/G-18 schema");
  eq(v.normalized.progress[0], "older shape", "today_progress aliased to progress");
  eq(
    v.normalized.tomorrow_first_action,
    "carry on",
    "tomorrows_first_action aliased to tomorrow_first_action",
  );
}

// validateAndNormalize — rejects garbage
{
  const v = validateAndNormalize({ date: "not-a-date" });
  ok(!v.ok, "validateAndNormalize rejects bad date");
  eq(v.reason, "packet_missing_or_bad_date", "named reason for bad date");
}
{
  const v = validateAndNormalize(null);
  ok(!v.ok, "validateAndNormalize rejects null");
}
{
  const v = validateAndNormalize(BAD_PACKET);
  ok(!v.ok, "validateAndNormalize rejects non-array progress");
  eq(v.reason, "progress_not_array", "named reason for type mismatch");
}

// findLatestLocalPacket — happy path, newest wins across dirs
{
  const r = findLatestLocalPacket({
    today: "2026-06-24",
    dirs: [DIR_A, DIR_B],
    maxLookbackDays: 7,
  });
  ok(r.ok, "findLatestLocalPacket finds the newer packet first");
  eq(r.packet.date, "2026-06-23", "newer date selected (2026-06-23)");
  eq(r.days_back, 1, "days_back=1 (today=24, found=23)");
}

// findLatestLocalPacket — old-schema directory only
{
  const r = findLatestLocalPacket({
    today: "2026-06-24",
    dirs: [DIR_B],
    maxLookbackDays: 7,
  });
  ok(r.ok, "findLatestLocalPacket finds the old-schema file in DOCTRINE dir");
  eq(r.packet.date, "2026-06-22", "old-schema date surfaced");
}

// findLatestLocalPacket — malformed file (in DIR_A under 2026-06-21) is
// only reachable if newer files don't exist. Force that.
{
  // Move the good packet aside.
  const goodPath = join(DIR_A, "2026-06-23.json");
  const stashed = join(DIR_A, "2026-06-23.json.bak");
  writeFileSync(stashed, JSON.stringify(VALID_PACKET_NEW_SCHEMA));
  rmSync(goodPath, { force: true });

  const r = findLatestLocalPacket({
    today: "2026-06-21",
    dirs: [DIR_A],
    maxLookbackDays: 7,
  });
  ok(!r.ok, "findLatestLocalPacket refuses to silently skip a malformed file");
  eq(
    r.reason,
    "local_packet_failed_validation",
    "named reason for malformed packet",
  );

  // Restore for later tests.
  writeFileSync(goodPath, JSON.stringify(VALID_PACKET_NEW_SCHEMA));
  rmSync(stashed, { force: true });
}

// findLatestLocalPacket — nothing in lookback window
{
  const emptyDir = join(TMP_ROOT, "empty");
  mkdirSync(emptyDir, { recursive: true });
  const r = findLatestLocalPacket({
    today: "2026-06-24",
    dirs: [emptyDir],
    maxLookbackDays: 3,
  });
  ok(!r.ok, "empty dir → not found");
  eq(
    r.reason,
    "no_local_continuity_packet_in_lookback_window",
    "named reason for empty lookback",
  );
  ok(Array.isArray(r.searched) && r.searched.length > 0, "searched paths reported");
}

// extractPacketCandidates — picks newest valid out of an events array,
// ignores invalid records without throwing.
{
  const fluxData = {
    events: [
      { date: "2026-06-20", progress: [], open_blockers: [] }, // valid bare packet
      { not_a_packet: true },
      { body: VALID_PACKET_NEW_SCHEMA }, // wrapped
      { payload: VALID_PACKET_OLD_SCHEMA }, // alt wrap, alt schema
      "string is fine",
      null,
    ],
  };
  const cands = extractPacketCandidates(fluxData);
  ok(cands.length === 3, `extractPacketCandidates found 3 valid (got ${cands.length})`);
  eq(cands[0].date, "2026-06-23", "newest packet first");
  eq(cands[cands.length - 1].date, "2026-06-20", "oldest packet last");
}

// loadLatest — Reality Flux wins when available
{
  const fakeAdapter = {
    async read() {
      return {
        ok: true,
        source: "cobra_loopback",
        stale: false,
        data: { events: [{ body: VALID_PACKET_NEW_SCHEMA }] },
      };
    },
  };
  const out = await loadLatest({
    adapter: fakeAdapter,
    skipFiles: true,
    skipCache: true,
  });
  ok(out.ok, "loadLatest succeeds via Reality Flux");
  eq(out.source, "reality_flux:cobra_loopback", "source labels flux + sub-source");
  eq(out.stale, false, "fresh flux is not stale");
  eq(out.date, "2026-06-23", "loadLatest returns newest packet date");
  ok(/^[0-9a-f]{64}$/.test(out.sha256), "sha256 hex digest is 64 chars");
}

// loadLatest — flux unreachable, falls through to local files
{
  const deadAdapter = {
    async read() {
      return { ok: false, reason: "cobra_unreachable_and_shadow_empty" };
    },
  };
  const out = await loadLatest({
    adapter: deadAdapter,
    today: "2026-06-24",
    fsDirs: [DIR_A, DIR_B],
    skipCache: true,
  });
  ok(out.ok, "loadLatest falls back to local files when flux is dead");
  ok(
    typeof out.source === "string" && out.source.startsWith("local_file:"),
    "source labels which local file was used",
  );
  eq(out.date, "2026-06-23", "fallback returns newest local packet");
  ok(out.attempts.length >= 2, "attempts ledger records both tries");
}

// loadLatest — all three sources skipped → ok:false with named reason
{
  const out = await loadLatest({
    skipFlux: true,
    skipFiles: true,
    skipCache: true,
  });
  ok(!out.ok, "loadLatest with all sources skipped returns not-ok");
  eq(
    out.reason,
    "no_continuity_packet_found_anywhere",
    "named reason for total failure",
  );
}

// loadLatest — flux returns stale shadow; we still take it, but mark stale
{
  const staleAdapter = {
    async read() {
      return {
        ok: true,
        source: "n150_shadow_cache",
        stale: true,
        data: { events: [{ body: VALID_PACKET_NEW_SCHEMA }] },
      };
    },
  };
  const out = await loadLatest({
    adapter: staleAdapter,
    skipFiles: true,
    skipCache: true,
  });
  ok(out.ok, "stale shadow still returns a packet");
  eq(out.stale, true, "stale flag honored");
}

// loadLatest — adapter throws → recorded, doesn't kill the request
{
  const throwingAdapter = {
    async read() {
      throw new Error("simulated adapter blow-up");
    },
  };
  const out = await loadLatest({
    adapter: throwingAdapter,
    skipFiles: true,
    skipCache: true,
  });
  ok(!out.ok, "throwing adapter does not surface as success");
  eq(out.reason, "no_continuity_packet_found_anywhere", "total-failure reason");
  ok(
    out.attempts.some((a) => a.reason === "flux_read_threw"),
    "throwing adapter recorded as flux_read_threw in attempts",
  );
}

// latestHandler — basic GET returns 200 + JSON body
{
  const captured = { headers: null, status: null, body: "" };
  const fakeRes = {
    writeHead(status, headers) {
      captured.status = status;
      captured.headers = headers;
    },
    end(body) {
      captured.body = body;
    },
  };
  // We allow it to fail naturally — no flux, no files at default paths.
  // The contract is "200 ok:false" not "5xx".
  await latestHandler({ method: "GET" }, fakeRes);
  eq(captured.status, 200, "latestHandler returns 200 even when nothing found");
  ok(
    captured.headers["Content-Type"] === "application/json",
    "Content-Type is application/json",
  );
  const parsed = JSON.parse(captured.body);
  ok(typeof parsed.ok === "boolean", "body has ok boolean");
  ok(typeof parsed.fetched_at === "number", "body has fetched_at timestamp");
}

// latestHandler — non-GET → 405
{
  const captured = { status: null, headers: null, body: "" };
  const fakeRes = {
    writeHead(status, headers) { captured.status = status; captured.headers = headers; },
    end(body) { captured.body = body; },
  };
  await latestHandler({ method: "POST" }, fakeRes);
  eq(captured.status, 405, "POST is rejected with 405");
  eq(captured.headers["Allow"], "GET", "Allow header advertises GET");
  const parsed = JSON.parse(captured.body);
  eq(parsed.reason, "method_not_allowed", "named reason");
}

// routes table sanity
ok(
  typeof routes["GET /v1/continuity/latest"] === "function",
  "routes table exposes GET /v1/continuity/latest → function",
);

// ------------------------------------------------------------------ cleanup

try { rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }

console.log(`\n[continuity-loader] ${pass} passed / ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
