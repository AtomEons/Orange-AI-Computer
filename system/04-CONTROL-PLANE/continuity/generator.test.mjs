// generator.test.mjs — smoke test for the Continuity Packet generator.
//
// Verifies:
//   1. ymdET() returns a YYYY-MM-DD string
//   2. dayWindowET() round-trips: ymdET(new Date(startMs)) === input
//   3. summarizeProgress() filters non-progress kinds out
//   4. extractOpenBlockers() picks up risk=high
//   5. readOpenCurrents() handles missing flow state gracefully
//   6. readFreshReceipts() handles missing dir gracefully
//   7. deriveTomorrowsFirstAction() falls through correctly
//   8. generatePacket({dryRun:true}) returns the documented shape and a sha256
//   9. generatePacket() actually writes a local file under continuity dir
//
// Run: `node generator.test.mjs`

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ymdET,
  dayWindowET,
  summarizeProgress,
  extractOpenBlockers,
  readOpenCurrents,
  readFreshReceipts,
  deriveTomorrowsFirstAction,
  readTodaysFluxEvents,
  generatePacket,
  PACKET_SCHEMA,
} from "./generator.mjs";

let failures = 0;
function t(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => process.stdout.write(`ok   ${name}\n`))
    .catch((e) => {
      failures += 1;
      process.stderr.write(`FAIL ${name}\n  ${e?.stack || e}\n`);
    });
}

async function main() {
  await t("ymdET returns YYYY-MM-DD", () => {
    const s = ymdET(new Date());
    assert.match(s, /^\d{4}-\d{2}-\d{2}$/);
  });

  await t("dayWindowET round-trips", () => {
    const date = "2026-06-24";
    const { startMs, endMs } = dayWindowET(date);
    assert.equal(ymdET(new Date(startMs)), date);
    assert.equal(ymdET(new Date(endMs)), date);
    assert.equal(endMs - startMs, 86_400_000 - 1);
  });

  await t("dayWindowET rejects garbage", () => {
    assert.throws(() => dayWindowET("not-a-date"));
  });

  await t("summarizeProgress filters non-progress kinds", () => {
    const events = [
      { ts: 1, kind: "observation", body: { summary: "boring obs" } },
      { ts: 2, kind: "decision", body: { summary: "chose Q5_K_M" } },
      { ts: 3, kind: "receipt", body: { summary: "PR-04 closed" } },
      { ts: 4, kind: "current_closed", body: { summary: "current_42 landed" } },
    ];
    const out = summarizeProgress(events);
    assert.equal(out.length, 3);
    assert.deepEqual(out.map((x) => x.kind).sort(), ["current_closed", "decision", "receipt"]);
  });

  await t("summarizeProgress de-dups by summary prefix", () => {
    const events = [
      { ts: 1, kind: "decision", body: { summary: "Same decision" } },
      { ts: 2, kind: "decision", body: { summary: "Same decision" } },
    ];
    const out = summarizeProgress(events);
    assert.equal(out.length, 1);
  });

  await t("extractOpenBlockers picks up risk=high", () => {
    const events = [
      { ts: 1, kind: "observation", body: { summary: "fine", risk: "low" } },
      { ts: 2, kind: "observation", body: { summary: "BAD", risk: "high" } },
      { ts: 3, kind: "error", body: { detail: "boom" } },
      { ts: 4, kind: "risk", body: { message: "exposure" } },
    ];
    const out = extractOpenBlockers(events);
    assert.equal(out.length, 3);
  });

  await t("readOpenCurrents handles missing file", () => {
    const out = readOpenCurrents("/no/such/path.json");
    assert.equal(out.ok, false);
    assert.deepEqual(out.currents, []);
  });

  await t("readFreshReceipts handles missing dir", () => {
    const { startMs, endMs } = dayWindowET("2026-06-24");
    const out = readFreshReceipts({
      dir: "/no/such/dir",
      dateStr: "2026-06-24",
      startMs,
      endMs,
    });
    assert.equal(out.ok, false);
  });

  await t("deriveTomorrowsFirstAction prefers critical blocker", () => {
    const r = deriveTomorrowsFirstAction({
      open_currents: [{ id: "c1", title: "x", pressure: 0.9 }],
      open_blockers: [{ ts: 1, kind: "error", lane: "reality", origin: "hermes", detail: "CRITICAL failure" }],
      progress_summary: [],
    });
    assert.equal(r.reason, "open_blocker_critical");
  });

  await t("deriveTomorrowsFirstAction falls to current when no critical blocker", () => {
    const r = deriveTomorrowsFirstAction({
      open_currents: [{ id: "c1", title: "ship pr-18", pressure: 0.8, owner_department: "AE6" }],
      open_blockers: [],
      progress_summary: [],
    });
    assert.equal(r.reason, "highest_pressure_current");
    assert.match(r.action, /ship pr-18/);
  });

  await t("deriveTomorrowsFirstAction final fallback", () => {
    const r = deriveTomorrowsFirstAction({
      open_currents: [],
      open_blockers: [],
      progress_summary: [],
    });
    assert.equal(r.reason, "no_signal_available");
  });

  await t("readTodaysFluxEvents safe-fails on missing root", () => {
    const out = readTodaysFluxEvents({
      fluxRoot: "/no/such/root",
      startMs: 0,
      endMs: Date.now(),
    });
    assert.equal(out.ok, false);
    assert.deepEqual(out.events, []);
  });

  await t("readTodaysFluxEvents reads a real ledger directory", () => {
    const root = mkdtempSync(join(tmpdir(), "flux-test-"));
    try {
      const lane = "reality";
      const date = ymdET();
      const dir = join(root, "events", lane);
      mkdirSync(dir, { recursive: true });
      const ts = Date.now();
      const rec = {
        ts,
        lane,
        origin: "test",
        kind: "decision",
        body: { summary: "test progress" },
        prev_hash: "GENESIS",
        hash: "x",
      };
      writeFileSync(join(dir, `${date}.jsonl`), JSON.stringify(rec) + "\n");
      const out = readTodaysFluxEvents({
        fluxRoot: root,
        startMs: ts - 1000,
        endMs: ts + 1000,
      });
      assert.equal(out.ok, true);
      assert.equal(out.events.length, 1);
      assert.equal(out.events[0].body.summary, "test progress");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t("generatePacket(dryRun) returns documented shape with sha256", async () => {
    const r = await generatePacket({
      dryRun: true,
      writeFlux: false,
      fluxRoot: "/no/such/root",
    });
    assert.equal(r.status, "dry_run");
    const p = r.packet;
    for (const k of [
      "schema", "date", "written_at", "progress_summary", "open_blockers",
      "tomorrows_first_action", "hot_currents", "fresh_receipts", "flux_counts",
      "soul_genome_ref", "sha256",
    ]) {
      assert.ok(k in p, `missing key ${k}`);
    }
    assert.equal(p.schema, PACKET_SCHEMA);
    assert.match(p.sha256, /^[0-9a-f]{64}$/);
    assert.match(p.date, /^\d{4}-\d{2}-\d{2}$/);
  });

  await t("generatePacket writes a local file at canonical path", async () => {
    const r = await generatePacket({
      dateStr: ymdET(),
      writeFlux: false, // skip daemon hop
      fluxRoot: "/no/such/root",
    });
    assert.ok(r.local_path, "local_path missing");
    assert.ok(existsSync(r.local_path), `not on disk: ${r.local_path}`);
    const parsed = JSON.parse(readFileSync(r.local_path, "utf8"));
    assert.equal(parsed.schema, "orange5.continuity-packet.v1");
    assert.equal(parsed.date, ymdET());
    // flux write was skipped → status should be ok
    assert.equal(r.status, "ok");
  });

  process.stdout.write(failures === 0 ? `\nall ok\n` : `\n${failures} failure(s)\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  process.stderr.write(`harness error: ${e?.stack || e}\n`);
  process.exit(1);
});
