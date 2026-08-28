// since-diff.mjs — Æ Cobra recall-ext #4: "what changed since <time>" for a project.
//
// WHY. "Where does project X stand" (engine.projectState) gives the current
// snapshot. But the operator returning after a gap asks a different question:
// "what CHANGED on X since <last Tuesday / an hour ago / 2026-06-25>?" — a delta,
// not a snapshot. This module produces that delta: the records touching a project
// that landed inside the since-window, grouped into a legible changelog (new
// decisions, new receipts, new errors/risks, new open threads, files touched,
// commands run), so a recall answer reads like a diff since the operator left.
//
// HOW:
//   1. Resolve the "since" boundary. Accepts a natural phrase (reusing the
//      engine's own parseTimePhrase — "an hour ago", "yesterday", "2026-06-25",
//      "March 28 four years ago") OR an explicit sinceMs. The window is
//      [sinceMs, nowMs].
//   2. Select the project's records in that window (same matching contract as the
//      engine's projectState: name-token subset match, or raw-substring fallback).
//   3. Bucket the delta by kind and lane, and roll up the concrete surface that
//      changed: distinct files touched, commands run, and the net new open
//      (forgotten/un-followed) threads on the project within the window.
//
// This is a pure re-view over the same ledger the engine reads — it introduces no
// new state and no model. It is the "diff" verb over Cobra's recall substrate.
//
// HONESTY. Deterministic. Reuses engine parseTimePhrase + _internal; the project-
// match logic mirrors projectState so "the project" means the same thing here.
// Modifies neither engine nor reader.
//
// EMPTY-SAFE. Missing/empty ledger, or a since-window with nothing in it →
//   { ok:true, changed:false, ... empties }. Bad phrase → { ok:false, reason }.
//   Never throws.
//
// CLI:
//   bun recall-ext/since-diff.mjs diff --project "AE Cobra" --since "yesterday" --flux-root <dir>
//   bun recall-ext/since-diff.mjs diff --project "AE Cobra" --since-ms 1719300000000 --flux-root <dir>

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseTimePhrase, surfaceForgottenThreads, _internal,
} from '../recall-engine.mjs';
import { readFlux } from '../flux/reader.mjs';

const { tokenizeText, recordTokens, bodyText, sharedCount, isMistakeRecord, projectRecord } = _internal;

const DAY_MS = 86_400_000;
const REALITY = 'reality';
const THOUGHT = 'thought';

// Project match — same contract as engine.projectState: token-subset for multi-
// token names, single-token match for one-word names, raw-substring fallback.
function projectMatcher(name) {
  const nameLc = String(name).toLowerCase();
  const nameToks = new Set(tokenizeText(name));
  return (rec) => {
    const toks = recordTokens(rec);
    if (nameToks.size) {
      if (nameToks.size >= 2) {
        let all = true;
        for (const t of nameToks) if (!toks.has(t)) { all = false; break; }
        if (all) return true;
      } else if (sharedCount(nameToks, toks) >= 1) {
        return true;
      }
    }
    return bodyText(rec).toLowerCase().includes(nameLc);
  };
}

// ===========================================================================
// sinceDiff — the changelog delta for a project since a boundary time.
//
// Params:
//   project (required), fluxRoot
//   since (phrase)  |  sinceMs (explicit epoch ms)   — one is required
//   nowMs (default now)
//   maxPer (25)     — cap per bucket
//
// Returns:
//   { ok, project, changed:boolean,
//     window:{ sinceMs, nowMs, sinceIso, nowIso, interpretation },
//     counts:{ total, reality, thought, decisions, receipts, mistakes, open_threads },
//     decisions[], receipts[], mistakes[], other[],       (projected records)
//     files_touched[], commands_run[],                    (distinct, sorted)
//     open_threads[] }                                    (new forgotten threads on the project)
//
// Bad phrase → { ok:false, reason }. Empty window → changed:false, empties.
// ===========================================================================
export function sinceDiff({ fluxRoot, project, since, sinceMs, nowMs = Date.now(), maxPer = 25 } = {}) {
  const name = String(project || '').trim();
  if (!name) return { ok: false, reason: 'no project name provided', project: null };

  // Resolve the since boundary.
  let lo, interpretation;
  if (Number.isFinite(sinceMs)) {
    lo = sinceMs;
    interpretation = 'explicit-ms';
  } else if (typeof since === 'string' && since.trim()) {
    const parsed = parseTimePhrase(since, nowMs);
    if (!parsed.ok) return { ok: false, reason: parsed.reason, project: name };
    // For a "since" boundary we want the START of the parsed window (e.g. "an
    // hour ago" → start = now-1h; "2026-06-25" → start = that day 00:00Z).
    lo = parsed.startMs;
    interpretation = `phrase:${parsed.interpretation}`;
  } else {
    return { ok: false, reason: 'provide {since:"<phrase>"} or {sinceMs:<epoch>}', project: name };
  }
  let hi = nowMs;
  if (lo > hi) [lo, hi] = [hi, lo];

  const recs = readFlux({ fluxRoot, lanes: [REALITY, THOUGHT], startMs: lo, endMs: hi });
  const match = projectMatcher(name);
  const hits = recs.filter(match);
  hits.sort((a, b) => b.ts - a.ts); // newest first

  // Bucket by kind / lane.
  const decisions = [];
  const receipts = [];
  const mistakes = [];
  const other = [];
  const filesTouched = new Set();
  const commandsRun = new Set();
  let realityN = 0, thoughtN = 0;

  for (const rec of hits) {
    if (rec.lane === REALITY) realityN++; else if (rec.lane === THOUGHT) thoughtN++;
    const kind = String(rec.kind || '').toLowerCase();
    const body = rec.body && typeof rec.body === 'object' ? rec.body : {};
    if (Array.isArray(body.files)) for (const f of body.files) if (f) filesTouched.add(String(f));
    if (Array.isArray(body.commands)) for (const c of body.commands) if (c) commandsRun.add(String(c));

    if (isMistakeRecord(rec)) mistakes.push(projectRecord(rec));
    else if (kind.includes('decision')) decisions.push(projectRecord(rec));
    else if (kind.includes('receipt')) receipts.push(projectRecord(rec));
    else other.push(projectRecord(rec));
  }

  // New open threads on this project within the window = forgotten (un-followed)
  // thoughts (from the engine surface) whose ts ≥ since and that match the project.
  const lookbackMs = Math.max(DAY_MS, hi - lo);
  const forgotten = surfaceForgottenThreads({ fluxRoot, nowMs: hi, lookbackMs });
  const nameToks = new Set(tokenizeText(name));
  const nameLc = name.toLowerCase();
  const openThreads = forgotten.threads.filter((t) => {
    if (!(t.ts >= lo && t.ts <= hi)) return false;
    const toks = new Set([
      ...tokenizeText(t.summary),
      ...(Array.isArray(t.entities) ? t.entities.flatMap((e) => tokenizeText(e)) : []),
      ...(Array.isArray(t.files) ? t.files.flatMap((f) => tokenizeText(f)) : []),
    ]);
    if (nameToks.size >= 2) { for (const nt of nameToks) if (!toks.has(nt)) return false; return true; }
    if (nameToks.size === 1) return toks.has([...nameToks][0]);
    return String(t.summary || '').toLowerCase().includes(nameLc);
  });

  const total = hits.length;
  return {
    ok: true,
    project: name,
    changed: total > 0 || openThreads.length > 0,
    window: {
      sinceMs: lo, nowMs: hi,
      sinceIso: new Date(lo).toISOString(), nowIso: new Date(hi).toISOString(),
      interpretation,
    },
    counts: {
      total,
      reality: realityN,
      thought: thoughtN,
      decisions: decisions.length,
      receipts: receipts.length,
      mistakes: mistakes.length,
      open_threads: openThreads.length,
      files_touched: filesTouched.size,
      commands_run: commandsRun.size,
    },
    decisions: decisions.slice(0, maxPer),
    receipts: receipts.slice(0, maxPer),
    mistakes: mistakes.slice(0, maxPer),
    other: other.slice(0, maxPer),
    files_touched: [...filesTouched].sort().slice(0, maxPer * 2),
    commands_run: [...commandsRun].sort().slice(0, maxPer * 2),
    open_threads: openThreads.slice(0, maxPer),
  };
}

export const _internal_since = { projectMatcher };

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseCliArgs(argv) {
  const a = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith('--')) a.flags[t.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    else a._.push(t);
  }
  return a;
}

function cliMain(argv) {
  const a = parseCliArgs(argv);
  const cmd = a._[0];
  const fluxRoot = a.flags['flux-root'] || process.env.AE_FLUX_ROOT;
  let out;
  switch (cmd) {
    case 'diff':
      out = sinceDiff({
        fluxRoot,
        project: a.flags.project,
        since: typeof a.flags.since === 'string' ? a.flags.since : undefined,
        sinceMs: a.flags['since-ms'] ? Number(a.flags['since-ms']) : undefined,
      });
      break;
    default:
      process.stderr.write(
        'Æ Cobra recall-ext since-diff — "what changed since <time>" for a project.\n\n' +
        'Usage:\n' +
        '  bun recall-ext/since-diff.mjs diff --project "<name>" --since "yesterday"   [--flux-root <dir>]\n' +
        '  bun recall-ext/since-diff.mjs diff --project "<name>" --since-ms <epoch>     [--flux-root <dir>]\n'
      );
      process.exit(a._.length ? 1 : 0);
  }
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  process.exit(out && out.ok === false ? 1 : 0);
}

const isDirect = (() => {
  try { return process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]); }
  catch { return false; }
})();

if (isDirect) {
  try { cliMain(process.argv.slice(2)); }
  catch (e) { process.stderr.write(`fatal: ${e.stack || e.message}\n`); process.exit(1); }
}
