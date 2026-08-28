// 11-MIRAGE/adapters/flux.mjs — READY (Night-1).
//
// Proxies to the Æ Cobra daemon (Bun, loopback-bound) for Flux ledger I/O + StateBrief.
// Primary  : http://127.0.0.1:7419     (Codexa-host loopback)
// Fallback : http://10.0.99.1:8097/api/ae-cobra   (Codexa command rail, token-gated)
// Last-ditch read: N150 shadow cache at 06-ORANGELLM/memory/cache/ (read-only, stale ok)
//
// Reality always overrides Thought on conflict. Receipts override recollection.
//
// Spec: 11-MIRAGE/SPEC.md#flux
//       06-ORANGELLM/PR-02-SPEC.md (frontier-isolation: never expose :7419 to non-loopback)

import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(process.env.ORANGE5_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'));

const SPEC          = '11-MIRAGE/SPEC.md#flux';
const COBRA_BASE    = process.env.AE_COBRA_BASE   || 'http://127.0.0.1:7419';
const CODEXA_BASE   = process.env.CODEXA_RAIL_BASE || 'http://10.0.99.1:8097';
const CODEXA_TOKEN  = process.env.CODEXA_RAIL_TOKEN || '';
const SHADOW_CACHE  = process.env.AE_FLUX_SHADOW_CACHE
  || resolve(ROOT, '06-ORANGELLM', 'memory', 'cache');
const FETCH_TIMEOUT_MS = parseInt(process.env.MIRAGE_FETCH_TIMEOUT_MS || '2500', 10);

/**
 * Fetch with timeout. Returns { ok, status, body? , err? }.
 */
async function tryFetch(url, init = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const txt = await res.text();
    let body;
    try { body = JSON.parse(txt); } catch { body = txt; }
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    return { ok: false, status: 0, err: String(err?.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Call POST /state-brief on the daemon with primary→rail fallback.
 */
async function callStateBrief(payload) {
  // 1. Primary loopback
  const r1 = await tryFetch(`${COBRA_BASE}/state-brief`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (r1.ok) return { source: 'cobra_loopback', data: r1.body };

  // 2. Codexa command rail (token-gated)
  if (CODEXA_TOKEN) {
    const r2 = await tryFetch(`${CODEXA_BASE}/api/ae-cobra/state-brief`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${CODEXA_TOKEN}`,
      },
      body: JSON.stringify(payload),
    });
    if (r2.ok) return { source: 'codexa_rail', data: r2.body };
  }

  // 3. N150 shadow cache — last-good StateBrief on disk, read-only
  const shadow = await readShadowStateBrief();
  if (shadow) return { source: 'n150_shadow_cache', data: shadow, stale: true };

  return { source: null, data: null, err: r1.err || `cobra ${r1.status}` };
}

async function readShadowStateBrief() {
  try {
    const p = join(SHADOW_CACHE, 'state-brief.last.json');
    if (!existsSync(p)) return null;
    const raw = await readFile(p, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * read({ query, time_range_ms?, max_records?, include_conflicts? })
 *   -> StateBrief JSON (orange5.state-brief.v0) or {ok:false}
 */
async function read(params = {}) {
  const payload = {
    query: String(params.query || ''),
    time_range_ms: params.time_range_ms ?? 86_400_000 * 7,
    max_records: params.max_records ?? 50,
    include_conflicts: params.include_conflicts !== false,
  };
  const out = await callStateBrief(payload);
  if (!out.data) {
    return { ok: false, reason: 'cobra_unreachable_and_shadow_empty', detail: out.err, spec: SPEC };
  }
  return {
    ok: true,
    source: out.source,
    stale: !!out.stale,
    data: out.data,
  };
}

/**
 * write({ lane, origin, event_type, body })
 *   -> POSTs to /event on the daemon. Caller is responsible for lane discipline:
 *      reality lane requires terminal/receipt origin; thought lane is model output.
 *      Daemon classifies origin → lane (V1 mitigation: origin-based, NOT string-match).
 */
async function write(params = {}) {
  if (!params.event_type) {
    return { ok: false, reason: 'event_type_required', spec: SPEC };
  }
  const evt = {
    origin: params.origin || 'mirage',
    event_type: params.event_type,
    ...(params.body || {}),
  };
  const r1 = await tryFetch(`${COBRA_BASE}/event`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(evt),
  });
  if (r1.ok) return { ok: true, source: 'cobra_loopback', receipt: r1.body };

  if (CODEXA_TOKEN) {
    const r2 = await tryFetch(`${CODEXA_BASE}/api/ae-cobra/event`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${CODEXA_TOKEN}`,
      },
      body: JSON.stringify(evt),
    });
    if (r2.ok) return { ok: true, source: 'codexa_rail', receipt: r2.body };
  }

  return { ok: false, reason: 'cobra_unreachable', detail: r1.err || `cobra ${r1.status}`, spec: SPEC };
}

async function healthz() {
  const r1 = await tryFetch(`${COBRA_BASE}/healthz`, { method: 'GET' });
  if (r1.ok) {
    return { ok: true, status: 'ready', source: 'cobra_loopback', cobra: r1.body, spec: SPEC };
  }
  if (CODEXA_TOKEN) {
    const r2 = await tryFetch(`${CODEXA_BASE}/api/ae-cobra/healthz`, {
      method: 'GET',
      headers: { 'authorization': `Bearer ${CODEXA_TOKEN}` },
    });
    if (r2.ok) {
      return { ok: true, status: 'ready', source: 'codexa_rail', cobra: r2.body, spec: SPEC };
    }
  }
  const shadow = await readShadowStateBrief();
  if (shadow) {
    return { ok: true, status: 'degraded_shadow_only', source: 'n150_shadow_cache', detail: 'cobra unreachable, shadow cache available', spec: SPEC };
  }
  return { ok: false, status: 'unreachable', detail: r1.err || `cobra ${r1.status}`, spec: SPEC };
}

export const fluxAdapter = Object.freeze({ read, write, healthz });
export default fluxAdapter;
