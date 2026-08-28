// Orange5 receipts SQLite store
// Path:    06-CONTROL-PLANE/receipts/db.mjs
// Runtime: Node >= 20, better-sqlite3 >= 11
//
// Markdown receipts at 10-RECEIPTS/orange5-build/ are the operator-audit
// ground truth. This module exposes the parallel SQLite index for machine
// queries. SHA-256 stored here MUST equal the SHA-256 of the markdown bytes
// on disk; ingest.mjs is the only writer that satisfies that invariant.
//
// Public surface (intentionally narrow):
//   openDb(dbPath?)                  -> Database
//   applySchema(db)                  -> void
//   upsertReceipt(db, row)           -> { changed: boolean, op: 'inserted'|'updated'|'unchanged' }
//   getReceipt(db, receipt_id)       -> row | undefined
//   listReceipts(db, opts?)          -> row[]
//   logIngest(db, evt)               -> void
//   countReceipts(db)                -> integer
//   close(db)                        -> void
//
// Nothing else writes. Nothing else opens. Single-writer discipline keeps
// WAL contention off the operator's audit lane.

import Database from '#sqlite';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const DEFAULT_DB_PATH = resolve(__dirname, 'orange5.db');
export const SCHEMA_PATH     = resolve(__dirname, 'schema.sql');

/**
 * Open (and create if needed) the receipts database.
 * Applies the schema and turns on WAL + foreign_keys + busy_timeout.
 */
export function openDb(dbPath = DEFAULT_DB_PATH) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');

    applySchema(db);
    return db;
}

/** Apply schema.sql idempotently. */
export function applySchema(db) {
    const ddl = readFileSync(SCHEMA_PATH, 'utf8');
    db.exec(ddl);
}

/**
 * UPSERT a parsed receipt row. Returns op for ingest_log telemetry.
 * row must include: receipt_id, markdown_path, sha256, body_json, file_mtime_ms.
 * All other columns may be null/undefined and are coerced to null.
 */
export function upsertReceipt(db, row) {
    if (!row || typeof row !== 'object') {
        throw new TypeError('upsertReceipt: row required');
    }
    const required = ['receipt_id', 'markdown_path', 'sha256', 'body_json', 'file_mtime_ms'];
    for (const k of required) {
        if (row[k] === undefined || row[k] === null || row[k] === '') {
            throw new Error(`upsertReceipt: missing required field "${k}"`);
        }
    }

    const existing = db.prepare(
        'SELECT sha256, file_mtime_ms FROM receipts WHERE receipt_id = ?'
    ).get(row.receipt_id);

    if (existing && existing.sha256 === row.sha256) {
        // Bytes unchanged. Bump mtime if it drifted, but no semantic change.
        if (existing.file_mtime_ms !== row.file_mtime_ms) {
            db.prepare('UPDATE receipts SET file_mtime_ms = ? WHERE receipt_id = ?')
              .run(row.file_mtime_ms, row.receipt_id);
        }
        return { changed: false, op: 'unchanged' };
    }

    const stmt = db.prepare(`
        INSERT INTO receipts (
            receipt_id, generated_at, schema, status, confidence, confidence_raw,
            prior_receipt, hash_chain, actor, sovereign, markdown_path, sha256,
            body_json, file_mtime_ms
        ) VALUES (
            @receipt_id, @generated_at, @schema, @status, @confidence, @confidence_raw,
            @prior_receipt, @hash_chain, @actor, @sovereign, @markdown_path, @sha256,
            @body_json, @file_mtime_ms
        )
        ON CONFLICT(receipt_id) DO UPDATE SET
            generated_at   = excluded.generated_at,
            schema         = excluded.schema,
            status         = excluded.status,
            confidence     = excluded.confidence,
            confidence_raw = excluded.confidence_raw,
            prior_receipt  = excluded.prior_receipt,
            hash_chain     = excluded.hash_chain,
            actor          = excluded.actor,
            sovereign      = excluded.sovereign,
            markdown_path  = excluded.markdown_path,
            sha256         = excluded.sha256,
            body_json      = excluded.body_json,
            file_mtime_ms  = excluded.file_mtime_ms,
            updated_at     = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    `);

    const params = {
        receipt_id:     row.receipt_id,
        generated_at:   row.generated_at   ?? null,
        schema:         row.schema         ?? null,
        status:         row.status         ?? null,
        confidence:     Number.isFinite(row.confidence) ? row.confidence : null,
        confidence_raw: row.confidence_raw ?? null,
        prior_receipt:  row.prior_receipt  ?? null,
        hash_chain:     row.hash_chain     ?? null,
        actor:          row.actor          ?? null,
        sovereign:      row.sovereign      ?? null,
        markdown_path:  row.markdown_path,
        sha256:         row.sha256,
        body_json:      row.body_json,
        file_mtime_ms:  row.file_mtime_ms,
    };

    stmt.run(params);
    return { changed: true, op: existing ? 'updated' : 'inserted' };
}

export function getReceipt(db, receipt_id) {
    return db.prepare('SELECT * FROM receipts WHERE receipt_id = ?').get(receipt_id);
}

/**
 * List receipts with light filtering. opts:
 *   - limit:        default 100
 *   - status:       exact status match
 *   - since:        ISO-8601 string compared against generated_at lexically
 *   - order:        'newest' (default) | 'oldest'
 */
export function listReceipts(db, opts = {}) {
    const limit  = Number.isInteger(opts.limit) ? opts.limit : 100;
    const order  = opts.order === 'oldest' ? 'ASC' : 'DESC';
    const where  = [];
    const params = {};

    if (opts.status) { where.push('status = @status'); params.status = opts.status; }
    if (opts.since)  { where.push('generated_at >= @since'); params.since = opts.since; }

    const sql =
        'SELECT * FROM receipts'
      + (where.length ? ' WHERE ' + where.join(' AND ') : '')
      + ` ORDER BY generated_at ${order}, receipt_id ${order}`
      + ' LIMIT @limit';

    params.limit = limit;
    return db.prepare(sql).all(params);
}

export function countReceipts(db) {
    return db.prepare('SELECT COUNT(*) AS n FROM receipts').get().n;
}

/**
 * Append-only ingest event. Never throws on missing optional fields;
 * the audit log must not be the thing that breaks ingest.
 */
export function logIngest(db, { event, receipt_id = null, markdown_path = null, detail = null }) {
    if (!event) return;
    try {
        db.prepare(`
            INSERT INTO ingest_log (event, receipt_id, markdown_path, detail)
            VALUES (?, ?, ?, ?)
        `).run(event, receipt_id, markdown_path, detail);
    } catch (err) {
        // Last-resort surface — do not swallow silently.
        // eslint-disable-next-line no-console
        console.error(`[receipts/db] logIngest failed: ${err.message}`);
    }
}

export function close(db) {
    // Checkpoint the WAL before closing so the -wal/-shm sidecars are folded
    // back into the main db. TRUNCATE is the strongest checkpoint: it empties
    // and removes the WAL file.
    try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* db may be read-only or already closing */ }
    try { db.close(); } catch { /* idempotent */ }

    // Under bun:sqlite, prepared statements created by this module's queries are
    // finalized lazily by the GC, not by db.close(). On Windows those unfinalized
    // handles keep an OS lock on the db file, so an immediate unlink after close
    // (e.g. temp-db cleanup in tests) fails with EBUSY. A synchronous GC pass
    // finalizes them and releases the lock deterministically. No-op off Bun.
    try { globalThis.Bun?.gc?.(true); } catch { /* gc is best-effort */ }
}

// Convenience: resolve the canonical receipts dir given the repo layout.
// 06-CONTROL-PLANE/receipts/ -> ../../10-RECEIPTS/orange5-build/
export function defaultReceiptsDir() {
    return resolve(__dirname, '..', '..', '10-RECEIPTS', 'orange5-build');
}

export { join as _join };
