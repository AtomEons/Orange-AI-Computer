// 11-MIRAGE/adapters/postgres.mjs — READY (Wave-2).
//
// External Postgres mount.
//   read  : query(sql, params), schema(table), list_tables() — SELECT-only enforced
//   write : insert / update / delete — gated by Hermes /v1/hermes/lease per call
//   healthz : SELECT 1 (or honest stub when creds / pg client missing — never throws)
//
// Auth: ATOMEONS_PG_URL env (postgres://user:pass@host:port/db). External by design.
// Client: pg (lazy dynamic import; absence does not crash the registry).
// Spec: 11-MIRAGE/SPEC.md#postgres
//
// Reality always overrides Thought on conflict. Receipts override recollection.
// Writes never bypass approval. If the lease HTTP route is down and no in-process
// gate is reachable, write() refuses — silent fall-through is the breach.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const SPEC = '11-MIRAGE/SPEC.md#postgres';

const PG_URL          = process.env.ATOMEONS_PG_URL || '';
const HERMES_BASE     = process.env.HERMES_BASE || 'http://127.0.0.1:7430';
const HERMES_PATH     = process.env.HERMES_LEASE_PATH || '/v1/hermes/lease';
const HERMES_TOKEN    = process.env.HERMES_TOKEN || '';
const FETCH_TIMEOUT_MS = parseInt(process.env.MIRAGE_FETCH_TIMEOUT_MS || '2500', 10);

// ──────────────────────────────────────────────────────────────────────────────
// pg client — singleton Pool, lazy-loaded. Returns null when pg or creds missing.
// ──────────────────────────────────────────────────────────────────────────────
let _pool = null;
let _pgLoadError = null;

async function getPool() {
  if (_pool) return _pool;
  if (!PG_URL) return null;
  try {
    const mod = await import('pg');
    const Pool = mod.Pool || mod.default?.Pool;
    if (!Pool) throw new Error('pg.Pool not found in module export');
    _pool = new Pool({
      connectionString: PG_URL,
      // Conservative defaults; operator can override via env in future revs.
      max: parseInt(process.env.ATOMEONS_PG_POOL_MAX || '4', 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: FETCH_TIMEOUT_MS,
    });
    return _pool;
  } catch (err) {
    _pgLoadError = String(err?.message || err);
    return null;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// SQL discipline — read path is SELECT-only at the parser level.
// ──────────────────────────────────────────────────────────────────────────────
const SELECT_PREFIX = /^\s*(?:with\s[\s\S]+?\)\s*)?select\s/i;
const WRITE_VERBS = /\b(insert|update|delete|drop|truncate|alter|create|grant|revoke|merge|copy|vacuum|reindex)\b/i;

function isSelectOnly(sql) {
  if (typeof sql !== 'string' || sql.length === 0) return false;
  // Strip line comments and block comments before testing — defensive.
  const stripped = sql
    .replace(/--[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  if (!SELECT_PREFIX.test(stripped)) return false;
  // Allow SELECT-only CTEs; reject any embedded write verb.
  // (Permits column/table names like "updated_at" by requiring word boundaries
  // on both sides via the \b in WRITE_VERBS, then we also check it's not inside
  // a string literal — a cheap heuristic: count quotes before the match.)
  return !containsWriteVerbOutsideStrings(stripped);
}

function containsWriteVerbOutsideStrings(sql) {
  // Remove single-quoted strings (with doubled '' escape) and double-quoted identifiers.
  const cleaned = sql
    .replace(/'(?:''|[^'])*'/g, "''")
    .replace(/"(?:""|[^"])*"/g, '""');
  return WRITE_VERBS.test(cleaned);
}

// ──────────────────────────────────────────────────────────────────────────────
// Hermes lease — write path gate. Tries HTTP route first; honest refusal if down.
// ──────────────────────────────────────────────────────────────────────────────
async function requestLease({ action, table, sql, params, operator_approved }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${HERMES_BASE}${HERMES_PATH}`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'content-type': 'application/json',
        ...(HERMES_TOKEN ? { authorization: `Bearer ${HERMES_TOKEN}` } : {}),
      },
      body: JSON.stringify({
        actor: 'mirage.postgres',
        target_project: 'orange5',
        risk_level: 'high', // any write to external pg is high-risk by default
        action,
        resource: { mount: 'postgres', table },
        sql,
        params,
        operator_approved: !!operator_approved,
      }),
    });
    const txt = await res.text();
    let body;
    try { body = JSON.parse(txt); } catch { body = txt; }
    if (res.ok && body && (body.allowed === true || body.ok === true)) {
      return { ok: true, source: 'hermes_http', lease: body };
    }
    return { ok: false, source: 'hermes_http', status: res.status, detail: body };
  } catch (err) {
    return { ok: false, source: 'hermes_http', err: String(err?.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────────────────────────

/**
 * read(params)
 *   { op: 'query', sql, params? }       -> SELECT-only; returns { ok, rows, rowCount, fields }
 *   { op: 'schema', table }             -> column metadata from information_schema
 *   { op: 'list_tables', schema? }      -> table list from information_schema
 * Default op is 'query' when sql is present.
 */
async function read(params = {}) {
  const op = params.op || (params.sql ? 'query' : params.table ? 'schema' : 'list_tables');

  if (!PG_URL) {
    return { ok: false, reason: 'no_atomeons_pg_url', detail: 'ATOMEONS_PG_URL env not set', spec: SPEC };
  }
  const pool = await getPool();
  if (!pool) {
    return { ok: false, reason: 'pg_client_unavailable', detail: _pgLoadError || 'pg npm module not installed', spec: SPEC };
  }

  try {
    if (op === 'query') {
      const sql = String(params.sql || '');
      if (!isSelectOnly(sql)) {
        return { ok: false, reason: 'read_path_is_select_only', detail: 'use write() for mutations', spec: SPEC };
      }
      const r = await pool.query(sql, Array.isArray(params.params) ? params.params : []);
      return {
        ok: true,
        op,
        rows: r.rows,
        rowCount: r.rowCount,
        fields: r.fields?.map(f => ({ name: f.name, dataTypeID: f.dataTypeID })),
      };
    }

    if (op === 'schema') {
      const table = String(params.table || '');
      if (!table) return { ok: false, reason: 'table_required', spec: SPEC };
      const schema = String(params.schema || 'public');
      const r = await pool.query(
        `SELECT column_name, data_type, is_nullable, column_default, character_maximum_length
           FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = $2
          ORDER BY ordinal_position`,
        [schema, table],
      );
      return { ok: true, op, schema, table, columns: r.rows };
    }

    if (op === 'list_tables') {
      const schema = String(params.schema || 'public');
      const r = await pool.query(
        `SELECT table_name, table_type
           FROM information_schema.tables
          WHERE table_schema = $1
          ORDER BY table_name`,
        [schema],
      );
      return { ok: true, op, schema, tables: r.rows };
    }

    return { ok: false, reason: 'unknown_read_op', op, spec: SPEC };
  } catch (err) {
    return { ok: false, reason: 'pg_query_failed', detail: String(err?.message || err), spec: SPEC };
  }
}

/**
 * write(params)
 *   { op: 'insert' | 'update' | 'delete', sql, params?, table?, operator_approved? }
 * Required: a Hermes lease grant for the action. No lease == no mutation.
 * Caller passes `operator_approved: true` only after human-in-the-loop confirmation.
 */
async function write(params = {}) {
  const op = String(params.op || '').toLowerCase();
  if (!['insert', 'update', 'delete'].includes(op)) {
    return { ok: false, reason: 'write_op_required', detail: 'op must be insert|update|delete', spec: SPEC };
  }
  const sql = String(params.sql || '');
  if (!sql) return { ok: false, reason: 'sql_required', spec: SPEC };

  // SQL must match the declared op verb — cheap parser to refuse spoofed verbs.
  const verbRe = new RegExp(`^\\s*${op}\\b`, 'i');
  if (!verbRe.test(sql)) {
    return { ok: false, reason: 'sql_verb_mismatch', detail: `expected statement to begin with ${op.toUpperCase()}`, spec: SPEC };
  }

  if (!PG_URL) {
    return { ok: false, reason: 'no_atomeons_pg_url', detail: 'ATOMEONS_PG_URL env not set', spec: SPEC };
  }

  // Hermes lease — required. Honest refusal if route is down and not approved.
  const lease = await requestLease({
    action: `pg.${op}`,
    table: params.table || null,
    sql,
    params: Array.isArray(params.params) ? params.params : [],
    operator_approved: !!params.operator_approved,
  });
  if (!lease.ok) {
    return {
      ok: false,
      reason: 'hermes_lease_denied',
      detail: lease.detail || lease.err || `lease unreachable (${HERMES_BASE}${HERMES_PATH})`,
      lease_source: lease.source,
      spec: SPEC,
    };
  }

  const pool = await getPool();
  if (!pool) {
    return { ok: false, reason: 'pg_client_unavailable', detail: _pgLoadError || 'pg npm module not installed', spec: SPEC };
  }

  try {
    const r = await pool.query(sql, Array.isArray(params.params) ? params.params : []);
    return {
      ok: true,
      op,
      rowCount: r.rowCount,
      receipt: {
        mount: 'postgres',
        action: `pg.${op}`,
        lease_id: lease.lease?.id || lease.lease?.lease_id || null,
        lease_source: lease.source,
        table: params.table || null,
        timestamp: new Date().toISOString(),
      },
    };
  } catch (err) {
    return { ok: false, reason: 'pg_query_failed', detail: String(err?.message || err), spec: SPEC };
  }
}

/**
 * healthz()
 *   SELECT 1 on the configured pool. Honest stub when creds / pg missing — never throws.
 */
async function healthz() {
  if (!PG_URL) {
    return { ok: false, status: 'no_creds', detail: 'ATOMEONS_PG_URL env not set', spec: SPEC };
  }
  const pool = await getPool();
  if (!pool) {
    return { ok: false, status: 'pg_client_unavailable', detail: _pgLoadError || 'pg npm module not installed', spec: SPEC };
  }
  try {
    const r = await pool.query('SELECT 1 AS ok');
    const ok = r.rows?.[0]?.ok === 1;
    return { ok, status: ok ? 'ready' : 'unexpected_response', detail: ok ? null : JSON.stringify(r.rows), spec: SPEC };
  } catch (err) {
    return { ok: false, status: 'unreachable', detail: String(err?.message || err), spec: SPEC };
  }
}

// Exposed for tests — not part of the adapter contract.
export const __internals = Object.freeze({ isSelectOnly, containsWriteVerbOutsideStrings });

export const postgresAdapter = Object.freeze({ read, write, healthz });
export default postgresAdapter;
