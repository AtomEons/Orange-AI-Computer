#!/usr/bin/env node
// query.mjs — Knowledge Strata: read-only query API over index.db.
// Path:    04-CONTROL-PLANE/knowledge-strata/query.mjs
// Runtime: Node >= 20.
//
// AtomEons canon: intake -> canon -> durable artifact -> integrity pass -> reuse.
//
// This is the reuse-facing surface of the SQLite index. It does NOT mutate
// the DB — receipts that need to cite Strata artifacts go through here.
//
// Programmatic
// ------------
//   import * as Q from './query.mjs';
//   Q.byId('intake_sample_1afd99')               // latest version of that id
//   Q.byId('intake_sample_1afd99', { version:1 })
//   Q.byTopic('pathwaves')                       // all versions, desc
//   Q.latestPerTopic('pathwaves')                // single row
//   Q.bySha256('dd56...')                        // exact match
//   Q.recent({ limit: 20 })                      // by emitted_at desc
//   Q.range({ since, until, topic, department })
//   Q.chain('pathwaves')                         // prior_version chain walk
//   Q.stats()
//
// All read functions accept an optional final arg `{ db }` so callers can
// share a connection (e.g. inside reuse.mjs). When omitted, a connection
// is opened, used, and closed per call.
//
// CLI
// ---
//   node query.mjs id <artifact_id> [--version N] [--json]
//   node query.mjs topic <topic> [--latest] [--json]
//   node query.mjs sha <sha256> [--json]
//   node query.mjs recent [--limit N] [--json]
//   node query.mjs range --since ISO --until ISO [--topic X] [--department X] [--json]
//   node query.mjs chain <topic> [--json]
//   node query.mjs stats [--json]
//
// Output without --json is human-grep-friendly: one row per line, tab-sep.

import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

export const dbPath = resolve(__dirname, 'index.db');

function open(opts = {}) {
  if (opts.db) return { db: opts.db, owned: false };
  if (!existsSync(dbPath)) {
    throw new Error(`index.db missing: ${dbPath} — run \`node index.db.mjs --ingest\` first`);
  }
  const db = new Database(dbPath, { readonly: true });
  db.pragma('query_only = ON');
  return { db, owned: true };
}

function close(ctx) { if (ctx.owned) ctx.db.close(); }

function rowify(r) {
  if (!r) return null;
  return {
    ...r,
    tags: r.tags_json ? JSON.parse(r.tags_json) : [],
    force_break: !!r.force_break,
  };
}

// ---------------------------------------------------------------------------
// Single-record lookups

export function byId(artifact_id, opts = {}) {
  const ctx = open(opts);
  try {
    if (opts.version != null) {
      const r = ctx.db.prepare(
        'SELECT * FROM artifacts WHERE artifact_id = ? AND version = ?',
      ).get(artifact_id, opts.version);
      return rowify(r);
    }
    const r = ctx.db.prepare(`
      SELECT * FROM artifacts
       WHERE artifact_id = ?
       ORDER BY version DESC
       LIMIT 1
    `).get(artifact_id);
    return rowify(r);
  } finally { close(ctx); }
}

export function bySha256(sha256, opts = {}) {
  const ctx = open(opts);
  try {
    const rs = ctx.db.prepare('SELECT * FROM artifacts WHERE sha256 = ?').all(sha256);
    return rs.map(rowify);
  } finally { close(ctx); }
}

// ---------------------------------------------------------------------------
// Topic-shaped queries

export function byTopic(topic, opts = {}) {
  const ctx = open(opts);
  try {
    const rs = ctx.db.prepare(`
      SELECT * FROM artifacts WHERE topic = ? ORDER BY version DESC
    `).all(topic);
    return rs.map(rowify);
  } finally { close(ctx); }
}

export function latestPerTopic(topic, opts = {}) {
  const ctx = open(opts);
  try {
    if (topic) {
      const r = ctx.db.prepare('SELECT * FROM v_latest_per_topic WHERE topic = ?').get(topic);
      return rowify(r);
    }
    const rs = ctx.db.prepare('SELECT * FROM v_latest_per_topic ORDER BY topic').all();
    return rs.map(rowify);
  } finally { close(ctx); }
}

/**
 * Walk a topic's prior_version chain from latest back to v1.
 * Returns an array ordered newest -> oldest.
 */
export function chain(topic, opts = {}) {
  const ctx = open(opts);
  try {
    const rs = ctx.db.prepare(`
      SELECT * FROM artifacts WHERE topic = ? ORDER BY version DESC
    `).all(topic);
    // Validate prior_version monotonicity along the way.
    const out = [];
    let expected = null;
    for (const r of rs) {
      out.push(rowify(r));
      if (expected != null && r.version !== expected) {
        out[out.length - 1].chain_gap = true;
      }
      expected = r.version - 1;
    }
    return out;
  } finally { close(ctx); }
}

// ---------------------------------------------------------------------------
// Range / recency

export function recent({ limit = 20, ...opts } = {}) {
  const ctx = open(opts);
  try {
    const rs = ctx.db.prepare(`
      SELECT * FROM artifacts
       WHERE source = 'archive'
       ORDER BY emitted_at DESC
       LIMIT ?
    `).all(limit);
    return rs.map(rowify);
  } finally { close(ctx); }
}

export function range({ since, until, topic, department, ...opts } = {}) {
  const ctx = open(opts);
  try {
    const where = ['1=1'];
    const params = [];
    if (since)      { where.push('emitted_at >= ?'); params.push(since); }
    if (until)      { where.push('emitted_at <= ?'); params.push(until); }
    if (topic)      { where.push('topic = ?');       params.push(topic); }
    if (department) { where.push('department = ?');  params.push(department); }
    const sql = `SELECT * FROM artifacts WHERE ${where.join(' AND ')} ORDER BY emitted_at DESC`;
    const rs = ctx.db.prepare(sql).all(...params);
    return rs.map(rowify);
  } finally { close(ctx); }
}

// ---------------------------------------------------------------------------
// Stats

export function stats(opts = {}) {
  const ctx = open(opts);
  try {
    const n         = ctx.db.prepare('SELECT COUNT(*) AS n FROM artifacts').get().n;
    const archived  = ctx.db.prepare("SELECT COUNT(*) AS n FROM artifacts WHERE source='archive'").get().n;
    const working   = ctx.db.prepare("SELECT COUNT(*) AS n FROM artifacts WHERE source='working'").get().n;
    const topics    = ctx.db.prepare('SELECT COUNT(DISTINCT topic) AS n FROM artifacts').get().n;
    const ids       = ctx.db.prepare('SELECT COUNT(DISTINCT artifact_id) AS n FROM artifacts').get().n;
    const lastRun   = ctx.db.prepare('SELECT * FROM ingest_runs ORDER BY finished_at DESC LIMIT 1').get();
    return { rows: n, archived, working, topics, artifact_ids: ids, last_run: lastRun ?? null };
  } finally { close(ctx); }
}

// ---------------------------------------------------------------------------
// CLI

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { args[key] = next; i++; }
      else args[key] = true;
    } else args._.push(a);
  }
  return args;
}

function emit(rows, asJson) {
  if (asJson) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  if (rows == null) { console.log('(no result)'); return; }
  const list = Array.isArray(rows) ? rows : [rows];
  for (const r of list) {
    if (!r) continue;
    console.log([
      r.emitted_at ?? '',
      r.topic ?? '',
      'v' + (r.version ?? ''),
      r.artifact_id ?? '',
      r.sha256 ?? '',
      r.archive_path ?? '',
    ].join('\t'));
  }
}

function main() {
  const args = parseArgs(process.argv);
  const cmd = args._[0];
  const asJson = !!args.json;
  switch (cmd) {
    case 'id': {
      const id = args._[1];
      if (!id) { console.error('usage: query.mjs id <artifact_id> [--version N]'); process.exit(2); }
      const v = args.version != null ? Number(args.version) : null;
      emit(byId(id, v != null ? { version: v } : {}), asJson);
      return;
    }
    case 'topic': {
      const t = args._[1];
      if (!t) { console.error('usage: query.mjs topic <topic> [--latest]'); process.exit(2); }
      emit(args.latest ? latestPerTopic(t) : byTopic(t), asJson);
      return;
    }
    case 'sha':   emit(bySha256(args._[1]), asJson); return;
    case 'recent': emit(recent({ limit: Number(args.limit ?? 20) }), asJson); return;
    case 'range': emit(range({
      since: args.since, until: args.until,
      topic: args.topic, department: args.department,
    }), asJson); return;
    case 'chain': emit(chain(args._[1]), asJson); return;
    case 'stats': console.log(JSON.stringify(stats(), null, 2)); return;
    default:
      console.error(
        'usage:\n' +
        '  query.mjs id <artifact_id> [--version N]\n' +
        '  query.mjs topic <topic> [--latest]\n' +
        '  query.mjs sha <sha256>\n' +
        '  query.mjs recent [--limit N]\n' +
        '  query.mjs range --since ISO --until ISO [--topic X] [--department X]\n' +
        '  query.mjs chain <topic>\n' +
        '  query.mjs stats\n' +
        '\nAll commands accept --json for machine output.',
      );
      process.exit(2);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
