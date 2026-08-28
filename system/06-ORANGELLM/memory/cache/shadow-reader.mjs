// shadow-reader.mjs — Read the N150 shadow cache.
//
// Public API:
//   readShadowCache({ lanes, startMs, endMs, maxRecords }) -> Promise<{
//     records: Array<{ lane, ts, ...payload }>,
//     by_lane: Record<lane, Array<record>>,
//     freshness: { last_sync_ms, last_sync_at, age_ms, stale, by_lane: {...} },
//     truncated: boolean,
//     source: 'shadow-cache',
//   }>
//
// Contract is intentionally identical to the Æ Cobra reader so the
// OrangeLLM gateway can switch on `source` only — the records[] and
// by_lane shape are the same.
//
// Mirage doctrine: shadow is mirage/memory thought-plane material. Caller
// must mark StateBriefs that come from here as shadow=true.

import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import { basename, join, resolve } from 'node:path';

export const SHADOW_CACHE_DIR = resolve(
  process.env.ORANGE5_CACHE_DIR
    || join(process.env.USERPROFILE || os.homedir(), 'OrangeBox-Data', 'orange5', 'memory-shadow'),
);
export const SHADOW_STATE_FILE = join(SHADOW_CACHE_DIR, '.sync-state.json');
export const CANONICAL_EVENTS_DIR = resolve(
  process.env.ORANGE5_COBRA_FLUX_ROOT
    || join(process.env.USERPROFILE || os.homedir(), 'OrangeBox-Data', 'orange5', 'ae-cobra-flux', 'events'),
);

// Freshness SLA. Tunable via env so gateway and brief stay aligned.
const FRESH_MS = Number(process.env.ORANGE5_SHADOW_FRESH_MS || 60 * 60 * 1000);    // 1h
const STALE_MS = Number(process.env.ORANGE5_SHADOW_STALE_MS || 2 * 60 * 60 * 1000); // 2h

const DEFAULT_LANES = ['reality', 'thought', 'receipts', 'conflicts'];

function recordTs(rec) {
  return Number(rec.ts ?? rec.t ?? rec.timestamp ?? rec.created_at_ms ?? 0);
}

async function loadState() {
  try {
    const raw = await readFile(SHADOW_STATE_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return { lanes: {}, last_run_ms: 0 };
  }
}

function isoDateRange(startMs, endMs) {
  // produce list of YYYY-MM-DD strings spanning the window, inclusive
  const out = [];
  const dayMs = 86400000;
  // align to UTC midnight
  let cur = new Date(startMs);
  cur.setUTCHours(0, 0, 0, 0);
  const endDay = new Date(endMs);
  endDay.setUTCHours(0, 0, 0, 0);
  while (cur.getTime() <= endDay.getTime()) {
    out.push(cur.toISOString().slice(0, 10));
    cur = new Date(cur.getTime() + dayMs);
  }
  return out;
}

async function listLaneFiles(lane, sourceDir) {
  const canonicalLane = join(sourceDir, lane);
  if (existsSync(canonicalLane)) {
    const all = await readdir(canonicalLane);
    return all
      .filter((file) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(file))
      .sort()
      .map((file) => join(canonicalLane, file));
  }
  if (!existsSync(SHADOW_CACHE_DIR)) return [];
  const all = await readdir(SHADOW_CACHE_DIR);
  return all
    .filter((file) => file.startsWith(`${lane}-`) && file.endsWith('.jsonl'))
    .sort()
    .map((file) => join(SHADOW_CACHE_DIR, file));
}

async function readJsonl(path) {
  const out = [];
  try {
    const raw = await readFile(path, 'utf8');
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t));
      } catch {
        // skip malformed; sync.mjs already logs these on write
      }
    }
  } catch {
    // missing file is fine
  }
  return out;
}

function classifyFreshness(ageMs) {
  if (ageMs == null || !Number.isFinite(ageMs)) return 'unknown';
  if (ageMs <= FRESH_MS) return 'fresh';
  if (ageMs <= STALE_MS) return 'aging';
  return 'stale';
}

/**
 * Read shadow cache records.
 *
 * @param {object} opts
 * @param {string[]} [opts.lanes]        Lanes to read. Default: canonical 4.
 * @param {number}   [opts.startMs]      Window start, inclusive. Default: now - 24h.
 * @param {number}   [opts.endMs]        Window end, inclusive. Default: now.
 * @param {number}   [opts.maxRecords]   Hard cap on records returned. Default: 5000.
 * @returns {Promise<object>}
 */
export async function readShadowCache(opts = {}) {
  const now = Date.now();
  const lanes = (opts.lanes && opts.lanes.length ? opts.lanes : DEFAULT_LANES).slice();
  const sourceDir = resolve(opts.sourceDir || CANONICAL_EVENTS_DIR);
  const endMs = Number.isFinite(opts.endMs) ? opts.endMs : now;
  const startMs = Number.isFinite(opts.startMs) ? opts.startMs : endMs - 24 * 60 * 60 * 1000;
  const maxRecords = Number.isFinite(opts.maxRecords) ? opts.maxRecords : 5000;

  const state = await loadState();
  const dateKeys = isoDateRange(startMs, endMs);

  const by_lane = {};
  const allRecords = [];
  const laneFreshness = {};

  for (const lane of lanes) {
    by_lane[lane] = [];
    const files = await listLaneFiles(lane, sourceDir);
    // restrict to relevant date span
    const relevant = files.filter((file) => {
      const name = basename(file);
      return dateKeys.some((date) => name === `${date}.jsonl` || name === `${lane}-${date}.jsonl`);
    });
    const fileStats = await Promise.all(relevant.map((file) => stat(file).catch(() => null)));
    const latestMtime = fileStats.reduce((latest, value) => Math.max(latest, Number(value?.mtimeMs || 0)), 0);

    for (const file of relevant) {
      const recs = await readJsonl(file);
      for (const r of recs) {
        const ts = recordTs(r);
        if (ts < startMs || ts > endMs) continue;
        const tagged = { ...r, lane, ts };
        by_lane[lane].push(tagged);
        allRecords.push(tagged);
      }
    }
    // newest-first within lane
    by_lane[lane].sort((a, b) => b.ts - a.ts);
    const evidenceMs = Math.max(latestMtime, Number(by_lane[lane][0]?.ts || 0));
    const age = evidenceMs ? now - evidenceMs : null;
    laneFreshness[lane] = {
      last_sync_at: evidenceMs ? new Date(evidenceMs).toISOString() : null,
      last_sync_ms: evidenceMs || null,
      ok: by_lane[lane].length > 0,
      age_ms: age,
      classification: classifyFreshness(age),
    };
  }

  // global newest-first
  allRecords.sort((a, b) => b.ts - a.ts);
  const records = allRecords.slice(0, maxRecords);
  const truncated = allRecords.length > records.length;

  const canonicalEvidenceMs = Math.max(0, ...Object.values(laneFreshness).map((value) => Number(value.last_sync_ms || 0)));
  const lastSyncMs = canonicalEvidenceMs || Number(state.last_run_ms || 0);
  const ageMs = lastSyncMs ? now - lastSyncMs : null;
  const freshness = {
    last_sync_ms: lastSyncMs || null,
    last_sync_at: state.last_run_at || null,
    age_ms: ageMs,
    fresh_threshold_ms: FRESH_MS,
    stale_threshold_ms: STALE_MS,
    classification: classifyFreshness(ageMs),
    stale: ageMs != null && ageMs > STALE_MS,
    by_lane: laneFreshness,
  };

  return {
    records,
    by_lane,
    freshness,
    truncated,
    source: canonicalEvidenceMs ? 'canonical-cobra-disk' : 'shadow-cache',
    source_dir: canonicalEvidenceMs ? sourceDir : SHADOW_CACHE_DIR,
  };
}

export const __test__ = { classifyFreshness, isoDateRange, recordTs };
