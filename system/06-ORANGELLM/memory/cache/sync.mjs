#!/usr/bin/env bun
// Compatibility snapshot for degraded memory fallback. The canonical Cobra
// ledger already lives on N150 disk, so this never calls a network rail.

import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import { join, resolve } from 'node:path';

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : null;
}

const USER_DATA_ROOT = join(process.env.USERPROFILE || os.homedir(), 'OrangeBox-Data', 'orange5');
const SNAPSHOT_DIR = resolve(argValue('--cache-dir') || process.env.ORANGE5_CACHE_DIR || join(USER_DATA_ROOT, 'memory-shadow'));
const STATE_FILE = join(SNAPSHOT_DIR, '.sync-state.json');
const LOG_FILE = join(SNAPSHOT_DIR, 'sync.log');
const SOURCE_ROOT = resolve(
  argValue('--source-root')
  || process.env.ORANGE5_COBRA_FLUX_ROOT
  || join(process.env.USERPROFILE || os.homedir(), 'OrangeBox-Data', 'orange5', 'ae-cobra-flux', 'events'),
);
const LANES = (process.env.ORANGE5_LANES || 'reality,thought').split(',').map((value) => value.trim()).filter(Boolean);
const WINDOW_MS = Math.max(60_000, Number(process.env.ORANGE5_SYNC_WINDOW_MS || 24 * 60 * 60 * 1_000));

function log(message, extra = {}) {
  const line = JSON.stringify({ at: new Date().toISOString(), message, ...extra });
  console.log(line);
  try {
    mkdirSync(SNAPSHOT_DIR, { recursive: true });
    appendFileSync(LOG_FILE, `${line}\n`, 'utf8');
  } catch {
    // Logging must not change snapshot truth or exit status.
  }
}

function timestamp(record) {
  const value = record?.ts ?? record?.t ?? record?.timestamp ?? record?.created_at_ms ?? record?.createdAt;
  const number = Number(value);
  if (Number.isFinite(number) && number > 0) return number;
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function day(value) {
  return new Date(value).toISOString().slice(0, 10);
}

async function writeJsonAtomic(filePath, value) {
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporary, filePath);
}

async function readLane(lane, since) {
  const laneRoot = join(SOURCE_ROOT, lane);
  if (!existsSync(laneRoot)) throw new Error(`canonical Cobra lane is missing: ${laneRoot}`);
  const earliestDay = day(since);
  const names = (await readdir(laneRoot))
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name) && name.slice(0, 10) >= earliestDay)
    .sort();
  const records = [];
  for (const name of names) {
    const text = await readFile(join(laneRoot, name), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        if (timestamp(record) >= since) records.push(record);
      } catch (error) {
        log('parse_skip', { lane, source: name, error: error.message });
      }
    }
  }
  return records;
}

async function writeLane(lane, records) {
  const grouped = new Map();
  for (const record of records) {
    const key = day(timestamp(record) || Date.now());
    const values = grouped.get(key) || [];
    values.push(record);
    grouped.set(key, values);
  }
  const files = [];
  for (const [date, values] of grouped) {
    const filePath = join(SNAPSHOT_DIR, `${lane}-${date}.jsonl`);
    await writeFile(filePath, `${values.map(JSON.stringify).join('\n')}\n`, 'utf8');
    files.push({ path: filePath, count: values.length });
  }
  return files;
}

async function main() {
  await mkdir(SNAPSHOT_DIR, { recursive: true });
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const since = now - WINDOW_MS;
  let previous = {};
  try {
    previous = JSON.parse(await readFile(STATE_FILE, 'utf8'));
  } catch {
    previous = {};
  }
  const results = [];
  for (const lane of LANES) {
    const started = Date.now();
    try {
      const records = await readLane(lane, since);
      const files = await writeLane(lane, records);
      results.push({ lane, ok: true, records: records.length, files, durationMs: Date.now() - started });
    } catch (error) {
      results.push({ lane, ok: false, error: error.message, durationMs: Date.now() - started });
    }
  }
  const successful = results.filter((row) => row.ok);
  const lanes = { ...(previous.lanes || {}) };
  for (const result of results) {
    const prior = lanes[result.lane] || {};
    lanes[result.lane] = result.ok
      ? { ok: true, last_sync_ms: now, last_sync_at: nowIso, records: result.records, files: result.files }
      : { ...prior, ok: false, last_error_at: nowIso, error: result.error };
  }
  const state = {
    schema: 'orange.memory-disk-snapshot.v1',
    status: results.every((row) => row.ok) ? 'VERIFIED' : (results.some((row) => row.ok) ? 'PARTIAL' : 'FAILED'),
    generatedAt: nowIso,
    last_run_ms: successful.length ? now : Number(previous.last_run_ms || 0),
    last_run_at: successful.length ? nowIso : (previous.last_run_at || null),
    lanes,
    windowMs: WINDOW_MS,
    source: { type: 'canonical-cobra-flux', transport: 'local-disk', root: SOURCE_ROOT },
    results,
  };
  await writeJsonAtomic(STATE_FILE, state);
  log('snapshot_complete', { status: state.status, lanes: results.length, records: results.reduce((sum, row) => sum + Number(row.records || 0), 0) });
  process.exit(state.status === 'VERIFIED' ? 0 : state.status === 'PARTIAL' ? 3 : 2);
}

main().catch((error) => {
  log('fatal', { error: error.message });
  process.exit(2);
});
