import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from '#sqlite';
import { ingestReceipt } from './learning-loop.mjs';

const DEFAULT_COBRA_URL = 'http://127.0.0.1:7419';
const DEFAULT_MAX_ATTEMPTS = 8;

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function parseJson(value) {
  return value == null ? null : JSON.parse(value);
}

function rowToItem(row) {
  if (!row) return null;
  return {
    item_id: row.item_id,
    receipt_hash: row.receipt_hash,
    payload_hash: row.payload_hash,
    payload: parseJson(row.payload_json),
    cobra_url: row.cobra_url,
    status: row.status,
    attempts: row.attempts,
    max_attempts: row.max_attempts,
    next_attempt_at: row.next_attempt_at,
    lease_owner: row.lease_owner,
    lease_expires_at: row.lease_expires_at,
    result: parseJson(row.result_json),
    result_hash: row.result_hash,
    last_error: row.last_error,
    created_at: row.created_at,
    updated_at: row.updated_at,
    completed_at: row.completed_at,
  };
}

function retryDelayMs(attempt) {
  return Math.min(300_000, 1_000 * (2 ** Math.max(0, attempt - 1)));
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function initializeDatabase(db) {
  db.exec('PRAGMA busy_timeout = 15000;');
  let lastError = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      // The source receipt is the durable truth and queue rows are replayable.
      // WAL + NORMAL keeps the database consistent while avoiding a physical
      // disk flush for every tiny queue transition on Windows.
      const journalMode = String(db.query('PRAGMA journal_mode;').get()?.journal_mode || '').toLowerCase();
      if (journalMode !== 'wal') db.exec('PRAGMA journal_mode = WAL;');
      db.exec('PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;');
      return;
    } catch (error) {
      lastError = error;
      if (!/SQLITE_BUSY|database is locked/i.test(String(error?.message || error))) throw error;
      sleepSync(50 * (attempt + 1));
    }
  }
  throw lastError;
}

export function canonicalLearningQueuePath() {
  return path.join(os.homedir(), 'OrangeBox-Data', 'orange5', 'control', 'learning-queue.sqlite');
}

export class LearningQueueStore {
  constructor(dbPath = canonicalLearningQueuePath()) {
    this.path = path.resolve(dbPath);
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
    this.db = new Database(this.path);
    initializeDatabase(this.db);
    const schemaExists = Boolean(this.db.query(`
      SELECT 1 AS present FROM sqlite_master
      WHERE type = 'table' AND name = 'learning_queue'
    `).get());
    if (!schemaExists) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS learning_queue (
        item_id TEXT PRIMARY KEY,
        receipt_hash TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        cobra_url TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL,
        next_attempt_at TEXT NOT NULL,
        lease_owner TEXT,
        lease_expires_at TEXT,
        result_json TEXT,
        result_hash TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_learning_queue_ready
          ON learning_queue(status, next_attempt_at, created_at);
      `);
      this.db.exec('PRAGMA optimize;');
    }
    // db.query() caches compiled SQLite bytecode in Bun. These statements are
    // the complete queue hot path, so compile each once per connection.
    this.statements = Object.freeze({
      get: this.db.query('SELECT * FROM learning_queue WHERE item_id = ?'),
      insert: this.db.query(`
        INSERT OR IGNORE INTO learning_queue
          (item_id, receipt_hash, payload_hash, payload_json, cobra_url, status,
           attempts, max_attempts, next_attempt_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?)
        RETURNING *
      `),
      lease: this.db.query(`
        UPDATE learning_queue SET status = 'processing', attempts = attempts + 1,
          lease_owner = ?, lease_expires_at = ?, updated_at = ?, last_error = NULL
        WHERE item_id = (
          SELECT item_id FROM learning_queue
          WHERE (
            status IN ('pending', 'retry') AND next_attempt_at <= ?
          ) OR (
            status = 'processing' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
          )
          ORDER BY created_at, item_id
          LIMIT 1
        )
        RETURNING *
      `),
      complete: this.db.query(`
        UPDATE learning_queue SET status = 'completed', result_json = ?, result_hash = ?,
          lease_owner = NULL, lease_expires_at = NULL, last_error = NULL,
          updated_at = ?, completed_at = ?
        WHERE item_id = ?
        RETURNING *
      `),
      fail: this.db.query(`
        UPDATE learning_queue SET status = ?, next_attempt_at = ?, lease_owner = NULL,
          lease_expires_at = NULL, last_error = ?, updated_at = ?
        WHERE item_id = ?
        RETURNING *
      `),
      listByStatus: this.db.query('SELECT * FROM learning_queue WHERE status = ? ORDER BY updated_at DESC, item_id LIMIT ?'),
      list: this.db.query('SELECT * FROM learning_queue ORDER BY updated_at DESC, item_id LIMIT ?'),
      stats: this.db.query('SELECT status, COUNT(*) AS count FROM learning_queue GROUP BY status'),
      oldestOpen: this.db.query(`
        SELECT MIN(created_at) AS oldest_created_at
        FROM learning_queue
        WHERE status IN ('pending', 'retry', 'processing')
      `),
    });
  }

  enqueue(receipt, { cobraUrl = DEFAULT_COBRA_URL, maxAttempts = DEFAULT_MAX_ATTEMPTS } = {}) {
    if (!receipt || typeof receipt !== 'object' || !receipt.action) {
      throw new Error('learning queue requires a receipt with an action');
    }
    const payloadJson = stableJson(receipt);
    const payloadHash = sha256(payloadJson);
    const receiptHash = String(receipt.hash || receipt.receipt_hash || payloadHash);
    const itemId = `learn_${sha256(`${receiptHash}|${receipt.action}`).slice(0, 32)}`;
    const now = new Date().toISOString();
    const inserted = this.statements.insert.get(
      itemId, receiptHash, payloadHash, payloadJson, String(cobraUrl),
      Math.max(1, Number(maxAttempts) || DEFAULT_MAX_ATTEMPTS), now, now, now,
    );
    if (inserted) return rowToItem(inserted);
    const existing = this.statements.get.get(itemId);
    if (!existing) throw new Error(`learning queue insert did not persist ${itemId}`);
    if (existing.payload_hash !== payloadHash) throw new Error(`learning queue payload changed for ${itemId}`);
    return rowToItem(existing);
  }

  leaseNext({ owner = `orange5-${process.pid}`, leaseMs = 30_000 } = {}) {
    const now = new Date();
    const nowIso = now.toISOString();
    const leaseExpires = new Date(now.getTime() + Math.max(1_000, leaseMs)).toISOString();
    return rowToItem(this.statements.lease.get(owner, leaseExpires, nowIso, nowIso, nowIso));
  }

  complete(itemId, result = {}) {
    const resultJson = stableJson(result);
    const now = new Date().toISOString();
    return rowToItem(this.statements.complete.get(resultJson, sha256(resultJson), now, now, itemId));
  }

  fail(itemId, error) {
    const item = this.get(itemId);
    if (!item) throw new Error(`learning queue item not found: ${itemId}`);
    const terminal = item.attempts >= item.max_attempts;
    const now = new Date();
    const next = new Date(now.getTime() + retryDelayMs(item.attempts)).toISOString();
    return rowToItem(this.statements.fail.get(
      terminal ? 'failed' : 'retry', next,
      String(error?.message ?? error).slice(0, 4000), now.toISOString(), itemId,
    ));
  }

  get(itemId) {
    return rowToItem(this.statements.get.get(itemId));
  }

  list({ limit = 50, status = null } = {}) {
    const bounded = Math.max(1, Math.min(200, Number(limit) || 50));
    const requestedStatus = String(status || '').trim();
    const rows = requestedStatus
      ? this.statements.listByStatus.all(requestedStatus, bounded)
      : this.statements.list.all(bounded);
    return rows.map((row) => {
      const payload = parseJson(row.payload_json) || {};
      return {
        item_id: row.item_id,
        receipt_hash: row.receipt_hash,
        payload_hash: row.payload_hash,
        action: payload.action || null,
        target_project: payload.targetProject || payload.target_project || null,
        learned_status: payload.status || null,
        status: row.status,
        attempts: row.attempts,
        max_attempts: row.max_attempts,
        next_attempt_at: row.next_attempt_at,
        lease_expires_at: row.lease_expires_at,
        result_hash: row.result_hash,
        last_error: row.last_error,
        created_at: row.created_at,
        updated_at: row.updated_at,
        completed_at: row.completed_at,
      };
    });
  }

  stats() {
    const rows = this.statements.stats.all();
    const byStatus = Object.fromEntries(rows.map((row) => [row.status, Number(row.count)]));
    const open = this.statements.oldestOpen.get();
    return {
      total: Object.values(byStatus).reduce((sum, count) => sum + count, 0),
      by_status: byStatus,
      open: (byStatus.pending || 0) + (byStatus.retry || 0) + (byStatus.processing || 0),
      failed: byStatus.failed || 0,
      oldest_open_at: open?.oldest_created_at || null,
    };
  }

  verify(itemId) {
    const item = this.get(itemId);
    if (!item) return { ok: false, reason: 'not_found', item_id: itemId };
    const broken = [];
    if (sha256(stableJson(item.payload)) !== item.payload_hash) broken.push('payload_hash');
    if (item.result_hash && sha256(stableJson(item.result)) !== item.result_hash) broken.push('result_hash');
    return { ok: broken.length === 0, item_id: itemId, status: item.status, broken };
  }

  close() {
    this.db.close();
  }
}

let runtimeStore = null;
let runtimeDrain = null;
let workerTimer = null;

function getRuntimeStore() {
  if (!runtimeStore) runtimeStore = new LearningQueueStore(process.env.ORANGE5_LEARNING_QUEUE_PATH || canonicalLearningQueuePath());
  return runtimeStore;
}

export function enqueueLearningReceipt(receipt, opts = {}) {
  const item = getRuntimeStore().enqueue(receipt, {
    cobraUrl: opts.cobraUrl || process.env.AE_COBRA_BASE || DEFAULT_COBRA_URL,
    maxAttempts: opts.maxAttempts,
  });
  queueMicrotask(() => { void drainLearningQueue().catch(() => {}); });
  return item;
}

export async function drainLearningQueue({ limit = 8, store = getRuntimeStore(), ingest = ingestReceipt } = {}) {
  if (store === runtimeStore && runtimeDrain) return runtimeDrain;
  const run = (async () => {
    const completed = [];
    for (let index = 0; index < Math.max(1, limit); index += 1) {
      const item = store.leaseNext();
      if (!item) break;
      try {
        const learned = await ingest(item.payload, { cobraUrl: item.cobra_url, requireCobra: true });
        if (learned?.accepted !== true) throw new Error('AE Cobra did not accept the learning receipt');
        completed.push(store.complete(item.item_id, learned));
      } catch (error) {
        completed.push(store.fail(item.item_id, error));
      }
    }
    return { processed: completed.length, items: completed, stats: store.stats() };
  })();
  if (store === runtimeStore) runtimeDrain = run;
  try {
    return await run;
  } finally {
    if (store === runtimeStore) runtimeDrain = null;
  }
}

export function startLearningQueueWorker({ intervalMs = 1_000 } = {}) {
  if (workerTimer) return { started: false, path: getRuntimeStore().path };
  void drainLearningQueue().catch(() => {});
  workerTimer = setInterval(() => { void drainLearningQueue().catch(() => {}); }, Math.max(250, intervalMs));
  workerTimer.unref?.();
  return { started: true, path: getRuntimeStore().path };
}

export function stopLearningQueueWorker() {
  if (workerTimer) clearInterval(workerTimer);
  workerTimer = null;
  if (runtimeStore) runtimeStore.close();
  runtimeStore = null;
  runtimeDrain = null;
}

export function learningQueueSnapshot() {
  const store = getRuntimeStore();
  const stats = store.stats();
  const oldestOpenAgeMs = stats.oldest_open_at
    ? Math.max(0, Date.now() - Date.parse(stats.oldest_open_at))
    : 0;
  return {
    status: stats.failed > 0 ? 'needs_attention' : (stats.open > 0 ? 'draining' : 'ok'),
    live: workerTimer != null,
    worker_running: workerTimer != null,
    drain_running: runtimeDrain != null,
    path: store.path,
    total: stats.total,
    open: stats.open,
    failed: stats.failed,
    by_status: stats.by_status,
    oldest_open_at: stats.oldest_open_at,
    oldest_open_age_ms: oldestOpenAgeMs,
  };
}

export const __learningQueueInternals = Object.freeze({ stableJson, sha256, retryDelayMs });
