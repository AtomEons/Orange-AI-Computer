// recall-engine.mjs — Æ Cobra dual-memory recall engine (Pillar 3, the wisdom layer).
//
// Orange5 Master Plan §9b: AE Cobra is the "resident SSD (Mamba-2), no KV cache,
// sees/saves/thinks at once; dual-LoRA (visual + thinking-text) over the SAME state."
// It answers four operator-facing recall questions:
//   1. time-of-event recall  — "what happened March 28 four years ago"
//   2. recency               — "what did I decide an hour ago"
//   3. project-state         — "where does <project> stand"
//   4. forgotten threads     — "catch me on the idea I raised but never acted on"
//   (+ history-of-mistakes   — "have I hit this failure before")
//
// SURROGATE HONESTY. Mamba-2 + dual-LoRA are the eventual runtime substrate.
// This module is NOT a model. It is the deterministic RECALL LOGIC + the
// dual-index architecture that logic runs over. No weights, no inference, no
// network. Pure filesystem JavaScript on top of flux/reader.mjs. When the
// trained serpent arrives it consumes THIS index contract; until then the
// contract is served by exact string/set retrieval that never hallucinates.
//
// DUAL INDEX (the "dual-LoRA over the SAME state" made concrete):
//   * Reality lane  → what actually happened (terminal, receipts, operator decisions,
//     observed state). Immutable ground truth.
//   * Thought lane  → what was proposed / hypothesized / considered (reasoning traces,
//     plans, rejected branches). Hypothesis until executed.
//   The two lanes are indexed SEPARATELY (via readFlux per-lane) and joined on the
//   SHARED STATE — a per-record topic-token fingerprint derived from summary +
//   entities + files + commands. A thought is "followed through" when a later reality
//   record shares enough of its topic surface. Reality overrides Thought (spec law).
//
// LIVE RECORD SHAPE (source of truth = flux/writer + flow-direct/caller, NOT the
// aspirational spec which used source/payload). Each record from readFlux is:
//   { ts:number, lane, origin, kind, body:object, prev_hash, hash }
// where, for AgentTurn-derived records, body carries the full turn:
//   body = { lane, event_type, summary, entities[], files[], commands[],
//            risk, next_action, confidence }
// Older records may carry an arbitrary body (e.g. { summary, run_id, disclosure_id, ... }).
// We read defensively: every field access tolerates absence.
//
// OFFLINE / EMPTY-SAFE CONTRACT (Mom's Law — no fake-green, no throw on empty):
//   * missing flux root, missing lane dir, empty ledger → sane empty result, never throw
//   * a torn / unparseable line is already skipped by reader.mjs
//   * every exported function returns a plain serializable object
//
// CLI:
//   bun recall-engine.mjs time   --phrase "an hour ago" --flux-root <dir>
//   bun recall-engine.mjs forgotten --flux-root <dir>
//   bun recall-engine.mjs project --project "AE Cobra" --flux-root <dir>
//   bun recall-engine.mjs mistakes --kind guardrails --flux-root <dir>

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFlux, countEvents, parseSince } from './flux/reader.mjs';

const REALITY = 'reality';
const THOUGHT = 'thought';
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

const MONTHS = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
  may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7,
  sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10,
  dec: 11, december: 11,
};

// Failure/repair vocabulary — records whose kind or body signals a mistake, an
// error, a risk, a guardrail trip, a repair, or a verification failure. Used by
// recallMistakes() to separate the "history of mistakes" surface from routine
// observations. Deterministic membership, no inference.
const MISTAKE_KINDS = new Set(['error', 'risk']);
const MISTAKE_KIND_SUBSTR = ['error', 'fail', 'red', 'critical', 'repair', 'rollback', 'reject', 'break', 'drift', 'guardrail'];

// ---------------------------------------------------------------------------
// Tokenization — the shared "state" the two lane indexes join on.
//
// A record's topic surface = summary words + entities + files + commands,
// lowercased, split on non-alphanumerics, stopworded, deduped. This is the
// deterministic stand-in for the SSM hidden state a trained Cobra would carry:
// two records that talk about the same thing share tokens.
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'to', 'of', 'in', 'on', 'at', 'for', 'with',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'this', 'that', 'these', 'those',
  'it', 'its', 'as', 'by', 'from', 'we', 'i', 'should', 'would', 'could', 'will',
  'not', 'no', 'yes', 'do', 'did', 'done', 'has', 'have', 'had', 'if', 'then', 'than',
  'so', 'up', 'out', 'over', 'into', 'via', 'per', 'vs', 'run', 'ran',
]);

function tokenizeText(s) {
  if (typeof s !== 'string' || !s) return [];
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w) && !/^\d+$/.test(w));
}

// Build the topic-token Set for one flux record from its body fields.
function recordTokens(rec) {
  const body = rec && typeof rec.body === 'object' && rec.body ? rec.body : {};
  const toks = new Set();
  for (const w of tokenizeText(bodyText(rec))) toks.add(w);
  for (const arrKey of ['entities', 'files', 'commands']) {
    const arr = body[arrKey];
    if (Array.isArray(arr)) {
      for (const item of arr) for (const w of tokenizeText(String(item))) toks.add(w);
    }
  }
  return toks;
}

// The primary human-readable text of a record — summary if present, else a
// compact fallback so downstream surfaces always have SOMETHING to show.
function bodyText(rec) {
  const body = rec && typeof rec.body === 'object' && rec.body ? rec.body : {};
  if (typeof body.summary === 'string' && body.summary) return body.summary;
  if (typeof body.next_action === 'string' && body.next_action) return body.next_action;
  if (typeof body.name === 'string' && body.name) return body.name;
  if (typeof rec?.kind === 'string' && rec.kind) return rec.kind;
  return '';
}

// Jaccard-style overlap of two token sets → [0,1]. Deterministic.
function tokenOverlap(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  for (const t of small) if (big.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union ? inter / union : 0;
}

// Count of shared tokens (used as a secondary, absolute-strength signal so a
// short thought with 2 distinctive shared tokens isn't drowned by Jaccard).
function sharedCount(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  for (const t of small) if (big.has(t)) inter++;
  return inter;
}

// ---------------------------------------------------------------------------
// Projection — the compact, serializable view of a record returned to callers.
// Never leaks prev_hash/internal chain plumbing beyond the receipt id (hash).
// ---------------------------------------------------------------------------
function projectRecord(rec) {
  const body = rec && typeof rec.body === 'object' && rec.body ? rec.body : {};
  return {
    ts: rec.ts,
    iso: Number.isFinite(rec.ts) ? new Date(rec.ts).toISOString() : null,
    lane: rec.lane || null,
    origin: rec.origin || null,
    kind: rec.kind || null,
    summary: bodyText(rec),
    entities: Array.isArray(body.entities) ? body.entities.slice(0, 20) : [],
    files: Array.isArray(body.files) ? body.files.slice(0, 20) : [],
    commands: Array.isArray(body.commands) ? body.commands.slice(0, 20) : [],
    next_action: typeof body.next_action === 'string' ? body.next_action : null,
    risk: typeof body.risk === 'string' ? body.risk : null,
    receipt_id: rec.hash || null,        // the Flux hash IS the receipt id (spec §Pillar4)
  };
}

// ---------------------------------------------------------------------------
// buildDualIndex — read reality + thought lanes SEPARATELY, attach topic tokens.
// This is the architectural core: two independent lane indexes over the shared
// state fingerprint. Every public query builds on this.
//
// Safe on empty/missing root: readFlux returns [] and we return empty indexes.
// ---------------------------------------------------------------------------
export function buildDualIndex({ fluxRoot, startMs = 0, endMs = Date.now(), maxRecords = Infinity } = {}) {
  const mk = (lane) => {
    const recs = readFlux({ fluxRoot, lanes: [lane], startMs, endMs, maxRecords });
    return recs.map((rec) => ({ rec, tokens: recordTokens(rec) }));
  };
  const reality = mk(REALITY);
  const thought = mk(THOUGHT);
  return {
    fluxRoot: fluxRoot || null,
    window: { startMs, endMs },
    reality,     // Array<{ rec, tokens:Set }>  — ground truth
    thought,     // Array<{ rec, tokens:Set }>  — hypotheses
    counts: { reality: reality.length, thought: thought.length },
  };
}

// ===========================================================================
// 1. resolveTimeQuery — events in a time window.
//
//   resolveTimeQuery({ fluxRoot, phrase })              — parse a phrase
//   resolveTimeQuery({ fluxRoot, fromMs, toMs })        — explicit range
//
// Phrase grammar (superset of reader.parseSince, which already does durations /
// epoch / ISO). We ADD natural calendar dates that parseSince can't do:
//   "an hour ago" / "1 hour ago" / "30 minutes ago" / "2 days ago"  (relative → [t, now])
//   "March 28 2022" / "28 March 2022" / "2022-03-28"                 (whole calendar day)
//   "March 28"                                                        (that month/day, most recent year ≤ now)
//   "X years ago" appended to a date  → shifts the year back         ("March 28 four years ago")
//   "today" / "yesterday"                                            (whole ET-naive local day)
//
// Deterministic. Unparseable phrase → { ok:false, reason } (never throws).
// Empty ledger → events:[] with ok:true (a valid, empty answer).
// ===========================================================================
export function resolveTimeQuery({ fluxRoot, phrase, fromMs, toMs, nowMs = Date.now(), maxRecords = 500, lanes } = {}) {
  let lo, hi, interpretation;

  if (Number.isFinite(fromMs) || Number.isFinite(toMs)) {
    lo = Number.isFinite(fromMs) ? fromMs : 0;
    hi = Number.isFinite(toMs) ? toMs : nowMs;
    interpretation = 'explicit-range';
  } else if (typeof phrase === 'string' && phrase.trim()) {
    const parsed = parseTimePhrase(phrase, nowMs);
    if (!parsed.ok) {
      return { ok: false, reason: parsed.reason, phrase, events: [], count: 0 };
    }
    lo = parsed.startMs;
    hi = parsed.endMs;
    interpretation = parsed.interpretation;
  } else {
    return { ok: false, reason: 'no phrase and no {fromMs,toMs} provided', events: [], count: 0 };
  }

  if (lo > hi) [lo, hi] = [hi, lo]; // tolerate reversed bounds

  const laneList = Array.isArray(lanes) && lanes.length ? lanes : [REALITY, THOUGHT];
  const recs = readFlux({ fluxRoot, lanes: laneList, startMs: lo, endMs: hi, maxRecords });
  return {
    ok: true,
    phrase: typeof phrase === 'string' ? phrase : null,
    interpretation,
    window: { startMs: lo, endMs: hi, startIso: new Date(lo).toISOString(), endIso: new Date(hi).toISOString() },
    count: recs.length,
    events: recs.map(projectRecord),
  };
}

// Parse a natural time phrase → { ok, startMs, endMs, interpretation } | { ok:false, reason }.
export function parseTimePhrase(phrase, nowMs = Date.now()) {
  const raw = String(phrase).trim();
  const s = raw.toLowerCase();

  // today / yesterday — whole local day.
  if (s === 'today') {
    const d = startOfLocalDay(nowMs);
    return { ok: true, startMs: d, endMs: d + DAY_MS - 1, interpretation: 'today' };
  }
  if (s === 'yesterday') {
    const d = startOfLocalDay(nowMs) - DAY_MS;
    return { ok: true, startMs: d, endMs: d + DAY_MS - 1, interpretation: 'yesterday' };
  }

  // "<n> <unit> ago"  /  "an hour ago" / "a minute ago" — relative → [now - dur, now].
  const rel = /^(?:(\d+(?:\.\d+)?)|an?)\s+(second|seconds|sec|minute|minutes|min|hour|hours|hr|day|days|week|weeks|month|months|year|years)\s+ago$/.exec(s);
  if (rel) {
    const n = rel[1] === undefined ? 1 : Number(rel[1]);
    const unit = rel[2];
    const mult = relUnitMs(unit);
    if (mult == null) return { ok: false, reason: `unknown relative unit: ${unit}` };
    const start = nowMs - n * mult;
    return { ok: true, startMs: start, endMs: nowMs, interpretation: `relative:${n}:${unit}` };
  }

  // Calendar date, optionally with a trailing "<n> years ago" year-shift.
  //   "march 28 2022"  |  "28 march 2022"  |  "march 28"  |  "2022-03-28"
  //   "march 28 four years ago"  → month/day of (currentYear - 4)
  const yearsAgo = /(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+years?\s+ago\s*$/.exec(s);
  let yearShift = 0;
  let core = s;
  if (yearsAgo) {
    yearShift = wordToInt(yearsAgo[1]);
    core = s.slice(0, yearsAgo.index).trim();
  }

  const cal = parseCalendarDate(core, nowMs, yearShift);
  if (cal.ok) return cal;

  // Fall back to reader.parseSince for pure duration / epoch / ISO forms it owns.
  // parseSince returns a single instant; we treat it as [instant, now] for a
  // duration-like phrase, or the whole day for a bare ISO date.
  try {
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      const t = Date.parse(raw + 'T00:00:00Z');
      if (Number.isFinite(t)) return { ok: true, startMs: t, endMs: t + DAY_MS - 1, interpretation: 'iso-date' };
    }
    const t = parseSince(raw, nowMs);
    if (Number.isFinite(t)) {
      // If it looks like an absolute epoch/ISO instant, window it to the day; a
      // relative duration collapses to [t, now].
      if (/^\d{10,}$/.test(raw) || /^\d{4}-\d{2}-\d{2}T/.test(raw)) {
        return { ok: true, startMs: t, endMs: t + DAY_MS - 1, interpretation: 'instant-day' };
      }
      return { ok: true, startMs: t, endMs: nowMs, interpretation: 'duration' };
    }
  } catch {
    /* fall through to failure */
  }

  return { ok: false, reason: `unparseable time phrase: "${raw}"` };
}

function parseCalendarDate(core, nowMs, yearShift) {
  // month name + day (+ optional year)
  let m = /^([a-z]+)\.?\s+(\d{1,2})(?:,)?(?:\s+(\d{4}))?$/.exec(core);
  if (m && MONTHS[m[1]] !== undefined) {
    return buildDayWindow(resolveYear(m[3], nowMs, yearShift), MONTHS[m[1]], Number(m[2]), 'month-day-year');
  }
  // day + month name (+ optional year)
  m = /^(\d{1,2})\s+([a-z]+)\.?(?:,)?(?:\s+(\d{4}))?$/.exec(core);
  if (m && MONTHS[m[2]] !== undefined) {
    return buildDayWindow(resolveYear(m[3], nowMs, yearShift), MONTHS[m[2]], Number(m[1]), 'day-month-year');
  }
  // numeric YYYY-MM-DD or YYYY/MM/DD
  m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(core);
  if (m) {
    const yr = Number(m[1]) - yearShift;
    return buildDayWindow(yr, Number(m[2]) - 1, Number(m[3]), 'numeric-ymd');
  }
  return { ok: false, reason: `not a calendar date: "${core}"` };
}

function resolveYear(yearStr, nowMs, yearShift) {
  if (yearStr) return Number(yearStr) - yearShift;
  // No explicit year: take the most recent year (<= now) for that month/day, then
  // apply any "N years ago" shift.
  const y = new Date(nowMs).getUTCFullYear();
  return y - yearShift;
}

function buildDayWindow(year, monthIdx, day, interpretation) {
  if (!Number.isInteger(year) || monthIdx < 0 || monthIdx > 11 || day < 1 || day > 31) {
    return { ok: false, reason: `invalid calendar components y=${year} m=${monthIdx + 1} d=${day}` };
  }
  const start = Date.UTC(year, monthIdx, day, 0, 0, 0, 0);
  if (!Number.isFinite(start)) return { ok: false, reason: 'date out of range' };
  return { ok: true, startMs: start, endMs: start + DAY_MS - 1, interpretation };
}

function relUnitMs(unit) {
  if (/^sec/.test(unit) || unit === 'second' || unit === 'seconds') return 1000;
  if (/^min/.test(unit) || unit === 'minute' || unit === 'minutes') return 60_000;
  if (/^h/.test(unit)) return HOUR_MS;
  if (/^day/.test(unit)) return DAY_MS;
  if (/^week/.test(unit)) return 7 * DAY_MS;
  if (/^month/.test(unit)) return 30 * DAY_MS;   // nominal
  if (/^year/.test(unit)) return 365 * DAY_MS;   // nominal
  return null;
}

function wordToInt(w) {
  const map = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
  if (/^\d+$/.test(w)) return Number(w);
  return map[w] ?? 0;
}

// Start-of-day in the process-local timezone (naive; the ledger stores UTC ms,
// operator phrasing like "today" is local). We floor via local Date fields.
function startOfLocalDay(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// ===========================================================================
// 2. surfaceForgottenThreads — thought-lane items raised but never followed
//    through on the reality lane within a window. The "catch me on the idea I
//    forgot" query.
//
// Algorithm (dual-index join):
//   For each thought record T (a proposal/plan/hypothesis):
//     * ignore it if it's structurally not an "idea" (see isIdeaThought)
//     * search the reality lane AFTER T.ts (up to nowMs) for any record R whose
//       topic tokens overlap T's tokens beyond threshold → that's a follow-through
//     * if NO such R exists, T is a forgotten thread
//   Rank forgotten threads by age (oldest-raised first — most likely dropped)
//   and by how concrete they were (had files/commands/next_action = more actionable).
//
// Params:
//   nowMs        — upper bound "now"
//   lookbackMs   — how far back to consider thoughts (default 120 days)
//   minOverlap   — Jaccard threshold for "followed through" (default 0.18)
//   minShared    — absolute shared-token floor (default 2)
//   limit        — max threads returned (default 50)
//
// Empty/missing ledger → { ok:true, threads:[], ... }. Never throws.
// ===========================================================================
export function surfaceForgottenThreads({
  fluxRoot,
  nowMs = Date.now(),
  lookbackMs = 120 * DAY_MS,
  minOverlap = 0.18,
  minShared = 2,
  limit = 50,
} = {}) {
  const startMs = Math.max(0, nowMs - lookbackMs);
  const idx = buildDualIndex({ fluxRoot, startMs, endMs: nowMs });

  const threads = [];
  for (const T of idx.thought) {
    if (!isIdeaThought(T.rec)) continue;
    if (T.tokens.size === 0) continue;

    let followed = false;
    let followedBy = null;
    // Only reality records at or after the thought's timestamp can be follow-through.
    for (const R of idx.reality) {
      if (R.rec.ts < T.rec.ts) continue;
      const ov = tokenOverlap(T.tokens, R.tokens);
      const sh = sharedCount(T.tokens, R.tokens);
      if (ov >= minOverlap && sh >= minShared) {
        followed = true;
        followedBy = R.rec;
        break;
      }
    }
    if (followed) continue;

    const p = projectRecord(T.rec);
    threads.push({
      ...p,
      age_ms: nowMs - T.rec.ts,
      age_days: Math.floor((nowMs - T.rec.ts) / DAY_MS),
      actionability: actionabilityScore(T.rec),   // higher = more concrete/actionable
      _followedBy: followedBy, // always null here (kept for shape symmetry; stripped below)
    });
  }

  // Rank: most actionable first, then oldest (longest-dropped) first.
  threads.sort((a, b) => (b.actionability - a.actionability) || (a.ts - b.ts));
  for (const t of threads) delete t._followedBy;

  return {
    ok: true,
    window: { startMs, endMs: nowMs, startIso: new Date(startMs).toISOString(), endIso: new Date(nowMs).toISOString() },
    scanned: { thoughts: idx.thought.length, reality: idx.reality.length },
    count: Math.min(threads.length, limit),
    total_forgotten: threads.length,
    threads: threads.slice(0, limit),
  };
}

// Is this thought record an actual "idea/proposal" (vs. noise)? Heuristic on the
// deterministic surface: reasoning/plan origins, or decision/risk/observation
// event kinds carrying a real summary. Guardrail-trip spam and empty bodies are
// excluded so the forgotten-thread surface stays high-signal.
function isIdeaThought(rec) {
  const origin = String(rec?.origin || '').toLowerCase();
  const kind = String(rec?.kind || '').toLowerCase();
  const summary = bodyText(rec);
  if (!summary) return false;
  // Explicit reasoning / planning origins are always candidate ideas.
  if (/reason|plan|hypoth|strategy|propos|consider|idea|orangellm/.test(origin)) return true;
  // AgentTurn thought events that represent a proposal.
  if (['decision', 'risk', 'observation', 'checkpoint'].includes(kind)) return true;
  // Otherwise, if it reads like a proposal verb, keep it.
  return /\b(plan|propose|hypothes|consider|should|idea|explore|maybe|try)\b/i.test(summary);
}

// How concrete/actionable was the idea? Concrete ideas that were dropped are the
// most important to surface. Points for: a next_action, named files, named
// commands, named entities, and length of the summary.
function actionabilityScore(rec) {
  const body = rec && typeof rec.body === 'object' && rec.body ? rec.body : {};
  let s = 0;
  if (typeof body.next_action === 'string' && body.next_action.trim()) s += 3;
  if (Array.isArray(body.files) && body.files.length) s += 2;
  if (Array.isArray(body.commands) && body.commands.length) s += 2;
  if (Array.isArray(body.entities) && body.entities.length) s += 1;
  const summ = bodyText(rec);
  if (summ.length >= 40) s += 1;
  return s;
}

// ===========================================================================
// 3. projectState — latest state summary for a named project from the ledger.
//
// A "project" match = the project name's tokens appear in a record's topic
// surface (summary/entities/files/commands) OR the raw name (case-insensitive
// substring) appears in the summary. We scan BOTH lanes, then:
//   * reality[]  — the ground-truth timeline for the project (latest first)
//   * thought[]  — open hypotheses/plans touching the project (latest first)
//   * latest     — the single most recent record touching the project (any lane)
//   * open_threads — forgotten (un-followed) thoughts touching the project
//   * conflicts  — reality records whose kind signals error/risk on the project
//
// Reality overrides Thought (spec law): `latest` prefers the newest reality
// record; if the newest record overall is a thought we still expose it but flag
// `latest_is_hypothesis: true`.
//
// Unknown project / empty ledger → ok:true with empty arrays. Never throws.
// ===========================================================================
export function projectState({ fluxRoot, project, nowMs = Date.now(), lookbackMs = 365 * DAY_MS, maxPer = 25 } = {}) {
  const name = String(project || '').trim();
  if (!name) return { ok: false, reason: 'no project name provided', project: null };

  const startMs = Math.max(0, nowMs - lookbackMs);
  const idx = buildDualIndex({ fluxRoot, startMs, endMs: nowMs });
  const nameTokens = new Set(tokenizeText(name));
  const nameLc = name.toLowerCase();

  const matches = (entry) => {
    if (nameTokens.size && sharedCount(nameTokens, entry.tokens) >= Math.min(nameTokens.size, 1)) {
      // require ALL name tokens present for multi-token names (tighter, avoids
      // "AE" matching everything); single-token names match on that one token.
      if (nameTokens.size >= 2) {
        for (const t of nameTokens) if (!entry.tokens.has(t)) return false;
        return true;
      }
      return true;
    }
    // substring fallback on the raw summary (handles names that tokenize oddly)
    return bodyText(entry.rec).toLowerCase().includes(nameLc);
  };

  const realityHits = idx.reality.filter(matches).map((e) => e.rec);
  const thoughtHits = idx.thought.filter(matches).map((e) => e.rec);

  const byTsDesc = (a, b) => b.ts - a.ts;
  realityHits.sort(byTsDesc);
  thoughtHits.sort(byTsDesc);

  const newestReality = realityHits[0] || null;
  const newestThought = thoughtHits[0] || null;
  let latest = newestReality;
  let latestIsHypothesis = false;
  if (newestThought && (!newestReality || newestThought.ts > newestReality.ts)) {
    latest = newestThought;
    latestIsHypothesis = true;
  }

  // Open threads on this project = forgotten (un-followed) thoughts among the hits.
  const forgotten = surfaceForgottenThreads({ fluxRoot, nowMs, lookbackMs });
  const openThreads = forgotten.threads.filter((t) => {
    const toks = new Set([...tokenizeText(t.summary), ...t.entities.flatMap((e) => tokenizeText(e)), ...t.files.flatMap((f) => tokenizeText(f))]);
    if (nameTokens.size >= 2) { for (const nt of nameTokens) if (!toks.has(nt)) return false; return true; }
    if (nameTokens.size === 1) return toks.has([...nameTokens][0]);
    return String(t.summary || '').toLowerCase().includes(nameLc);
  });

  const conflicts = realityHits.filter((r) => isMistakeRecord(r)).map(projectRecord);

  return {
    ok: true,
    project: name,
    found: realityHits.length + thoughtHits.length > 0,
    latest: latest ? projectRecord(latest) : null,
    latest_is_hypothesis: latestIsHypothesis,
    counts: { reality: realityHits.length, thought: thoughtHits.length, open_threads: openThreads.length },
    reality: realityHits.slice(0, maxPer).map(projectRecord),
    thought: thoughtHits.slice(0, maxPer).map(projectRecord),
    open_threads: openThreads.slice(0, maxPer),
    conflicts: conflicts.slice(0, maxPer),
  };
}

// ===========================================================================
// 4. recallMistakes — prior events tagged as failures / repairs of a given kind.
//
// "kind" is a free-text filter matched against a record's mistake surface:
//   * record kind (event_type)              e.g. "error", "risk"
//   * record kind substrings                e.g. "guardrails.red.critical"
//   * origin                                e.g. "doctrine.27guardrails.triage"
//   * body.summary / body.name text
// A record qualifies as a MISTAKE at all iff isMistakeRecord(); the `kind`
// argument then narrows that set (omit kind → all mistakes). Both lanes scanned
// (an error observed on reality AND a risk raised on thought both count), reality
// first. Chronological newest-first.
//
// Empty ledger / no matches → ok:true, mistakes:[]. Never throws.
// ===========================================================================
export function recallMistakes({ fluxRoot, kind, nowMs = Date.now(), lookbackMs = 365 * DAY_MS, limit = 100 } = {}) {
  const startMs = Math.max(0, nowMs - lookbackMs);
  const recs = readFlux({ fluxRoot, lanes: [REALITY, THOUGHT], startMs, endMs: nowMs });
  const kindLc = typeof kind === 'string' && kind.trim() ? kind.trim().toLowerCase() : null;

  const out = [];
  for (const rec of recs) {
    if (!isMistakeRecord(rec)) continue;
    if (kindLc && !mistakeMatchesKind(rec, kindLc)) continue;
    out.push(rec);
  }
  // Newest first; stable tie-break by lane (reality before thought) then hash.
  out.sort((a, b) => (b.ts - a.ts)
    || (laneRank(a.lane) - laneRank(b.lane))
    || String(a.hash || '').localeCompare(String(b.hash || '')));

  return {
    ok: true,
    kind: kindLc,
    window: { startMs, endMs: nowMs, startIso: new Date(startMs).toISOString(), endIso: new Date(nowMs).toISOString() },
    count: Math.min(out.length, limit),
    total: out.length,
    mistakes: out.slice(0, limit).map(projectRecord),
  };
}

function laneRank(lane) { return lane === REALITY ? 0 : lane === THOUGHT ? 1 : 2; }

// Does a record represent a mistake / failure / risk / repair at all?
function isMistakeRecord(rec) {
  const kind = String(rec?.kind || '').toLowerCase();
  const origin = String(rec?.origin || '').toLowerCase();
  const body = rec && typeof rec.body === 'object' && rec.body ? rec.body : {};
  if (MISTAKE_KINDS.has(kind)) return true;
  for (const sub of MISTAKE_KIND_SUBSTR) if (kind.includes(sub) || origin.includes(sub)) return true;
  // AgentTurn high risk with a summary counts as a logged risk.
  if (typeof body.risk === 'string' && body.risk.toLowerCase() === 'high') return true;
  // Explicit failure signals in structured verification bodies.
  if (body.overall_ok === false) return true;
  if (typeof body.severity === 'string' && /crit|high|error|fail/.test(body.severity.toLowerCase())) return true;
  return false;
}

// Narrow a known-mistake record by the caller's free-text kind filter.
function mistakeMatchesKind(rec, kindLc) {
  const kind = String(rec?.kind || '').toLowerCase();
  const origin = String(rec?.origin || '').toLowerCase();
  const summary = bodyText(rec).toLowerCase();
  const body = rec && typeof rec.body === 'object' && rec.body ? rec.body : {};
  const disclosure = String(body.disclosure_id || '').toLowerCase();
  const guardrail = String(body.guardrail_id || '').toLowerCase();
  return kind.includes(kindLc)
    || origin.includes(kindLc)
    || summary.includes(kindLc)
    || disclosure.includes(kindLc)
    || guardrail.includes(kindLc);
}

// ---------------------------------------------------------------------------
// ledgerHealth — thin convenience over countEvents for CLI / callers wanting a
// one-shot "is there anything to recall" probe. Safe on empty root.
// ---------------------------------------------------------------------------
export function ledgerHealth({ fluxRoot } = {}) {
  const counts = countEvents({ fluxRoot });
  return { ok: true, fluxRoot: fluxRoot || null, counts, empty: (counts.total || 0) === 0 };
}

// Exposed for tests.
export const _internal = {
  tokenizeText, recordTokens, bodyText, tokenOverlap, sharedCount,
  parseTimePhrase, parseCalendarDate, isIdeaThought, actionabilityScore,
  isMistakeRecord, mistakeMatchesKind, projectRecord,
};

// ---------------------------------------------------------------------------
// CLI — thin dispatcher so the engine is hand-runnable. Not a test harness.
// ---------------------------------------------------------------------------
function parseCliArgs(argv) {
  const a = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith('--')) { a.flags[t.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; }
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
    case 'time':
      out = resolveTimeQuery({ fluxRoot, phrase: a.flags.phrase });
      break;
    case 'forgotten':
      out = surfaceForgottenThreads({ fluxRoot });
      break;
    case 'project':
      out = projectState({ fluxRoot, project: a.flags.project });
      break;
    case 'mistakes':
      out = recallMistakes({ fluxRoot, kind: a.flags.kind });
      break;
    case 'health':
      out = ledgerHealth({ fluxRoot });
      break;
    default:
      process.stderr.write(
        'Æ Cobra recall-engine — dual-memory recall over the Flux ledger.\n\n' +
        'Usage:\n' +
        '  bun recall-engine.mjs time      --phrase "an hour ago"   [--flux-root <dir>]\n' +
        '  bun recall-engine.mjs forgotten                          [--flux-root <dir>]\n' +
        '  bun recall-engine.mjs project   --project "AE Cobra"     [--flux-root <dir>]\n' +
        '  bun recall-engine.mjs mistakes  --kind guardrails        [--flux-root <dir>]\n' +
        '  bun recall-engine.mjs health                             [--flux-root <dir>]\n'
      );
      process.exit(a._.length ? 1 : 0);
  }
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  process.exit(0);
}

const isDirect = (() => {
  try { return process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]); }
  catch { return false; }
})();

if (isDirect) {
  try { cliMain(process.argv.slice(2)); }
  catch (e) { process.stderr.write(`fatal: ${e.stack || e.message}\n`); process.exit(1); }
}
