#!/usr/bin/env node
// sync.mjs — N150 shadow cache sync
// Pulls last-24h Flux events from each lane on the Codexa command rail
// and writes them to local JSONL files for offline StateBrief fallback.
//
// Runtime: Bun or Node 20+. No third-party deps.
//
// Env:
//   ORANGEBOX_RAIL_TOKEN   required — bearer token for 10.0.99.1:8097
//   ORANGEBOX_RAIL_HOST    optional — defaults to 10.0.99.1
//   ORANGEBOX_RAIL_PORT    optional — defaults to 8097
//   ORANGE5_LANES          optional CSV — defaults to canonical 4-lane set
//   ORANGE5_CACHE_DIR      optional — defaults to dir of this file
//   ORANGE5_SYNC_TIMEOUT_MS optional — defaults to 15000
//
// Exit codes:
//   0  success (all lanes synced)
//   1  config error (missing token)
//   2  network error (rail unreachable for ALL lanes)
//   3  partial success (some lanes failed) — state file still updated for the lanes that succeeded
//
// Mirage doctrine: this is mirage/memory shadow material. Read-write per
// Sovereign. Reality (Codexa) overrides Thought (this cache) on conflict.

import { mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---- config -----------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CACHE_DIR = resolve(process.env.ORANGE5_CACHE_DIR || __dirname);
const STATE_FILE = join(CACHE_DIR, '.sync-state.json');

const RAIL_HOST = process.env.ORANGEBOX_RAIL_HOST || '10.0.0.4';
const RAIL_PORT = Number(process.env.ORANGEBOX_RAIL_PORT || 8097);
const RAIL_TOKEN = process.env.ORANGEBOX_RAIL_TOKEN || '';
const RAIL_BASE = `http://${RAIL_HOST}:${RAIL_PORT}`;
const TIMEOUT_MS = Number(process.env.ORANGE5_SYNC_TIMEOUT_MS || 15000);

// Canonical Flux lanes. Override via ORANGE5_LANES env if needed.
const DEFAULT_LANES = ['reality', 'thought', 'receipts', 'conflicts'];
const LANES = (process.env.ORANGE5_LANES || DEFAULT_LANES.join(','))
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const WINDOW_MS = 24 * 60 * 60 * 1000;

// ---- helpers ----------------------------------------------------------------

function isoDate(ts = Date.now()) {
  return new Date(ts).toISOString().slice(0, 10); // YYYY-MM-DD
}

function log(msg, extra) {
  const line = { t: new Date().toISOString(), msg, ...(extra || {}) };
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(line));
}

async function readJson(path, fallback) {
  try {
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(path, data) {
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  // rename is atomic on same filesystem
  const { rename } = await import('node:fs/promises');
  await rename(tmp, path);
}

async function fetchWithTimeout(url, opts = {}, timeoutMs = TIMEOUT_MS) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(id);
  }
}

// ---- rail client ------------------------------------------------------------

/**
 * Fetch Flux events for a lane within [sinceMs, untilMs).
 * Rail contract: GET /flux/events?lane=<lane>&since=<isoOrMs>&until=<isoOrMs>
 * Returns NDJSON or JSON array. We accept both.
 */
async function fetchLane(lane, sinceMs, untilMs) {
  const url =
    `${RAIL_BASE}/flux/events` +
    `?lane=${encodeURIComponent(lane)}` +
    `&since=${sinceMs}` +
    `&until=${untilMs}`;

  const res = await fetchWithTimeout(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${RAIL_TOKEN}`,
      'X-Orangebox-Token': RAIL_TOKEN,
      Accept: 'application/x-ndjson, application/json',
      'User-Agent': 'orange5-n150-shadow-sync/1.0',
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`rail ${res.status} ${res.statusText} :: ${body.slice(0, 200)}`);
  }

  const ct = (res.headers.get('content-type') || '').toLowerCase();
  const text = await res.text();

  let records = [];
  if (ct.includes('ndjson') || ct.includes('jsonl') || text.includes('\n{')) {
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        records.push(JSON.parse(trimmed));
      } catch (e) {
        log('parse_skip', { lane, err: String(e), line: trimmed.slice(0, 120) });
      }
    }
  } else if (ct.includes('json')) {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) records = parsed;
    else if (Array.isArray(parsed.events)) records = parsed.events;
    else if (Array.isArray(parsed.records)) records = parsed.records;
    else throw new Error(`unexpected JSON shape from rail for ${lane}`);
  } else {
    throw new Error(`unexpected content-type from rail: ${ct}`);
  }

  return records;
}

// ---- writer -----------------------------------------------------------------

function recordTs(rec) {
  // Tolerate a handful of common field names. Otherwise stamp now.
  return Number(rec.ts ?? rec.t ?? rec.timestamp ?? rec.created_at_ms ?? Date.now());
}

async function writeLaneRecords(lane, records) {
  // Group by UTC date so each file stays manageable and aligns with cron rotation.
  const byDate = new Map();
  for (const r of records) {
    const d = isoDate(recordTs(r));
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d).push(r);
  }

  const filesWritten = [];
  for (const [d, recs] of byDate) {
    const path = join(CACHE_DIR, `${lane}-${d}.jsonl`);
    const lines = recs.map((r) => JSON.stringify(r)).join('\n') + (recs.length ? '\n' : '');
    // Overwrite: the rail is source of truth for the 24h window. Idempotent.
    await writeFile(path, lines, 'utf8');
    filesWritten.push({ path, count: recs.length });
  }
  return filesWritten;
}

// ---- main -------------------------------------------------------------------

async function main() {
  if (!RAIL_TOKEN) {
    log('config_error', { reason: 'ORANGEBOX_RAIL_TOKEN not set' });
    process.exit(1);
  }

  if (!existsSync(CACHE_DIR)) {
    await mkdir(CACHE_DIR, { recursive: true });
  }

  const prevState = await readJson(STATE_FILE, { lanes: {}, version: 1 });

  const now = Date.now();
  const since = now - WINDOW_MS;

  const results = [];
  let anySuccess = false;
  let anyFailure = false;

  for (const lane of LANES) {
    const t0 = Date.now();
    try {
      const records = await fetchLane(lane, since, now);
      const files = await writeLaneRecords(lane, records);
      const elapsed = Date.now() - t0;
      results.push({ lane, ok: true, count: records.length, files, elapsed_ms: elapsed });
      prevState.lanes[lane] = {
        last_sync_at: new Date(now).toISOString(),
        last_sync_ms: now,
        count: records.length,
        ok: true,
      };
      anySuccess = true;
      log('lane_ok', { lane, count: records.length, elapsed_ms: elapsed });
    } catch (e) {
      anyFailure = true;
      const elapsed = Date.now() - t0;
      results.push({ lane, ok: false, err: String(e), elapsed_ms: elapsed });
      // keep the previous successful sync stamp; record the failure attempt
      const prior = prevState.lanes[lane] || {};
      prevState.lanes[lane] = {
        ...prior,
        last_attempt_at: new Date(now).toISOString(),
        last_attempt_ms: now,
        last_error: String(e),
        ok: false,
      };
      log('lane_fail', { lane, err: String(e), elapsed_ms: elapsed });
    }
  }

  prevState.last_run_at = new Date(now).toISOString();
  prevState.last_run_ms = now;
  prevState.window_ms = WINDOW_MS;
  prevState.rail = { host: RAIL_HOST, port: RAIL_PORT };

  await writeJsonAtomic(STATE_FILE, prevState);

  const summary = {
    ok_lanes: results.filter((r) => r.ok).length,
    fail_lanes: results.filter((r) => !r.ok).length,
    total_records: results.reduce((a, r) => a + (r.count || 0), 0),
  };
  log('sync_complete', summary);

  if (!anySuccess) process.exit(2);
  if (anyFailure) process.exit(3);
  process.exit(0);
}

main().catch((e) => {
  log('fatal', { err: String(e), stack: e?.stack });
  process.exit(2);
});
