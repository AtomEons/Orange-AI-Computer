#!/usr/bin/env bun
// AUDIT-07 concurrency test worker (added 2026-06-27).
//
// Spawned by tests/concurrency.test.mjs as a separate Bun process to exercise
// two-process write contention against the same file DB.
//
// Argv: [0]=bun, [1]=this script, [2]=dbPath, [3]=workerId, [4]=count
// Stdout: one JSON line on success, of shape:
//   { worker, attempted, succeeded, errors_count, errors_sample, duration_ms }
// Exit: 0 on completion (regardless of per-insert errors — caller decides).

import { Store } from '../../storage.mjs';

const dbPath = process.argv[2];
const workerId = process.argv[3];
const count = parseInt(process.argv[4], 10);

if (!dbPath || !workerId || !count) {
  console.error('usage: bun storage-concurrent-writer.mjs <dbPath> <workerId> <count>');
  process.exit(2);
}

const store = new Store(dbPath);

const errors = [];
const ids = [];
const t0 = Date.now();
for (let i = 0; i < count; i++) {
  try {
    const rid = store.insertReceipt(
      'concurrency.test',
      'ok',
      `worker=${workerId} i=${i}`,
      { worker: workerId, i }
    );
    ids.push(rid);
  } catch (e) {
    errors.push({ i, message: e.message });
  }
}
const dt = Date.now() - t0;

const out = {
  worker: workerId,
  attempted: count,
  succeeded: ids.length,
  errors_count: errors.length,
  errors_sample: errors.slice(0, 3),
  duration_ms: dt,
};
store.close();
console.log(JSON.stringify(out));
process.exit(0);
