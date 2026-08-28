#!/usr/bin/env bun
// bin/atomsmasher-smoke-all.mjs — CI gate: run all AtomSmasher 2 module smokes
//
// Operator law (2026-06-25): Bun-only. AtomSmasher 2 is Pillar 5.
// Every module's smoke-test.mjs must exit 0 before a release can ship.
//
// Usage:
//   bun bin/atomsmasher-smoke-all.mjs           — run all 11 module smokes
//   bun bin/atomsmasher-smoke-all.mjs --json    — emit JSON summary
//   bun bin/atomsmasher-smoke-all.mjs --strict  — exit non-zero on any fail
//
// Exit code:
//   0  — all 11 modules pass
//   1  — one or more failed (or --strict trigger)

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ATOMSMASHER_ROOT = path.resolve(__dirname, '..', '12-ATOMSMASHER');

const MODULES = [
  'air-codec',
  'canon-pressure',
  'cartridges',
  'commitment-atoms',
  'compression-debt',
  'equation-store',
  'expansion-warrants',
  'least-action',
  'pathwave',
  'saved-work',
  'sparse-worksets',
];

const argv = process.argv.slice(2);
const wantJson = argv.includes('--json');
const wantStrict = argv.includes('--strict');

const bunPath = process.execPath;
if (typeof globalThis.Bun === 'undefined') {
  console.error('FAIL: this gate must run under Bun (bun bin/atomsmasher-smoke-all.mjs)');
  process.exit(1);
}

const results = [];
for (const m of MODULES) {
  const smoke = path.join(ATOMSMASHER_ROOT, m, 'smoke-test.mjs');
  const t0 = Number(process.hrtime.bigint() / 1000000n);
  const r = spawnSync(bunPath, [smoke], {
    encoding: 'utf8',
    cwd: path.join(ATOMSMASHER_ROOT, m),
    timeout: 60_000,
  });
  const t1 = Number(process.hrtime.bigint() / 1000000n);
  const lastLine = (r.stdout || r.stderr || '').trim().split('\n').pop() || '';
  results.push({
    module: m,
    ok: r.status === 0,
    exit_code: r.status,
    elapsed_ms: t1 - t0,
    last_line: lastLine,
  });
}

const passed = results.filter(r => r.ok).length;
const failed = results.length - passed;
const totalMs = results.reduce((a, r) => a + r.elapsed_ms, 0);

if (wantJson) {
  console.log(JSON.stringify({
    runner: 'atomsmasher-smoke-all',
    timestamp: new Date().toISOString(),
    bun_version: process.versions.bun ?? null,
    total: results.length,
    passed,
    failed,
    elapsed_ms: totalMs,
    modules: results,
  }, null, 2));
} else {
  console.log('AtomSmasher 2 — 11-module smoke sweep');
  console.log(`Bun ${process.versions.bun ?? '?'} · runtime ${totalMs}ms`);
  console.log('');
  for (const r of results) {
    const flag = r.ok ? 'PASS' : 'FAIL';
    console.log(`  ${flag}  ${r.module.padEnd(20)} ${String(r.elapsed_ms).padStart(5)}ms  ${r.last_line.slice(0, 80)}`);
  }
  console.log('');
  console.log(`Summary: ${passed} pass / ${failed} fail of ${results.length}`);
}

const exitOk = wantStrict ? failed === 0 : true;
process.exit(exitOk && failed === 0 ? 0 : (wantStrict ? 1 : 0));
