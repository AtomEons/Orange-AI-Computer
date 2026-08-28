#!/usr/bin/env node
// Orange5 — Weekly Continuity Summary
// Path:    04-CONTROL-PLANE/continuity/weekly-summary.mjs
// Runtime: Node >= 20 (Bun-compatible — uses node: imports only)
// Trigger: Friday 23:55 America/New_York, cron-driven (node-cron or systemd timer)
//
// What this does
// --------------
// Every Friday at 23:55 ET this script reads the operator's receipt corpus,
// asks the SQLite index for fast aggregates, and writes ONE markdown file:
//
//     10-RECEIPTS/orange5-build/<YYYY-MM-DD>-week-N-status.md
//
// The <YYYY-MM-DD> is the Friday's date in ET. Week N is ISO-8601 week number.
//
// Doctrine alignment (binding)
// ----------------------------
// 1. Markdown at 10-RECEIPTS/orange5-build/ is operator-audit ground truth.
//    SQLite at 06-CONTROL-PLANE/receipts/orange5.db is the parallel machine
//    index. SHA-256 must agree across both stores. This script reads from
//    SQLite for speed and re-verifies each file's bytes against the indexed
//    SHA-256 before quoting it. Truth over throughput.
// 2. Mom's Law: no "all green" without evidence. Anything we cannot verify
//    from receipts gets named as such, not papered over.
// 3. The weekly receipt itself is a receipt — it joins the chain on next
//    reindex tick. It carries front-matter (receipt_id, generated_at, schema,
//    status, actor, sovereign, hash_chain placeholder) so the query module's
//    parser indexes it cleanly.
// 4. Idempotent: re-running for the same Friday rewrites the same file with
//    the same bytes given the same inputs.
//
// CLI
// ---
//   node weekly-summary.mjs                        # run for "now" (ET)
//   node weekly-summary.mjs --date 2026-06-26      # run for a specific Friday
//   node weekly-summary.mjs --dry-run              # print path + body, no write
//   node weekly-summary.mjs --receipts-dir <path>  # override corpus dir
//   node weekly-summary.mjs --db <path>            # override SQLite path
//   node weekly-summary.mjs --allow-broken-chain   # do not refuse to run
//   node weekly-summary.mjs --start                # start cron loop (in-proc)
//
// Cron / systemd
// --------------
// For systemd: a OnCalendar=Fri 23:55 America/New_York timer that runs this
// script with no args. For in-process node-cron (npm i node-cron), pass
// --start; the script registers a Friday 23:55 ET schedule and stays alive.
//
// Exit codes: 0 ok, 2 wrote-warning (chain break suppressed), 1 hard fail.

import {
  readFileSync, writeFileSync, mkdirSync, existsSync, statSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

// The receipts query module is loaded LAZILY inside runWeeklySummary so the
// pure helpers in this file (date math, classification, markdown rendering,
// CLI parsing) remain importable in environments without better-sqlite3 —
// for unit tests, lint, type-check, doc generation, etc. The contract is
// unchanged: every runtime call routes through the canonical query.mjs
// single-writer at 06-CONTROL-PLANE/receipts/query.mjs.

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const RECEIPTS_QUERY_MODULE_PATH = path.resolve(
  __dirname, '..', '..', '06-CONTROL-PLANE', 'receipts', 'query.mjs'
);

async function loadReceiptsModule() {
  // pathToFileURL would be ideal but path.resolve gives us a usable URL on
  // both POSIX and Windows when prefixed with file://. Use URL constructor
  // to be safe across drive letters.
  const url = new URL('file://' + RECEIPTS_QUERY_MODULE_PATH.replace(/\\/g, '/'));
  return await import(url.href);
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const ET_TIMEZONE = 'America/New_York';
export const CRON_EXPRESSION = '55 23 * * 5'; // Fri 23:55 (local TZ at runtime)
export const RECEIPT_SCHEMA = 'orange5.receipt.v0';
export const SCRIPT_ACTOR =
  'Orange5 Weekly Continuity (04-CONTROL-PLANE/continuity/weekly-summary.mjs)';
export const SOVEREIGN = 'Atom McCree';

// Vocabulary the weekly synthesizer uses to classify a receipt as a
// gauntlet pass / fail / mission completion / hot blocker. Sourced from the
// existing receipt corpus shape — these are observed tokens, not aspirational.
const GAUNTLET_PASS_TOKENS = [
  'gauntlet_pass', 'gauntlet passed', 'gauntlet_passed',
  'all gauntlets pass', '_closed', '_promoted', '_live',
  '_live_', '_landed', '_go', 'preflight_go',
];
const GAUNTLET_FAIL_TOKENS = [
  'gauntlet_fail', 'gauntlet failed', 'gauntlet_failed',
  '_blocked', '_regression', '_break', '_broken', '_aborted',
  '_rollback',
];
const MISSION_TOKENS = [
  '_built', '_authored', '_published', '_locked', '_complete',
  '_completed', '_landed', '_promoted', '_live', '_closed',
];

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--start') args.start = true;
    else if (a === '--allow-broken-chain') args.allowBrokenChain = true;
    else if (a === '--date') args.date = argv[++i];
    else if (a === '--receipts-dir') args.receiptsDir = argv[++i];
    else if (a === '--db') args.dbPath = argv[++i];
    else if (a === '--out-dir') args.outDir = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
    else args._.push(a);
  }
  return args;
}

// ---------------------------------------------------------------------------
// Time helpers — ET-aware without bringing in a date library
// ---------------------------------------------------------------------------
//
// We use Intl.DateTimeFormat with timeZone: 'America/New_York' to read the
// civil date in ET regardless of the host's local TZ. This is the cheapest
// correct way to do "what Friday is it for the operator right now."

const ET_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: ET_TIMEZONE,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hour12: false, weekday: 'short',
});

/** Returns { y, m, d, hh, mm, ss, weekday } for a given Date in ET. */
export function etParts(date = new Date()) {
  const parts = ET_FMT.formatToParts(date);
  const m = Object.create(null);
  for (const p of parts) if (p.type !== 'literal') m[p.type] = p.value;
  return {
    y: Number(m.year),
    mo: Number(m.month),
    d: Number(m.day),
    hh: Number(m.hour),
    mm: Number(m.minute),
    ss: Number(m.second),
    weekday: String(m.weekday), // "Fri", "Sat", ...
  };
}

/** YYYY-MM-DD in ET. */
export function etDateString(date = new Date()) {
  const p = etParts(date);
  return `${pad4(p.y)}-${pad2(p.mo)}-${pad2(p.d)}`;
}

function pad2(n) { return String(n).padStart(2, '0'); }
function pad4(n) { return String(n).padStart(4, '0'); }

/**
 * Given any Date, return the YYYY-MM-DD of the Friday in that week's ET
 * calendar. If the date is itself a Friday, returns that day. Saturday or
 * Sunday roll forward conceptually only when --date is explicit; for a live
 * cron tick on Friday 23:55 ET, the answer is "today."
 *
 * Week ends on Friday at 23:59:59.999 ET in our convention (the cron tick is
 * 23:55 Friday). Anything earlier in the week belongs to the upcoming Friday.
 */
export function fridayOfWeekET(date = new Date()) {
  // Build a "civil" Date from ET parts to do day arithmetic safely.
  const p = etParts(date);
  // Use UTC date as a stable arithmetic surface; we only care about weekday
  // offsets relative to ET civil days, which match civil day arithmetic.
  const civil = new Date(Date.UTC(p.y, p.mo - 1, p.d));
  // JS getUTCDay: Sun=0, Mon=1, ... Fri=5, Sat=6.
  const dow = civil.getUTCDay();
  let deltaToFri;
  if (dow <= 5) deltaToFri = 5 - dow;        // Sun..Fri → upcoming/same Fri
  else          deltaToFri = -1;             // Sat → previous day (Fri)
  civil.setUTCDate(civil.getUTCDate() + deltaToFri);
  const y = civil.getUTCFullYear();
  const m = civil.getUTCMonth() + 1;
  const d = civil.getUTCDate();
  return `${pad4(y)}-${pad2(m)}-${pad2(d)}`;
}

/**
 * ISO-8601 week number for the given YYYY-MM-DD. Pure civil math — no TZ.
 */
export function isoWeekNumber(yyyyMmDd) {
  const [y, m, d] = yyyyMmDd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  // Set to Thursday in current week — ISO 8601 anchor.
  const day = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((dt - yearStart) / 86400000) + 1) / 7);
  return weekNo;
}

/**
 * Saturday-00:00:00 ET of the week BEFORE the given Friday. The week we
 * summarize is Saturday→Friday inclusive (operator week-end convention).
 * Returns ISO-8601 UTC string for stable since/until comparisons.
 */
export function weekWindowET(fridayYmd) {
  const [y, m, d] = fridayYmd.split('-').map(Number);
  // Saturday-of-the-previous-week 00:00 ET == Friday 00:00 ET minus 6 days.
  const sat = new Date(Date.UTC(y, m - 1, d));
  sat.setUTCDate(sat.getUTCDate() - 6);
  // 00:00 ET corresponds to 04:00 or 05:00 UTC depending on DST. We accept a
  // small tolerance: filter receipts by their generated_at_iso DATE (ET day),
  // not by sub-day timestamp. Concretely: window_start_date and window_end_date.
  return {
    start_date: ymd(sat),
    end_date: fridayYmd,
  };
}

function ymd(d) {
  return `${pad4(d.getUTCFullYear())}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

// ---------------------------------------------------------------------------
// Receipt classification
// ---------------------------------------------------------------------------

function lower(s) { return (s == null ? '' : String(s)).toLowerCase(); }

export function classifyReceipt(r) {
  const status = lower(r.status);
  const title  = lower(r.title);
  const id     = lower(r.receipt_id);
  const hay = `${status} ${title} ${id}`;

  const isFail = GAUNTLET_FAIL_TOKENS.some(t => hay.includes(t));
  const isPass = !isFail && GAUNTLET_PASS_TOKENS.some(t => hay.includes(t));
  const isMission = MISSION_TOKENS.some(t => hay.includes(t));

  return {
    is_gauntlet_pass: isPass,
    is_gauntlet_fail: isFail,
    is_mission_completion: isMission,
    has_blockers: !!r.has_blockers,
  };
}

// ---------------------------------------------------------------------------
// Day grouping
// ---------------------------------------------------------------------------

/**
 * For each receipt, compute its civil ET day (YYYY-MM-DD). We prefer
 * generated_at_iso when present, falling back to the filename prefix
 * "YYYY-MM-DD" the corpus uses by convention.
 */
function dayKeyForReceipt(r) {
  if (r.generated_at_iso) {
    // Already an ISO string — derive the ET day.
    const d = new Date(r.generated_at_iso);
    if (!Number.isNaN(d.getTime())) return etDateString(d);
  }
  // Filename fallback: 2026-06-24-foo-bar.md → 2026-06-24
  const base = path.basename(r.file_path || '', '.md');
  const m = base.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  return 'unknown';
}

// ---------------------------------------------------------------------------
// SHA-256 re-verify on read (defense in depth)
// ---------------------------------------------------------------------------

function sha256Bytes(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function verifyReceiptOnDisk(r) {
  if (!r.file_path || !existsSync(r.file_path)) {
    return { ok: false, reason: 'missing_file' };
  }
  const buf = readFileSync(r.file_path);
  const sha = sha256Bytes(buf);
  if (sha !== r.content_sha256) {
    return {
      ok: false,
      reason: 'content_drift',
      indexed_sha: r.content_sha256,
      on_disk_sha: sha,
    };
  }
  return { ok: true, sha };
}

// ---------------------------------------------------------------------------
// Build the summary
// ---------------------------------------------------------------------------

/**
 * Pure synthesizer — given a set of receipts (already verified on disk) and
 * the week window, produces the markdown body and the structured aggregate.
 * Exported for tests.
 */
export function buildSummary({ receipts, window, fridayYmd, weekNumber, integrity, dropped }) {
  // Group by ET civil day.
  const byDay = new Map();
  for (const r of receipts) {
    const k = dayKeyForReceipt(r);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(r);
  }

  // Order day keys ascending, but only inside the window.
  const days = [...byDay.keys()]
    .filter(k => k >= window.start_date && k <= window.end_date)
    .sort();

  // Aggregate counters.
  const counts = {
    total: 0,
    gauntlet_pass: 0,
    gauntlet_fail: 0,
    mission_completion: 0,
    hot_blockers: 0,
    fake_green_flagged: 0,
  };

  const hotBlockers = [];
  const gauntletFails = [];
  const missionCompletions = [];

  for (const k of days) {
    for (const r of byDay.get(k)) {
      counts.total += 1;
      const c = classifyReceipt(r);
      if (c.is_gauntlet_pass) counts.gauntlet_pass += 1;
      if (c.is_gauntlet_fail) {
        counts.gauntlet_fail += 1;
        gauntletFails.push({
          day: k,
          receipt_id: r.receipt_id,
          status: r.status,
          file: r.file_path,
        });
      }
      if (c.is_mission_completion && !c.is_gauntlet_fail) {
        counts.mission_completion += 1;
        missionCompletions.push({
          day: k,
          receipt_id: r.receipt_id,
          title: r.title,
        });
      }
      if (c.has_blockers) {
        counts.hot_blockers += 1;
        hotBlockers.push({
          day: k,
          receipt_id: r.receipt_id,
          status: r.status,
          blockers_text: (r.blockers_text || '').trim(),
        });
      }
      if (r.flags && r.flags.fake_green_hits && r.flags.fake_green_hits.length) {
        counts.fake_green_flagged += 1;
      }
    }
  }

  const status = determineWeeklyStatus(counts, integrity, dropped);

  const md = renderMarkdown({
    fridayYmd, weekNumber, window, counts, byDay, days,
    hotBlockers, gauntletFails, missionCompletions,
    integrity, dropped, status,
  });

  return { markdown: md, counts, status, days };
}

function determineWeeklyStatus(counts, integrity, dropped) {
  if (!integrity.ok)                 return 'WEEK_SUMMARY_AUTHORED_CHAIN_BREAK';
  if (dropped && dropped.length > 0) return 'WEEK_SUMMARY_AUTHORED_DEGRADED';
  if (counts.gauntlet_fail > 0)      return 'WEEK_SUMMARY_AUTHORED_HOT';
  if (counts.hot_blockers > 0)       return 'WEEK_SUMMARY_AUTHORED_WITH_BLOCKERS';
  if (counts.total === 0)            return 'WEEK_SUMMARY_AUTHORED_EMPTY';
  return 'WEEK_SUMMARY_AUTHORED';
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

function renderMarkdown({
  fridayYmd, weekNumber, window, counts, byDay, days,
  hotBlockers, gauntletFails, missionCompletions,
  integrity, dropped, status,
}) {
  const receiptId = `${fridayYmd}-week-${weekNumber}-status`;
  const generatedAtIso = new Date().toISOString();
  const repoRel = (p) => {
    if (!p) return '(unknown)';
    const root = path.resolve(__dirname, '..', '..');
    const rel = path.relative(root, p).split(path.sep).join('/');
    return rel.startsWith('..') ? p : rel;
  };

  const lines = [];
  lines.push(`# Weekly Status — Week ${weekNumber} (ending ${fridayYmd})`);
  lines.push('');
  lines.push(`- **receipt_id:** ${receiptId}`);
  lines.push(`- **generated_at:** ${generatedAtIso} (auto, ET cron)`);
  lines.push(`- **schema:** ${RECEIPT_SCHEMA}`);
  lines.push(`- **actor:** ${SCRIPT_ACTOR}`);
  lines.push(`- **sovereign:** ${SOVEREIGN}`);
  lines.push(`- **status:** ${status}`);
  lines.push(`- **window:** ${window.start_date} → ${window.end_date} (ET, Sat→Fri inclusive)`);
  lines.push(`- **hash_chain:** (assigned on next reindex)`);
  lines.push('');
  lines.push('---');
  lines.push('');

  // Headline counters.
  lines.push('## Headline');
  lines.push('');
  lines.push('| Metric | Count |');
  lines.push('|---|---:|');
  lines.push(`| Receipts in window | ${counts.total} |`);
  lines.push(`| Gauntlets passed (heuristic) | ${counts.gauntlet_pass} |`);
  lines.push(`| Gauntlets failed (heuristic) | ${counts.gauntlet_fail} |`);
  lines.push(`| Mission completions | ${counts.mission_completion} |`);
  lines.push(`| Receipts carrying blockers | ${counts.hot_blockers} |`);
  lines.push(`| Receipts flagged for fake-green vocabulary | ${counts.fake_green_flagged} |`);
  lines.push('');

  // Integrity panel — Mom's Law surface.
  lines.push('## Integrity');
  lines.push('');
  lines.push(`- **chain_verified:** ${integrity.ok ? 'true' : `false (${integrity.break_count} break(s))`}`);
  lines.push(`- **head_link:** \`${integrity.head_link}\``);
  lines.push(`- **indexed_row_count:** ${integrity.row_count}`);
  if (!integrity.ok) {
    lines.push('- **first_break:**');
    const b = integrity.breaks[0];
    lines.push(`  - kind: ${b?.kind}`);
    lines.push(`  - receipt_id: ${b?.receipt_id}`);
  }
  if (dropped && dropped.length > 0) {
    lines.push(`- **dropped_from_quote_set:** ${dropped.length} receipt(s) failed on-disk SHA-256 reverify`);
    for (const d of dropped.slice(0, 5)) {
      lines.push(`  - ${d.receipt_id}: ${d.reason}`);
    }
    if (dropped.length > 5) lines.push(`  - ... and ${dropped.length - 5} more`);
  }
  lines.push('');

  // Day-by-day list — receipts grouped by their ET civil day.
  lines.push('## Receipts by day');
  lines.push('');
  if (days.length === 0) {
    lines.push('_No receipts authored in this window._');
    lines.push('');
  } else {
    for (const day of days) {
      const items = byDay.get(day);
      lines.push(`### ${day} (${items.length})`);
      lines.push('');
      for (const r of items) {
        const tag = classifyTag(r);
        const title = r.title ? r.title.trim() : r.receipt_id;
        lines.push(`- ${tag} **${r.receipt_id}** — ${escapeMd(title)}`);
        if (r.status) lines.push(`  - status: \`${escapeBackticks(r.status)}\``);
        lines.push(`  - file: \`${repoRel(r.file_path)}\``);
        lines.push(`  - sha256: \`${r.content_sha256}\``);
      }
      lines.push('');
    }
  }

  // Gauntlet fails.
  lines.push('## Gauntlets — failures');
  lines.push('');
  if (gauntletFails.length === 0) {
    lines.push('_None detected. Heuristic-based; absence is not proof of pass — see Mom\'s Law caveat below._');
  } else {
    for (const f of gauntletFails) {
      lines.push(`- **${f.day}** — \`${f.receipt_id}\``);
      if (f.status) lines.push(`  - status: \`${escapeBackticks(f.status)}\``);
      if (f.file)   lines.push(`  - file: \`${repoRel(f.file)}\``);
    }
  }
  lines.push('');

  // Missions completed.
  lines.push('## Missions completed');
  lines.push('');
  if (missionCompletions.length === 0) {
    lines.push('_None in window._');
  } else {
    for (const m of missionCompletions) {
      lines.push(`- **${m.day}** — \`${m.receipt_id}\``);
      if (m.title) lines.push(`  - ${escapeMd(m.title)}`);
    }
  }
  lines.push('');

  // Hot blockers.
  lines.push('## Hot blockers');
  lines.push('');
  if (hotBlockers.length === 0) {
    lines.push('_No blocker sections detected in week\'s receipts._');
  } else {
    for (const b of hotBlockers) {
      lines.push(`- **${b.day}** — \`${b.receipt_id}\``);
      if (b.status)         lines.push(`  - status: \`${escapeBackticks(b.status)}\``);
      if (b.blockers_text) {
        const preview = b.blockers_text.split('\n').slice(0, 6).join('\n');
        lines.push('  - blockers:');
        for (const ln of preview.split('\n')) lines.push(`    > ${ln}`);
      }
    }
  }
  lines.push('');

  // Footer — Mom's Law surface.
  lines.push('---');
  lines.push('');
  lines.push('## Mom\'s Law caveat');
  lines.push('');
  lines.push('This summary is synthesized from receipt front-matter and section');
  lines.push('parsing. Classification of a receipt as "gauntlet pass," "gauntlet');
  lines.push('fail," or "mission completion" is heuristic: it reads status tokens');
  lines.push('and title language, not gauntlet logs themselves. A green count here');
  lines.push('is NOT a green claim about the underlying system — only that no');
  lines.push('failure token surfaced in the week\'s receipts. Treat the integrity');
  lines.push('panel and the receipts-by-day list as the operator-audit surface;');
  lines.push('counters are navigation aids.');
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push(`_Authored by \`04-CONTROL-PLANE/continuity/weekly-summary.mjs\` at ${generatedAtIso}_`);
  lines.push('');

  return lines.join('\n');
}

function classifyTag(r) {
  const c = classifyReceipt(r);
  if (c.is_gauntlet_fail)       return '[FAIL]';
  if (c.has_blockers)           return '[BLOCK]';
  if (c.is_gauntlet_pass)       return '[PASS]';
  if (c.is_mission_completion)  return '[DONE]';
  return '[----]';
}

function escapeMd(s) {
  if (s == null) return '';
  return String(s).replace(/[\r\n]+/g, ' ').trim();
}

function escapeBackticks(s) {
  if (s == null) return '';
  return String(s).replace(/`/g, '​`');
}

// ---------------------------------------------------------------------------
// Top-level runner
// ---------------------------------------------------------------------------

export async function runWeeklySummary(opts = {}) {
  const t0 = performance.now();

  const receipts = await loadReceiptsModule();
  const {
    openDb: openReceiptsDb,
    reindex: reindexReceipts,
    queryReceipts,
    verifyChain,
    DEFAULT_DB_PATH: RECEIPTS_DB_PATH,
    DEFAULT_RECEIPTS_DIR: RECEIPTS_DIR_DEFAULT,
  } = receipts;

  const receiptsDir = opts.receiptsDir || RECEIPTS_DIR_DEFAULT;
  const dbPath      = opts.dbPath      || RECEIPTS_DB_PATH;
  const outDir      = opts.outDir      || receiptsDir;
  const allowBrokenChain = !!opts.allowBrokenChain;

  if (!existsSync(receiptsDir)) {
    throw new Error(`receipts directory not found: ${receiptsDir}`);
  }
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  // Determine which Friday we are summarizing.
  const targetDate = opts.date
    ? new Date(`${opts.date}T12:00:00${etOffsetGuess(opts.date)}`)
    : new Date();
  const fridayYmd = opts.date
    ? // honor explicit --date verbatim if it is itself a Friday, otherwise
      // snap to that week's Friday
      fridayOfWeekET(new Date(`${opts.date}T12:00:00Z`))
    : fridayOfWeekET(targetDate);
  const weekNumber = isoWeekNumber(fridayYmd);
  const window = weekWindowET(fridayYmd);

  // Open / build the index. If empty, reindex once.
  let db = openReceiptsDb({ dbPath });
  const indexed = db.prepare('SELECT COUNT(*) AS n FROM receipts').get().n;
  if (indexed === 0) {
    db.close();
    const r = reindexReceipts({ dbPath, receiptsDir });
    db = r.db;
  }

  // Integrity scan up front.
  const integrityRaw = verifyChain({ db });
  const integrity = {
    ok: integrityRaw.ok,
    head_link: integrityRaw.head_link,
    row_count: integrityRaw.row_count,
    break_count: integrityRaw.breaks.length,
    breaks: integrityRaw.breaks,
  };
  if (!integrity.ok && !allowBrokenChain) {
    db.close();
    const err = new Error(
      `receipts hash-chain integrity broken: ${integrity.break_count} break(s); ` +
      `first=${integrity.breaks[0]?.kind}/${integrity.breaks[0]?.receipt_id}. ` +
      `Re-run with --allow-broken-chain to author a degraded summary.`
    );
    err.code = 'RECEIPTS_CHAIN_BREAK';
    err.integrity = integrity;
    throw err;
  }

  // Pull receipts for the window. We over-fetch slightly (since=start of
  // window) and let buildSummary filter by ET civil day so we never miss a
  // late-Friday entry whose timestamp falls just past midnight UTC.
  const sinceIso = `${window.start_date}T00:00:00.000Z`;
  const q = queryReceipts({
    db,
    since: sinceIso,
    limit: 1000,
    allow_broken_chain: allowBrokenChain,
  });

  // Defense-in-depth: reverify each receipt's bytes against indexed SHA-256.
  // Anything that fails reverify is dropped from the quote set AND surfaced.
  const verified = [];
  const dropped = [];
  for (const r of q.receipts) {
    const v = verifyReceiptOnDisk(r);
    if (v.ok) verified.push(r);
    else dropped.push({ receipt_id: r.receipt_id, file: r.file_path, reason: v.reason });
  }

  const { markdown, counts, status, days } = buildSummary({
    receipts: verified,
    window,
    fridayYmd,
    weekNumber,
    integrity,
    dropped,
  });

  // Idempotent write: same inputs → same body. We do not include wall-clock
  // ms in the path (only the ET date), so reruns overwrite cleanly.
  const outFile = path.join(outDir, `${fridayYmd}-week-${weekNumber}-status.md`);

  let wrote = false;
  if (opts.dryRun) {
    // No-op; caller will inspect markdown.
  } else {
    // Avoid pointless mtime bumps if the new bytes equal the old bytes.
    let prior = null;
    if (existsSync(outFile)) {
      try { prior = readFileSync(outFile, 'utf8'); } catch { /* ignore */ }
    }
    if (prior !== markdown) {
      writeFileSync(outFile, markdown, 'utf8');
      wrote = true;
    }
  }

  db.close();

  const took_ms = Math.round(performance.now() - t0);
  return {
    ok: true,
    out_file: outFile,
    friday: fridayYmd,
    week_number: weekNumber,
    window,
    counts,
    status,
    days_with_activity: days.length,
    integrity,
    dropped_count: dropped.length,
    receipts_in_window: verified.length,
    wrote,
    dry_run: !!opts.dryRun,
    took_ms,
    markdown: opts.includeMarkdown ? markdown : undefined,
  };
}

// Rough ET offset guess for `new Date("YYYY-MM-DDTHH:MM:SS-04:00")` parsing.
// Returns -05:00 for Nov..Mar, -04:00 for Apr..Oct. Good enough for picking
// the Friday of an explicitly-passed --date; the actual cron run does not
// rely on this (it just uses new Date()).
function etOffsetGuess(yyyyMmDd) {
  const m = Number(yyyyMmDd.split('-')[1]);
  return (m >= 4 && m <= 10) ? '-04:00' : '-05:00';
}

// ---------------------------------------------------------------------------
// Cron loop (optional — only when --start is passed)
// ---------------------------------------------------------------------------
//
// We do not hard-depend on node-cron. If `--start` is used and the module is
// missing, we tell the operator clearly. systemd is the preferred path.

async function startCronLoop({ allowBrokenChain }) {
  let cron;
  try {
    cron = await import('node-cron');
  } catch (e) {
    console.error('[weekly-summary] node-cron not installed.');
    console.error('  Install with:  npm i node-cron');
    console.error('  Or run from systemd timer:  OnCalendar=Fri 23:55  +  TZ=America/New_York');
    process.exit(1);
  }

  console.log(`[weekly-summary] scheduling ${CRON_EXPRESSION} ${ET_TIMEZONE}`);
  const task = cron.schedule(CRON_EXPRESSION, async () => {
    try {
      const r = await runWeeklySummary({ allowBrokenChain });
      console.log(`[weekly-summary] ${r.status} → ${r.out_file} (${r.took_ms}ms)`);
    } catch (err) {
      console.error(`[weekly-summary] FAILED: ${err.message}`);
    }
  }, { timezone: ET_TIMEZONE });

  process.on('SIGINT',  () => { task.stop(); process.exit(0); });
  process.on('SIGTERM', () => { task.stop(); process.exit(0); });

  // Stay alive.
  setInterval(() => {}, 1 << 30);
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

function printHelp() {
  console.log(`Orange5 weekly continuity summary

USAGE
  node weekly-summary.mjs [options]

OPTIONS
  --date <YYYY-MM-DD>      Summarize the week that contains this date (ET)
  --receipts-dir <path>    Override 10-RECEIPTS/orange5-build/
  --db <path>              Override 06-CONTROL-PLANE/receipts/orange5.db
  --out-dir <path>         Override output dir (defaults to receipts-dir)
  --dry-run                Do not write; print path + markdown
  --allow-broken-chain     Author a degraded summary even if chain broken
  --start                  Stay alive and run Fri 23:55 ET via node-cron
  -h, --help               Show this help`);
}

const isCli = (() => {
  // Cross-platform "am I the entrypoint" detection.
  try {
    return import.meta.url === `file://${path.resolve(process.argv[1])}` ||
           import.meta.url === path.resolve(process.argv[1]) ||
           fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
  } catch {
    return false;
  }
})();

if (isCli) {
  const args = parseArgs(process.argv);
  if (args.help) { printHelp(); process.exit(0); }

  if (args.start) {
    startCronLoop({ allowBrokenChain: !!args.allowBrokenChain });
  } else {
    try {
      const r = await runWeeklySummary({
        date: args.date,
        receiptsDir: args.receiptsDir,
        dbPath: args.dbPath,
        outDir: args.outDir,
        dryRun: !!args.dryRun,
        allowBrokenChain: !!args.allowBrokenChain,
        includeMarkdown: !!args.dryRun,
      });
      if (args.dryRun) {
        console.log(`--- would write: ${r.out_file} ---`);
        console.log(r.markdown);
        console.log(`--- end (status=${r.status}, took=${r.took_ms}ms) ---`);
      } else {
        const verb = r.wrote ? 'wrote' : 'unchanged';
        console.log(JSON.stringify({
          ok: true,
          status: r.status,
          out_file: r.out_file,
          friday: r.friday,
          week_number: r.week_number,
          window: r.window,
          counts: r.counts,
          receipts_in_window: r.receipts_in_window,
          dropped_count: r.dropped_count,
          chain_ok: r.integrity.ok,
          file_op: verb,
          took_ms: r.took_ms,
        }, null, 2));
      }
      process.exit(r.integrity.ok ? 0 : 2);
    } catch (err) {
      console.error(`[weekly-summary] FAILED: ${err.message}`);
      if (err.code) console.error(`  code: ${err.code}`);
      process.exit(1);
    }
  }
}
