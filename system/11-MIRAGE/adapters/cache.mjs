// 11-MIRAGE/adapters/cache.mjs — READY (Wave-2, memory-family).
//
// N150 cockpit shadow cache — read-through proxy to the canonical shadow store
// at 06-ORANGELLM/memory/cache/ (shadow-reader.mjs + shadow-state-brief.mjs).
//
// Doctrine:
//   - Cache is DOWNSTREAM-ONLY. The shadow store is populated by the upstream
//     sync.mjs job pulling from Æ Cobra. Mirage does not mutate it. write()
//     refuses honestly with reason='cache_is_downstream_only' so callers
//     wire to flux (the producer) instead.
//   - read() supports two ops:
//       { op:'readShadowCache', lanes?, startMs?, endMs?, maxRecords? }
//          -> raw newest-first records grouped by lane (see shadow-reader.mjs)
//       { op:'stateBrief', query?, windowMs?, limits? }
//          -> computed StateBrief (same shape as live Cobra /state-brief,
//             with shadow:true and freshness fields)
//     Default op when none specified: 'stateBrief'.
//   - All output is mirage/memory shadow. The brief is already tagged
//     shadow=true by shadow-state-brief.mjs; raw records carry source='shadow-cache'.
//   - healthz reports freshness classification (fresh|aging|stale|unknown)
//     using the shadow-reader's own SLA thresholds. Never throws: returns
//     an honest stub when the cache dir is missing.
//
// Spec: 11-MIRAGE/SPEC.md#cache
//
// Reality always overrides Thought on conflict. Receipts override recollection.
// Shadow is thought-plane material; callers MUST treat shadow=true accordingly.

import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  readShadowCache,
  SHADOW_CACHE_DIR,
  SHADOW_STATE_FILE,
} from '../../06-ORANGELLM/memory/cache/shadow-reader.mjs';
import { computeStateBrief } from '../../06-ORANGELLM/memory/cache/shadow-state-brief.mjs';

const SPEC = '11-MIRAGE/SPEC.md#cache';

const READ_OPS = Object.freeze(['stateBrief', 'readShadowCache']);

// ──────────────────────────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────────────────────────

/**
 * read(params)
 *   { op: 'stateBrief', query?, windowMs?, limits? }
 *     -> { ok, source:'shadow-cache', shadow:true, brief }
 *   { op: 'readShadowCache', lanes?, startMs?, endMs?, maxRecords? }
 *     -> { ok, source:'shadow-cache', shadow:true, records, by_lane, freshness, truncated }
 * Default op: 'stateBrief'.
 */
async function read(params = {}) {
  const op = String(params.op || 'stateBrief');
  if (!READ_OPS.includes(op)) {
    return {
      ok: false,
      reason: 'unknown_read_op',
      detail: `op must be one of: ${READ_OPS.join(', ')}`,
      op,
      spec: SPEC,
    };
  }

  if (!existsSync(SHADOW_CACHE_DIR)) {
    return {
      ok: false,
      reason: 'shadow_cache_dir_missing',
      detail: `not found: ${SHADOW_CACHE_DIR}`,
      spec: SPEC,
    };
  }

  try {
    if (op === 'stateBrief') {
      const brief = await computeStateBrief({
        query: params.query,
        windowMs: params.windowMs,
        limits: params.limits,
      });
      return {
        ok: true,
        op,
        source: 'shadow-cache',
        shadow: true,
        brief,
      };
    }

    // op === 'readShadowCache'
    const cache = await readShadowCache({
      lanes: params.lanes,
      startMs: params.startMs,
      endMs: params.endMs,
      maxRecords: params.maxRecords,
    });
    return {
      ok: true,
      op,
      source: 'shadow-cache',
      shadow: true,
      records: cache.records,
      by_lane: cache.by_lane,
      freshness: cache.freshness,
      truncated: cache.truncated,
    };
  } catch (err) {
    return {
      ok: false,
      reason: 'cache_read_failed',
      detail: String(err?.message || err),
      spec: SPEC,
    };
  }
}

/**
 * write(_params)
 *   Always refuses. The shadow cache is populated upstream by
 *   06-ORANGELLM/memory/cache/sync.mjs pulling from Æ Cobra. Writes through
 *   Mirage would create silent reality/thought drift — exactly the failure
 *   mode the dual-lane doctrine forbids. Callers that want to record state
 *   must use the flux adapter (writes go to the Cobra event log, then sync
 *   propagates to the shadow cache on the next pull).
 */
async function write(_params = {}) {
  return {
    ok: false,
    reason: 'cache_is_downstream_only',
    detail:
      'shadow cache is read-only from Mirage. To record events, write via the flux adapter; ' +
      'sync.mjs will propagate to the shadow cache on its next run.',
    redirect: 'mirage/memory/flux',
    spec: SPEC,
  };
}

/**
 * healthz()
 *   Reports freshness classification of the shadow cache. Never throws.
 *   - ok:true  when the cache dir exists AND freshness is fresh|aging
 *   - ok:false when the cache dir is missing, the sync state is unknown,
 *              or freshness is stale (> stale_threshold_ms behind Cobra)
 */
async function healthz() {
  if (!existsSync(SHADOW_CACHE_DIR)) {
    return {
      ok: false,
      status: 'shadow_cache_dir_missing',
      detail: `not found: ${SHADOW_CACHE_DIR}`,
      spec: SPEC,
    };
  }

  try {
    // Probe via readShadowCache with a tiny window — cheap, surfaces freshness.
    const probe = await readShadowCache({
      lanes: ['reality', 'thought', 'receipts', 'conflicts'],
      startMs: Date.now() - 60_000,
      endMs: Date.now(),
      maxRecords: 1,
    });

    const fresh = probe.freshness || {};
    const stateFileExists = existsSync(SHADOW_STATE_FILE);

    if (!stateFileExists || fresh.last_sync_ms == null) {
      return {
        ok: false,
        status: 'no_sync_state',
        detail: 'shadow cache dir present but .sync-state.json missing or empty — sync.mjs has not run',
        source: 'shadow-cache',
        spec: SPEC,
      };
    }

    const classification = fresh.classification || 'unknown';
    const stale = fresh.stale === true || classification === 'stale';

    return {
      ok: !stale && classification !== 'unknown',
      status: stale ? 'stale' : classification,
      source: 'shadow-cache',
      last_sync_at: fresh.last_sync_at,
      last_sync_ms: fresh.last_sync_ms,
      age_ms: fresh.age_ms,
      fresh_threshold_ms: fresh.fresh_threshold_ms,
      stale_threshold_ms: fresh.stale_threshold_ms,
      per_lane: fresh.by_lane,
      detail: stale
        ? 'shadow cache is older than stale threshold; sync.mjs may be stuck'
        : null,
      spec: SPEC,
    };
  } catch (err) {
    return {
      ok: false,
      status: 'probe_failed',
      detail: String(err?.message || err),
      spec: SPEC,
    };
  }
}

// Exposed for tests — not part of the adapter contract.
export const __internals = Object.freeze({
  SHADOW_CACHE_DIR,
  SHADOW_STATE_FILE,
  READ_OPS,
});

export const cacheAdapter = Object.freeze({ read, write, healthz });
export default cacheAdapter;
