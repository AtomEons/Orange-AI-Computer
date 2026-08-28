// Determinism unlock verification test
// Verifies: with ATOMSMASHER_DETERMINISM_SEED set, calls to uniqueRuntimeId
// produce identical sequences across runs. This is what unlocks the
// replay pipeline (PERFECT_SYNTHESIS Law 1).

import { uniqueRuntimeId, __resetDeterminismCounter } from '../engines.mjs';

const TESTS = [];
function test(name, fn) { TESTS.push({ name, fn }); }

test('deterministic_mode_off_by_default', () => {
  if (process.env.ATOMSMASHER_DETERMINISM_SEED) {
    throw new Error('Env var should not be set in this test segment');
  }
  const id1 = uniqueRuntimeId('rcpt_', 'a');
  const id2 = uniqueRuntimeId('rcpt_', 'a');
  if (id1 === id2) throw new Error('Without seed, IDs should differ: ' + id1);
  if (!id1.startsWith('rcpt_') || id1.length !== 21) throw new Error('Bad ID format: ' + id1);
  return `ok (rnd ids differ: ${id1.slice(0,10)}... ≠ ${id2.slice(0,10)}...)`;
});

test('deterministic_mode_on_repeats', () => {
  process.env.ATOMSMASHER_DETERMINISM_SEED = 'unit-test-seed';
  __resetDeterminismCounter();
  const first = [uniqueRuntimeId('a_', 'x'), uniqueRuntimeId('b_', 'y'), uniqueRuntimeId('c_', 'z')];
  __resetDeterminismCounter();
  const second = [uniqueRuntimeId('a_', 'x'), uniqueRuntimeId('b_', 'y'), uniqueRuntimeId('c_', 'z')];
  for (let i = 0; i < 3; i++) {
    if (first[i] !== second[i]) throw new Error(`mismatch at ${i}: ${first[i]} vs ${second[i]}`);
  }
  delete process.env.ATOMSMASHER_DETERMINISM_SEED;
  return `ok (3 ids reproduced: ${first.join(', ')})`;
});

test('deterministic_mode_changes_with_parts', () => {
  process.env.ATOMSMASHER_DETERMINISM_SEED = 'unit-test-seed';
  __resetDeterminismCounter();
  const a = uniqueRuntimeId('rcpt_', 'alpha');
  __resetDeterminismCounter();
  const b = uniqueRuntimeId('rcpt_', 'beta');
  if (a === b) throw new Error('Different parts must produce different IDs');
  delete process.env.ATOMSMASHER_DETERMINISM_SEED;
  return `ok (alpha=${a.slice(0,16)} ≠ beta=${b.slice(0,16)})`;
});

test('deterministic_mode_changes_with_seed', () => {
  process.env.ATOMSMASHER_DETERMINISM_SEED = 'seed-A';
  __resetDeterminismCounter();
  const a = uniqueRuntimeId('rcpt_', 'fixed');
  process.env.ATOMSMASHER_DETERMINISM_SEED = 'seed-B';
  __resetDeterminismCounter();
  const b = uniqueRuntimeId('rcpt_', 'fixed');
  if (a === b) throw new Error('Different seeds must produce different IDs');
  delete process.env.ATOMSMASHER_DETERMINISM_SEED;
  return `ok (seed-A=${a.slice(0,16)} ≠ seed-B=${b.slice(0,16)})`;
});

test('deterministic_mode_unique_within_session', () => {
  process.env.ATOMSMASHER_DETERMINISM_SEED = 'unit-test-seed';
  __resetDeterminismCounter();
  const ids = new Set();
  for (let i = 0; i < 100; i++) ids.add(uniqueRuntimeId('rcpt_'));
  if (ids.size !== 100) throw new Error('IDs should be unique within session, got ' + ids.size + ' / 100');
  delete process.env.ATOMSMASHER_DETERMINISM_SEED;
  return `ok (100 unique ids)`;
});

console.log('AtomSmasher Determinism Unlock — 5-case Bun test sweep');
console.log('Bun ' + (process.versions?.bun || 'unknown'));
console.log('');
let pass = 0, fail = 0;
for (const t of TESTS) {
  const t0 = Date.now();
  try {
    const note = t.fn();
    pass++;
    console.log(`  PASS  ${t.name.padEnd(45)} ${(Date.now() - t0).toString().padStart(4)}ms  ${note || ''}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL  ${t.name.padEnd(45)} ${(Date.now() - t0).toString().padStart(4)}ms  ${e.message}`);
  }
}
console.log('');
console.log(`Summary: ${pass} pass / ${fail} fail of ${TESTS.length}`);
if (fail > 0) process.exit(1);
