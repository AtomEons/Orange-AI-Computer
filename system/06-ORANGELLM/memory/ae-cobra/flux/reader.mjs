// flux/reader.mjs — reader for the Æ Cobra Flux ledger (live per-lane/per-day layout).
//
// LIVE LEDGER LAYOUT (source of truth — matches writer, the graph-weaver daemon,
// the continuity generator's self-contained reader, and the 100-pair smoke test):
//
//   Path:    <fluxRoot>/events/<lane>/<YYYY-MM-DD>.jsonl      (one JSONL file per lane per ET day)
//   Lanes:   reality | thought | merge
//   Record:  { ts, lane, origin, kind, body, prev_hash, hash }   (one JSON object per line)
//   Chain:   prev_hash = "GENESIS" on the first record per lane; each subsequent
//            record's prev_hash === the previous record's hash on that lane.
//
// This module replaces an earlier draft that read a divergent FLAT-file layout
// (`<fluxRoot>/{reality,thought}.jsonl`) with an `{ts, sha256, prior_sha256,
// origin, lane, event}` record shape and an async `readFlux` that returned
// `{events, warnings, summary}`. That draft was stale: it did not match the
// on-disk ledger the daemon actually writes, it never exported `countEvents`,
// and its `readFlux` return shape was not what the live consumers call. The
// three live consumers —
//   - mirage/state-brief.mjs        → readFlux({fluxRoot, lanes, startMs, endMs, maxRecords}) → Array
//   - flow-direct/server.mjs        → readFlux(...) + countEvents({fluxRoot}) → per-lane counts
//   - graph-weaver/daemon.mjs       → readFlux({fluxRoot, lanes, startMs, endMs, maxRecords}) → Array
// — all expect the synchronous, array-returning API implemented below.
//
// Honest scope: pure filesystem JavaScript, host-agnostic, no network, no daemon
// dependency. Runs on the host that mounts the flux root (Codexa WSL2 in prod;
// AE_FLUX_ROOT points at a local cache on Windows). Reads are tolerant: a torn or
// unparseable trailing line is skipped, never thrown — end-of-day generation and
// tail daemons must never crash on an in-flight append.
//
// CLI:
//   bun reader.mjs --lane reality --since 1h
//   bun reader.mjs --lanes reality,thought --since 30m --json
//   bun reader.mjs --lane reality --verify-only
//   bun reader.mjs --lane reality --flux-root /tmp/ae_flux_test

import fs from 'node:fs';
import path from 'node:path';
import { canonicalFluxRoot } from '../paths.mjs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const VALID_LANES = new Set(['reality', 'thought', 'merge']);
export const DEFAULT_LANES = ['reality', 'thought'];
const GENESIS = 'GENESIS';
const DEFAULT_ROOT = canonicalFluxRoot();

// ---------------------------------------------------------------------------
// Path helpers — live layout: <fluxRoot>/events/<lane>/<YYYY-MM-DD>.jsonl
// ---------------------------------------------------------------------------

function laneDir(fluxRoot, lane) {
  return path.join(fluxRoot, 'events', lane);
}

function sha256Hex(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// --since / --until parser (kept for CLI + backward compat). Accepts:
//   "1h"   "30m"  "45s"  "2d"  "500ms"   — relative durations
//   "1700000000000"                       — absolute ms epoch
//   "2026-06-24T00:00:00Z"                — ISO 8601
// Returns absolute ms epoch.
// ---------------------------------------------------------------------------
export function parseSince(input, nowMs = Date.now()) {
  if (input === undefined || input === null || input === '') return 0;
  if (typeof input === 'number') return input;
  const s = String(input).trim();

  // ISO 8601
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const t = Date.parse(s);
    if (Number.isFinite(t)) return t;
    throw new Error(`unparseable ISO date: ${s}`);
  }

  // Pure integer → ms epoch
  if (/^\d+$/.test(s)) return Number(s);

  // Duration: <num><unit>
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(s);
  if (!m) throw new Error(`unparseable --since value: ${s} (expected e.g. "1h", "30m", "2d", "1700000000000", or ISO date)`);
  const n = Number(m[1]);
  const unit = m[2];
  const mult = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit];
  return nowMs - n * mult;
}

// ---------------------------------------------------------------------------
// Per-lane raw read — return the parsed records for one lane whose ts falls in
// [startMs, endMs] (inclusive), oldest first, capped at maxRecords.
//
// Tolerant by design: a missing lane dir yields []; a torn or unparseable line
// is skipped, not thrown. Day files are read in chronological (filename) order.
// ---------------------------------------------------------------------------
function readLaneRecords({ fluxRoot, lane, startMs, endMs, maxRecords }) {
  const dir = laneDir(fluxRoot, lane);
  let names;
  try {
    if (!fs.existsSync(dir)) return [];
    names = fs.readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith('.jsonl'))
      .map((d) => d.name)
      .sort(); // chronological by YYYY-MM-DD filename
    // The ledger is partitioned by day, so a bounded query should not parse
    // every historical file. Keep a full day on either side because older
    // writers used both UTC and America/New_York partition dates.
    if (Number.isFinite(startMs) && startMs > 0 && Number.isFinite(endMs)) {
      const marginMs = 86_400_000;
      const firstDay = new Date(Math.max(0, startMs - marginMs)).toISOString().slice(0, 10);
      const lastDay = new Date(endMs + marginMs).toISOString().slice(0, 10);
      names = names.filter((name) => {
        const day = name.slice(0, 10);
        return /^\d{4}-\d{2}-\d{2}$/.test(day) && day >= firstDay && day <= lastDay;
      });
    }
  } catch {
    return [];
  }

  const out = [];
  for (const name of names) {
    let raw;
    try {
      raw = fs.readFileSync(path.join(dir, name), 'utf8');
    } catch {
      continue; // file vanished / unreadable — skip, don't crash
    }
    for (const line of raw.split('\n')) {
      if (!line) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue; // torn / partial trailing line — skip
      }
      const ts = rec?.ts;
      if (typeof ts !== 'number') continue;
      if (ts < startMs || ts > endMs) continue;
      out.push(rec);
      if (out.length >= maxRecords) return out;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read flux records from one or more lanes over the live per-lane/per-day
 * ledger. SYNCHRONOUS. Returns a flat Array of records (oldest → newest),
 * each of shape { ts, lane, origin, kind, body, prev_hash, hash }.
 *
 * Primary (live-consumer) signature:
 *   readFlux({ fluxRoot, lanes: ['reality'], startMs, endMs, maxRecords })
 *
 * Backward-compatible aliases are accepted so older callers keep working:
 *   - `lane: 'reality'`     → treated as `lanes: ['reality']`
 *   - `sinceMs` / `untilMs` → treated as `startMs` / `endMs`
 *
 * @param {object}   args
 * @param {string}   [args.fluxRoot=/mnt/ae_flux]
 * @param {string[]} [args.lanes=['reality','thought']]  — subset of reality|thought|merge
 * @param {string}   [args.lane]                         — single-lane alias for lanes
 * @param {number}   [args.startMs=0]                    — inclusive lower ts bound
 * @param {number}   [args.endMs=Date.now()]             — inclusive upper ts bound
 * @param {number}   [args.sinceMs]                      — alias for startMs
 * @param {number}   [args.untilMs]                      — alias for endMs
 * @param {number}   [args.maxRecords=Infinity]          — cap on total returned records
 * @returns {Array<{ts:number,lane:string,origin:string,kind:string,body:object,prev_hash:string,hash:string}>}
 */
export function readFlux({
  fluxRoot = DEFAULT_ROOT,
  lanes,
  lane,
  startMs,
  endMs,
  sinceMs,
  untilMs,
  maxRecords = Infinity,
} = {}) {
  // Resolve lane list (accept single-lane alias; validate; keep only known lanes).
  let laneList = Array.isArray(lanes) ? lanes.slice() : null;
  if (!laneList && typeof lane === 'string') laneList = [lane];
  if (!laneList || laneList.length === 0) laneList = DEFAULT_LANES.slice();
  laneList = laneList.filter((l) => VALID_LANES.has(l));
  if (laneList.length === 0) {
    throw new Error(`readFlux: no valid lanes requested (expected some of ${[...VALID_LANES].join('|')})`);
  }

  const lo = Number.isFinite(startMs) ? startMs : (Number.isFinite(sinceMs) ? sinceMs : 0);
  const hi = Number.isFinite(endMs) ? endMs : (Number.isFinite(untilMs) ? untilMs : Date.now());
  const cap = Number.isFinite(maxRecords) ? maxRecords : Infinity;

  if (!fluxRoot || !fs.existsSync(fluxRoot)) return [];

  const all = [];
  for (const l of laneList) {
    if (all.length >= cap) break;
    const recs = readLaneRecords({
      fluxRoot,
      lane: l,
      startMs: lo,
      endMs: hi,
      maxRecords: cap - all.length,
    });
    for (const r of recs) all.push(r);
  }

  // Global order oldest → newest across lanes. Stable tie-break on hash so a
  // deterministic order is returned even when two lanes share a ts.
  all.sort((a, b) => (a.ts - b.ts) || String(a.hash || '').localeCompare(String(b.hash || '')));

  return all.length > cap ? all.slice(0, cap) : all;
}

/**
 * Read the newest bounded slice without replaying the full ledger. This is for
 * hot operational memory, where the latest outcome episode matters and stale
 * history must not dominate the route. Results are newest first.
 */
export function readFluxTail({
  fluxRoot = DEFAULT_ROOT,
  lanes,
  lane,
  startMs = 0,
  endMs = Date.now(),
  maxRecords = 2_000,
} = {}) {
  let laneList = Array.isArray(lanes) ? lanes.slice() : null;
  if (!laneList && typeof lane === 'string') laneList = [lane];
  if (!laneList || laneList.length === 0) laneList = DEFAULT_LANES.slice();
  laneList = laneList.filter((value) => VALID_LANES.has(value));
  if (!fluxRoot || !fs.existsSync(fluxRoot) || laneList.length === 0) return [];

  const cap = Math.max(1, Number(maxRecords) || 2_000);
  const all = [];
  for (const currentLane of laneList) {
    let laneCount = 0;
    const dir = laneDir(fluxRoot, currentLane);
    let names = [];
    try {
      names = fs.readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(entry.name))
        .map((entry) => entry.name)
        .sort()
        .reverse();
    } catch { continue; }

    for (const name of names) {
      let lines;
      try { lines = fs.readFileSync(path.join(dir, name), 'utf8').split('\n').filter(Boolean).reverse(); }
      catch { continue; }
      for (const line of lines) {
        let record;
        try { record = JSON.parse(line); } catch { continue; }
        if (!Number.isFinite(record?.ts) || record.ts < startMs || record.ts > endMs) continue;
        all.push(record);
        laneCount += 1;
        if (laneCount >= cap) break;
      }
      if (laneCount >= cap) break;
    }
  }
  all.sort((a, b) => (b.ts - a.ts) || String(a.hash || '').localeCompare(String(b.hash || '')));
  return all.slice(0, cap);
}

/**
 * Count events per lane in the ledger (optionally within a ts window).
 * Returns an object keyed by lane plus a `total`, e.g.
 *   { reality: 1847, thought: 312, merge: 0, total: 2159 }
 *
 * Used by flow-direct/server.mjs `/healthz` (`lanes: countEvents({fluxRoot})`).
 * Safe-fails to zeros when the root or a lane dir is missing.
 *
 * @param {object}   args
 * @param {string}   [args.fluxRoot=/mnt/ae_flux]
 * @param {string[]} [args.lanes=[reality,thought,merge]]
 * @param {number}   [args.startMs=0]
 * @param {number}   [args.endMs=Date.now()]
 * @returns {{[lane:string]:number, total:number}}
 */
export function countEvents({
  fluxRoot = DEFAULT_ROOT,
  lanes,
  startMs = 0,
  endMs = Date.now(),
} = {}) {
  let laneList = Array.isArray(lanes) && lanes.length ? lanes.filter((l) => VALID_LANES.has(l)) : [...VALID_LANES];
  const counts = {};
  let total = 0;
  const rootOk = !!fluxRoot && fs.existsSync(fluxRoot);

  for (const lane of laneList) {
    let n = 0;
    if (rootOk) {
      const dir = laneDir(fluxRoot, lane);
      try {
        if (fs.existsSync(dir)) {
          const names = fs.readdirSync(dir, { withFileTypes: true })
            .filter((d) => d.isFile() && d.name.endsWith('.jsonl'))
            .map((d) => d.name);
          for (const name of names) {
            let raw;
            try { raw = fs.readFileSync(path.join(dir, name), 'utf8'); } catch { continue; }
            for (const line of raw.split('\n')) {
              if (!line) continue;
              let rec;
              try { rec = JSON.parse(line); } catch { continue; }
              const ts = rec?.ts;
              if (typeof ts !== 'number') continue;
              if (ts < startMs || ts > endMs) continue;
              n++;
            }
          }
        }
      } catch { /* leave n as counted-so-far */ }
    }
    counts[lane] = n;
    total += n;
  }
  counts.total = total;
  return counts;
}

/**
 * Verify the per-lane hash chain of a single lane over the live layout.
 * Recomputes prev_hash linkage from GENESIS across the lane's day files in
 * chronological order. Non-throwing: returns a status object.
 *
 * Note: this verifies the LINKAGE (each record's prev_hash === previous hash).
 * It does not recompute `hash` from the body, because the canonical hashing
 * function that produced these records lives with the writer; re-deriving it
 * here would risk a divergence that reports false breaks. Linkage verification
 * is the honest, self-contained check this reader can make.
 *
 * @returns {{ok:boolean, lane:string, count:number, broken:Array, tailHash:string}}
 */
export function verifyChainStream({ lane, fluxRoot = DEFAULT_ROOT } = {}) {
  if (!VALID_LANES.has(lane)) throw new Error(`invalid lane: ${lane} (expected ${[...VALID_LANES].join('|')})`);
  const dir = laneDir(fluxRoot, lane);
  const broken = [];
  let count = 0;
  let prev = GENESIS;

  let names = [];
  try {
    if (fs.existsSync(dir)) {
      names = fs.readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isFile() && d.name.endsWith('.jsonl'))
        .map((d) => d.name)
        .sort();
    }
  } catch {
    return { ok: true, lane, count: 0, broken: [], tailHash: GENESIS };
  }

  for (const name of names) {
    let raw;
    try { raw = fs.readFileSync(path.join(dir, name), 'utf8'); } catch { continue; }
    const torn = raw.length > 0 && !raw.endsWith('\n');
    const body = torn ? raw.slice(0, raw.lastIndexOf('\n') + 1) : raw;
    const lines = body.split('\n').filter(Boolean);
    for (const line of lines) {
      let rec;
      try { rec = JSON.parse(line); } catch { broken.push({ file: name, idx: count, reason: 'parse error' }); return { ok: false, lane, count, broken, tailHash: prev }; }
      if (rec.prev_hash !== prev) {
        broken.push({ file: name, idx: count, reason: `prev_hash mismatch (expected ${prev}, got ${rec.prev_hash})` });
        return { ok: false, lane, count, broken, tailHash: prev };
      }
      prev = rec.hash;
      count++;
    }
    if (torn) broken.push({ file: name, idx: count, reason: 'torn trailing line (unterminated)' });
  }

  return { ok: broken.length === 0, lane, count, broken, tailHash: prev };
}

// Exposed for tests + cross-module sanity checks.
export const _internal = { sha256Hex, GENESIS, parseSince, laneDir, readLaneRecords };

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    lanes: null,
    since: null,
    until: null,
    fluxRoot: DEFAULT_ROOT,
    max: Infinity,
    json: false,
    verifyOnly: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--lane':         args.lanes = [next()]; break;
      case '--lanes':        args.lanes = String(next()).split(',').map((s) => s.trim()).filter(Boolean); break;
      case '--since':        args.since = next(); break;
      case '--until':        args.until = next(); break;
      case '--flux-root':    args.fluxRoot = next(); break;
      case '--max':          args.max = Number(next()); break;
      case '--json':         args.json = true; break;
      case '--verify-only':  args.verifyOnly = true; break;
      case '-h': case '--help': args.help = true; break;
      default:
        throw new Error(`unknown argument: ${a}`);
    }
  }
  return args;
}

function printHelp() {
  process.stdout.write(`Æ Cobra flux/reader.mjs — reader for the live per-lane/per-day flux ledger

Layout: <flux-root>/events/<lane>/<YYYY-MM-DD>.jsonl   (lanes: reality|thought|merge)

Usage:
  bun reader.mjs [--lane <name> | --lanes r,t,m] [options]

Options:
  --lane <name>         single lane: reality | thought | merge
  --lanes <a,b,c>       comma list of lanes            (default: reality,thought)
  --since <dur|ts|iso>  e.g. "1h", "30m", "2d", ISO    (default: all)
  --until <dur|ts|iso>  upper bound on ts              (default: now)
  --flux-root <dir>     override AE_FLUX_ROOT / default /mnt/ae_flux
  --max <n>             cap emitted records            (default: unlimited)
  --json                emit one JSON record per line to stdout
  --verify-only         verify each lane's hash-chain linkage; print summary
  -h, --help            this help

Exit codes:
  0  ok (chain intact when --verify-only)
  1  usage error
  2  chain break detected (--verify-only)
`);
}

function cliMain(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n\n`);
    printHelp();
    process.exit(1);
  }
  if (args.help) { printHelp(); process.exit(0); }

  const laneList = (args.lanes && args.lanes.length ? args.lanes : DEFAULT_LANES).filter((l) => VALID_LANES.has(l));
  if (laneList.length === 0) {
    process.stderr.write(`error: no valid lane(s) (expected ${[...VALID_LANES].join('|')})\n`);
    process.exit(1);
  }

  if (args.verifyOnly) {
    let anyBroken = false;
    for (const lane of laneList) {
      const r = verifyChainStream({ lane, fluxRoot: args.fluxRoot });
      const status = r.ok ? 'OK' : 'BROKEN';
      process.stderr.write(`[summary] lane=${lane} status=${status} records=${r.count} tail_hash=${String(r.tailHash).slice(0, 12)}\n`);
      for (const b of r.broken) process.stderr.write(`  break: file=${b.file} idx=${b.idx} reason=${b.reason}\n`);
      if (!r.ok) anyBroken = true;
    }
    process.exit(anyBroken ? 2 : 0);
  }

  const now = Date.now();
  let startMs = 0;
  let endMs = now;
  try {
    startMs = parseSince(args.since, now);
    if (args.until) endMs = parseSince(args.until, now);
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    process.exit(1);
  }

  const records = readFlux({
    fluxRoot: args.fluxRoot,
    lanes: laneList,
    startMs,
    endMs,
    maxRecords: Number.isFinite(args.max) ? args.max : Infinity,
  });

  for (const rec of records) {
    if (args.json) {
      process.stdout.write(JSON.stringify(rec) + '\n');
    } else {
      const tsStr = new Date(rec.ts).toISOString();
      const origin = String(rec.origin || '?').padEnd(14);
      const laneStr = String(rec.lane || '?').padEnd(8);
      const kind = String(rec.kind || '-').padEnd(20);
      const h = String(rec.hash || '').slice(0, 12);
      process.stdout.write(`${tsStr}  ${laneStr}  ${origin}  ${kind}  ${h}\n`);
    }
  }
  process.stderr.write(`\n[summary] lanes=${laneList.join(',')} emitted=${records.length}\n`);
  process.exit(0);
}

// Run CLI iff invoked directly (not when imported).
const isDirect = (() => {
  try {
    return process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
  } catch {
    return false;
  }
})();

if (isDirect) {
  try {
    cliMain(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`fatal: ${e.stack || e.message}\n`);
    process.exit(1);
  }
}
