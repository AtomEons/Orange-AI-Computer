import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from '#sqlite';

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

function parseJson(value) {
  return value == null ? null : JSON.parse(value);
}

export function canonicalMcpTaskPath() {
  return process.env.ORANGE5_MCP_TASK_DB
    || path.join(os.homedir(), 'OrangeBox-Data', 'orange5', 'control', 'mcp-tasks.sqlite');
}

export class McpTaskStore {
  constructor(dbPath = canonicalMcpTaskPath()) {
    this.path = path.resolve(dbPath);
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
    this.db = new Database(this.path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mcp_tasks (
        task_id TEXT PRIMARY KEY,
        method TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        arguments_json TEXT NOT NULL,
        status TEXT NOT NULL,
        status_message TEXT,
        result_json TEXT,
        error_json TEXT,
        input_requests_json TEXT,
        input_responses_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        ttl_ms INTEGER,
        poll_interval_ms INTEGER NOT NULL,
        worker_id TEXT,
        lease_until_ms INTEGER,
        cancel_requested INTEGER NOT NULL DEFAULT 0,
        attempt INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_mcp_tasks_status ON mcp_tasks(status, updated_at);
    `);
  }

  create({ method = 'tools/call', toolName, arguments: args = {}, ttlMs = 3_600_000, pollIntervalMs = 250 }) {
    if (!toolName) throw new Error('toolName is required');
    const now = new Date().toISOString();
    const taskId = `task_${crypto.randomBytes(24).toString('base64url')}`;
    this.db.prepare(`
      INSERT INTO mcp_tasks
        (task_id, method, tool_name, arguments_json, status, status_message, created_at, updated_at, ttl_ms, poll_interval_ms)
      VALUES (?, ?, ?, ?, 'working', 'accepted by OrangeFive durable task runtime', ?, ?, ?, ?)
    `).run(taskId, method, toolName, JSON.stringify(args), now, now, boundedTtl(ttlMs), boundedPoll(pollIntervalMs));
    return this.get(taskId, { createResult: true });
  }

  get(taskId, { createResult = false } = {}) {
    const row = this.db.prepare('SELECT * FROM mcp_tasks WHERE task_id = ?').get(taskId);
    if (!row) return null;
    const task = {
      resultType: createResult ? 'task' : 'complete',
      taskId: row.task_id,
      status: row.status,
      createdAt: row.created_at,
      lastUpdatedAt: row.updated_at,
      ttlMs: row.ttl_ms,
      pollIntervalMs: row.poll_interval_ms,
    };
    if (row.status_message) task.statusMessage = row.status_message;
    if (row.status === 'completed') task.result = parseJson(row.result_json);
    if (row.status === 'failed') task.error = parseJson(row.error_json);
    if (row.status === 'input_required') task.inputRequests = parseJson(row.input_requests_json) || {};
    return task;
  }

  execution(taskId) {
    const row = this.db.prepare('SELECT * FROM mcp_tasks WHERE task_id = ?').get(taskId);
    if (!row) return null;
    return {
      taskId: row.task_id,
      method: row.method,
      toolName: row.tool_name,
      arguments: parseJson(row.arguments_json),
      status: row.status,
      cancelRequested: row.cancel_requested === 1,
      leaseUntilMs: row.lease_until_ms,
    };
  }

  claim(taskId, workerId, leaseMs = 30_000) {
    const now = Date.now();
    const result = this.db.prepare(`
      UPDATE mcp_tasks SET worker_id = ?, lease_until_ms = ?, attempt = attempt + 1,
        updated_at = ?, status_message = 'executing through OrangeFive governed runtime'
      WHERE task_id = ? AND status = 'working' AND cancel_requested = 0
        AND (worker_id IS NULL OR worker_id = ? OR lease_until_ms IS NULL OR lease_until_ms < ?)
    `).run(workerId, now + leaseMs, new Date(now).toISOString(), taskId, workerId, now);
    return result.changes === 1;
  }

  renew(taskId, workerId, leaseMs = 30_000) {
    const now = Date.now();
    this.db.prepare(`
      UPDATE mcp_tasks SET lease_until_ms = ?, updated_at = ?
      WHERE task_id = ? AND worker_id = ? AND status = 'working'
    `).run(now + leaseMs, new Date(now).toISOString(), taskId, workerId);
  }

  complete(taskId, result) {
    const row = this.db.prepare('SELECT cancel_requested FROM mcp_tasks WHERE task_id = ?').get(taskId);
    if (!row) return false;
    const now = new Date().toISOString();
    if (row.cancel_requested === 1) {
      this.db.prepare(`UPDATE mcp_tasks SET status = 'cancelled', status_message = 'cancelled by client', updated_at = ?, worker_id = NULL, lease_until_ms = NULL WHERE task_id = ?`).run(now, taskId);
    } else {
      this.db.prepare(`UPDATE mcp_tasks SET status = 'completed', status_message = 'completed with governed result', result_json = ?, updated_at = ?, worker_id = NULL, lease_until_ms = NULL WHERE task_id = ?`).run(JSON.stringify(result), now, taskId);
    }
    return true;
  }

  fail(taskId, error) {
    const row = this.db.prepare('SELECT cancel_requested FROM mcp_tasks WHERE task_id = ?').get(taskId);
    if (!row) return false;
    const now = new Date().toISOString();
    if (row.cancel_requested === 1) {
      this.db.prepare(`UPDATE mcp_tasks SET status = 'cancelled', status_message = 'cancelled by client', updated_at = ?, worker_id = NULL, lease_until_ms = NULL WHERE task_id = ?`).run(now, taskId);
    } else {
      const message = String(error?.message || error).slice(0, 4000);
      this.db.prepare(`UPDATE mcp_tasks SET status = 'failed', status_message = ?, error_json = ?, updated_at = ?, worker_id = NULL, lease_until_ms = NULL WHERE task_id = ?`).run(message, JSON.stringify({ code: -32000, message }), now, taskId);
    }
    return true;
  }

  cancel(taskId) {
    const current = this.get(taskId);
    if (!current) return false;
    if (TERMINAL.has(current.status)) throw new Error(`task is already ${current.status}`);
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE mcp_tasks SET cancel_requested = 1, status = 'cancelled', status_message = 'cancelled by client', updated_at = ?, worker_id = NULL, lease_until_ms = NULL WHERE task_id = ?`).run(now, taskId);
    return true;
  }

  update(taskId, inputResponses = {}) {
    const current = this.get(taskId);
    if (!current) return false;
    if (current.status !== 'input_required') return true;
    const now = new Date().toISOString();
    this.db.prepare('UPDATE mcp_tasks SET input_responses_json = ?, updated_at = ? WHERE task_id = ?')
      .run(JSON.stringify(inputResponses), now, taskId);
    return true;
  }

  shouldRecover(taskId) {
    const row = this.db.prepare('SELECT status, worker_id, lease_until_ms FROM mcp_tasks WHERE task_id = ?').get(taskId);
    return row?.status === 'working' && (!row.worker_id || !row.lease_until_ms || row.lease_until_ms < Date.now());
  }

  close() {
    this.db.close();
  }
}

function boundedTtl(value) {
  if (value == null) return 3_600_000;
  return Math.max(60_000, Math.min(86_400_000, Number(value) || 3_600_000));
}

function boundedPoll(value) {
  return Math.max(100, Math.min(10_000, Number(value) || 250));
}
