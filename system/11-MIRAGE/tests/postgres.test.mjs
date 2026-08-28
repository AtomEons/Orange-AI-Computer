#!/usr/bin/env node
// 11-MIRAGE/tests/postgres.test.mjs
//
// Offline-safe test battery for the postgres adapter. Does NOT require a live
// postgres. Covers the four discipline gates:
//   1. healthz honest stub when ATOMEONS_PG_URL is missing (no throws)
//   2. SELECT-only enforcement on read({sql})
//   3. write verb / op coupling (SQL must begin with the declared op)
//   4. Hermes lease refusal when /v1/hermes/lease unreachable (no silent fall-through)
//
// Run: node 11-MIRAGE/tests/postgres.test.mjs

// Force a clean env BEFORE importing the adapter so module-level constants
// resolve to the test posture (no creds, lease pointed at a closed port).
delete process.env.ATOMEONS_PG_URL;
process.env.HERMES_BASE = 'http://127.0.0.1:1'; // closed loopback port
process.env.HERMES_LEASE_PATH = '/v1/hermes/lease';
process.env.MIRAGE_FETCH_TIMEOUT_MS = '500';

const { postgresAdapter, __internals } = await import('../adapters/postgres.mjs');

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log(`  PASS ${msg}`); }
  else      { fail++; console.log(`  FAIL ${msg}`); }
}

// ── 1. healthz honest stub ──────────────────────────────────────────────────
{
  const h = await postgresAdapter.healthz();
  assert(h.ok === false, 'healthz returns ok:false with no creds');
  assert(h.status === 'no_creds', 'healthz status is no_creds (not throws)');
  assert(typeof h.spec === 'string' && h.spec.includes('postgres'), 'healthz includes spec link');
}

// ── 2. SELECT-only enforcement (parser-level) ───────────────────────────────
{
  const { isSelectOnly } = __internals;
  assert(isSelectOnly('SELECT 1') === true, 'plain SELECT allowed');
  assert(isSelectOnly('  select * from t where updated_at > now()') === true,
    'SELECT with column named "updated_at" allowed (not a write verb)');
  assert(isSelectOnly("WITH x AS (SELECT 1) SELECT * FROM x") === true, 'SELECT-only CTE allowed');
  assert(isSelectOnly('INSERT INTO t VALUES (1)') === false, 'INSERT rejected');
  assert(isSelectOnly('UPDATE t SET x=1') === false, 'UPDATE rejected');
  assert(isSelectOnly('DELETE FROM t') === false, 'DELETE rejected');
  assert(isSelectOnly('DROP TABLE t') === false, 'DROP rejected');
  assert(isSelectOnly("SELECT 'delete from t' AS s") === true,
    'SELECT containing write verb inside a string literal allowed');
  assert(isSelectOnly('SELECT * FROM t; DELETE FROM t') === false,
    'piggybacked DELETE rejected');
  assert(isSelectOnly('') === false, 'empty sql rejected');
  assert(isSelectOnly('-- SELECT 1\nDELETE FROM t') === false,
    'commented-out SELECT does not whitelist following DELETE');
}

// ── 3. read() refuses non-SELECT (even without creds, parser fires first when sql present) ──
{
  // No creds, so read() returns no_atomeons_pg_url unless we trip the parser
  // first. The parser runs after the creds check, so we test the parser via
  // __internals (above) — here we just confirm the creds gate is honest.
  const r = await postgresAdapter.read({ sql: 'SELECT 1' });
  assert(r.ok === false, 'read() refuses without creds');
  assert(r.reason === 'no_atomeons_pg_url', 'read() reason is no_atomeons_pg_url');
}

// ── 4. write() verb/op coupling and lease refusal ───────────────────────────
{
  const r = await postgresAdapter.write({ op: 'select', sql: 'SELECT 1' });
  assert(r.ok === false && r.reason === 'write_op_required',
    'write() refuses non-mutation op');

  const r2 = await postgresAdapter.write({});
  assert(r2.ok === false && r2.reason === 'write_op_required',
    'write() refuses missing op');

  const r3 = await postgresAdapter.write({ op: 'insert' });
  assert(r3.ok === false && r3.reason === 'sql_required',
    'write() refuses missing sql');

  const r4 = await postgresAdapter.write({ op: 'insert', sql: 'DELETE FROM t' });
  assert(r4.ok === false && r4.reason === 'sql_verb_mismatch',
    'write() refuses op/verb mismatch (insert vs DELETE)');

  // op + sql aligned but no creds — should still fail BEFORE attempting lease.
  // (Honest: we don't pretend a write went through.)
  const r5 = await postgresAdapter.write({ op: 'insert', sql: 'INSERT INTO t VALUES (1)' });
  assert(r5.ok === false, 'write() with aligned op/sql but no creds refuses');
  assert(r5.reason === 'no_atomeons_pg_url',
    'write() reports no_atomeons_pg_url (creds gate fires before lease)');
}

// ── 5. lease refusal path — simulate creds present, Hermes down ─────────────
// We can't actually open a pool (pg not installed in this workspace), but we
// can drive the lease path by setting a fake PG_URL and observing that the
// adapter refuses cleanly when Hermes is unreachable. The module-level PG_URL
// is captured at import time, so reload with env set.
{
  process.env.ATOMEONS_PG_URL = 'postgres://nobody@127.0.0.1:1/db';
  // bust the module cache via cache-buster query string
  const fresh = await import('../adapters/postgres.mjs?reload=1');
  const r = await fresh.postgresAdapter.write({
    op: 'insert',
    sql: 'INSERT INTO t VALUES (1)',
    table: 't',
  });
  assert(r.ok === false, 'write() with creds but Hermes down refuses');
  assert(r.reason === 'hermes_lease_denied',
    `write() reason is hermes_lease_denied (got ${r.reason})`);
  assert(r.lease_source === 'hermes_http', 'lease_source recorded for audit');

  // healthz with creds + no pg client installed -> honest stub, no throw
  const h = await fresh.postgresAdapter.healthz();
  assert(h.ok === false, 'healthz returns ok:false when pg client missing');
  assert(['pg_client_unavailable', 'unreachable'].includes(h.status),
    `healthz status is pg_client_unavailable or unreachable (got ${h.status})`);
  delete process.env.ATOMEONS_PG_URL;
}

console.log(`\n[mirage/postgres] ${pass} passed / ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
