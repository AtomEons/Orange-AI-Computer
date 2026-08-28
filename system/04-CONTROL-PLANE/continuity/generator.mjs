#!/usr/bin/env node
// Orange5 — Author Continuity Packet auto-writer
// Path:    04-CONTROL-PLANE/continuity/generator.mjs
// Runtime: Node >= 20
// Trigger: 23:50 America/New_York daily, cron-driven (node-cron) or systemd timer.
//
// What this does
// --------------
// At end of each day (23:50 ET) this script:
//   1. Reads today's Reality Flux events from the Æ Cobra Flux ledger (reality lane,
//      thought lane, merge lane — bounded by today's ET window).
//   2. Reads open AE Flow currents from 05-FLOW/state/flow.json (status != closed).
//   3. Reads fresh receipts from 10-RECEIPTS/orange5-build/ (today's ET filename
//      prefix + mtime fallback).
//   4. Synthesizes one JSON Continuity Packet:
//        { schema, date, written_at, progress_summary, open_blockers,
//          tomorrows_first_action, hot_currents, fresh_receipts,
//          flux_counts, soul_genome_ref, sha256 }
//   5. Writes the packet to the canonical Continuity store at
//      `01-DOCTRINE/27-guardrails/state/continuity/<YYYY-MM-DD>.json`
//      (the single source of truth read by g15 and by next session boot).
//   6. Also writes the same packet body into Reality Flux with origin=continuity,
//      lane=reality, event_type=continuity_packet, kind=continuity. This makes
//      the packet a first-class hash-chained record in the memory organ.
//
// Doctrine alignment (binding)
// ----------------------------
// 1. Mom's Law: full effort. No fake-green. If the daemon is unreachable, we
//    still write the local packet, mark the flux_write status honestly, and
//    exit code 2 (wrote-with-warning) instead of pretending success.
// 2. G15 — Continuity Packet for previous day exists by 06:00 local. This
//    generator writes the file the guardrail looks for.
// 3. G10 — Receipts are hash-chained. The Flux record we emit chains into
//    the reality lane file via flux/writer.mjs (prev_hash + self-hash).
// 4. G14 / G19 — Soul Genome is the z_0 anchor. We don't mutate it; we
//    reference its sha256 so the packet declares which anchor was active.
// 5. Reality lane discipline (G12): origin=continuity is a receipt-origin
//    write (the packet IS the daily receipt of operator continuity), and the
//    daemon's origin-based classifier (V1 fix) routes it to reality.
// 6. Idempotent: re-running for the same date overwrites the local packet
//    with identical bytes given identical inputs. The flux write is append-
//    only by design (every run leaves a new chained record — that's correct
//    behavior for a ledger, not a bug).
//
// CLI
// ---
//   node generator.mjs                       # write for today (ET)
//   node generator.mjs --date 2026-06-24     # write for a specific day
//   node generator.mjs --dry-run             # print packet, no write
//   node generator.mjs --no-flux             # skip Flux write (local only)
//   node generator.mjs --start               # stay alive and run nightly via cron
//   node generator.mjs --help                # show this help
//
// Exit codes
//   0  ok (local packet written, Flux write ok or skipped intentionally)
//   2  wrote-with-warning (local packet written, Flux unreachable)
//   1  hard fail

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

import { writeContinuity, continuityPath, readContinuity } from "../../01-DOCTRINE/27-guardrails/lib/continuity-packet.mjs";
import { ensureSoulGenome } from "../../01-DOCTRINE/27-guardrails/lib/soul-genome.mjs";
import { RECEIPTS_DIR, SOUL_GENOME_PATH, ORANGE5_ROOT } from "../../01-DOCTRINE/27-guardrails/lib/paths.mjs";
import { canonicalFluxRoot } from "../../06-ORANGELLM/memory/ae-cobra/paths.mjs";
import { __loopInternals } from "../../03-BACKEND/learning-loop.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const ET_TIMEZONE = "America/New_York";
export const CRON_EXPRESSION = "50 23 * * *"; // 23:50 daily (TZ at runtime)
export const PACKET_SCHEMA = "orange5.continuity-packet.v1";
export const RECEIPTS_BUILD_DIR = resolve(RECEIPTS_DIR, "orange5-build");

// Where the Flux ledger lives — overridable so Codexa (WSL2) and Windows hosts
// can both run this. The Codexa daemon uses /mnt/ae_flux; on Windows you can
// point AE_FLUX_ROOT at the shadow cache for local-only authoring.
export const FLUX_ROOT_DEFAULT = canonicalFluxRoot();

// ---------------------------------------------------------------------------
// Date math (ET-aware)
// ---------------------------------------------------------------------------

/**
 * Return YYYY-MM-DD for the given Date interpreted in America/New_York.
 * No external tz lib — we use Intl.DateTimeFormat for correctness.
 */
export function ymdET(d = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: ET_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  // en-CA gives YYYY-MM-DD verbatim.
  return fmt.format(d);
}

/**
 * Compute [startMs, endMs] (UTC milliseconds) for a given ET YYYY-MM-DD day.
 * Inclusive of full 00:00:00.000 ET → 23:59:59.999 ET.
 */
export function dayWindowET(yyyyMmDd) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(yyyyMmDd)) {
    throw new Error(`invalid date: ${yyyyMmDd}`);
  }
  // Build local midnight in ET by iterating: we want the UTC instant whose
  // ET wall clock is YYYY-MM-DD 00:00:00.000. We compute by formatting a
  // candidate UTC instant in ET and bisecting once. In practice ET is either
  // UTC-5 or UTC-4, so try both and pick the one that round-trips.
  const [y, m, d] = yyyyMmDd.split("-").map(Number);
  const candidates = [
    Date.UTC(y, m - 1, d, 4, 0, 0, 0),  // EDT (UTC-4)
    Date.UTC(y, m - 1, d, 5, 0, 0, 0),  // EST (UTC-5)
  ];
  let startMs = null;
  for (const c of candidates) {
    if (ymdET(new Date(c)) === yyyyMmDd) {
      // Verify it's actually 00:00 in ET, not just the right date.
      const hourFmt = new Intl.DateTimeFormat("en-US", {
        timeZone: ET_TIMEZONE,
        hour: "2-digit",
        hour12: false,
      });
      if (hourFmt.format(new Date(c)) === "00") {
        startMs = c;
        break;
      }
    }
  }
  if (startMs === null) {
    // Fallback: pick the candidate whose ET date matches.
    startMs = candidates.find((c) => ymdET(new Date(c)) === yyyyMmDd) ?? candidates[1];
  }
  const endMs = startMs + 86_400_000 - 1;
  return { startMs, endMs };
}

// ---------------------------------------------------------------------------
// Reality Flux ingestion
// ---------------------------------------------------------------------------

// Lanes the continuity generator harvests. The Æ Cobra Flux ledger stores one
// JSONL file per lane per ET day at `<fluxRoot>/events/<lane>/<YYYY-MM-DD>.jsonl`,
// with record shape { ts, lane, origin, kind, body, prev_hash, hash } — the same
// layout writer.mjs / the live daemon produce and the smoke test asserts.
export const FLUX_LANES = ["reality", "thought", "merge"];

/**
 * Read Flux records for a lane across the ET day files that overlap [startMs,
 * endMs]. Only complete (newline-terminated) records are parsed; a torn or
 * unparseable trailing line is skipped rather than throwing, so end-of-day
 * generation never fails on an in-flight append.
 */
function readLaneRecords({ fluxRoot, lane, startMs, endMs, maxRecords }) {
  const dir = join(fluxRoot, "events", lane);
  if (!existsSync(dir)) return [];
  const out = [];
  const dayFiles = readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith(".jsonl"))
    .map((d) => d.name)
    .sort(); // chronological by YYYY-MM-DD filename
  for (const name of dayFiles) {
    const raw = readFileSync(join(dir, name), "utf8");
    for (const line of raw.split("\n")) {
      if (!line) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue; // torn / partial trailing line — skip, don't crash
      }
      if (typeof rec.ts !== "number" || rec.ts < startMs || rec.ts > endMs) continue;
      out.push(rec);
      if (out.length >= maxRecords) return out;
    }
  }
  return out;
}

/**
 * Read today's events from the Flux ledger. Bounded by ET day window.
 * Safe-fails to empty list if FLUX_ROOT is missing.
 */
export function readTodaysFluxEvents({ fluxRoot, startMs, endMs, maxRecords = 5000 }) {
  if (!fluxRoot || !existsSync(fluxRoot)) {
    return { ok: false, reason: "flux_root_missing", root: fluxRoot, events: [], counts: {} };
  }
  try {
    const events = [];
    const counts = {};
    for (const lane of FLUX_LANES) {
      const laneEvents = readLaneRecords({
        fluxRoot,
        lane,
        startMs,
        endMs,
        maxRecords: maxRecords - events.length,
      });
      counts[lane] = laneEvents.length;
      events.push(...laneEvents);
      if (events.length >= maxRecords) break;
    }
    events.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
    return { ok: true, root: fluxRoot, events, counts };
  } catch (e) {
    return { ok: false, reason: String(e?.message || e), root: fluxRoot, events: [], counts: {} };
  }
}

/**
 * Reduce raw events into a compact progress_summary list.
 * Heuristic: keep records whose kind/event_type signals progress
 * (decision, receipt, checkpoint, observation with files), de-dup by summary.
 */
export function summarizeProgress(events) {
  const PROGRESS_KINDS = new Set([
    "decision", "receipt", "checkpoint", "promotion", "merge",
    "gauntlet_pass", "current_closed", "milestone",
  ]);
  const lines = [];
  const seen = new Set();
  for (const e of events) {
    const k = String(e.kind || e.event_type || "").toLowerCase();
    const body = e.body || {};
    const summary = body.summary || body.title || body.note || null;
    if (!summary) continue;
    if (!PROGRESS_KINDS.has(k) && !/decision|closed|landed|shipped|promoted|gauntlet/i.test(k)) {
      continue;
    }
    const key = summary.toLowerCase().slice(0, 120);
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push({
      ts: e.ts,
      lane: e.lane,
      origin: e.origin,
      kind: k,
      summary: String(summary).slice(0, 220),
    });
    if (lines.length >= 25) break;
  }
  return lines;
}

/**
 * Extract open blockers from flux events with kind=risk/error or body.risk=high.
 */
export function extractOpenBlockers(events) {
  const out = [];
  const seen = new Set();
  for (const e of events) {
    const k = String(e.kind || e.event_type || "").toLowerCase();
    const body = e.body || {};
    const isBlocker =
      k === "error" || k === "risk" || k === "current_blocked" ||
      body.risk === "high" || body.blocker === true;
    if (!isBlocker) continue;
    const text = body.summary || body.detail || body.message || body.title;
    if (!text) continue;
    const key = String(text).toLowerCase().slice(0, 160);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      ts: e.ts,
      lane: e.lane,
      origin: e.origin,
      kind: k,
      detail: String(text).slice(0, 240),
    });
    if (out.length >= 20) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// AE Flow currents ingestion
// ---------------------------------------------------------------------------

const FLOW_STATE_PATH = resolve(ORANGE5_ROOT, "05-FLOW/state/flow.json");

/**
 * Read AE Flow state and return the open (non-closed) currents sorted by pressure desc.
 */
export function readOpenCurrents(path = FLOW_STATE_PATH) {
  if (!existsSync(path)) return { ok: false, reason: "flow_state_missing", currents: [] };
  let state;
  try {
    state = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    return { ok: false, reason: `parse_error: ${e.message}`, currents: [] };
  }
  const all = Object.values(state.currents || {});
  const open = all
    .filter((c) => c.status !== "closed")
    .sort((a, b) => (b.pressure ?? 0) - (a.pressure ?? 0))
    .slice(0, 15)
    .map((c) => ({
      id: c.id,
      title: c.title,
      pressure: c.pressure,
      owner_department: c.owner_department,
      status: c.status,
      assigned_agent: c.assigned_agent,
      created_at: c.created_at,
      updated_at: c.updated_at,
    }));
  return { ok: true, total: all.length, open_count: open.length, currents: open };
}

// ---------------------------------------------------------------------------
// Fresh receipts ingestion
// ---------------------------------------------------------------------------

/**
 * Read fresh receipts authored today. A receipt is a .md file under
 * 10-RECEIPTS/orange5-build/ whose filename begins with the ET date or
 * whose mtime falls inside the day window.
 */
export function readFreshReceipts({ dir = RECEIPTS_BUILD_DIR, dateStr, startMs, endMs } = {}) {
  if (!existsSync(dir)) return { ok: false, reason: "receipts_dir_missing", receipts: [] };
  const datePrefix = dateStr; // YYYY-MM-DD
  const entries = readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith(".md"))
    .map((d) => {
      const full = join(dir, d.name);
      const stat = statSync(full);
      return {
        name: d.name,
        path: full,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        matches_date_prefix: d.name.startsWith(datePrefix),
        in_window: stat.mtimeMs >= startMs && stat.mtimeMs <= endMs,
      };
    })
    .filter((r) => r.matches_date_prefix || r.in_window)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, 30);

  // Hash each (small files; receipts are kilobytes) so we can chain.
  const receipts = entries.map((r) => {
    let sha256 = null;
    try {
      const bytes = readFileSync(r.path);
      sha256 = createHash("sha256").update(bytes).digest("hex");
    } catch {}
    return {
      name: r.name,
      path: r.path,
      bytes: r.size,
      mtime_ms: r.mtimeMs,
      sha256,
    };
  });
  return { ok: true, count: receipts.length, receipts };
}

// ---------------------------------------------------------------------------
// Tomorrow's first action — derived from the highest-pressure open current,
// or the most recent open blocker, falling back to "review yesterday's packet".
// ---------------------------------------------------------------------------

export function deriveTomorrowsFirstAction({ open_currents, open_blockers, progress_summary }) {
  // Priority 1: a CRITICAL/blocker tagged event with a clear next-step shape.
  for (const b of open_blockers) {
    if (/critical|blocker|stop|fail/i.test(b.kind) || /critical|stop/i.test(b.detail)) {
      return {
        action: `Resolve blocker: ${b.detail}`,
        reason: "open_blocker_critical",
        source: { kind: "flux_blocker", lane: b.lane, origin: b.origin, ts: b.ts },
      };
    }
  }
  // Priority 2: highest-pressure open current
  if (open_currents.length > 0) {
    const c = open_currents[0];
    return {
      action: `Ride current: ${c.title} (pressure ${c.pressure?.toFixed(2)})`,
      reason: "highest_pressure_current",
      source: { kind: "flow_current", id: c.id, owner_department: c.owner_department },
    };
  }
  // Priority 3: last shipped item — confirm and move next.
  if (progress_summary.length > 0) {
    const last = progress_summary[progress_summary.length - 1];
    return {
      action: `Confirm yesterday's last step landed: ${last.summary}`,
      reason: "last_progress_followup",
      source: { kind: "progress_summary_tail", ts: last.ts, lane: last.lane },
    };
  }
  return {
    action: "Review yesterday's packet, open AECommand Center, pick top current.",
    reason: "no_signal_available",
    source: null,
  };
}

// ---------------------------------------------------------------------------
// Soul Genome reference (we do NOT mutate it)
// ---------------------------------------------------------------------------

export function soulGenomeRef() {
  try {
    if (!existsSync(SOUL_GENOME_PATH)) {
      // Materialize defaults if missing — required by G14.
      ensureSoulGenome();
    }
    const bytes = readFileSync(SOUL_GENOME_PATH);
    return {
      path: SOUL_GENOME_PATH,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
    };
  } catch (e) {
    return { path: SOUL_GENOME_PATH, sha256: null, error: String(e?.message || e) };
  }
}

// ---------------------------------------------------------------------------
// Flux write — origin=continuity → reality lane
// ---------------------------------------------------------------------------

export function writePacketToFlux({ packet, fluxRoot }) {
  if (!fluxRoot) return { ok: false, reason: "flux_root_unset" };
  try {
    // Ensure parent so first-ever run on a clean host doesn't crash.
    mkdirSync(join(fluxRoot, "events", "reality"), { recursive: true });
    const rec = __loopInternals.appendFlux({
      lane: "reality",
      origin: "receipt.continuity",
      kind: "continuity_packet",
      body: {
        summary: `Continuity packet for ${packet.date} — ${packet.progress_summary.length} progress items, ${packet.open_blockers.length} blockers, ${packet.hot_currents.length} hot currents.`,
        date: packet.date,
        progress_count: packet.progress_summary.length,
        blocker_count: packet.open_blockers.length,
        current_count: packet.hot_currents.length,
        fresh_receipt_count: packet.fresh_receipts.length,
        tomorrows_first_action: packet.tomorrows_first_action?.action || null,
        packet_sha256: packet.sha256,
        soul_genome_sha256: packet.soul_genome_ref?.sha256 || null,
      },
      fluxRoot,
    });
    return { ok: true, record: { ts: rec.ts, hash: rec.hash, prev_hash: rec.prev_hash, lane: rec.lane } };
  } catch (e) {
    return { ok: false, reason: String(e?.message || e) };
  }
}

// ---------------------------------------------------------------------------
// Main synthesis
// ---------------------------------------------------------------------------

export async function generatePacket({
  dateStr = ymdET(),
  fluxRoot = FLUX_ROOT_DEFAULT,
  writeFlux = true,
  dryRun = false,
} = {}) {
  const t0 = performance.now();
  const { startMs, endMs } = dayWindowET(dateStr);

  // 1. Reality Flux events for the day
  const fluxRead = readTodaysFluxEvents({ fluxRoot, startMs, endMs });
  const progress = summarizeProgress(fluxRead.events);
  const blockers = extractOpenBlockers(fluxRead.events);

  // 2. Open AE Flow currents
  const flow = readOpenCurrents();
  const hot_currents = flow.currents || [];

  // 3. Fresh receipts
  const receiptsRead = readFreshReceipts({ dateStr, startMs, endMs });

  // 4. Tomorrow's first action
  const tomorrow = deriveTomorrowsFirstAction({
    open_currents: hot_currents,
    open_blockers: blockers,
    progress_summary: progress,
  });

  // 5. Soul Genome reference
  const soul_genome_ref = soulGenomeRef();

  // Assemble packet (sha256 computed over the canonical body with sha256:null)
  const body = {
    schema: PACKET_SCHEMA,
    date: dateStr,
    written_at: Date.now(),
    progress_summary: progress,
    open_blockers: blockers,
    tomorrows_first_action: tomorrow,
    hot_currents,
    fresh_receipts: receiptsRead.receipts || [],
    flux_counts: fluxRead.counts || {},
    flux_read_ok: fluxRead.ok,
    flow_read_ok: flow.ok,
    receipts_read_ok: receiptsRead.ok,
    soul_genome_ref,
    sha256: null,
  };
  const canonical = JSON.stringify({ ...body, sha256: null });
  body.sha256 = createHash("sha256").update(canonical).digest("hex");

  if (dryRun) {
    return {
      status: "dry_run",
      packet: body,
      window: { startMs, endMs },
      flux_root: fluxRoot,
      took_ms: Math.round(performance.now() - t0),
    };
  }

  // 6. Write the local packet via the canonical writer (so g15 sees it)
  const local = await writeContinuity({
    dateStr,
    progress: body.progress_summary,
    open_blockers: body.open_blockers,
    tomorrow_first_action: body.tomorrows_first_action?.action || null,
    notes: {
      generator: "04-CONTROL-PLANE/continuity/generator.mjs",
      hot_currents: body.hot_currents,
      fresh_receipts: body.fresh_receipts,
      flux_counts: body.flux_counts,
      tomorrows_first_action_full: body.tomorrows_first_action,
      soul_genome_ref: body.soul_genome_ref,
      packet_sha256: body.sha256,
      flux_root: fluxRoot,
    },
  });

  // 7. Flux write — append the chained record into reality lane
  let flux_write = { ok: false, reason: "skipped" };
  if (writeFlux) {
    flux_write = writePacketToFlux({ packet: body, fluxRoot });
  }

  return {
    status: flux_write.ok || !writeFlux ? "ok" : "ok_with_warning",
    packet: body,
    local_path: local.path,
    local_sha256: local.sha256,
    flux_write,
    flux_root: fluxRoot,
    window: { startMs, endMs },
    took_ms: Math.round(performance.now() - t0),
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { help: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--no-flux") args.noFlux = true;
    else if (a === "--start") args.start = true;
    else if (a === "--date") args.date = argv[++i];
    else if (a === "--flux-root") args.fluxRoot = argv[++i];
  }
  return args;
}

function printHelp() {
  console.log(`Orange5 continuity packet generator

USAGE
  node generator.mjs [options]

OPTIONS
  --date <YYYY-MM-DD>   Generate for a specific ET date (default: today ET)
  --flux-root <path>    Override the Flux ledger root
  --dry-run             Compute the packet, do not write
  --no-flux             Write local packet only, skip Flux ledger write
  --start               Stay alive and run nightly at 23:50 ET via node-cron
  -h, --help            Show this help

EXIT CODES
  0  ok
  2  local packet written but Flux write failed (degraded)
  1  hard fail`);
}

async function startCronLoop({ noFlux }) {
  let cron;
  try {
    cron = await import("node-cron");
  } catch {
    console.error("[continuity-generator] node-cron not installed.");
    console.error("  Install with:  npm i node-cron");
    console.error("  Or run from systemd timer:  OnCalendar=*-*-* 23:50  +  TZ=America/New_York");
    process.exit(1);
  }
  console.log(`[continuity-generator] scheduling ${CRON_EXPRESSION} ${ET_TIMEZONE}`);
  const task = cron.schedule(
    CRON_EXPRESSION,
    async () => {
      try {
        const r = await generatePacket({ writeFlux: !noFlux });
        console.log(`[continuity-generator] ${r.status} → ${r.local_path} (${r.took_ms}ms)`);
      } catch (err) {
        console.error(`[continuity-generator] FAILED: ${err.message}`);
      }
    },
    { timezone: ET_TIMEZONE }
  );
  process.on("SIGINT", () => { task.stop(); process.exit(0); });
  process.on("SIGTERM", () => { task.stop(); process.exit(0); });
  setInterval(() => {}, 1 << 30);
}

const isCli = (() => {
  try {
    return (
      import.meta.url === `file://${process.argv[1]?.replaceAll("\\", "/")}` ||
      fileURLToPath(import.meta.url) === resolve(process.argv[1] || "")
    );
  } catch {
    return false;
  }
})();

if (isCli) {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  if (args.start) {
    await startCronLoop({ noFlux: !!args.noFlux });
  } else {
    try {
      const r = await generatePacket({
        dateStr: args.date || ymdET(),
        fluxRoot: args.fluxRoot || FLUX_ROOT_DEFAULT,
        writeFlux: !args.noFlux,
        dryRun: !!args.dryRun,
      });
      if (args.dryRun) {
        console.log(JSON.stringify(r.packet, null, 2));
        console.log(`--- dry-run (status=${r.status}, took=${r.took_ms}ms, flux_root=${r.flux_root}) ---`);
        process.exit(0);
      }
      console.log(
        JSON.stringify(
          {
            status: r.status,
            local_path: r.local_path,
            local_sha256: r.local_sha256,
            flux_write: r.flux_write,
            took_ms: r.took_ms,
            counts: {
              progress: r.packet.progress_summary.length,
              blockers: r.packet.open_blockers.length,
              hot_currents: r.packet.hot_currents.length,
              fresh_receipts: r.packet.fresh_receipts.length,
            },
          },
          null,
          2
        )
      );
      process.exit(r.status === "ok_with_warning" ? 2 : 0);
    } catch (err) {
      console.error(`[continuity-generator] FAILED: ${err?.stack || err?.message || err}`);
      process.exit(1);
    }
  }
}
