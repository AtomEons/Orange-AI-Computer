// continuity-packet.mjs — forward-looking JSON record emitted at end of day.
//
// Shape: progress[], open_blockers[], tomorrow_first_action. Written to
// state/continuity/YYYY-MM-DD.json. Auto-loaded at next session start as the
// first context injection. Cron writes the day's packet at 23:55 local.
//
// The packet is intentionally compact — operator should be able to read it
// in under 30 seconds and have full picture of where the lab left off.

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { CONTINUITY_DIR } from "./paths.mjs";
import { latestRun } from "./db.mjs";

function ensureDir(p) {
  mkdirSync(p, { recursive: true });
}

function ymd(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function yesterdayYmd() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return ymd(d);
}

export function continuityPath(dateStr = ymd()) {
  return resolve(CONTINUITY_DIR, `${dateStr}.json`);
}

export function readContinuity(dateStr = ymd()) {
  const p = continuityPath(dateStr);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch (e) {
    return { _read_error: String(e?.message || e), _path: p };
  }
}

export async function writeContinuity({
  dateStr = ymd(),
  progress = [],
  open_blockers = [],
  tomorrow_first_action = null,
  notes = null,
} = {}) {
  ensureDir(CONTINUITY_DIR);
  const last = await latestRun().catch(() => null);
  const guardrails_summary = last
    ? {
        run_id: last.run_id,
        ok: !!last.ok,
        violations: (last.results || []).filter((r) => !r.pass).length,
        finished_at: last.finished_at,
      }
    : null;

  const packet = {
    schema: "orange5.continuity-packet.v1",
    date: dateStr,
    written_at: Date.now(),
    progress: Array.isArray(progress) ? progress : [],
    open_blockers: Array.isArray(open_blockers) ? open_blockers : [],
    tomorrow_first_action: tomorrow_first_action || null,
    notes: notes || null,
    guardrails_summary,
  };
  const json = JSON.stringify(packet, null, 2);
  const p = continuityPath(dateStr);
  writeFileSync(p, json, "utf8");
  return {
    path: p,
    sha256: createHash("sha256").update(json).digest("hex"),
    packet,
  };
}

export function loadMostRecentContinuity() {
  if (!existsSync(CONTINUITY_DIR)) return null;
  const files = readdirSync(CONTINUITY_DIR)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort();
  if (files.length === 0) return null;
  const latest = files[files.length - 1];
  try {
    return {
      date: latest.replace(/\.json$/, ""),
      data: JSON.parse(readFileSync(join(CONTINUITY_DIR, latest), "utf8")),
    };
  } catch {
    return null;
  }
}

export function continuityForYesterdayExists() {
  return existsSync(continuityPath(yesterdayYmd()));
}

// CLI: `node lib/continuity-packet.mjs write` writes a skeleton packet for
// today using the latest guardrail run. Real progress / blockers / next-action
// are filled in by the operator or by the cron job that scrapes the day's
// receipts directory.
if (import.meta.url === `file://${process.argv[1]?.replaceAll("\\", "/")}`) {
  const cmd = process.argv[2] || "write";
  (async () => {
    if (cmd === "write") {
      const r = await writeContinuity({});
      process.stdout.write(JSON.stringify({ path: r.path, sha256: r.sha256 }, null, 2) + "\n");
    } else if (cmd === "show") {
      const r = loadMostRecentContinuity();
      process.stdout.write(JSON.stringify(r, null, 2) + "\n");
    } else {
      process.stderr.write(`unknown command: ${cmd}\n`);
      process.exit(2);
    }
  })();
}
