#!/usr/bin/env bun
// Orange5 - FULL verifier (Bun-native).
//
// Why this exists: the legacy `run-all-tests.ps1` only ran 7 hand-listed test
// files via `node`, while the repo actually holds ~58 `*.test.mjs` across every
// numbered pillar. That gap let real reds hide behind a green 7/7. This verifier
// discovers EVERY test file and runs each with the correct invocation:
//
//   - Framework files (import from 'bun:test' or 'node:test')  -> `bun test <f>`
//   - Standalone print-harness files                          -> `bun <f>`
//
// Endurance-class tests get a longer timeout. Everything else is capped so one
// hung suite can't stall the whole run. Exit 0 iff every discovered suite is green.
//
// Run:  bun 00-CHARTER/orange5-full-verifier.mjs
//       bun 00-CHARTER/orange5-full-verifier.mjs --json     (machine-readable)
//
// Mom's Law: honest count. No hand-picked subset. No fake-green.

import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(process.env.ORANGE5_VERIFY_ROOT || join(SCRIPT_DIR, '..'));
const CONCURRENCY = 4; // N150-safe: heavy SQLite/replay suites can false-red above 4-way under Docker/OBS load.
const DEFAULT_TIMEOUT_MS = 120_000;
const LONG_TIMEOUT_MS = 420_000; // slow-class: replay-integration (~5min), endurance, concurrency
const jsonOut = process.argv.includes('--json');

// ---- discover every *.test.mjs plus the two non-.test verifier scripts ----
const EXTRA = [
  '06-ORANGELLM/tests/run-boundary-tests.mjs',
  '09-SCHEMAS/tests/validate-schemas.mjs',
];
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '19-ARCHIVE']);

function walk(dir, acc) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(join(dir, e.name), acc);
    } else if (e.isFile() && e.name.endsWith('.test.mjs')) {
      acc.push(join(dir, e.name));
    }
  }
  return acc;
}

function discover() {
  const found = walk(ROOT, []);
  for (const x of EXTRA) {
    const full = join(ROOT, x);
    try { statSync(full); if (!found.includes(full)) found.push(full); } catch {}
  }
  // stable, de-duped, repo-relative
  return [...new Set(found.map((f) => relative(ROOT, f).split(sep).join('/')))].sort();
}

function isFramework(relPath) {
  try {
    const src = readFileSync(join(ROOT, relPath), 'utf8');
    return /from\s+['"](?:node:test|bun:test)['"]/.test(src) ||
           /require\(\s*['"](?:node:test|bun:test)['"]\s*\)/.test(src);
  } catch { return false; }
}

function isEndurance(relPath) {
  // slow-class: these are known-heavy suites that legitimately exceed the default cap.
  // replay-integration ~5min (full deterministic replay), concurrency ~46s (2-proc),
  // and the rest of 12-ATOMSMASHER/full-scope run long by design.
  return /endurance|replay-integration|concurrency|12-ATOMSMASHER[\/\\]full-scope|27-guardrails|guardrails-smoke/i.test(relPath);
}

function isExclusive(relPath) {
  // Source scanners must not inspect files while another suite is exercising
  // temporary build/runtime fixtures in the same tree. They are fast alone;
  // running them concurrently creates false reds from transient file state.
  // Live integration suites also share the running gateway, task database,
  // receipt chain, and machine health snapshot. They must prove the real path,
  // but they must not mutate or probe that shared state concurrently.
  return /27-guardrails|guardrails-smoke|runtime-portability|upstream-backend-resolver|slack\.test|navigator-residency-recovery|learning-queue\.test|visual-gateway-integration\.test|operational-audit\.test|orange5-brain-mcp-server\.test|spine-cli-io\.test/i.test(relPath);
}

async function runOne(relPath) {
  const framework = isFramework(relPath);
  const timeoutMs = isEndurance(relPath) ? LONG_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
  const cmd = framework ? ['bun', 'test', relPath] : ['bun', relPath];
  const stateRoot = mkdtempSync(join(tmpdir(), 'orange5-verify-'));
  const env = {
    ...process.env,
    ORANGE5_ROOT: ROOT,
    ORANGE5_FLOW_STATE: join(stateRoot, 'flow.json'),
    ORANGE5_FLOW_PID: join(stateRoot, 'scheduler.pid'),
    ORANGE5_FLOW_CONF: join(stateRoot, 'scheduler.config.json'),
    ORANGE5_FLOW_RECEIPTS_DIR: join(stateRoot, 'receipts'),
    ORANGE5_CONTINUITY_CACHE_PATH: join(stateRoot, 'continuity-cache.json'),
    ORANGE5_GUARDRAILS_STATE: join(stateRoot, 'guardrails'),
  };

  const started = performance.now();
  const proc = Bun.spawn(cmd, { cwd: ROOT, env, stdout: 'pipe', stderr: 'pipe' });
  const killer = setTimeout(() => { try { proc.kill(); } catch {} }, timeoutMs);

  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(killer);
  try { rmSync(stateRoot, { recursive: true, force: true }); } catch {}

  const elapsedMs = Math.round(performance.now() - started);
  const timedOut = elapsedMs >= timeoutMs - 500;
  const green = code === 0 && !timedOut;
  const tail = (out + err).trim().split('\n').filter(Boolean).slice(-1)[0]?.slice(0, 80) ?? '';

  return { relPath, framework, green, code, elapsedMs, timedOut, tail };
}

async function pool(items, n, fn) {
  const results = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return results;
}

const files = discover();
if (!jsonOut) {
  console.log(`Orange5 FULL verifier - ${files.length} test files discovered`);
  console.log('='.repeat(60));
}

const parallelFiles = files.filter((file) => !isExclusive(file));
const exclusiveFiles = files.filter(isExclusive);
const parallelResults = await pool(parallelFiles, CONCURRENCY, runOne);
const exclusiveResults = [];
for (const file of exclusiveFiles) exclusiveResults.push(await runOne(file));
const results = [...parallelResults, ...exclusiveResults];
const green = results.filter((r) => r.green);
const red = results.filter((r) => !r.green);

if (jsonOut) {
  console.log(JSON.stringify({
    total: files.length,
    green: green.length,
    red: red.length,
    reds: red.map((r) => ({ file: r.relPath, code: r.code, timedOut: r.timedOut, tail: r.tail })),
  }, null, 2));
} else {
  for (const r of results.sort((a, b) => a.relPath.localeCompare(b.relPath))) {
    const tag = r.green ? 'PASS' : (r.timedOut ? 'TIMEOUT' : 'FAIL');
    const inv = r.framework ? 'bun test' : 'bun     ';
    console.log(`  [${tag.padEnd(7)}] (${inv}) ${r.relPath.padEnd(58)} ${String(r.elapsedMs).padStart(6)}ms`);
  }
  console.log('='.repeat(60));
  console.log(` Orange5 full verifier: ${green.length} green / ${red.length} red  (of ${files.length})`);
  if (red.length) {
    console.log(' REDS:');
    for (const r of red) console.log(`   - ${r.relPath}  ::  ${r.tail}`);
  }
  console.log('='.repeat(60));
}

process.exit(red.length > 0 ? 1 : 0);
