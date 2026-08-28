#!/usr/bin/env bun
// AtomSmasher Full-Scope — Parallel test orchestrator.
//
// Spawns every test suite in tests/ (matching *.test.mjs) as an independent
// Bun subprocess via Bun.spawn, awaits them with Promise.all, aggregates
// pass/fail counts from each suite's "Summary: N pass / M fail of T" line,
// and writes a receipt next to the runner.
//
// Run: bun tests/run-all.mjs
// Exit code: 0 if every suite is all-green, non-zero otherwise.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SUITES = [
  'full-scope.test.mjs',
  'determinism.test.mjs',
  'codec-export.test.mjs',
  'numeric-integrity.test.mjs',
  'replay-integration.test.mjs',
  'sieve.test.mjs',
  'storage-api.test.mjs',
  'concurrency.test.mjs',
  'feature-distinctness.test.mjs',
  'schema-caps.test.mjs',
  'internal-parity.test.mjs',
];

function existing(files) {
  return files
    .map((f) => ({ name: f, full: path.join(__dirname, f) }))
    .filter((s) => fs.existsSync(s.full));
}

function parseSummary(stdout) {
  // Look for "Summary: N pass / M fail of T"
  const m = stdout.match(/Summary:\s*(\d+)\s*pass\s*\/\s*(\d+)\s*fail\s*of\s*(\d+)/i);
  if (!m) return null;
  return {
    pass: Number(m[1]),
    fail: Number(m[2]),
    total: Number(m[3]),
  };
}

async function runSuite(suite) {
  const started = performance.now();
  const proc = Bun.spawn(['bun', suite.full], {
    cwd: __dirname,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  const elapsedMs = performance.now() - started;
  const summary = parseSummary(stdout) ?? parseSummary(stderr) ?? {
    pass: 0,
    fail: 0,
    total: 0,
  };

  return {
    name: suite.name,
    exitCode,
    elapsedMs: Math.round(elapsedMs),
    pass: summary.pass,
    fail: summary.fail,
    total: summary.total,
    stdout,
    stderr,
  };
}

async function main() {
  const suites = existing(SUITES);
  if (suites.length === 0) {
    console.error('run-all: no test suites found in', __dirname);
    process.exit(2);
  }

  const wallStart = performance.now();
  const results = await Promise.all(suites.map(runSuite));
  const wallMs = Math.round(performance.now() - wallStart);

  let totalPass = 0;
  let totalFail = 0;
  let totalCases = 0;
  let nonZeroExits = 0;

  console.log('parallel suite results');
  console.log('----------------------');
  for (const r of results) {
    totalPass += r.pass;
    totalFail += r.fail;
    totalCases += r.total;
    if (r.exitCode !== 0) nonZeroExits++;
    const tag = r.exitCode === 0 && r.fail === 0 ? 'PASS' : 'FAIL';
    console.log(
      `  [${tag}] ${r.name.padEnd(28)} ${String(r.elapsedMs).padStart(6)}ms` +
        `  ${r.pass}/${r.total} pass  fail=${r.fail}  exit=${r.exitCode}`,
    );
  }
  console.log('----------------------');
  console.log(
    `aggregate: ${totalPass}/${totalCases} pass  fail=${totalFail}  ` +
      `suites=${results.length}  wall=${wallMs}ms`,
  );

  // On any failure, surface the failing suite's stderr/stdout.
  for (const r of results) {
    if (r.exitCode !== 0 || r.fail > 0) {
      console.log(`\n--- ${r.name} stdout ---\n${r.stdout}`);
      if (r.stderr.trim()) {
        console.log(`--- ${r.name} stderr ---\n${r.stderr}`);
      }
    }
  }

  // Receipt.
  const receiptDir = path.join(__dirname, '..', 'receipts');
  try {
    fs.mkdirSync(receiptDir, { recursive: true });
  } catch {}
  const receipt = {
    kind: 'parallel-test-orchestrator',
    version: 'v1',
    timestamp_iso: new Date().toISOString(),
    cwd: __dirname,
    suite_count: results.length,
    total_cases: totalCases,
    total_pass: totalPass,
    total_fail: totalFail,
    nonzero_exits: nonZeroExits,
    wall_ms_parallel: wallMs,
    suites: results.map((r) => ({
      name: r.name,
      exit_code: r.exitCode,
      elapsed_ms: r.elapsedMs,
      pass: r.pass,
      fail: r.fail,
      total: r.total,
    })),
  };
  const stamp = receipt.timestamp_iso.replace(/[:.]/g, '-');
  const receiptPath = path.join(receiptDir, `run-all-${stamp}.json`);
  fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
  console.log(`\nreceipt: ${receiptPath}`);

  const allGreen = totalFail === 0 && nonZeroExits === 0;
  process.exit(allGreen ? 0 : 1);
}

main().catch((err) => {
  console.error('run-all crashed:', err);
  process.exit(2);
});
