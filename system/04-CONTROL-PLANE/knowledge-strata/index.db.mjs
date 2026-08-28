#!/usr/bin/env node
// index.db.mjs — Knowledge Strata: SQLite projection over the durable archive.
// Path:    04-CONTROL-PLANE/knowledge-strata/index.db.mjs
// Runtime: Node >= 20 (uses createRequire for the better-sqlite3 native module).
//
// AtomEons canon: intake -> canon -> durable artifact -> integrity pass -> reuse.
//
// What this is
// ------------
// A queryable index over every emitted Strata artifact. Source of truth is
// still on disk under 19-ARCHIVE/strata/<topic>/v<NN>/. This module rebuilds
// `index.db` from the archive INDEX.jsonl (primary) and optionally augments
// it with rows from the working canon dir (secondary, marked source='working').
//
// Why SQLite, not the existing JSONL
// ----------------------------------
// JSONL is append-only and fine for receipts, but receipt-grade queries
// (latest per topic, prior_version chain, sha lookup, range scans) collapse
// to one SQL each. SQLite is local, embedded, file-backed, atomic — fits the
// AtomEons "no cloud surface for canon" rule.
//
// Schema
// ------
// See index.schema.sql. The required columns from the build order
// (artifact_id, topic, version, prior_version, sha256, emitted_at,
//  archive_path) are all NOT NULL; the rest are fidelity columns.
//
// Ingest
// ------
//   1. Open / create index.db (WAL mode).
//   2. Apply schema from index.schema.sql.
//   3. Stream 19-ARCHIVE/strata/INDEX.jsonl line by line.
//   4. For each row, derive prior_version from same-topic predecessors
//      (already in the DB or earlier in this stream).
//   5. INSERT OR REPLACE keyed on (artifact_id, version). Idempotent.
//   6. Optionally re-hash archive_path's markdown and verify against
//      markdown_sha256. --verify enables this; mismatches go in errors_json.
//   7. (--include-working) walk knowledge-strata/canon/<dept>/*.canon.json
//      and add any working rows not already covered by archive.
//   8. Append ingest_runs receipt row.
//
// CLI
// ---
//   node index.db.mjs --ingest                rebuild / refresh index.db
//   node index.db.mjs --ingest --verify       re-hash every md file
//   node index.db.mjs --ingest --include-working
//   node index.db.mjs --stats                 row counts, latest topic, last run
//   node index.db.mjs --schema                print effective schema (debug)
//
// Programmatic export
// -------------------
//   import { openDb, ingest, IngestResult, schemaPath, dbPath } from './index.db.mjs'
//
// See query.mjs for the read-side API.

import { createRequire } from 'node:module';
import { readFileSync, existsSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { createHash, randomUUID } from 'node:crypto';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

// better-sqlite3 lives in Orange5/node_modules (control-plane has no own
// package.json today). Resolve absolutely so module location does not bite.
const Database = require('better-sqlite3');

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

// ---------------------------------------------------------------------------
// Paths

export const HERE        = __dirname;
export const dbPath      = resolve(HERE, 'index.db');
export const schemaPath  = resolve(HERE, 'index.schema.sql');
export const archiveRoot = resolve(HERE, '..', '..', '19-ARCHIVE', 'strata');
export const archiveIndex = resolve(archiveRoot, 'INDEX.jsonl');
export const canonRoot   = resolve(HERE, 'canon');

// ---------------------------------------------------------------------------
// DB open + schema

export function openDb(path = dbPath) {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  if (!existsSync(schemaPath)) {
    throw new Error(`schema missing: ${schemaPath}`);
  }
  const ddl = readFileSync(schemaPath, 'utf8');
  db.exec(ddl);
  return db;
}

// ---------------------------------------------------------------------------
// Helpers

function sha256OfFile(path) {
  if (!existsSync(path)) return null;
  const buf = readFileSync(path);
  return createHash('sha256').update(buf).digest('hex');
}

function nowIso() {
  return new Date().toISOString();
}

function safeJson(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

// ---------------------------------------------------------------------------
// Ingest

const INSERT_SQL = `
INSERT INTO artifacts (
  artifact_id, version, topic, prior_version, sha256, emitted_at,
  archive_path, md_path,
  department, title, summary, tags_json,
  intake_sha256, canon_sha256, markdown_sha256,
  canon_path, force_break, source, ingested_at
) VALUES (
  @artifact_id, @version, @topic, @prior_version, @sha256, @emitted_at,
  @archive_path, @md_path,
  @department, @title, @summary, @tags_json,
  @intake_sha256, @canon_sha256, @markdown_sha256,
  @canon_path, @force_break, @source, @ingested_at
)
ON CONFLICT(artifact_id, version) DO UPDATE SET
  topic = excluded.topic,
  prior_version = excluded.prior_version,
  sha256 = excluded.sha256,
  emitted_at = excluded.emitted_at,
  archive_path = excluded.archive_path,
  md_path = excluded.md_path,
  department = excluded.department,
  title = excluded.title,
  summary = excluded.summary,
  tags_json = excluded.tags_json,
  intake_sha256 = excluded.intake_sha256,
  canon_sha256 = excluded.canon_sha256,
  markdown_sha256 = excluded.markdown_sha256,
  canon_path = excluded.canon_path,
  force_break = excluded.force_break,
  source = excluded.source,
  ingested_at = excluded.ingested_at
`;

const INSERT_RUN_SQL = `
INSERT INTO ingest_runs (
  run_id, started_at, finished_at, archive_index,
  rows_seen, rows_inserted, rows_updated, rows_skipped, rows_failed,
  verify, errors_json
) VALUES (
  @run_id, @started_at, @finished_at, @archive_index,
  @rows_seen, @rows_inserted, @rows_updated, @rows_skipped, @rows_failed,
  @verify, @errors_json
)
`;

/**
 * Ingest archive INDEX.jsonl into the SQLite index.
 *
 * @param {object} opts
 * @param {string} [opts.path]            override db path
 * @param {boolean} [opts.verify]         rehash markdown files
 * @param {boolean} [opts.includeWorking] also ingest working canon rows
 * @param {object}  [opts.log]            { info, warn } (default: console)
 * @returns {{
 *   run_id: string,
 *   started_at: string, finished_at: string,
 *   rows_seen: number, rows_inserted: number, rows_updated: number,
 *   rows_skipped: number, rows_failed: number,
 *   errors: Array<{row:number, reason:string, data?:any}>,
 *   verify: boolean,
 * }}
 */
export async function ingest(opts = {}) {
  const log = opts.log ?? console;
  const verify = !!opts.verify;
  const includeWorking = !!opts.includeWorking;
  const db = openDb(opts.path ?? dbPath);

  const run_id = randomUUID();
  const started_at = nowIso();

  const seen = new Set();              // `${artifact_id}::${version}`
  const topicMaxVersion = new Map();   // topic -> max version observed
  // Preload existing topic versions so prior_version derivation survives
  // partial / incremental ingests too.
  for (const r of db.prepare('SELECT topic, MAX(version) AS v FROM artifacts GROUP BY topic').all()) {
    topicMaxVersion.set(r.topic, r.v);
  }

  const insertStmt = db.prepare(INSERT_SQL);
  const errors = [];
  let rows_seen = 0;
  let rows_inserted = 0;
  let rows_updated = 0;
  let rows_skipped = 0;
  let rows_failed = 0;

  const before = new Set(
    db.prepare("SELECT artifact_id || '::' || version AS k FROM artifacts").all().map(r => r.k),
  );

  if (!existsSync(archiveIndex)) {
    log.warn?.(`[ingest] archive INDEX.jsonl missing: ${archiveIndex} — archive pass skipped`);
  } else {
    const stream = createReadStream(archiveIndex, { encoding: 'utf8' });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    // Buffer rows because we want a single transaction.
    const buffered = [];
    let lineNo = 0;
    for await (const line of rl) {
      lineNo++;
      if (!line.trim()) continue;
      const row = safeJson(line, null);
      if (!row) {
        errors.push({ row: lineNo, reason: 'invalid_jsonl' });
        rows_failed++;
        continue;
      }
      buffered.push({ lineNo, row });
    }

    const tx = db.transaction(() => {
      for (const { lineNo, row } of buffered) {
        rows_seen++;
        try {
          const artifact_id = String(row.canon_id ?? '').trim();
          const topic = String(row.topic ?? '').trim();
          const version = Number(row.version);
          if (!artifact_id || !topic || !Number.isFinite(version) || version < 1) {
            errors.push({ row: lineNo, reason: 'missing_required', data: { artifact_id, topic, version } });
            rows_failed++;
            continue;
          }
          const sha256 = String(row.chain_sha256 ?? '').trim();
          if (sha256.length !== 64) {
            errors.push({ row: lineNo, reason: 'bad_chain_sha256', data: { sha256 } });
            rows_failed++;
            continue;
          }

          const prior_version = version > 1 ? version - 1 : null;

          if (verify) {
            const md_path = row.md_path;
            const md_sha = sha256OfFile(md_path);
            if (md_sha && md_sha !== row.markdown_sha256) {
              errors.push({
                row: lineNo,
                reason: 'markdown_sha_mismatch',
                data: { md_path, expected: row.markdown_sha256, actual: md_sha },
              });
              rows_failed++;
              continue;
            }
            if (!md_sha && md_path) {
              errors.push({ row: lineNo, reason: 'markdown_missing', data: { md_path } });
              rows_failed++;
              continue;
            }
          }

          const params = {
            artifact_id,
            version,
            topic,
            prior_version,
            sha256,
            emitted_at: String(row.emitted_at ?? ''),
            archive_path: String(row.json_path ?? ''),
            md_path: String(row.md_path ?? ''),
            department: row.department ?? null,
            title: row.title ?? null,
            summary: row.summary ?? null,
            tags_json: JSON.stringify(Array.isArray(row.tags) ? row.tags : []),
            intake_sha256: row.intake_sha256 ?? null,
            canon_sha256: row.canon_sha256 ?? null,
            markdown_sha256: row.markdown_sha256 ?? null,
            canon_path: null,                                     // archive row; working path filled later
            force_break: row.force_break ? 1 : 0,
            source: 'archive',
            ingested_at: started_at,
          };
          insertStmt.run(params);
          const k = `${artifact_id}::${version}`;
          seen.add(k);
          if (before.has(k)) rows_updated++; else rows_inserted++;
          const cur = topicMaxVersion.get(topic) ?? 0;
          if (version > cur) topicMaxVersion.set(topic, version);
        } catch (err) {
          errors.push({ row: lineNo, reason: 'insert_failed', data: { message: err.message } });
          rows_failed++;
        }
      }
    });
    tx();
  }

  if (includeWorking) {
    // Walk canon/<dept>/*.canon.json. Each working row is a not-yet-archived
    // canon. Use version 0 to mark "working / pre-archive" — keeps the
    // (topic, version) uniqueness intact because archive versions start at 1,
    // and ORDER BY remains correct (working sorts below v1). Schema CHECK
    // explicitly allows version 0; reuse.mjs should filter source='archive'
    // when only durable rows are wanted.
    const departments = existsSync(canonRoot)
      ? readdirSync(canonRoot).filter(f => statSync(join(canonRoot, f)).isDirectory())
      : [];
    const workingRows = [];
    for (const dept of departments) {
      const dir = join(canonRoot, dept);
      for (const f of readdirSync(dir)) {
        if (!f.endsWith('.canon.json')) continue;
        const p = join(dir, f);
        const txt = readFileSync(p, 'utf8');
        const canon = safeJson(txt, null);
        if (!canon) continue;
        workingRows.push({ canon, canon_path: p });
      }
    }

    const tx2 = db.transaction(() => {
      for (const { canon, canon_path } of workingRows) {
        rows_seen++;
        try {
          const artifact_id = String(canon.id ?? '').trim();
          if (!artifact_id) { rows_skipped++; continue; }
          const department = canon.department ?? null;
          // Skip working rows already represented as archived (any version).
          const archived = db
            .prepare('SELECT 1 FROM artifacts WHERE artifact_id = ? AND source = ?')
            .get(artifact_id, 'archive');
          if (archived) { rows_skipped++; continue; }

          const md_path = canon?.artifact?.markdown_path ?? '';
          const markdown_sha256 = canon?.artifact?.sha256 ?? null;
          const canon_sha = createHash('sha256').update(readFileSync(canon_path)).digest('hex');

          // Working rows have no archive emission yet — synthesize a chain
          // hash from canon + markdown for the sha256 column so the NOT NULL
          // constraint holds; mark force_break=0, source='working'.
          const sha256 = createHash('sha256')
            .update(canon_sha + ':' + (markdown_sha256 ?? ''))
            .digest('hex');

          const params = {
            artifact_id,
            version: 0,
            topic: canon?.topic ?? artifact_id,        // working has no topic until emit; use id as placeholder
            prior_version: null,
            sha256,
            emitted_at: canon?.created_at ?? started_at,
            archive_path: canon_path,                  // working: archive_path = working canon row
            md_path,
            department,
            title: canon?.title ?? null,
            summary: canon?.summary ?? null,
            tags_json: JSON.stringify(Array.isArray(canon?.tags) ? canon.tags : []),
            intake_sha256: canon?.intake?.sha256 ?? null,
            canon_sha256: canon_sha,
            markdown_sha256,
            canon_path,
            force_break: 0,
            source: 'working',
            ingested_at: started_at,
          };
          insertStmt.run(params);
          const k = `${artifact_id}::0`;
          if (before.has(k)) rows_updated++; else rows_inserted++;
          seen.add(k);
        } catch (err) {
          errors.push({ row: -1, reason: 'working_insert_failed', data: { message: err.message } });
          rows_failed++;
        }
      }
    });
    tx2();
  }

  const finished_at = nowIso();

  db.prepare(INSERT_RUN_SQL).run({
    run_id,
    started_at,
    finished_at,
    archive_index: archiveIndex,
    rows_seen,
    rows_inserted,
    rows_updated,
    rows_skipped,
    rows_failed,
    verify: verify ? 1 : 0,
    errors_json: JSON.stringify(errors),
  });

  db.close();

  return {
    run_id,
    started_at,
    finished_at,
    rows_seen,
    rows_inserted,
    rows_updated,
    rows_skipped,
    rows_failed,
    errors,
    verify,
  };
}

// ---------------------------------------------------------------------------
// CLI

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) args[a.slice(2)] = true;
    else args._.push(a);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.schema) {
    process.stdout.write(readFileSync(schemaPath, 'utf8'));
    return;
  }
  if (args.stats) {
    const db = openDb();
    const counts = db.prepare('SELECT COUNT(*) AS n FROM artifacts').get();
    const topics = db.prepare('SELECT COUNT(DISTINCT topic) AS n FROM artifacts').get();
    const latest = db.prepare(`
      SELECT topic, MAX(version) AS v FROM artifacts GROUP BY topic ORDER BY topic
    `).all();
    const lastRun = db.prepare(`
      SELECT * FROM ingest_runs ORDER BY finished_at DESC LIMIT 1
    `).get();
    db.close();
    console.log(JSON.stringify({
      result: 'ok',
      db: dbPath,
      rows: counts.n,
      topics: topics.n,
      latest_per_topic: latest,
      last_ingest: lastRun ?? null,
    }, null, 2));
    return;
  }
  if (args.ingest) {
    const out = await ingest({
      verify: !!args.verify,
      includeWorking: !!args['include-working'],
    });
    const blockers = [];
    if (out.rows_failed > 0) blockers.push(`${out.rows_failed} rows failed`);
    console.log(JSON.stringify({
      result: out.rows_failed === 0 ? 'ok' : 'partial',
      evidence: {
        db: dbPath,
        run_id: out.run_id,
        started_at: out.started_at,
        finished_at: out.finished_at,
        rows_seen: out.rows_seen,
        rows_inserted: out.rows_inserted,
        rows_updated: out.rows_updated,
        rows_skipped: out.rows_skipped,
        rows_failed: out.rows_failed,
        verify: out.verify,
      },
      blockers,
      next_action: out.rows_failed === 0
        ? 'query via query.mjs'
        : 'inspect ingest_runs.errors_json',
      errors: out.errors,
    }, null, 2));
    process.exit(out.rows_failed === 0 ? 0 : 1);
  }
  console.error('usage: node index.db.mjs --ingest [--verify] [--include-working] | --stats | --schema');
  process.exit(2);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => { console.error(err); process.exit(1); });
}
