import fs from 'node:fs';
import path from 'node:path';
import { writeChainedJsonReceipt } from '../10-RECEIPTS/tools/json-receipt-chain.mjs';

const ROOT = path.resolve(import.meta.dir, '..');
const RECEIPT_DIR = path.join(ROOT, '10-RECEIPTS', 'orange5-build');
const SUITES = [
  'scripts/tests/navigator-residency-recovery.test.mjs',
  '06-ORANGELLM/server/routes/visual-gateway-integration.test.mjs',
  '03-BACKEND/tests/learning-queue.test.mjs',
];

function latestCanonicalProof() {
  const matches = fs.readdirSync(RECEIPT_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('-failure-memory-closeout.json'))
    .map((entry) => {
      const fullPath = path.join(RECEIPT_DIR, entry.name);
      return { fullPath, mtime: fs.statSync(fullPath).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
  if (!matches.length) return null;
  const receipt = JSON.parse(fs.readFileSync(matches[0].fullPath, 'utf8'));
  return {
    path: matches[0].fullPath,
    receipt_sha256: receipt.receipt_sha256 || null,
    canonical_discovery: receipt.verification?.canonical_discovery || null,
  };
}

function runSuite(file) {
  const started = performance.now();
  const child = Bun.spawnSync(['bun', 'test', file], {
    cwd: ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
    env: process.env,
  });
  const output = `${child.stdout.toString()}\n${child.stderr.toString()}`.trim();
  const pass = Number(output.match(/\b(\d+) pass\b/)?.[1] || 0);
  const fail = Number(output.match(/\b(\d+) fail\b/)?.[1] || 0);
  return {
    file,
    ok: child.exitCode === 0 && fail === 0 && pass > 0,
    exit_code: child.exitCode,
    pass,
    fail,
    duration_ms: Math.round(performance.now() - started),
    output_tail: output.split(/\r?\n/).slice(-12),
  };
}

const generatedAt = new Date().toISOString();
const suites = SUITES.map(runSuite);
const canonical = latestCanonicalProof();
const canonicalGreen = canonical?.canonical_discovery?.green === 169
  && canonical?.canonical_discovery?.red === 0;
const green = suites.every((suite) => suite.ok) && canonicalGreen;
const target = path.join(
  RECEIPT_DIR,
  `${generatedAt.replaceAll(':', '-')}-verifier-isolation-proof.json`,
);
const receipt = writeChainedJsonReceipt(target, {
  schema: 'orange5.verifier-isolation-proof.v1',
  generated_at: generatedAt,
  status: green ? 'VERIFIER_ISOLATION_GREEN' : 'VERIFIER_ISOLATION_NEEDS_WORK',
  reason: 'Fixed-port, subprocess, and SQLite lifecycle suites are serialized to prevent cross-suite state contention.',
  suites,
  totals: {
    suites: suites.length,
    green: suites.filter((suite) => suite.ok).length,
    red: suites.filter((suite) => !suite.ok).length,
    pass: suites.reduce((sum, suite) => sum + suite.pass, 0),
    fail: suites.reduce((sum, suite) => sum + suite.fail, 0),
  },
  canonical_verification: canonical,
  claim_boundary: {
    focused_shared_state_suites_proven: suites.every((suite) => suite.ok),
    prior_full_discovery_proven: canonicalGreen,
    a_new_full_discovery_run_claimed: false,
  },
});

console.log(JSON.stringify({
  status: receipt.status,
  totals: receipt.totals,
  suites: suites.map(({ file, ok, pass, fail, duration_ms }) => ({ file, ok, pass, fail, duration_ms })),
  receipt_path: target,
  receipt_sha256: receipt.receipt_sha256,
}, null, 2));

if (!green) process.exitCode = 1;
