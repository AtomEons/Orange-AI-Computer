import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from '#sqlite';

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function parse(value) {
  return value == null ? null : JSON.parse(value);
}

export function canonicalTracePath() {
  return process.env.ORANGE5_TRACE_DB || path.join(os.homedir(), 'OrangeBox-Data', 'orange5', 'control', 'traces.sqlite');
}

export class TraceStore {
  constructor(dbPath = canonicalTracePath()) {
    this.path = path.resolve(dbPath);
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
    this.db = new Database(this.path);
    // Traces are diagnostic evidence, never authorization state. WAL/NORMAL
    // avoids a full disk flush per span while receipts and run checkpoints keep FULL sync.
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS traces (
        trace_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        attributes_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        invocation_count INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS trace_spans (
        span_id TEXT PRIMARY KEY,
        trace_id TEXT NOT NULL,
        parent_span_id TEXT,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        started_ms REAL NOT NULL,
        ended_at TEXT,
        duration_ms REAL,
        attributes_json TEXT NOT NULL,
        result_json TEXT,
        result_hash TEXT,
        span_hash TEXT,
        error TEXT,
        FOREIGN KEY(trace_id) REFERENCES traces(trace_id)
      );
      CREATE INDEX IF NOT EXISTS idx_trace_spans_trace ON trace_spans(trace_id, started_ms);
      CREATE INDEX IF NOT EXISTS idx_trace_spans_parent ON trace_spans(parent_span_id);
    `);
  }

  openTrace({ traceId, name, attributes = {} }) {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO traces (trace_id, name, attributes_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(trace_id) DO UPDATE SET
        name = excluded.name, attributes_json = excluded.attributes_json,
        updated_at = excluded.updated_at, invocation_count = traces.invocation_count + 1
    `).run(traceId, name, stableJson(attributes), now, now);
    return this.getTrace(traceId);
  }

  startSpan({ traceId, parentSpanId = null, name, kind = 'internal', attributes = {} }) {
    if (!this.db.prepare('SELECT 1 FROM traces WHERE trace_id = ?').get(traceId)) throw new Error(`trace not found: ${traceId}`);
    const spanId = `span_${crypto.randomBytes(16).toString('hex')}`;
    const startedMs = performance.timeOrigin + performance.now();
    const startedAt = new Date(startedMs).toISOString();
    this.db.prepare(`
      INSERT INTO trace_spans
        (span_id, trace_id, parent_span_id, name, kind, status, started_at, started_ms, attributes_json)
      VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?)
    `).run(spanId, traceId, parentSpanId, name, kind, startedAt, startedMs, stableJson(attributes));
    return spanId;
  }

  endSpan(spanId, { status = 'ok', attributes = {}, result = null, error = null } = {}) {
    const row = this.db.prepare('SELECT * FROM trace_spans WHERE span_id = ?').get(spanId);
    if (!row) throw new Error(`span not found: ${spanId}`);
    const endedMs = performance.timeOrigin + performance.now();
    const endedAt = new Date(endedMs).toISOString();
    const mergedAttributes = { ...(parse(row.attributes_json) || {}), ...attributes };
    const resultJson = result == null ? null : stableJson(result);
    const resultHash = resultJson == null ? null : sha256(resultJson);
    const unsigned = {
      span_id: spanId, trace_id: row.trace_id, parent_span_id: row.parent_span_id,
      name: row.name, kind: row.kind, status, started_at: row.started_at,
      ended_at: endedAt, duration_ms: Number((endedMs - row.started_ms).toFixed(3)),
      attributes: mergedAttributes, result_hash: resultHash, error: error ? String(error).slice(0, 4000) : null,
    };
    const spanHash = sha256(stableJson(unsigned));
    this.db.prepare(`
      UPDATE trace_spans SET status = ?, ended_at = ?, duration_ms = ?, attributes_json = ?,
        result_json = ?, result_hash = ?, span_hash = ?, error = ? WHERE span_id = ?
    `).run(status, endedAt, unsigned.duration_ms, stableJson(mergedAttributes), resultJson, resultHash, spanHash, unsigned.error, spanId);
    this.db.prepare('UPDATE traces SET updated_at = ? WHERE trace_id = ?').run(endedAt, row.trace_id);
    return this.getSpan(spanId);
  }

  getSpan(spanId) {
    const row = this.db.prepare('SELECT * FROM trace_spans WHERE span_id = ?').get(spanId);
    return row ? this.#span(row) : null;
  }

  getTrace(traceId) {
    const row = this.db.prepare('SELECT * FROM traces WHERE trace_id = ?').get(traceId);
    if (!row) return null;
    const spans = this.db.prepare('SELECT * FROM trace_spans WHERE trace_id = ? ORDER BY started_ms, span_id').all(traceId).map((span) => this.#span(span));
    return {
      trace_id: row.trace_id,
      name: row.name,
      attributes: parse(row.attributes_json),
      created_at: row.created_at,
      updated_at: row.updated_at,
      invocation_count: row.invocation_count,
      spans,
    };
  }

  listTraces(limit = 20) {
    const bounded = Math.max(1, Math.min(500, Number(limit) || 20));
    return this.db.prepare(`
      SELECT trace_id, name, attributes_json, created_at, updated_at, invocation_count
      FROM traces ORDER BY updated_at DESC, trace_id LIMIT ?
    `).all(bounded).map((row) => ({
      trace_id: row.trace_id,
      name: row.name,
      attributes: parse(row.attributes_json),
      created_at: row.created_at,
      updated_at: row.updated_at,
      invocation_count: row.invocation_count,
    }));
  }

  verifyTrace(traceId) {
    const trace = this.getTrace(traceId);
    if (!trace) return { ok: false, trace_id: traceId, reason: 'trace_not_found' };
    const broken = [];
    for (const span of trace.spans) {
      if (span.result_hash && sha256(stableJson(span.result)) !== span.result_hash) broken.push(`${span.span_id}:result`);
      if (span.status !== 'running') {
        const unsigned = {
          span_id: span.span_id, trace_id: span.trace_id, parent_span_id: span.parent_span_id,
          name: span.name, kind: span.kind, status: span.status, started_at: span.started_at,
          ended_at: span.ended_at, duration_ms: span.duration_ms, attributes: span.attributes,
          result_hash: span.result_hash, error: span.error,
        };
        if (sha256(stableJson(unsigned)) !== span.span_hash) broken.push(`${span.span_id}:span`);
      }
    }
    return {
      ok: broken.length === 0,
      trace_id: traceId,
      invocation_count: trace.invocation_count,
      spans: trace.spans.length,
      completed: trace.spans.filter((span) => span.status !== 'running').length,
      resumed: trace.spans.filter((span) => span.attributes?.resumed === true).length,
      duration_ms: Number(trace.spans.filter((span) => span.parent_span_id == null).reduce((sum, span) => sum + (span.duration_ms || 0), 0).toFixed(3)),
      broken,
    };
  }

  close() { this.db.close(); }

  #span(row) {
    return {
      span_id: row.span_id,
      trace_id: row.trace_id,
      parent_span_id: row.parent_span_id,
      name: row.name,
      kind: row.kind,
      status: row.status,
      started_at: row.started_at,
      ended_at: row.ended_at,
      duration_ms: row.duration_ms,
      attributes: parse(row.attributes_json),
      result: parse(row.result_json),
      result_hash: row.result_hash,
      span_hash: row.span_hash,
      error: row.error,
    };
  }
}

export const __traceInternals = Object.freeze({ stableJson, sha256 });
