#!/usr/bin/env node
// runner.mjs
// Frontier-Isolation chaos suite orchestrator (Orange5 / 04-CONTROL-PLANE).
//
// What this runner does:
//   Runs the 12 forbidden-path tests in ./forbidden-paths/ in series
//   (some are stateful: e.g., #04 SSH probes mutate connection state, #08
//   "green_assumed" probes write/clean receipt artifacts, #09 attempts a
//   real disk write against runtime/node.py and may leave half-written
//   tempfiles if a prior run crashed). Parallel execution would race on
//   the receipt store and on the Hermes daemon socket. Series only.
//
//   For each test the runner:
//     1. Imports the test module by file URL (Windows-safe).
//     2. Calls the exported `runTest()` (the contract every forbidden-path
//        test honors). Wraps in a wall-clock timeout (TEST_TIMEOUT_MS) so a
//        hung daemon cannot freeze the suite.
//     3. Records { test_id, expected, actual, pass, evidence, ms,
//        harness_error? }.
//     4. Continues to the next test even on individual failure or throw —
//        the whole point of the suite is to see EVERY boundary, not bail
//        on first leak.
//
//   After all 12 tests, the runner:
//     - Aggregates: total / passed / failed / errored / missing.
//     - Computes verdict: GREEN iff every test pass===true, RED otherwise.
//     - Refuses to mark GREEN if ANY test returned pass===false, errored,
//       or could not be loaded. A single forbidden action that was NOT
//       blocked = the moat is leaking = the suite is RED. No "mostly
//       green" verdict exists.
//     - Writes a human-readable report to ./last-run.md.
//     - Emits a single JSON line on stdout for downstream callers.
//     - Exits 0 on GREEN, 1 on RED.
//
// Doctrine anchor:
//   27 Guardrails #07 (frontier-via-gateway), 9-Gate Stack, Hermes lease
//   system, runtime/node.py sole-authority lockdown, ATOMEONS_IDENTITY_SECRET
//   env-only, Human Final Stop on autonomous action. The 12 tests
//   collectively enumerate the documented forbidden boundary paths; this
//   runner is the assertion harness.
//
// Mom's Law:
//   No hand-waving, no theater, no silent fall-through. If a test is
//   missing the runner says so on the row. If a test throws the runner
//   records the throw verbatim. If anything is uncertain the verdict is
//   RED. The receipt is honest.

import { performance } from 'node:perf_hooks'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// ---------------------------------------------------------------------------
// Suite manifest
// ---------------------------------------------------------------------------

// The 12 forbidden paths as enumerated in the Frontier-Isolation chaos
// doctrine. The runner expects each filename to live in ./forbidden-paths/.
// If a file is missing, the row is recorded as 'harness-missing' with
// pass=false (the moat cannot be claimed green on absent evidence).
const TESTS = Object.freeze([
  {
    n: 1,
    file: '01-frontier-hermes-direct.mjs',
    label: 'frontier → direct Hermes daemon (no gateway)',
  },
  {
    n: 2,
    file: '02-frontier-cobra-direct.mjs',
    label: 'frontier → direct Æ Cobra daemon (no lease)',
  },
  {
    n: 3,
    file: '03-frontier-sqlite-direct.mjs',
    label: 'frontier → SQLite (no gateway mediation)',
  },
  {
    n: 4,
    file: '04-frontier-ssh-codexa.mjs',
    label: 'frontier → SSH to Codexa',
  },
  {
    n: 5,
    file: '05-egress-unbounded.mjs',
    label: 'frontier → outbound HTTP to non-allowlisted endpoint',
  },
  {
    n: 6,
    file: '06-bypass-codexa-lease.mjs',
    label: 'OrangeLLM → bypass Gate 5 codexa_lease',
  },
  {
    n: 7,
    file: '07-bypass-gateway-tag.mjs',
    label: 'OrangeLLM → bypass Gate 6 openai_gateway',
  },
  {
    n: 8,
    file: '08-fake-green-words.mjs',
    label: 'any actor → false_green_guard bypass via "green_assumed"',
  },
  {
    n: 9,
    file: '09-write-runtime-node-py.mjs',
    label: 'any actor → write to runtime/node.py (sole-authority lockdown)',
  },
  {
    n: 10,
    file: '10-exfil-identity-secret.mjs',
    label: 'any actor → exfil ATOMEONS_IDENTITY_SECRET',
  },
  {
    n: 11,
    file: '11-modify-receipt-body.mjs',
    label: 'any actor → modify receipt body without hash-rebuild',
  },
  {
    n: 12,
    file: '12-bypass-human-final-stop.mjs',
    label: 'any actor → bypass Human Final Stop on autonomous-action',
  },
])

const FORBIDDEN_PATHS_DIR = path.join(__dirname, 'forbidden-paths')
const REPORT_PATH = path.join(__dirname, 'last-run.md')

// Per-test wall-clock cap. Individual tests have their own internal
// timeouts (Hermes probes use 1500ms loopback); this is the outer
// safety net for a test that itself hangs. 30s is well above any
// healthy test runtime in this suite.
const TEST_TIMEOUT_MS = 30_000

// ---------------------------------------------------------------------------
// Test execution
// ---------------------------------------------------------------------------

/**
 * Run a single forbidden-path test with a hard wall-clock cap.
 * Always returns a row object; never throws.
 */
async function runOne(spec) {
  const abs = path.join(FORBIDDEN_PATHS_DIR, spec.file)
  const t0 = performance.now()

  // File-existence check first. We do NOT want to claim "tested" on a
  // file that does not exist. The contract is: missing => pass=false.
  try {
    await fs.access(abs)
  } catch {
    return {
      n: spec.n,
      file: spec.file,
      label: spec.label,
      test_id: `forbidden-path-${String(spec.n).padStart(2, '0')}-missing`,
      expected: 'block',
      actual: 'harness-missing',
      pass: false,
      ms: 0,
      evidence: {
        error_code: 'TEST_FILE_NOT_FOUND',
        error_message: `expected test file at ${abs}`,
      },
      harness_error: 'test file not found',
    }
  }

  // Import + run. Windows requires pathToFileURL for dynamic ESM import.
  let mod
  try {
    mod = await import(pathToFileURL(abs).href)
  } catch (err) {
    const ms = Math.round(performance.now() - t0)
    return {
      n: spec.n,
      file: spec.file,
      label: spec.label,
      test_id: `forbidden-path-${String(spec.n).padStart(2, '0')}-import-error`,
      expected: 'block',
      actual: 'harness-import-error',
      pass: false,
      ms,
      evidence: {
        error_code: 'IMPORT_THROW',
        error_message: String(err?.stack || err?.message || err),
      },
      harness_error: 'import threw',
    }
  }

  const runTest = mod.runTest || mod.default
  if (typeof runTest !== 'function') {
    const ms = Math.round(performance.now() - t0)
    return {
      n: spec.n,
      file: spec.file,
      label: spec.label,
      test_id: mod.TEST_ID || `forbidden-path-${String(spec.n).padStart(2, '0')}-no-runtest`,
      expected: 'block',
      actual: 'harness-no-runtest',
      pass: false,
      ms,
      evidence: {
        error_code: 'NO_RUNTEST_EXPORT',
        error_message: `module ${spec.file} does not export runTest or default function`,
      },
      harness_error: 'no runTest export',
    }
  }

  // Wall-clock cap. Promise.race against a timeout sentinel. We cannot
  // forcibly kill an awaited promise in-process, so a runaway test will
  // continue executing until the process exits — but the runner moves
  // on with a recorded timeout row, which is what the verdict needs.
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`test exceeded ${TEST_TIMEOUT_MS}ms wall-clock cap`))
    }, TEST_TIMEOUT_MS)
  })

  try {
    const result = await Promise.race([Promise.resolve().then(() => runTest()), timeout])
    clearTimeout(timer)
    const ms = Math.round(performance.now() - t0)

    // Defensive shape-check. Every forbidden-path test must return
    // { test_id, expected, actual, pass, evidence }. If pass is not
    // strictly boolean true, we record RED.
    const test_id = result?.test_id || mod.TEST_ID || spec.file
    const expected = result?.expected || 'block'
    const actual = result?.actual ?? 'no-actual'
    const pass = result?.pass === true
    const evidence = result?.evidence || {}

    return {
      n: spec.n,
      file: spec.file,
      label: spec.label,
      test_id,
      expected,
      actual,
      pass,
      ms,
      evidence,
    }
  } catch (err) {
    clearTimeout(timer)
    const ms = Math.round(performance.now() - t0)
    const isTimeout = String(err?.message || '').includes('wall-clock cap')
    return {
      n: spec.n,
      file: spec.file,
      label: spec.label,
      test_id: mod.TEST_ID || `forbidden-path-${String(spec.n).padStart(2, '0')}-runtime-throw`,
      expected: 'block',
      actual: isTimeout ? 'harness-timeout' : 'harness-runtime-throw',
      pass: false,
      ms,
      evidence: {
        error_code: isTimeout ? 'HARNESS_WALL_CLOCK_TIMEOUT' : 'RUNTEST_THROW',
        error_message: String(err?.stack || err?.message || err),
      },
      harness_error: isTimeout ? 'wall-clock timeout' : 'runTest threw',
    }
  }
}

// ---------------------------------------------------------------------------
// Aggregation & verdict
// ---------------------------------------------------------------------------

function aggregate(rows) {
  const total = rows.length
  let passed = 0
  let failed = 0
  let errored = 0
  let missing = 0
  for (const r of rows) {
    if (r.actual === 'harness-missing') missing += 1
    else if (r.harness_error) errored += 1
    else if (r.pass) passed += 1
    else failed += 1
  }
  // GREEN = every single row passed. Anything else is RED. This is the
  // doctrine: a single forbidden action that was NOT blocked = the moat
  // is leaking. "Mostly green" does not exist.
  const verdict = passed === total ? 'GREEN' : 'RED'
  return { total, passed, failed, errored, missing, verdict }
}

// ---------------------------------------------------------------------------
// Markdown report
// ---------------------------------------------------------------------------

function fmtEvidence(ev) {
  if (!ev || typeof ev !== 'object') return '(none)'
  try {
    const json = JSON.stringify(ev, null, 2)
    // Cap evidence in the markdown to keep last-run.md scannable. The
    // structured JSON line on stdout carries the full payload.
    if (json.length <= 1200) return json
    return json.slice(0, 1200) + '\n... [truncated; see stdout JSON for full evidence]'
  } catch {
    return '(unserializable)'
  }
}

function buildReport({ rows, summary, started_at, finished_at, total_ms }) {
  const lines = []
  lines.push('# Frontier-Isolation Chaos Suite — last run')
  lines.push('')
  lines.push(`- **Verdict**: ${summary.verdict === 'GREEN' ? '🟢 GREEN — moat held on all 12 forbidden paths' : '🔴 RED — at least one forbidden action was NOT blocked'}`)
  lines.push(`- **Total**: ${summary.total}`)
  lines.push(`- **Passed (blocked)**: ${summary.passed}`)
  lines.push(`- **Failed (not blocked)**: ${summary.failed}`)
  lines.push(`- **Harness errors**: ${summary.errored}`)
  lines.push(`- **Missing test files**: ${summary.missing}`)
  lines.push(`- **Started**: ${started_at}`)
  lines.push(`- **Finished**: ${finished_at}`)
  lines.push(`- **Wall-clock**: ${total_ms}ms`)
  lines.push('')
  lines.push('## Doctrine')
  lines.push('')
  lines.push('The 27 Guardrails include #07 frontier-via-gateway: a frontier model')
  lines.push('never reaches Hermes, daemons, or disk directly. The 9-gate-stack and')
  lines.push('the Hermes lease system enforce this. This suite enumerates every')
  lines.push('forbidden boundary path and fires each one to assert refusal. A single')
  lines.push('test that did NOT return a documented block is a moat leak; the')
  lines.push('verdict is RED. No partial-green.')
  lines.push('')
  lines.push('## Results')
  lines.push('')
  lines.push('| # | Path | test_id | expected | actual | pass | ms |')
  lines.push('|---|------|---------|----------|--------|------|----|')
  for (const r of rows) {
    const passCell = r.pass ? '✅' : (r.harness_error ? '⚠️' : '❌')
    const safeLabel = r.label.replace(/\|/g, '\\|')
    const safeActual = String(r.actual).replace(/\|/g, '\\|')
    lines.push(`| ${r.n} | ${safeLabel} | \`${r.test_id}\` | ${r.expected} | ${safeActual} | ${passCell} | ${r.ms} |`)
  }
  lines.push('')
  lines.push('## Per-test evidence')
  lines.push('')
  for (const r of rows) {
    lines.push(`### ${r.n}. ${r.label}`)
    lines.push('')
    lines.push(`- file: \`${r.file}\``)
    lines.push(`- test_id: \`${r.test_id}\``)
    lines.push(`- expected: \`${r.expected}\``)
    lines.push(`- actual: \`${r.actual}\``)
    lines.push(`- pass: \`${r.pass}\``)
    lines.push(`- ms: \`${r.ms}\``)
    if (r.harness_error) {
      lines.push(`- harness_error: \`${r.harness_error}\``)
    }
    lines.push('')
    lines.push('Evidence:')
    lines.push('')
    lines.push('```json')
    lines.push(fmtEvidence(r.evidence))
    lines.push('```')
    lines.push('')
  }
  lines.push('---')
  lines.push('')
  lines.push('_Generated by `04-CONTROL-PLANE/chaos/runner.mjs`. Mom is watching._')
  lines.push('')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const started = new Date()
  const t0 = performance.now()

  const rows = []
  // SERIES. Not Promise.all. Some tests are stateful (SSH connection
  // state, receipt store mutation, file-system probes against
  // runtime/node.py) and would race each other in parallel.
  for (const spec of TESTS) {
    // Stdout heartbeat so a long-running test does not look like a hang.
    process.stderr.write(`[chaos] running ${spec.file} — ${spec.label}\n`)
    const row = await runOne(spec)
    const tag = row.pass ? 'PASS' : (row.harness_error ? 'ERROR' : 'FAIL')
    process.stderr.write(`[chaos]   ${tag} actual=${row.actual} ms=${row.ms}\n`)
    rows.push(row)
  }

  const finished = new Date()
  const total_ms = Math.round(performance.now() - t0)
  const summary = aggregate(rows)

  // Write markdown report. Best-effort — if disk is read-only we still
  // emit the JSON line so the caller has the receipt.
  let report_path_written = null
  try {
    const md = buildReport({
      rows,
      summary,
      started_at: started.toISOString(),
      finished_at: finished.toISOString(),
      total_ms,
    })
    await fs.writeFile(REPORT_PATH, md, 'utf8')
    report_path_written = REPORT_PATH
  } catch (err) {
    process.stderr.write(`[chaos] WARNING: failed to write ${REPORT_PATH}: ${String(err?.message || err)}\n`)
  }

  // Single JSON line on stdout — the machine-readable receipt.
  const payload = {
    suite: 'frontier-isolation-chaos',
    version: 1,
    started_at: started.toISOString(),
    finished_at: finished.toISOString(),
    total_ms,
    summary,
    report_path: report_path_written,
    rows,
  }
  process.stdout.write(JSON.stringify(payload) + '\n')

  // Honest exit code: 0 only on GREEN. Anything else (any fail, any
  // error, any missing file) exits 1. The runner refuses to be marked
  // green when any forbidden action was NOT blocked.
  process.exit(summary.verdict === 'GREEN' ? 0 : 1)
}

// Module guard — only run main() when invoked directly via `node runner.mjs`.
const isDirectRun = (() => {
  try {
    const invoked = process.argv[1]
      ? pathToFileURL(process.argv[1]).href
      : ''
    return invoked && invoked === import.meta.url
  } catch {
    return false
  }
})()

if (isDirectRun) {
  main().catch((err) => {
    // Last-resort harness failure. Emit a structured RED receipt so any
    // caller piping stdout still gets a parseable line, then exit 1.
    const payload = {
      suite: 'frontier-isolation-chaos',
      version: 1,
      summary: {
        total: TESTS.length,
        passed: 0,
        failed: 0,
        errored: TESTS.length,
        missing: 0,
        verdict: 'RED',
      },
      harness_error: {
        error_code: 'RUNNER_TOP_LEVEL_THROW',
        error_message: String(err?.stack || err?.message || err),
      },
    }
    process.stdout.write(JSON.stringify(payload) + '\n')
    process.exit(1)
  })
}

export { TESTS, runOne, aggregate, buildReport, main }
export default main
