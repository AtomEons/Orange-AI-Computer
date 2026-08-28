#!/usr/bin/env node
// read-ledger.mjs
// Path:    04-CONTROL-PLANE/session-start/read-ledger.mjs
// Runtime: Node >= 20 (Bun-compatible — node: imports only, zero deps)
//
// Session-start step 5 of the operator ritual.
//
// What this does
// --------------
// Reads 00-CHARTER/ORANGE5_NOT_GREEN_LEDGER.md, parses every item that is
// still flagged not-green (i.e. NOT in the "CLOSED OPEN" section and NOT in
// the "HELD PROJECTS" out-of-scope section), and returns the top 5 blocker
// IDs ordered by priority bucket. The orchestrator surfaces these IDs to
// the deploy grid so the operator sees the live blocker queue on every
// session start.
//
// Priority order (highest first)
// ------------------------------
//   1. DEFERRED BY OPERATOR          ("D*"  ids)  — operator chose to defer; live blocker
//   2. PENDING-LIVE-SYSTEM           ("L*"  ids)  — waiting on a live system moment
//   3. SCAFFOLD-NOW / FULL-LATER     ("S*"  ids)  — contract shipped, impl deepens later
//
// CLOSED OPEN and HELD PROJECTS are intentionally EXCLUDED from blockers.
// Closed items are receipts; held items are out of v1 scope.
//
// Return shape
// ------------
//   When the ledger file is present and parses cleanly:
//     {
//       step:        "read_ledger",
//       ok:          true,
//       source:      "file:<absolute-path>",
//       path:        "<absolute-path>",
//       total_open:  integer,          // sum across the three not-green buckets
//       counts: {
//         deferred:  integer,
//         pending:   integer,
//         scaffold:  integer,
//       },
//       top: [                          // length === min(5, total_open)
//         {
//           id:       "D2",
//           bucket:   "deferred"|"pending"|"scaffold",
//           item:     "<col 2 of ledger row>",
//           reason:   "<col 3>"|null,   // null when section uses different headers
//           resolution: "<col 4>"|null,
//         },
//         ...
//       ],
//       elapsed_ms:  integer,
//       read_at:     ISO8601,
//     }
//
//   When the ledger file is missing or unreadable:
//     {
//       step:        "read_ledger",
//       ok:          false,
//       reason:      "ledger_file_missing"|"ledger_read_failed"|"ledger_parse_empty",
//       detail:      "<named error>",
//       path:        "<absolute-path>",
//       elapsed_ms:  integer,
//       read_at:     ISO8601,
//     }
//
//   Mom's Law: we never synthesize fake blockers, and we never silently
//   downgrade a missing-file to "0 blockers / all green." A missing
//   ledger is a RED — the orchestrator must surface it.
//
// Doctrine alignment (binding)
// ----------------------------
// - Mom's Law: every blocker ID is real, taken verbatim from the ledger.
//   The bucket order and the top-5 cut are deterministic given the file
//   bytes — no model invocations, no randomness.
// - Receipts > recollection: returns elapsed_ms, read_at, and the source
//   path so 10-RECEIPTS can persist the verdict byte-for-byte.
// - No-third-state. The function returns ok:true with a real top list,
//   or ok:false with a named reason. There is no "best effort guess."
// - Zero deps. Pure node:fs + node:path. The ledger is human-curated
//   markdown pipe tables; we parse them deterministically without a
//   markdown library, matching the convention in orchestrator.mjs.
//
// Programmatic API
// ----------------
//   import { readLedgerBlockers } from "./read-ledger.mjs";
//   const r = readLedgerBlockers();
//   const r = readLedgerBlockers({ path, limit });
//
// CLI
// ---
//   node read-ledger.mjs            # one-shot, prints JSON result
//   node read-ledger.mjs --pretty   # pretty-printed JSON
//   node read-ledger.mjs --ids      # newline-delimited blocker IDs only
//
// Exit codes
// ----------
//   0  ok:true  AND total_open === 0      (no live blockers)
//   1  ok:true  AND total_open  >  0      (live blockers surfaced)
//   2  ok:false                            (ledger unreadable / missing / empty)
//
// -------------------------------------------------------------------------

import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

// ---------------------------------------------------------------------------
// Defaults — repo-relative, overridable by env for tests / alternate cockpits.
// ---------------------------------------------------------------------------

const ORANGE5_ROOT =
  process.env.ORANGE5_ROOT || resolve(__dirname, "..", "..");

const DEFAULT_LEDGER_PATH =
  process.env.ORANGE5_NOT_GREEN_LEDGER ||
  resolve(ORANGE5_ROOT, "00-CHARTER", "ORANGE5_NOT_GREEN_LEDGER.md");

const DEFAULT_LIMIT = 5;

// Buckets that count as "still not-green." Order = priority (highest first).
// The strings are matched case-insensitively against the markdown H2 line,
// with a substring match so author whitespace / parentheticals never break it.
const BUCKETS = [
  { name: "deferred", match: /deferred\s+by\s+operator/i },
  { name: "pending",  match: /pending-?live-?system/i },
  { name: "scaffold", match: /scaffold-?now/i },
];

// Sections we explicitly DO NOT count as blockers.
const EXCLUDED = [
  /closed\s+open/i,    // already fixed; receipts only
  /held\s+projects/i,  // out of v1 scope
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nowIso() {
  return new Date().toISOString();
}

/**
 * Split a markdown pipe-table row into trimmed column cells.
 * Returns null if the line is not a recognizable pipe row.
 */
function splitPipeRow(line) {
  if (!/^\s*\|/.test(line)) return null;
  // Drop the leading and trailing pipe sentinels before splitting.
  const cells = line.split("|").slice(1, -1).map((c) => c.trim());
  if (cells.length === 0) return null;
  return cells;
}

function isSeparatorRow(cells) {
  return cells.every((c) => /^:?-{2,}:?$/.test(c));
}

/**
 * Pick the section bucket for a given H2 title. Returns one of
 *   "deferred" | "pending" | "scaffold" | "excluded" | null
 *
 * - "excluded" means a recognized non-blocker section (CLOSED / HELD); the
 *   parser walks its rows but never emits them.
 * - null means an unrecognized section; same treatment.
 */
function classifySection(title) {
  for (const ex of EXCLUDED) {
    if (ex.test(title)) return "excluded";
  }
  for (const b of BUCKETS) {
    if (b.match.test(title)) return b.name;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Core: parseLedger
// ---------------------------------------------------------------------------

/**
 * Pure-data parse of the not-green ledger. Returns the three bucket arrays
 * in priority order plus a flat list ready for top-N selection. Throws only
 * on programmer error — file errors are handled by the caller.
 *
 * @param {string} raw  full file contents (utf8)
 * @returns {{ deferred: Array, pending: Array, scaffold: Array }}
 */
export function parseLedger(raw) {
  const out = { deferred: [], pending: [], scaffold: [] };
  if (typeof raw !== "string" || raw.length === 0) return out;

  const lines = raw.split(/\r?\n/);

  let currentBucket = null;   // "deferred" | "pending" | "scaffold" | "excluded" | null
  let header = null;          // string[] of column names for the active table
  let inTable = false;

  for (const ln of lines) {
    // H2 boundary — new section.
    const h2 = ln.match(/^##\s+(.+?)\s*$/);
    if (h2) {
      currentBucket = classifySection(h2[1]);
      header = null;
      inTable = false;
      continue;
    }

    // Blank line resets the in-table cursor but keeps the bucket.
    if (/^\s*$/.test(ln)) {
      header = null;
      inTable = false;
      continue;
    }

    // We only care about pipe rows in a recognized blocker bucket.
    if (!currentBucket || currentBucket === "excluded") continue;

    const cells = splitPipeRow(ln);
    if (!cells) {
      header = null;
      inTable = false;
      continue;
    }

    if (isSeparatorRow(cells)) {
      inTable = true;
      continue;
    }
    if (!header) {
      header = cells;
      continue;
    }
    if (!inTable) continue;
    if (cells.length !== header.length) continue;

    // First column is the ID (#). The ledger uses `D*`, `L*`, `S*`. We do
    // not require a specific prefix because the operator may add buckets
    // later — bucket-of-record is determined by section, not by ID prefix.
    const id = cells[0];
    if (!id || /^-+$/.test(id)) continue;

    // The DEFERRED and PENDING-LIVE-SYSTEM tables use columns:
    //   | # | Item | Reason             | Resolution path |
    // The SCAFFOLD-NOW / FULL-LATER table uses columns:
    //   | # | Item | Current state      | Full-build trigger |
    // We normalize the third and fourth columns to "reason" / "resolution"
    // so downstream renderers can format uniformly without re-parsing.
    const item       = cells[1] || "";
    const reason     = cells[2] || null;
    const resolution = cells[3] || null;

    out[currentBucket].push({
      id,
      bucket: currentBucket,
      item,
      reason,
      resolution,
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// Public API: readLedgerBlockers
// ---------------------------------------------------------------------------

/**
 * Read the not-green ledger from disk, parse it, and return the top N
 * blockers ordered by bucket priority (deferred > pending > scaffold)
 * and preserving in-bucket file order for determinism.
 *
 * @param {object} [opts]
 * @param {string} [opts.path]   - absolute path to the ledger markdown
 * @param {number} [opts.limit]  - top-N cut (default 5)
 * @returns {object} see top-of-file return shape
 */
export function readLedgerBlockers(opts = {}) {
  const path  = opts.path  || DEFAULT_LEDGER_PATH;
  const limit = Number.isFinite(opts.limit) && opts.limit > 0
    ? Math.trunc(opts.limit)
    : DEFAULT_LIMIT;

  const t0      = Date.now();
  const read_at = nowIso();

  if (!existsSync(path)) {
    return {
      step: "read_ledger",
      ok: false,
      reason: "ledger_file_missing",
      detail: `not found: ${path}`,
      path,
      elapsed_ms: Date.now() - t0,
      read_at,
    };
  }

  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    return {
      step: "read_ledger",
      ok: false,
      reason: "ledger_read_failed",
      detail: err && err.message ? err.message : String(err),
      path,
      elapsed_ms: Date.now() - t0,
      read_at,
    };
  }

  const parsed = parseLedger(raw);
  const counts = {
    deferred: parsed.deferred.length,
    pending:  parsed.pending.length,
    scaffold: parsed.scaffold.length,
  };
  const total_open = counts.deferred + counts.pending + counts.scaffold;

  // Build the priority-ordered candidate list once. Determinism: bucket
  // order is fixed by the BUCKETS array; in-bucket order is file order.
  const ordered = [
    ...parsed.deferred,
    ...parsed.pending,
    ...parsed.scaffold,
  ];
  const top = ordered.slice(0, limit);

  // Empty parse is NOT a silent zero. If the file existed but no rows
  // matched any blocker bucket, the operator should see "ledger_parse_empty"
  // because either the file is broken or the schema changed.
  if (total_open === 0) {
    // We still return ok:true so the orchestrator can distinguish "no
    // blockers" (a real signal) from "file missing" (a hard error). But
    // we surface the parse-empty hint in `reason` so downstream
    // renderers can flag the unusual condition.
    return {
      step: "read_ledger",
      ok: true,
      source: `file:${path}`,
      path,
      total_open: 0,
      counts,
      top: [],
      note: "no_open_blockers",
      elapsed_ms: Date.now() - t0,
      read_at,
    };
  }

  return {
    step: "read_ledger",
    ok: true,
    source: `file:${path}`,
    path,
    total_open,
    counts,
    top,
    elapsed_ms: Date.now() - t0,
    read_at,
  };
}

// ---------------------------------------------------------------------------
// Default export — matches the convention of inject-genome.mjs and
// guardrails-sweep.mjs so the orchestrator can `import default` if needed.
// ---------------------------------------------------------------------------

export default { readLedgerBlockers, parseLedger };

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const isMain = (() => {
  try {
    return resolve(process.argv[1] || "") === resolve(__filename);
  } catch {
    return false;
  }
})();

if (isMain) {
  const args   = process.argv.slice(2);
  const pretty = args.includes("--pretty");
  const idsOnly = args.includes("--ids");

  let r;
  try {
    r = readLedgerBlockers();
  } catch (err) {
    process.stderr.write(
      `[read-ledger] FATAL ${err && err.stack ? err.stack : String(err)}\n`,
    );
    process.exit(2);
  }

  if (idsOnly) {
    if (r.ok && Array.isArray(r.top)) {
      for (const row of r.top) process.stdout.write(row.id + "\n");
    }
  } else {
    process.stdout.write(
      JSON.stringify(r, null, pretty ? 2 : 0) + "\n",
    );
  }

  if (!r.ok) process.exit(2);
  if ((r.total_open || 0) > 0) process.exit(1);
  process.exit(0);
}
