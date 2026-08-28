#!/usr/bin/env bun
// AUDIT-07 storage concurrency tests (added 2026-06-27).
//
// Three regression tests that prove the audit-07 fixes are in place:
//   1. two_process_concurrent_writes_no_loss
//      Two Bun subprocesses each insert 500 receipts to the same file DB.
//      Expect 1000/1000 inserted, 0 SQLITE_BUSY exceptions. Pre-fix baseline
//      was ~46.8% loss; fix is `PRAGMA busy_timeout=5000` in init().
//
//   2. getReceiptStats_atomic_under_load
//      A long-running insert task runs in the same process while we call
//      getReceiptStats() 100 times. Every call's `total` must equal the sum
//      of `by_status`. Pre-fix baseline had non-atomic 3-statement aggregates;
//      fix wraps the aggregates in a transaction snapshot.
//
//   3. init_idempotent_on_reopen
//      Open and close the same file DB twice. No errors, no duplicate meta
//      rows. Pre-fix baseline always re-INSERTed meta rows + re-ran the 620-
//      row registerFeatures sweep; fix gates both on schema_version match.
//
// Run: bun tests/concurrency.test.mjs
// Exits 0 if all cases pass, non-zero otherwise.

import { Store } from '../storage.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKER = path.join(__dirname, 'workers', 'storage-concurrent-writer.mjs');

const TESTS = [];
function test(name, fn) { TESTS.push({ name, fn }); }

function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}
function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(`expected ${JSON.stringify(b)}, got ${JSON.stringify(a)} — ${msg}`);
}

function tmpDbPath(label) {
  return path.join(os.tmpdir(), `atomsmasher-${label}-${process.hrtime.bigint()}.db`);
}

function cleanupDb(p) {
  for (const sfx of ['', '-shm', '-wal', '-journal']) {
    try { fs.unlinkSync(p + sfx); } catch { /* noop */ }
  }
}

async function spawnWorker(dbPath, workerId, count) {
  const proc = Bun.spawn({
    cmd: ['bun', WORKER, dbPath, workerId, String(count)],
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  let parsed = null;
  try { parsed = JSON.parse(out.trim()); } catch { /* leave null */ }
  return { exitCode, parsed, stderr: err };
}

// ---------------------------------------------------------------------------
// Test 1 — two_process_concurrent_writes_no_loss
// ---------------------------------------------------------------------------

test('two_process_concurrent_writes_no_loss', async () => {
  const dbPath = tmpDbPath('concurrency-2proc');
  // Pre-init so both workers see the schema. Initialize and close to flush WAL.
  const init = new Store(dbPath);
  init.close();
  try {
    const PER = 500;
    const [a, b] = await Promise.all([
      spawnWorker(dbPath, 'A', PER),
      spawnWorker(dbPath, 'B', PER),
    ]);
    if (a.exitCode !== 0 || !a.parsed) {
      throw new Error(`worker A failed exit=${a.exitCode} stderr=${a.stderr.slice(0, 200)}`);
    }
    if (b.exitCode !== 0 || !b.parsed) {
      throw new Error(`worker B failed exit=${b.exitCode} stderr=${b.stderr.slice(0, 200)}`);
    }
    assertEqual(a.parsed.errors_count, 0, `worker A errors: ${JSON.stringify(a.parsed.errors_sample)}`);
    assertEqual(b.parsed.errors_count, 0, `worker B errors: ${JSON.stringify(b.parsed.errors_sample)}`);
    assertEqual(a.parsed.succeeded, PER, 'worker A all 500 succeeded');
    assertEqual(b.parsed.succeeded, PER, 'worker B all 500 succeeded');
    // Verify the union landed.
    const reader = new Store(dbPath);
    try {
      const total = reader.one('SELECT COUNT(*) c FROM receipts WHERE action=?', ['concurrency.test']).c;
      const distinct = reader.one('SELECT COUNT(DISTINCT id) c FROM receipts WHERE action=?', ['concurrency.test']).c;
      assertEqual(total, 2 * PER, `union total = ${2 * PER}`);
      assertEqual(distinct, 2 * PER, `union distinct ids = ${2 * PER}`);
    } finally { reader.close(); }
  } finally {
    cleanupDb(dbPath);
  }
});

// ---------------------------------------------------------------------------
// Test 2 — getReceiptStats_atomic_under_load
// ---------------------------------------------------------------------------

test('getReceiptStats_atomic_under_load', async () => {
  const dbPath = tmpDbPath('concurrency-stats');
  const store = new Store(dbPath);
  try {
    // Seed with a few receipts so by_status is populated immediately.
    store.insertReceipt('seed.ok', 'ok', 'seed', {});
    store.insertReceipt('seed.error', 'error', 'seed', {});
    store.insertReceipt('seed.warn', 'warn', 'seed', {});
    store.insertReceipt('seed.pending', 'pending', 'seed', {});

    // Background insert task: 1000 receipts, yielding to the loop to let the
    // stats reader race in between.
    let writerDone = false;
    const writer = (async () => {
      for (let i = 0; i < 1000; i++) {
        const status = ['ok', 'error', 'warn', 'pending'][i & 3];
        store.insertReceipt('load.test', status, `i=${i}`, { i });
        if ((i & 31) === 0) await Promise.resolve();
      }
      writerDone = true;
    })();

    // Stats reader: call getReceiptStats 100 times. Every call's total must
    // equal sum(by_status). Pre-fix baseline saw disagreement under live writes.
    let disagreements = 0;
    let calls = 0;
    while (!writerDone && calls < 100) {
      const stats = store.getReceiptStats();
      const sum = Object.values(stats.by_status).reduce((a, b) => a + b, 0);
      if (sum !== stats.total) disagreements++;
      calls++;
      await Promise.resolve();
    }
    // Drain remaining iterations even if the writer finished early.
    while (calls < 100) {
      const stats = store.getReceiptStats();
      const sum = Object.values(stats.by_status).reduce((a, b) => a + b, 0);
      if (sum !== stats.total) disagreements++;
      calls++;
    }
    await writer;

    assertEqual(disagreements, 0, `expected 0 atomic-snapshot disagreements across 100 reads, got ${disagreements}`);
    assertEqual(calls, 100, '100 stats calls completed');

    // Final check: writer's totals are visible.
    const finalStats = store.getReceiptStats();
    const finalSum = Object.values(finalStats.by_status).reduce((a, b) => a + b, 0);
    assertEqual(finalSum, finalStats.total, 'final snapshot: total = sum(by_status)');
    assert(finalStats.total >= 1004, `final total includes 4 seed + 1000 load (got ${finalStats.total})`);
  } finally {
    try { store.close(); } catch { /* noop */ }
    cleanupDb(dbPath);
  }
});

// ---------------------------------------------------------------------------
// Test 3 — init_idempotent_on_reopen
// ---------------------------------------------------------------------------

test('init_idempotent_on_reopen', () => {
  const dbPath = tmpDbPath('concurrency-idempotent');
  try {
    // First open — initializes from scratch.
    const a = new Store(dbPath);
    const metaCountA = a.one('SELECT COUNT(*) c FROM meta').c;
    const featCountA = a.one('SELECT COUNT(*) c FROM features').c;
    a.close();

    // Second open — must NOT throw and must NOT add new meta or feature rows.
    const b = new Store(dbPath);
    const metaCountB = b.one('SELECT COUNT(*) c FROM meta').c;
    const featCountB = b.one('SELECT COUNT(*) c FROM features').c;
    // schema_version meta row must still be readable and singular.
    const versionRows = b.all("SELECT value FROM meta WHERE key='schema_version'");
    b.close();

    assertEqual(metaCountB, metaCountA, 'meta row count unchanged on reopen');
    assertEqual(featCountB, featCountA, 'feature row count unchanged on reopen');
    assertEqual(versionRows.length, 1, 'exactly one schema_version row after reopen');

    // Third open — same again, to be sure repeated opens stay idempotent.
    const c = new Store(dbPath);
    const metaCountC = c.one('SELECT COUNT(*) c FROM meta').c;
    const featCountC = c.one('SELECT COUNT(*) c FROM features').c;
    c.close();
    assertEqual(metaCountC, metaCountA, 'meta row count unchanged on third open');
    assertEqual(featCountC, featCountA, 'feature row count unchanged on third open');
  } finally {
    cleanupDb(dbPath);
  }
});

// ---------------------------------------------------------------------------
console.log('AtomSmasher Storage Concurrency — Bun test sweep (AUDIT-07 regressions)');
console.log('Bun ' + (process.versions?.bun || 'unknown'));
console.log('');
let pass = 0, fail = 0;
for (const t of TESTS) {
  const t0 = Date.now();
  try {
    await t.fn();
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
