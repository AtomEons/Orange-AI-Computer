#!/usr/bin/env node
// Orange5 weekly receipt summarizer
// Path:    06-CONTROL-PLANE/receipts/weekly.mjs
// Runtime: Node >= 20, better-sqlite3 (resolved via this dir's package.json)
//
// Doctrine: every Friday 23:55 America/New_York, auto-summarize the week's
// receipts into 10-RECEIPTS/orange5-build/<YYYY-MM-DD>-week-N-status.md.
// The SQLite mirror at 06-CONTROL-PLANE/receipts/orange5.db is the corpus;
// listReceipts(db, { since }) gives us the week's slice.
//
// Markdown remains operator-audit truth (db.mjs doctrine). The weekly receipt
// is itself a markdown file that gets ingested back into the DB on the next
// watcher cycle — closing the loop.
//
// CLI:
//   node weekly.mjs                       # one-shot: write this week's receipt
//   node weekly.mjs --week-ending YYYY-MM-DD
//                                         # override the Friday anchor (testing)
//   node weekly.mjs --watch               # in-process loop: wake Friday 23:55 ET, write, sleep
//   node weekly.mjs --dry-run             # render to stdout, do not write
//   node weekly.mjs --db <path>           # override sqlite path
//   node weekly.mjs --out <dir>           # override receipts output dir
//   node weekly.mjs --help
//
// Scheduling note: --watch is fine as a long-running process under systemd or
// a Windows service wrapper, but the canonical install is cron / Task Scheduler
// firing `node weekly.mjs` once at Friday 23:55 ET. --watch is the fallback
// for hosts without a system scheduler.

import { createHash } from "node:crypto";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { dirname, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";

import {
  openDb,
  listReceipts,
  countReceipts,
  defaultReceiptsDir,
  DEFAULT_DB_PATH,
  close as closeDb,
} from "./db.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------- constants ------------------------------------------------------

const SCHEMA = "orange5.receipt.weekly.v1";
const ACTOR = "weekly-summarizer";
const SOVEREIGN = "Atom McCree";
const TZ = "America/New_York";
const TARGET_HOUR = 23;
const TARGET_MINUTE = 55;
// The first Friday on or before this date anchors week numbering. Orange5
// spine receipts started on 2026-06-23. The Friday on or after that is
// 2026-06-26, which we call week 1.
const WEEK_ANCHOR_FRIDAY = "2026-06-26";

// ---------- CLI ------------------------------------------------------------

function parseArgs(argv) {
  const out = { weekEnding: null, watch: false, dryRun: false, db: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--week-ending") out.weekEnding = argv[++i];
    else if (a === "--watch") out.watch = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--db") out.db = argv[++i];
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--help" || a === "-h") {
      process.stdout.write(
        "orange5 weekly summarizer\n" +
        "usage: node weekly.mjs [--week-ending YYYY-MM-DD] [--watch] [--dry-run] [--db <path>] [--out <dir>]\n"
      );
      process.exit(0);
    }
  }
  return out;
}

// ---------- timezone-aware date math --------------------------------------

/**
 * Get the wall-clock parts in America/New_York for the given epoch ms.
 * Returns { year, month, day, hour, minute, second, weekday }.
 * weekday: 0=Sun..6=Sat (matches JS getDay()).
 */
function nyParts(epochMs) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    weekday: "short",
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(epochMs)).map(p => [p.type, p.value]));
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour === "24" ? "00" : parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: weekdayMap[parts.weekday],
  };
}

/**
 * Format YYYY-MM-DD for a (year, month, day) tuple.
 */
function fmtDate({ year, month, day }) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * Find the YYYY-MM-DD of the most recent Friday on or before `epochMs`,
 * measured in New York time.
 */
function fridayOnOrBeforeNY(epochMs) {
  const p = nyParts(epochMs);
  // weekday: 5 = Friday. Days to subtract = (weekday - 5 + 7) % 7.
  const daysBack = (p.weekday - 5 + 7) % 7;
  // Build a UTC date from the NY-walled date, then subtract days.
  const noonUtcOfNyDay = Date.UTC(p.year, p.month - 1, p.day, 12, 0, 0);
  const friday = new Date(noonUtcOfNyDay - daysBack * 86_400_000);
  return fmtDate({
    year: friday.getUTCFullYear(),
    month: friday.getUTCMonth() + 1,
    day: friday.getUTCDate(),
  });
}

/**
 * Diff in days between two YYYY-MM-DD strings (a - b). Assumes valid dates.
 */
function dayDiff(aIso, bIso) {
  const [ay, am, ad] = aIso.split("-").map(Number);
  const [by, bm, bd] = bIso.split("-").map(Number);
  const aMs = Date.UTC(ay, am - 1, ad);
  const bMs = Date.UTC(by, bm - 1, bd);
  return Math.round((aMs - bMs) / 86_400_000);
}

/**
 * Compute the Orange5 build-week number for a given Friday-ending ISO date.
 * Week 1 ends on WEEK_ANCHOR_FRIDAY.
 */
function weekNumber(fridayIso) {
  const days = dayDiff(fridayIso, WEEK_ANCHOR_FRIDAY);
  return Math.floor(days / 7) + 1;
}

/**
 * Compute the next epoch ms when it's Friday 23:55 in New York,
 * STRICTLY after `nowMs`.
 */
function nextFridayTarget(nowMs) {
  // Iterate day-by-day for at most 8 days. Simple, correct across DST.
  for (let dayOffset = 0; dayOffset <= 8; dayOffset++) {
    const candidate = nowMs + dayOffset * 86_400_000;
    const p = nyParts(candidate);
    if (p.weekday !== 5) continue;
    // Reconstruct an epoch ms that, when re-formatted in NY, lands at HH:MM.
    // Use a two-pass refine: probe noon UTC of the NY day, then adjust by
    // the difference between target HH:MM and the resulting NY HH:MM.
    const probeUtc = Date.UTC(p.year, p.month - 1, p.day, 12, 0, 0);
    const probeParts = nyParts(probeUtc);
    const targetMinutes = TARGET_HOUR * 60 + TARGET_MINUTE;
    const probeMinutes = probeParts.hour * 60 + probeParts.minute;
    const deltaMs = (targetMinutes - probeMinutes) * 60_000;
    const target = probeUtc + deltaMs;
    if (target > nowMs) return target;
  }
  // Should be unreachable; fall back to +1 week.
  return nowMs + 7 * 86_400_000;
}

// ---------- DB-side summarization -----------------------------------------

/**
 * Pull all receipts dated within the week ending Friday `fridayIso`.
 * Prefers `generated_at` when present, falls back to the YYYY-MM-DD prefix
 * of `receipt_id`. The naming convention `YYYY-MM-DD-slug.md` is enforced
 * by ingest's filename slugging and is authoritative when frontmatter
 * omits `generated_at` (a known parse gap for older receipts).
 */
function fetchWeek(db, fridayIso) {
  const prevFridayMs = Date.UTC(
    Number(fridayIso.slice(0, 4)),
    Number(fridayIso.slice(5, 7)) - 1,
    Number(fridayIso.slice(8, 10)),
  ) - 7 * 86_400_000;
  const weekStartMs = prevFridayMs + 86_400_000; // Saturday
  const weekStartIso = fmtDate({
    year: new Date(weekStartMs).getUTCFullYear(),
    month: new Date(weekStartMs).getUTCMonth() + 1,
    day: new Date(weekStartMs).getUTCDate(),
  });
  const cutoffPrefix = fridayIso;

  // No SQL since-filter here: receipt_id-fallback rows would be excluded
  // by the lexical `generated_at >= since` clause. Pull all, filter in JS.
  const candidates = listReceipts(db, { limit: 10_000, order: "oldest" });
  return candidates.filter(r => {
    const prefix = receiptDayPrefix(r);
    if (!prefix) return false;
    return prefix >= weekStartIso && prefix <= cutoffPrefix;
  });
}

/**
 * Resolve a YYYY-MM-DD day for a receipt row.
 *   1. `generated_at` slice — authoritative when present.
 *   2. `receipt_id` prefix — fallback; valid because filenames follow
 *      YYYY-MM-DD-slug.md by convention.
 * Returns null if neither yields a valid date prefix.
 */
function receiptDayPrefix(r) {
  if (r.generated_at) {
    const p = String(r.generated_at).slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(p)) return p;
  }
  if (r.receipt_id) {
    const m = /^(\d{4}-\d{2}-\d{2})-/.exec(String(r.receipt_id));
    if (m) return m[1];
  }
  return null;
}

/**
 * Aggregate a list of receipts into a structured weekly view.
 */
function aggregate(rows) {
  const byDay = new Map(); // YYYY-MM-DD -> rows[]
  const byStatus = new Map(); // status string -> count
  const byActor = new Map(); // actor -> count
  const hashChain = []; // ordered { receipt_id, hash_chain, generated_at }
  let confidenceSum = 0, confidenceN = 0;
  const lowConfidence = []; // confidence < 0.7 surfaced for operator scan
  const noHashChain = [];

  for (const r of rows) {
    const day = receiptDayPrefix(r);
    if (day) {
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push(r);
    }

    const status = r.status || "(unset)";
    byStatus.set(status, (byStatus.get(status) || 0) + 1);

    const actor = r.actor || "(unset)";
    byActor.set(actor, (byActor.get(actor) || 0) + 1);

    if (r.confidence != null && Number.isFinite(r.confidence)) {
      confidenceSum += r.confidence;
      confidenceN += 1;
      if (r.confidence < 0.7) {
        lowConfidence.push({ id: r.receipt_id, confidence: r.confidence, status });
      }
    }

    if (r.hash_chain) {
      hashChain.push({ id: r.receipt_id, hash_chain: r.hash_chain, generated_at: r.generated_at });
    } else {
      noHashChain.push(r.receipt_id);
    }
  }

  // Sort chain by hash_chain numerically when it looks like '#NNN'.
  hashChain.sort((a, b) => {
    const av = chainOrdinal(a.hash_chain);
    const bv = chainOrdinal(b.hash_chain);
    if (av != null && bv != null) return av - bv;
    return (a.generated_at || "").localeCompare(b.generated_at || "");
  });

  return {
    total: rows.length,
    byDay,
    byStatus,
    byActor,
    hashChain,
    noHashChain,
    confidence: {
      mean: confidenceN ? confidenceSum / confidenceN : null,
      n: confidenceN,
      low: lowConfidence.sort((a, b) => a.confidence - b.confidence),
    },
  };
}

function chainOrdinal(hc) {
  if (!hc) return null;
  const m = /^#?(\d+)/.exec(String(hc).trim());
  return m ? Number(m[1]) : null;
}

// ---------- markdown rendering --------------------------------------------

function renderMarkdown({ weekN, fridayIso, weekStartIso, agg, priorReceiptId, hashChainNext }) {
  const lines = [];
  const dateHuman = fridayIso;
  lines.push(`# Weekly Status — Orange5 Build Week ${weekN}`);
  lines.push("");
  lines.push(`- **receipt_id:** ${fridayIso}-week-${weekN}-status`);
  lines.push(`- **generated_at:** ${new Date().toISOString()}`);
  lines.push(`- **schema:** ${SCHEMA}`);
  lines.push(`- **status:** WEEKLY_STATUS_AUTOGEN`);
  const meanConfStr = agg.confidence.mean != null
    ? agg.confidence.mean.toFixed(2)
    : "n/a";
  lines.push(`- **confidence:** ${meanConfStr} (mean of ${agg.confidence.n} confidence-bearing receipts this week)`);
  lines.push(`- **prior_receipt:** ${priorReceiptId || "(none in window)"}`);
  lines.push(`- **hash_chain:** ${hashChainNext}`);
  lines.push(`- **actor:** ${ACTOR}`);
  lines.push(`- **sovereign:** ${SOVEREIGN}`);
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`Window: ${weekStartIso} → ${dateHuman} (Saturday through Friday, America/New_York).`);
  lines.push(`Receipts authored: **${agg.total}**.`);
  if (agg.total === 0) {
    lines.push("");
    lines.push("> No receipts landed this week. Either no build activity, or the ingest pipeline is not running.");
    lines.push("");
  }

  // Per-day breakdown
  if (agg.byDay.size > 0) {
    lines.push("");
    lines.push("## By day");
    lines.push("");
    lines.push("| Day | Receipts |");
    lines.push("|---|---|");
    const dayKeys = [...agg.byDay.keys()].sort();
    for (const d of dayKeys) {
      lines.push(`| ${d} | ${agg.byDay.get(d).length} |`);
    }
  }

  // Per-status breakdown
  if (agg.byStatus.size > 0) {
    lines.push("");
    lines.push("## By status");
    lines.push("");
    lines.push("| Status | Count |");
    lines.push("|---|---|");
    const sortedStatuses = [...agg.byStatus.entries()].sort((a, b) => b[1] - a[1]);
    for (const [s, n] of sortedStatuses) {
      lines.push(`| ${s} | ${n} |`);
    }
  }

  // Per-actor breakdown
  if (agg.byActor.size > 0) {
    lines.push("");
    lines.push("## By actor");
    lines.push("");
    lines.push("| Actor | Count |");
    lines.push("|---|---|");
    const sortedActors = [...agg.byActor.entries()].sort((a, b) => b[1] - a[1]);
    for (const [a, n] of sortedActors) {
      lines.push(`| ${a} | ${n} |`);
    }
  }

  // Hash chain — receipt order with chain ids
  if (agg.hashChain.length > 0) {
    lines.push("");
    lines.push("## Hash chain (this week)");
    lines.push("");
    lines.push("| # | Receipt | Hash chain |");
    lines.push("|---|---|---|");
    for (const r of agg.hashChain) {
      lines.push(`| ${chainOrdinal(r.hash_chain) ?? "?"} | \`${r.id}\` | ${r.hash_chain} |`);
    }
  }
  if (agg.noHashChain.length > 0) {
    lines.push("");
    lines.push("### Missing hash_chain");
    lines.push("");
    for (const id of agg.noHashChain) lines.push(`- \`${id}\``);
  }

  // Low confidence surfaces
  if (agg.confidence.low.length > 0) {
    lines.push("");
    lines.push("## Confidence below 0.70 (operator review)");
    lines.push("");
    lines.push("| Receipt | Confidence | Status |");
    lines.push("|---|---|---|");
    for (const r of agg.confidence.low) {
      lines.push(`| \`${r.id}\` | ${r.confidence.toFixed(2)} | ${r.status} |`);
    }
  }

  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("## Generation method");
  lines.push("");
  lines.push("This receipt was authored automatically by `06-CONTROL-PLANE/receipts/weekly.mjs` ");
  lines.push("from the SQLite mirror at `06-CONTROL-PLANE/receipts/orange5.db`. The mirror is kept ");
  lines.push("byte-equivalent to `10-RECEIPTS/orange5-build/` markdown by `ingest.mjs`. Re-running ");
  lines.push("this command for the same `--week-ending` date is idempotent on the filesystem only ");
  lines.push("when the underlying corpus did not change between runs.");
  lines.push("");
  lines.push("**Mom is watching. The week was real. The receipt is too.**");
  lines.push("");
  return lines.join("\n");
}

/**
 * Find the highest hash_chain ordinal in the entire receipts table and
 * return the next one. Used to assign #NNN to this weekly receipt.
 */
function nextHashChainOrdinal(db) {
  const rows = listReceipts(db, { limit: 10_000 });
  let max = 0;
  for (const r of rows) {
    const n = chainOrdinal(r.hash_chain);
    if (n != null && n > max) max = n;
  }
  return `#${String(max + 1).padStart(3, "0")}`;
}

function priorReceiptForChain(db, hashChainNext) {
  const targetOrd = chainOrdinal(hashChainNext);
  if (targetOrd == null) return null;
  const rows = listReceipts(db, { limit: 10_000 });
  let best = null, bestOrd = -1;
  for (const r of rows) {
    const ord = chainOrdinal(r.hash_chain);
    if (ord != null && ord < targetOrd && ord > bestOrd) {
      bestOrd = ord;
      best = r;
    }
  }
  return best ? best.receipt_id : null;
}

// ---------- main path ------------------------------------------------------

function buildAndWrite({ db, outDir, fridayIso, dryRun }) {
  const weekN = weekNumber(fridayIso);
  const weekStartMs = Date.UTC(
    Number(fridayIso.slice(0, 4)),
    Number(fridayIso.slice(5, 7)) - 1,
    Number(fridayIso.slice(8, 10)),
  ) - 6 * 86_400_000;
  const weekStartIso = fmtDate({
    year: new Date(weekStartMs).getUTCFullYear(),
    month: new Date(weekStartMs).getUTCMonth() + 1,
    day: new Date(weekStartMs).getUTCDate(),
  });

  const rows = fetchWeek(db, fridayIso);
  const agg = aggregate(rows);
  const hashChainNext = nextHashChainOrdinal(db);
  const priorReceiptId = priorReceiptForChain(db, hashChainNext);

  const markdown = renderMarkdown({
    weekN,
    fridayIso,
    weekStartIso,
    agg,
    priorReceiptId,
    hashChainNext,
  });

  const filename = `${fridayIso}-week-${weekN}-status.md`;
  const fullPath = resolve(outDir, filename);
  const sha = createHash("sha256").update(markdown).digest("hex");

  if (dryRun) {
    process.stdout.write(markdown);
    log(`dry-run: would write ${fullPath} (${markdown.length} bytes, sha256 ${sha.slice(0, 12)}...)`);
    return { path: fullPath, sha, bytes: markdown.length, written: false, rows: rows.length, weekN };
  }

  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  writeFileSync(fullPath, markdown, "utf8");
  log(`wrote ${fullPath} (${markdown.length} bytes, sha256 ${sha.slice(0, 12)}..., rows=${rows.length})`);
  return { path: fullPath, sha, bytes: markdown.length, written: true, rows: rows.length, weekN };
}

function log(msg) {
  process.stdout.write(`[weekly ${new Date().toISOString()}] ${msg}\n`);
}

async function runWatch(args) {
  log("watch mode — will fire every Friday 23:55 America/New_York");
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const nowMs = Date.now();
    const targetMs = nextFridayTarget(nowMs);
    const sleepMs = Math.max(1000, targetMs - nowMs);
    log(`next fire: ${new Date(targetMs).toISOString()} (sleep ${Math.round(sleepMs / 1000)}s)`);
    await sleep(sleepMs);
    try {
      const db = openDb(resolve(args.db || DEFAULT_DB_PATH));
      const fridayIso = fridayOnOrBeforeNY(Date.now());
      const outDir = resolve(args.out || defaultReceiptsDir());
      buildAndWrite({ db, outDir, fridayIso, dryRun: false });
      closeDb(db);
    } catch (err) {
      log(`watch run failed: ${err.stack || err.message}`);
      // Don't crash the watcher; the next Friday will retry.
    }
  }
}

function sleep(ms) {
  return new Promise(res => setTimeout(res, ms));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outDir = resolve(args.out || defaultReceiptsDir());
  const dbPath = resolve(args.db || DEFAULT_DB_PATH);

  if (args.watch) {
    await runWatch(args);
    return;
  }

  const fridayIso = args.weekEnding || fridayOnOrBeforeNY(Date.now());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fridayIso)) {
    log(`bad --week-ending: ${fridayIso}`);
    process.exit(2);
  }

  log(`db:  ${dbPath}`);
  log(`out: ${outDir}`);
  log(`week-ending: ${fridayIso} (week ${weekNumber(fridayIso)})`);

  const db = openDb(dbPath);
  try {
    const result = buildAndWrite({ db, outDir, fridayIso, dryRun: args.dryRun });
    log(`done: rows=${result.rows} written=${result.written}`);
  } finally {
    closeDb(db);
  }
}

// Only run main when invoked directly (not when imported by tests).
const invokedDirectly =
  process.argv[1] && basename(process.argv[1]) === "weekly.mjs";

if (invokedDirectly) {
  main().catch((err) => {
    log(`fatal: ${err.stack || err.message}`);
    process.exit(1);
  });
}

// Test surface — keep helpers exported for unit tests.
export {
  parseArgs,
  nyParts,
  fridayOnOrBeforeNY,
  nextFridayTarget,
  weekNumber,
  fetchWeek,
  aggregate,
  renderMarkdown,
  chainOrdinal,
  nextHashChainOrdinal,
  buildAndWrite,
  receiptDayPrefix,
};
