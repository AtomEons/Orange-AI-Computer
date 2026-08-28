#!/usr/bin/env bun
// Storage API hardening — Bun test suite (Part C, 2026-06-27).
// Covers Part A (insertReceipt schema gate) + Part B (new query methods).
//
// Run: bun 12-ATOMSMASHER/full-scope/tests/storage-api.test.mjs
// Exits 0 if all cases pass, non-zero otherwise.

import { Store } from '../storage.mjs';

const TESTS = [];
function test(name, fn) { TESTS.push({ name, fn }); }

function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}
function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(`expected ${JSON.stringify(b)}, got ${JSON.stringify(a)} — ${msg}`);
}
function assertGE(a, b, msg) {
  if (!(a >= b)) throw new Error(`expected ${a} >= ${b} — ${msg}`);
}
function assertThrows(fn, needle, msg) {
  let caught = null;
  try { fn(); } catch (e) { caught = e; }
  if (!caught) throw new Error(`expected throw — ${msg}`);
  if (needle && !String(caught.message).includes(needle)) {
    throw new Error(`expected error to include ${JSON.stringify(needle)}, got ${JSON.stringify(caught.message)} — ${msg}`);
  }
  return caught;
}

// ---------------------------------------------------------------------------
// Part A — schema gate
// ---------------------------------------------------------------------------

test('valid_receipts_accepted_across_all_status_values', () => {
  const store = new Store(':memory:');
  try {
    const before = store.one('SELECT COUNT(*) c FROM receipts').c;
    // Each allowed status, exercising every payload shape: null, object, undefined, JSON string.
    const r1 = store.insertReceipt('test.ok', 'ok', 'ok msg', { x: 1 });
    const r2 = store.insertReceipt('test.error', 'error', 'err msg', null);
    const r3 = store.insertReceipt('test.warn', 'warn', '', undefined);
    const r4 = store.insertReceipt('test.pending', 'pending', 'pending msg', '{"y":2}');
    for (const id of [r1, r2, r3, r4]) {
      assert(typeof id === 'string' && id.startsWith('rcpt_'), `valid receipt id: ${id}`);
    }
    const after = store.one('SELECT COUNT(*) c FROM receipts').c;
    assertEqual(after - before, 4, 'four receipts inserted');
    // Verify JSON string passthrough did not double-encode.
    const row = store.one('SELECT payload_json FROM receipts WHERE id=?', [r4]);
    assertEqual(row.payload_json, '{"y":2}', 'JSON string passthrough preserved');
  } finally { store.close(); }
});

test('malformed_action_rejected_each_rule', () => {
  const store = new Store(':memory:');
  try {
    const before = store.one('SELECT COUNT(*) c FROM receipts').c;
    // empty action
    assertThrows(() => store.insertReceipt('', 'ok', 's', {}), 'action must be a non-empty string', 'empty action');
    // non-string action
    assertThrows(() => store.insertReceipt(null, 'ok', 's', {}), 'action must be a non-empty string', 'null action');
    assertThrows(() => store.insertReceipt(42, 'ok', 's', {}), 'action must be a non-empty string', 'number action');
    // whitespace
    assertThrows(() => store.insertReceipt('bad action', 'ok', 's', {}), 'must not contain whitespace', 'space');
    assertThrows(() => store.insertReceipt('bad\taction', 'ok', 's', {}), 'must not contain whitespace', 'tab');
    assertThrows(() => store.insertReceipt('bad\naction', 'ok', 's', {}), 'must not contain whitespace', 'newline');
    // No partial inserts — count unchanged.
    const after = store.one('SELECT COUNT(*) c FROM receipts').c;
    assertEqual(after, before, 'no rows inserted from rejected calls');
  } finally { store.close(); }
});

test('malformed_status_summary_payload_rejected', () => {
  const store = new Store(':memory:');
  try {
    const before = store.one('SELECT COUNT(*) c FROM receipts').c;
    // status out of set
    assertThrows(() => store.insertReceipt('a', 'bogus', 's', {}), 'status must be one of', 'bogus status');
    assertThrows(() => store.insertReceipt('a', '', 's', {}), 'status must be one of', 'empty status');
    assertThrows(() => store.insertReceipt('a', null, 's', {}), 'status must be one of', 'null status');
    assertThrows(() => store.insertReceipt('a', 1, 's', {}), 'status must be one of', 'numeric status');
    // summary non-string
    assertThrows(() => store.insertReceipt('a', 'ok', 123, {}), 'summary must be a string', 'numeric summary');
    assertThrows(() => store.insertReceipt('a', 'ok', { not: 'a string' }, {}), 'summary must be a string', 'object summary');
    assertThrows(() => store.insertReceipt('a', 'ok', null, {}), 'summary must be a string', 'null summary');
    // payload bad types
    assertThrows(() => store.insertReceipt('a', 'ok', 's', 42), 'payload must be', 'numeric payload');
    assertThrows(() => store.insertReceipt('a', 'ok', 's', true), 'payload must be', 'boolean payload');
    assertThrows(() => store.insertReceipt('a', 'ok', 's', '{invalid json'), 'JSON-parseable', 'bad JSON string payload');
    // No partial inserts
    const after = store.one('SELECT COUNT(*) c FROM receipts').c;
    assertEqual(after, before, 'no rows inserted from rejected calls');
  } finally { store.close(); }
});

// ---------------------------------------------------------------------------
// Part B — new query methods
// ---------------------------------------------------------------------------

test('getReceiptsByAction_returns_only_matching_rows', () => {
  const store = new Store(':memory:');
  try {
    for (let i = 0; i < 5; i++) store.insertReceipt('action.alpha', 'ok', `alpha ${i}`, { i });
    for (let i = 0; i < 3; i++) store.insertReceipt('action.beta', 'ok', `beta ${i}`, { i });
    const alphas = store.getReceiptsByAction('action.alpha');
    const betas = store.getReceiptsByAction('action.beta');
    const missing = store.getReceiptsByAction('action.does_not_exist');
    assertEqual(alphas.length, 5, 'alpha count');
    assertEqual(betas.length, 3, 'beta count');
    assertEqual(missing.length, 0, 'missing returns empty array');
    for (const r of alphas) assertEqual(r.action, 'action.alpha', 'shape: action');
    // shape sanity
    const sample = alphas[0];
    for (const k of ['id', 'action', 'status', 'summary', 'payload_json', 'created_at']) {
      assert(k in sample, `field ${k} present`);
    }
    // input validation
    assertThrows(() => store.getReceiptsByAction(''), 'non-empty string', 'empty action');
    assertThrows(() => store.getReceiptsByAction(null), 'non-empty string', 'null action');
  } finally { store.close(); }
});

test('getReceiptsByTimeRange_filters_by_created_at', () => {
  const store = new Store(':memory:');
  try {
    // Insert some real receipts (created_at is stamped by nowIso() inside insertReceipt).
    for (let i = 0; i < 10; i++) store.insertReceipt('time.test', 'ok', `t${i}`, { i });
    const all = store.all('SELECT created_at FROM receipts WHERE action=? ORDER BY created_at ASC', ['time.test']);
    const earliest = all[0].created_at;
    const latest = all[all.length - 1].created_at;
    // Full range: should return all 10.
    const fullRange = store.getReceiptsByTimeRange(earliest, latest);
    assertEqual(fullRange.length, 10, 'full range returns all');
    // Tiny range outside: should return 0 (use a year in 1900 to be safe).
    const empty = store.getReceiptsByTimeRange('1900-01-01T00:00:00Z', '1900-12-31T00:00:00Z');
    assertEqual(empty.length, 0, 'out-of-range returns empty');
    // input validation
    assertThrows(() => store.getReceiptsByTimeRange(null, latest), 'must be strings', 'null from');
    assertThrows(() => store.getReceiptsByTimeRange(earliest, 42), 'must be strings', 'numeric to');
  } finally { store.close(); }
});

test('searchReceiptsBySummary_LIKE_substring_works', () => {
  const store = new Store(':memory:');
  try {
    store.insertReceipt('s.test', 'ok', 'apple pie recipe', { kind: 'food' });
    store.insertReceipt('s.test', 'ok', 'apple cider', { kind: 'drink' });
    store.insertReceipt('s.test', 'ok', 'banana split', { kind: 'food' });
    store.insertReceipt('s.test', 'ok', '', { kind: 'empty' });
    const apples = store.searchReceiptsBySummary('apple');
    assertEqual(apples.length, 2, 'two apple matches');
    const cider = store.searchReceiptsBySummary('cider');
    assertEqual(cider.length, 1, 'one cider match');
    const nada = store.searchReceiptsBySummary('mango');
    assertEqual(nada.length, 0, 'no mango matches');
    // Empty substring matches all non-null summaries (LIKE '%%' is true for any string).
    const all = store.searchReceiptsBySummary('');
    assertGE(all.length, 4, 'empty substring matches all');
    // LIKE wildcard escape — '%' as literal must not act as wildcard.
    store.insertReceipt('s.test', 'ok', '100% pure honey', { kind: 'sweet' });
    const literalPercent = store.searchReceiptsBySummary('100%');
    assertEqual(literalPercent.length, 1, 'literal % escaped properly');
    // input validation
    assertThrows(() => store.searchReceiptsBySummary(null), 'must be a string', 'null substring');
    assertThrows(() => store.searchReceiptsBySummary(42), 'must be a string', 'numeric substring');
  } finally { store.close(); }
});

test('getReceiptStats_aggregates_total_and_groups', () => {
  const store = new Store(':memory:');
  try {
    store.insertReceipt('stat.a', 'ok', 'one', {});
    store.insertReceipt('stat.a', 'ok', 'two', {});
    store.insertReceipt('stat.a', 'error', 'three', {});
    store.insertReceipt('stat.b', 'warn', 'four', {});
    store.insertReceipt('stat.b', 'pending', 'five', {});
    const stats = store.getReceiptStats();
    assert(typeof stats.total === 'number', 'total is number');
    assertGE(stats.total, 5, 'total >= 5');
    assertEqual(stats.by_action['stat.a'], 3, 'stat.a count');
    assertEqual(stats.by_action['stat.b'], 2, 'stat.b count');
    // by_status totals should sum to total
    const statusSum = Object.values(stats.by_status).reduce((a, b) => a + b, 0);
    assertEqual(statusSum, stats.total, 'by_status sums to total');
    // Each known status family present in this store
    assert('ok' in stats.by_status, 'ok present');
    assert('error' in stats.by_status, 'error present');
    assert('warn' in stats.by_status, 'warn present');
    assert('pending' in stats.by_status, 'pending present');
    assertGE(stats.by_status.warn, 1, 'warn count');
    assertGE(stats.by_status.pending, 1, 'pending count');
  } finally { store.close(); }
});

test('pagination_limit_and_offset_respected', () => {
  const store = new Store(':memory:');
  try {
    for (let i = 0; i < 25; i++) store.insertReceipt('page.test', 'ok', `summary ${i}`, { i });
    const firstPage = store.getReceiptsByAction('page.test', { limit: 10, offset: 0 });
    const secondPage = store.getReceiptsByAction('page.test', { limit: 10, offset: 10 });
    const lastPage = store.getReceiptsByAction('page.test', { limit: 10, offset: 20 });
    assertEqual(firstPage.length, 10, 'page 1 len');
    assertEqual(secondPage.length, 10, 'page 2 len');
    assertEqual(lastPage.length, 5, 'page 3 len (tail)');
    // Pages must not overlap by id.
    const ids = new Set([...firstPage, ...secondPage, ...lastPage].map(r => r.id));
    assertEqual(ids.size, 25, 'pages cover all 25 unique ids');
    // Defaults work.
    const def = store.getReceiptsByAction('page.test');
    assertEqual(def.length, 25, 'default limit covers all 25');
    // limit clamping: 0 returns empty, negative coerced to 0
    const zero = store.getReceiptsByAction('page.test', { limit: 0 });
    assertEqual(zero.length, 0, 'limit=0 returns empty');
    // time-range pagination
    const all = store.all("SELECT created_at FROM receipts WHERE action='page.test' ORDER BY created_at ASC");
    const fromTs = all[0].created_at, toTs = all[all.length - 1].created_at;
    const tr = store.getReceiptsByTimeRange(fromTs, toTs, { limit: 7 });
    assertEqual(tr.length, 7, 'time-range limit=7');
    // search-by-summary pagination
    const sr = store.searchReceiptsBySummary('summary', { limit: 3 });
    assertEqual(sr.length, 3, 'search limit=3');
  } finally { store.close(); }
});

// ---------------------------------------------------------------------------
console.log('AtomSmasher Storage API Hardening — Bun test sweep');
console.log('Bun ' + (process.versions?.bun || 'unknown'));
console.log('');
let pass = 0, fail = 0;
for (const t of TESTS) {
  const t0 = Date.now();
  try {
    t.fn();
    pass++;
    console.log(`  PASS  ${t.name.padEnd(55)} ${(Date.now() - t0).toString().padStart(5)}ms`);
  } catch (e) {
    fail++;
    console.log(`  FAIL  ${t.name.padEnd(55)} ${(Date.now() - t0).toString().padStart(5)}ms  ${e.message}`);
    if (process.env.VERBOSE) console.log(e.stack);
  }
}
console.log('');
console.log(`Summary: ${pass} pass / ${fail} fail of ${TESTS.length}`);
if (fail > 0) process.exit(1);
process.exit(0);
