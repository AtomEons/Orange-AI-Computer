// decay-rank.mjs — Æ Cobra recall-ext #2: recency + importance decay-weighted relevance.
//
// WHY. Recall surfaces (forgotten threads, project state, mistakes) currently
// rank by a single axis (age, or ts-desc, or actionability). But operator-facing
// relevance is TWO things at once: how RECENT a record is AND how IMPORTANT it
// is. A critical guardrail trip from yesterday should outrank a routine
// observation from an hour ago; a stale low-signal note should sink even if it's
// newer. This module makes that trade-off explicit and tunable.
//
// SCORE MODEL (deterministic, bounded, auditable):
//   relevance(rec) = recencyWeight(age) * (1 + importanceBoost(rec))
// where
//   recencyWeight(age) = 0.5 ** (age / halfLifeMs)      # exponential decay ∈ (0,1]
//   importanceBoost    = weighted sum of structural importance signals ∈ [0, ~1.6]
//
// Exponential half-life decay (not linear) matches how memory salience actually
// falls off and is the standard recency-weighting kernel. halfLifeMs defaults to
// 7 days: a record is worth half as much per week of age. importanceBoost reads
// ONLY deterministic structural signals already on the record — risk level,
// mistake-ness (reusing the engine's own isMistakeRecord), receipt/decision kind,
// presence of a next_action / files / commands, and stated confidence. No
// inference, no model.
//
// The multiplicative form means importance MODULATES recency rather than adding a
// free-floating constant: an ancient record can't outrank a fresh one on
// importance alone (recency floor), but among similar-age records importance is
// the tie-breaker that matters. Optional query-topic relevance can be folded in
// via the `queryTokens` param (exact-token overlap with the engine tokenizer).
//
// HONESTY. Pure arithmetic over fields already present. Weights are named
// constants (WEIGHTS) so every point of the score is inspectable and reproducible.
//
// EMPTY-SAFE. Missing/empty ledger → { ok:true, ranked:[], ... }, never throws.
// Imports the green engine's _internal + buildDualIndex; modifies nothing.
//
// CLI:
//   bun recall-ext/decay-rank.mjs rank --flux-root <dir> [--half-life-days 7] [--limit 20]
//   bun recall-ext/decay-rank.mjs rank --query "guardrail" --flux-root <dir>

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDualIndex, _internal } from '../recall-engine.mjs';

const { tokenizeText, bodyText, sharedCount, isMistakeRecord, projectRecord } = _internal;

const DAY_MS = 86_400_000;
const DEFAULT_HALF_LIFE_MS = 7 * DAY_MS;

// Named importance weights — every one is a documented, tunable knob. The score
// is fully reconstructable from these + the record fields. Keep the table small.
export const WEIGHTS = {
  mistake: 0.6,        // a logged failure/risk/repair is high-salience by default
  riskHigh: 0.5,       // body.risk === 'high'
  riskMed: 0.2,        // body.risk === 'medium'/'med'
  decision: 0.35,      // an operator decision / receipt is load-bearing
  receipt: 0.3,
  hasNextAction: 0.15, // an open next_action means it's still actionable
  hasFiles: 0.1,       // touches concrete files
  hasCommands: 0.1,    // ran concrete commands
  confidenceMax: 0.15, // scaled by stated confidence ∈ [0,1]
  queryHitMax: 0.8,    // scaled by topic overlap with an optional query
};

// recencyWeight — exponential half-life decay in (0,1]. age<=0 → 1 (future/now).
export function recencyWeight(ageMs, halfLifeMs = DEFAULT_HALF_LIFE_MS) {
  if (!Number.isFinite(ageMs) || ageMs <= 0) return 1;
  if (!Number.isFinite(halfLifeMs) || halfLifeMs <= 0) return 1;
  return Math.pow(0.5, ageMs / halfLifeMs);
}

// importanceBoost — deterministic structural salience ∈ [0, ~1.6]. Reads only
// fields already on the record; reuses the engine's isMistakeRecord so "mistake"
// means exactly what the engine means by it.
export function importanceBoost(rec, { queryTokens = null } = {}) {
  const body = rec && typeof rec.body === 'object' && rec.body ? rec.body : {};
  const kind = String(rec?.kind || '').toLowerCase();
  let b = 0;

  if (isMistakeRecord(rec)) b += WEIGHTS.mistake;

  const risk = String(body.risk || '').toLowerCase();
  if (risk === 'high') b += WEIGHTS.riskHigh;
  else if (risk === 'medium' || risk === 'med') b += WEIGHTS.riskMed;

  if (kind.includes('decision')) b += WEIGHTS.decision;
  if (kind.includes('receipt')) b += WEIGHTS.receipt;

  if (typeof body.next_action === 'string' && body.next_action.trim()) b += WEIGHTS.hasNextAction;
  if (Array.isArray(body.files) && body.files.length) b += WEIGHTS.hasFiles;
  if (Array.isArray(body.commands) && body.commands.length) b += WEIGHTS.hasCommands;

  const conf = Number(body.confidence);
  if (Number.isFinite(conf) && conf > 0) b += WEIGHTS.confidenceMax * Math.max(0, Math.min(1, conf));

  // Optional query-topic relevance (exact-token overlap fraction of the query).
  if (queryTokens && queryTokens.size) {
    const recToks = new Set([
      ...tokenizeText(bodyText(rec)),
      ...(Array.isArray(body.entities) ? body.entities.flatMap((e) => tokenizeText(String(e))) : []),
      ...(Array.isArray(body.files) ? body.files.flatMap((f) => tokenizeText(String(f))) : []),
    ]);
    const hits = sharedCount(queryTokens, recToks);
    const frac = queryTokens.size ? hits / queryTokens.size : 0;
    b += WEIGHTS.queryHitMax * frac;
  }

  return b;
}

// relevanceScore — the composite. recency * (1 + importance). Bounded, monotone
// decreasing in age, monotone increasing in importance.
export function relevanceScore(rec, { nowMs = Date.now(), halfLifeMs = DEFAULT_HALF_LIFE_MS, queryTokens = null } = {}) {
  const age = nowMs - (Number.isFinite(rec?.ts) ? rec.ts : nowMs);
  const rw = recencyWeight(age, halfLifeMs);
  const boost = importanceBoost(rec, { queryTokens });
  return rw * (1 + boost);
}

// ===========================================================================
// rankRecall — read both lanes over a window, score every record, return the
// top-N by relevance with the score breakdown attached (so a caller can SEE why
// something ranked where it did — Mom's Law receipts, not a black box).
//
// Params:
//   nowMs, lookbackMs (90d), halfLifeDays (7), limit (25), lanes, query (string)
//
// Empty/missing ledger → { ok:true, ranked:[], count:0 }. Never throws.
// ===========================================================================
export function rankRecall({
  fluxRoot,
  nowMs = Date.now(),
  lookbackMs = 90 * DAY_MS,
  halfLifeDays = 7,
  limit = 25,
  query = null,
} = {}) {
  const halfLifeMs = Math.max(1, halfLifeDays) * DAY_MS;
  const startMs = Math.max(0, nowMs - lookbackMs);
  const idx = buildDualIndex({ fluxRoot, startMs, endMs: nowMs });
  const queryTokens = query ? new Set(tokenizeText(String(query))) : null;

  const all = [...idx.reality, ...idx.thought].map((e) => e.rec);
  const scored = all.map((rec) => {
    const age = nowMs - (Number.isFinite(rec.ts) ? rec.ts : nowMs);
    const rw = recencyWeight(age, halfLifeMs);
    const boost = importanceBoost(rec, { queryTokens });
    const score = rw * (1 + boost);
    return {
      ...projectRecord(rec),
      relevance: round4(score),
      breakdown: {
        recency_weight: round4(rw),
        importance_boost: round4(boost),
        age_days: Math.floor(age / DAY_MS),
        half_life_days: halfLifeDays,
      },
    };
  });

  // Rank by relevance desc; deterministic tie-break by ts desc then receipt id.
  scored.sort((a, b) =>
    (b.relevance - a.relevance)
    || (b.ts - a.ts)
    || String(a.receipt_id || '').localeCompare(String(b.receipt_id || '')));

  return {
    ok: true,
    query: query || null,
    params: { half_life_days: halfLifeDays, lookback_days: Math.round(lookbackMs / DAY_MS) },
    window: { startMs, endMs: nowMs, startIso: new Date(startMs).toISOString(), endIso: new Date(nowMs).toISOString() },
    scanned: all.length,
    count: Math.min(scored.length, limit),
    ranked: scored.slice(0, limit),
  };
}

function round4(n) { return Math.round(n * 1e4) / 1e4; }

export const _internal_decay = { recencyWeight, importanceBoost, relevanceScore, round4, WEIGHTS };

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
    case 'rank':
      out = rankRecall({
        fluxRoot,
        query: typeof a.flags.query === 'string' ? a.flags.query : null,
        halfLifeDays: a.flags['half-life-days'] ? Number(a.flags['half-life-days']) : 7,
        limit: a.flags.limit ? Number(a.flags.limit) : 25,
      });
      break;
    default:
      process.stderr.write(
        'Æ Cobra recall-ext decay-rank — recency+importance decay-weighted relevance.\n\n' +
        'Usage:\n' +
        '  bun recall-ext/decay-rank.mjs rank [--query "<t>"] [--half-life-days 7] [--limit 25] [--flux-root <dir>]\n'
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
