import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from '#sqlite';

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

function jsonHash(value) {
  return sha256(stableJson(value));
}

function parseJson(value) {
  if (value == null) return null;
  return JSON.parse(value);
}

export function canonicalDurableRunPath() {
  return path.join(os.homedir(), 'OrangeBox-Data', 'orange5', 'control', 'durable-runs.sqlite');
}

export class DurableRunStore {
  constructor(dbPath = canonicalDurableRunPath()) {
    this.path = path.resolve(dbPath);
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
    this.db = new Database(this.path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS durable_runs (
        run_id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL,
        run_type TEXT NOT NULL,
        status TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        input_json TEXT NOT NULL,
        output_hash TEXT,
        output_json TEXT,
        current_step TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        last_error TEXT
      );
      CREATE TABLE IF NOT EXISTS durable_checkpoints (
        run_id TEXT NOT NULL,
        step_index INTEGER NOT NULL,
        step_name TEXT NOT NULL,
        status TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        input_json TEXT NOT NULL,
        output_hash TEXT,
        output_json TEXT,
        attempt INTEGER NOT NULL DEFAULT 1,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        error TEXT,
        PRIMARY KEY (run_id, step_name),
        FOREIGN KEY (run_id) REFERENCES durable_runs(run_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_durable_runs_order ON durable_runs(order_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_durable_checkpoints_run ON durable_checkpoints(run_id, step_index);
    `);
  }

  openRun({ runId, orderId, runType, input = {} }) {
    if (!runId || !orderId || !runType) throw new Error('runId, orderId, and runType are required');
    const inputHash = jsonHash(input);
    const now = new Date().toISOString();
    const existing = this.db.prepare('SELECT * FROM durable_runs WHERE run_id = ?').get(runId);
    if (existing && existing.input_hash !== inputHash) {
      throw new Error(`durable run input changed for ${runId}`);
    }
    if (!existing) {
      this.db.prepare(`
        INSERT INTO durable_runs
          (run_id, order_id, run_type, status, input_hash, input_json, created_at, updated_at)
        VALUES (?, ?, ?, 'running', ?, ?, ?, ?)
      `).run(runId, orderId, runType, inputHash, stableJson(input), now, now);
    } else if (existing.status !== 'completed') {
      this.db.prepare(`
        UPDATE durable_runs SET status = 'running', updated_at = ?, last_error = NULL WHERE run_id = ?
      `).run(now, runId);
    }
    return this.getRun(runId);
  }

  async step({ runId, stepName, stepIndex, input = {}, execute }) {
    if (typeof execute !== 'function') throw new Error('execute must be a function');
    const run = this.db.prepare('SELECT * FROM durable_runs WHERE run_id = ?').get(runId);
    if (!run) throw new Error(`durable run not found: ${runId}`);
    const inputHash = jsonHash(input);
    const existing = this.db.prepare(`
      SELECT * FROM durable_checkpoints WHERE run_id = ? AND step_name = ?
    `).get(runId, stepName);
    if (existing?.status === 'completed' && existing.input_hash === inputHash) {
      const output = parseJson(existing.output_json);
      if (jsonHash(output) !== existing.output_hash) {
        throw new Error(`durable checkpoint hash mismatch: ${runId}/${stepName}`);
      }
      return { output, resumed: true, attempt: existing.attempt, checkpoint: this.#checkpointRow(existing) };
    }

    const attempt = (existing?.attempt ?? 0) + 1;
    const startedAt = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO durable_checkpoints
        (run_id, step_index, step_name, status, input_hash, input_json, attempt, started_at)
      VALUES (?, ?, ?, 'running', ?, ?, ?, ?)
      ON CONFLICT(run_id, step_name) DO UPDATE SET
        step_index = excluded.step_index,
        status = 'running',
        input_hash = excluded.input_hash,
        input_json = excluded.input_json,
        output_hash = NULL,
        output_json = NULL,
        attempt = excluded.attempt,
        started_at = excluded.started_at,
        completed_at = NULL,
        error = NULL
    `).run(runId, stepIndex, stepName, inputHash, stableJson(input), attempt, startedAt);
    this.db.prepare(`
      UPDATE durable_runs SET status = 'running', current_step = ?, updated_at = ?, last_error = NULL WHERE run_id = ?
    `).run(stepName, startedAt, runId);

    try {
      const output = await execute();
      const outputJson = stableJson(output);
      const outputHash = sha256(outputJson);
      const completedAt = new Date().toISOString();
      this.db.prepare(`
        UPDATE durable_checkpoints SET
          status = 'completed', output_hash = ?, output_json = ?, completed_at = ?, error = NULL
        WHERE run_id = ? AND step_name = ?
      `).run(outputHash, outputJson, completedAt, runId, stepName);
      this.db.prepare('UPDATE durable_runs SET updated_at = ? WHERE run_id = ?').run(completedAt, runId);
      return {
        output,
        resumed: false,
        attempt,
        checkpoint: this.getCheckpoint(runId, stepName),
      };
    } catch (error) {
      const failedAt = new Date().toISOString();
      const message = String(error?.message ?? error).slice(0, 4000);
      this.db.prepare(`
        UPDATE durable_checkpoints SET status = 'failed', completed_at = ?, error = ?
        WHERE run_id = ? AND step_name = ?
      `).run(failedAt, message, runId, stepName);
      this.db.prepare(`
        UPDATE durable_runs SET status = 'failed', updated_at = ?, last_error = ? WHERE run_id = ?
      `).run(failedAt, message, runId);
      throw error;
    }
  }

  completeRun(runId, output = {}) {
    const outputJson = stableJson(output);
    const completedAt = new Date().toISOString();
    this.db.prepare(`
      UPDATE durable_runs SET status = 'completed', output_hash = ?, output_json = ?,
        current_step = NULL, updated_at = ?, completed_at = ?, last_error = NULL
      WHERE run_id = ?
    `).run(sha256(outputJson), outputJson, completedAt, completedAt, runId);
    return this.getRun(runId);
  }

  failRun(runId, error) {
    const now = new Date().toISOString();
    const message = String(error?.message ?? error).slice(0, 4000);
    this.db.prepare(`
      UPDATE durable_runs SET status = 'failed', updated_at = ?, last_error = ? WHERE run_id = ?
    `).run(now, message, runId);
    return this.getRun(runId);
  }

  getCheckpoint(runId, stepName) {
    const row = this.db.prepare(`
      SELECT * FROM durable_checkpoints WHERE run_id = ? AND step_name = ?
    `).get(runId, stepName);
    return row ? this.#checkpointRow(row) : null;
  }

  getRun(runId) {
    const row = this.db.prepare('SELECT * FROM durable_runs WHERE run_id = ?').get(runId);
    if (!row) return null;
    const checkpoints = this.db.prepare(`
      SELECT * FROM durable_checkpoints WHERE run_id = ? ORDER BY step_index, step_name
    `).all(runId).map((item) => this.#checkpointRow(item));
    return {
      run_id: row.run_id,
      order_id: row.order_id,
      run_type: row.run_type,
      status: row.status,
      input_hash: row.input_hash,
      input: parseJson(row.input_json),
      output_hash: row.output_hash,
      output: parseJson(row.output_json),
      current_step: row.current_step,
      created_at: row.created_at,
      updated_at: row.updated_at,
      completed_at: row.completed_at,
      last_error: row.last_error,
      checkpoints,
    };
  }

  verifyRun(runId) {
    const run = this.getRun(runId);
    if (!run) return { ok: false, reason: 'run_not_found', run_id: runId };
    const broken = [];
    if (run.output_hash && jsonHash(run.output) !== run.output_hash) broken.push('run_output_hash');
    for (const checkpoint of run.checkpoints) {
      if (checkpoint.status === 'completed' && jsonHash(checkpoint.output) !== checkpoint.output_hash) {
        broken.push(checkpoint.step_name);
      }
    }
    return {
      ok: broken.length === 0,
      run_id: runId,
      status: run.status,
      checkpoints: run.checkpoints.length,
      completed: run.checkpoints.filter((item) => item.status === 'completed').length,
      broken,
    };
  }

  close() {
    this.db.close();
  }

  #checkpointRow(row) {
    return {
      run_id: row.run_id,
      step_index: row.step_index,
      step_name: row.step_name,
      status: row.status,
      input_hash: row.input_hash,
      input: parseJson(row.input_json),
      output_hash: row.output_hash,
      output: parseJson(row.output_json),
      attempt: row.attempt,
      started_at: row.started_at,
      completed_at: row.completed_at,
      error: row.error,
    };
  }
}

export const __durableRunInternals = Object.freeze({ stableJson, sha256, jsonHash });
