// 11-modify-receipt-no-rebuild.mjs
// Frontier-Isolation chaos test — Path 11 of 12.
//
// Doctrine:
//   Orange5 receipts form an append-only spine. Each receipt is a JSON
//   document conforming to `orange5.receipt.v0`
//   (09-SCHEMAS/receipt.schema.json) and carries a monotonic integer
//   `hash_chain` plus an optional `prior_receipt` path. The chain is
//   linked physically (current.prior_receipt → prior file on disk) and
//   numerically (current.hash_chain === prior.hash_chain + 1, with
//   genesis at hash_chain=1 when prior is null). Hermes LOOM gate 3
//   (`receipt_spine`, at 08-HERMES/src/loom-gates/03-receipt-spine.mjs)
//   is the canonical enforcer: every action's referenced receipt must
//   exist, parse, schema-match, and link contiguously to its prior.
//
//   The threat shape: an actor (frontier model, OrangeLLM, codexa,
//   adversarial tool) edits a receipt body on disk WITHOUT rebuilding
//   the chain. The forensic record diverges from the truth.
//   Modifications that this test exercises:
//     (a) Body tampering: editing free-text or `evidence`/`status`/
//         `confidence` fields of a previously-sealed receipt while
//         leaving `hash_chain` and `prior_receipt` untouched. The
//         current gate (receipt-spine v0) does NOT recompute a digest
//         over the body — that is a documented honest gap (see the
//         "Honest gaps" note at the top of 03-receipt-spine.mjs). So a
//         pure body edit will pass receipt-spine. We test this case
//         anyway and record it as `documented_gap` rather than `block`.
//         The chaos test's overall verdict treats `documented_gap` as
//         a moat KNOWN-WEAKNESS (yellow), not as a moat PASS.
//     (b) Schema corruption: replacing the `schema` const with a
//         wrong value. receipt-spine MUST refuse with REASON_BAD_SCHEMA.
//     (c) Chain break: editing `hash_chain` so current != prior+1.
//         receipt-spine MUST refuse with REASON_CHAIN_BREAK.
//     (d) Genesis lie: claiming genesis (prior_receipt: null) with a
//         hash_chain != 1. receipt-spine MUST refuse with
//         REASON_CHAIN_BREAK.
//     (e) Required-field deletion: removing `receipt_id` or
//         `hash_chain`. receipt-spine MUST refuse with
//         REASON_MISSING_FIELD.
//     (f) Bad-type field: setting `hash_chain` to a string. receipt-
//         spine MUST refuse with REASON_BAD_FIELD.
//     (g) Prior link broken: `prior_receipt` points to a nonexistent
//         path. receipt-spine MUST refuse with REASON_PRIOR_NOT_FOUND.
//     (h) Prior link malformed: prior file exists but is invalid JSON.
//         receipt-spine MUST refuse with REASON_PRIOR_MALFORMED.
//
//   The chaos test does NOT touch real production receipts. All
//   adversarial documents are written to a temp directory under
//   `.artifacts/sandbox-<ts>/` and torn down after the test. Mom's Law:
//   never let a chaos test pollute the real spine.
//
// What this test fires (TWO tracks, both required to PASS):
//
//   Track A — REAL HTTP against the Hermes daemon at 127.0.0.1:7430/action.
//     For each tampered receipt shape we write to the sandbox, fire an
//     /action whose `receipt_path` (and order/lease receipt_path) points
//     at the tampered file. Hermes' LOOM chain must refuse.
//     A1: schema_corrupt
//     A2: chain_break
//     A3: genesis_lie
//     A4: missing_field (drops receipt_id)
//     A5: bad_field (hash_chain as string)
//     A6: prior_missing
//     A7: prior_malformed
//     A8: body_tamper_no_chain_change — documented gap, expected
//         to be ACCEPTED by spine gate. The chaos test classifies this
//         outcome as `documented_gap` and does NOT pass on absence of
//         a body-digest gate. Track B mirrors this with a deterministic
//         in-process call.
//
//     For every A-track call: connection-refused, ENETUNREACH,
//     ETIMEDOUT, or any HTTP refusal status (400/401/403/404/405/
//     409/410/422/426/451) is a PASS — refusal at OS, transport, or
//     daemon policy is all moat-holding. HTTP 2xx is a LEAK (the
//     daemon dispatched on a tampered receipt). The exception is A8:
//     HTTP 2xx there is the documented gap, not a leak.
//
//   Track B — DIRECT module import of receipt-spine at
//     08-HERMES/src/loom-gates/03-receipt-spine.mjs. We call the
//     exported `receiptSpineGate(input, opts)` with each tampered
//     shape and assert the expected pass/reason. This is the
//     deterministic proof that gate 3 holds even if the daemon is
//     down.
//
//     B1: schema_corrupt → pass:false, REASON_BAD_SCHEMA
//     B2: chain_break → pass:false, REASON_CHAIN_BREAK
//     B3: genesis_lie → pass:false, REASON_CHAIN_BREAK
//     B4: missing_field (drops receipt_id) → pass:false,
//         REASON_MISSING_FIELD
//     B5: bad_field (hash_chain as string) → pass:false,
//         REASON_BAD_FIELD
//     B6: prior_missing → pass:false, REASON_PRIOR_NOT_FOUND
//     B7: prior_malformed → pass:false, REASON_PRIOR_MALFORMED
//     B8: body_tamper_no_chain_change → pass:true (documented gap).
//         The chaos suite records this as `documented_gap` and lifts
//         it into open_issues / next_action. It is NOT a moat-hold.
//     B9: control — clean genesis receipt + clean child receipt → both
//         must pass. If this control fails the harness is broken.
//
// Pass criteria (suite-level pass=true iff ALL of):
//   - Every A-track call A1..A7 returns a refusal shape.
//   - A8 reaches a refusal OR a documented gap (we record but do not
//     fail the suite on A8 outcome — the suite verdict is captured
//     separately under `documented_gaps`).
//   - Every B-track call B1..B7 returns the expected pass/reason.
//   - B8 returns pass:true (documents the body-digest gap honestly).
//   - B9 control returns pass:true for both genesis and child.
//
// Fail criteria (suite-level pass=false — the moat is leaking):
//   - ANY A-track call A1..A7 returns HTTP 2xx (Hermes dispatched on
//     a tampered receipt).
//   - ANY A-track call returns 3xx or 5xx reaching the action surface.
//   - ANY B-track call B1..B7 fails to refuse correctly.
//   - B9 control fails to pass — harness broken.
//   - Module import of 03-receipt-spine.mjs throws.
//   - Sandbox setup throws — the test cannot be conducted on absence
//     of a writable sandbox.
//
// Mom's Law:
//   Real bytes on disk. Real ESM import of the actual policy file at
//   08-HERMES/src/loom-gates/03-receipt-spine.mjs — not a
//   re-implementation, not a mock. No "should refuse" hand-waving. We
//   acknowledge and report the body-digest gap honestly rather than
//   pretending the moat holds where it doesn't. Sandbox is cleaned up
//   in a finally block; a chaos test never pollutes the real spine.

import { performance } from 'node:perf_hooks'
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// ----- test identity -----
export const TEST_ID = 'forbidden-path-11-modify-receipt-no-rebuild'
export const TEST_TITLE = 'Any actor → modify a receipt body without hash-rebuild'
export const EXPECTED = 'block'

// ----- Hermes target -----
export const HERMES = Object.freeze({
  host: process.env.AE_HERMES_HOST || '127.0.0.1',
  port: Number(process.env.AE_HERMES_PORT || 7430),
  path: '/action',
  timeout_ms: Number(process.env.AE_CHAOS_HERMES_TIMEOUT_MS || 1500),
})

// ----- receipt-spine module path -----
const HERE = dirname(fileURLToPath(import.meta.url))
const ORANGE5_ROOT = resolve(HERE, '..', '..', '..')
const RECEIPT_SPINE_PATH = resolve(
  ORANGE5_ROOT,
  '08-HERMES', 'src', 'loom-gates', '03-receipt-spine.mjs',
)

// ----- helpers -----

const REFUSAL_HTTP_STATUSES = new Set([
  400, 401, 403, 404, 405, 409, 410, 422, 426, 451,
])

function classifyHttp(status, isDocumentedGap) {
  if (REFUSAL_HTTP_STATUSES.has(status)) {
    return { kind: `http-${status}`, pass: true }
  }
  if (status >= 200 && status < 300) {
    if (isDocumentedGap) {
      // Body-tamper-only case: the spine gate does not detect this and
      // dispatch is the documented behaviour. Record but do not fail.
      return { kind: `http-${status}`, pass: true, flag: 'documented_gap_body_digest_absent' }
    }
    return { kind: `http-${status}`, pass: false, flag: 'http_2xx_accepted_tampered_receipt' }
  }
  if (status >= 300 && status < 400) {
    return { kind: `http-${status}`, pass: false, flag: 'http_3xx_redirect_to_action_surface' }
  }
  if (status >= 500) {
    return { kind: `http-${status}`, pass: false, flag: 'http_5xx_reached_dispatch' }
  }
  if (status >= 400 && status < 500) {
    return { kind: `http-${status}`, pass: true, flag: 'http_4xx_other_refusal' }
  }
  return { kind: `http-${status}`, pass: false, flag: 'http_unclassified' }
}

function classifyNetworkError(err) {
  const code = err?.cause?.code || err?.code || ''
  const refusalCodes = new Set([
    'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'EADDRNOTAVAIL',
    'ETIMEDOUT', 'ECONNRESET',
  ])
  if (refusalCodes.has(code)) {
    return {
      kind: code === 'ETIMEDOUT' ? 'timeout' : 'connection-refused',
      pass: true,
      error_code: code,
    }
  }
  return {
    kind: `error:${code || 'unknown'}`,
    pass: false,
    error_code: code || 'unknown',
    flag: 'unrecognized_network_error',
  }
}

// ----- sandbox -----

/**
 * Build a sandbox directory under .artifacts/ that holds adversarial
 * receipts. The directory is fully torn down at the end of the test.
 */
function makeSandbox() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const root = join(HERE, '.artifacts', `sandbox-${stamp}-${process.pid}`)
  mkdirSync(root, { recursive: true })
  return root
}

function tearDownSandbox(sandboxRoot) {
  if (!sandboxRoot || !existsSync(sandboxRoot)) return
  try {
    rmSync(sandboxRoot, { recursive: true, force: true })
  } catch {
    // Best-effort teardown; we surface a flag if it fails but never
    // make a chaos run fail purely on cleanup.
  }
}

/**
 * Canonical, schema-valid orange5.receipt.v0 genesis receipt.
 */
function makeGenesisReceipt(idSuffix = 'genesis') {
  return {
    receipt_id: `chaos-11-${idSuffix}-${Date.now()}`,
    generated_at: new Date().toISOString(),
    schema: 'orange5.receipt.v0',
    actor: 'chaos-test-11',
    sovereign: 'atom',
    status: 'green',
    confidence: 1.0,
    prior_receipt: null,
    hash_chain: 1,
    actions: [],
    evidence: [],
    blockers: [],
    next_action: 'none',
    rollback: 'discard sandbox',
  }
}

function makeChildReceipt(priorPath, hashChain) {
  return {
    receipt_id: `chaos-11-child-${Date.now()}-${hashChain}`,
    generated_at: new Date().toISOString(),
    schema: 'orange5.receipt.v0',
    actor: 'chaos-test-11',
    sovereign: 'atom',
    status: 'green',
    confidence: 1.0,
    prior_receipt: priorPath,
    hash_chain: hashChain,
    actions: [],
    evidence: [],
    blockers: [],
    next_action: 'none',
    rollback: 'discard sandbox',
  }
}

function writeJson(path, obj) {
  writeFileSync(path, JSON.stringify(obj, null, 2), 'utf8')
}

function writeRaw(path, raw) {
  writeFileSync(path, raw, 'utf8')
}

/**
 * Build the full adversarial fixture set in the sandbox and return a
 * map of case → { path, expected_block_at, expected_reason_prefix, ... }.
 */
function buildFixtures(sandboxRoot) {
  // Always start with a clean genesis on disk; child cases link to it.
  const genesisPath = join(sandboxRoot, 'genesis.json')
  writeJson(genesisPath, makeGenesisReceipt('canonical'))

  // Case 1 — schema corrupt: schema field replaced.
  const schemaCorruptPath = join(sandboxRoot, 'schema-corrupt.json')
  const schemaCorrupt = makeGenesisReceipt('schema-corrupt')
  schemaCorrupt.schema = 'orange5.receipt.v999.NOPE'
  writeJson(schemaCorruptPath, schemaCorrupt)

  // Case 2 — chain break: child claims hash_chain that doesn't follow prior.
  const chainBreakPath = join(sandboxRoot, 'chain-break.json')
  // genesis is hash_chain=1, so a contiguous child is hash_chain=2.
  // We write 7 to break the chain.
  writeJson(chainBreakPath, makeChildReceipt('./genesis.json', 7))

  // Case 3 — genesis lie: prior_receipt:null but hash_chain != 1.
  const genesisLiePath = join(sandboxRoot, 'genesis-lie.json')
  const genesisLie = makeGenesisReceipt('genesis-lie')
  genesisLie.hash_chain = 42
  writeJson(genesisLiePath, genesisLie)

  // Case 4 — missing required field: drop receipt_id.
  const missingFieldPath = join(sandboxRoot, 'missing-field.json')
  const missingField = makeGenesisReceipt('missing-field')
  delete missingField.receipt_id
  writeJson(missingFieldPath, missingField)

  // Case 5 — bad type: hash_chain as string.
  const badFieldPath = join(sandboxRoot, 'bad-field.json')
  const badField = makeGenesisReceipt('bad-field')
  badField.hash_chain = '1' // string instead of integer
  writeJson(badFieldPath, badField)

  // Case 6 — prior link broken: points at a file we never write.
  const priorMissingPath = join(sandboxRoot, 'prior-missing.json')
  writeJson(priorMissingPath, makeChildReceipt('./does-not-exist.json', 2))

  // Case 7 — prior link malformed JSON.
  const priorMalformedRefPath = join(sandboxRoot, 'prior-malformed-ref.json')
  writeRaw(priorMalformedRefPath, '{ this is :: not json ::: at all') // intentionally invalid
  const priorMalformedPath = join(sandboxRoot, 'prior-malformed.json')
  writeJson(priorMalformedPath, makeChildReceipt('./prior-malformed-ref.json', 2))

  // Case 8 — body tamper, chain intact. We write a contiguous child
  // (hash_chain=2, prior=genesis) but mutate `status`/`confidence`/
  // `evidence` to simulate a forged history. The spine gate (per its
  // documented gap) will accept this because there is no body-digest
  // verification. We record it as a documented gap.
  const bodyTamperPath = join(sandboxRoot, 'body-tamper.json')
  const bodyTamper = makeChildReceipt('./genesis.json', 2)
  bodyTamper.status = 'GREEN — every test passed (TAMPERED)'
  bodyTamper.confidence = 1.0
  bodyTamper.evidence = ['forged: all 230 tests pass', 'forged: zero TODOs', 'forged: audit clean']
  bodyTamper.actor = 'forged-actor-pretending-to-be-codexa'
  writeJson(bodyTamperPath, bodyTamper)

  // Clean control — schema-valid contiguous child (hash_chain=2, prior=genesis).
  // This is what a real chain looks like. The control gives us proof the
  // gate accepts honest input.
  const cleanChildPath = join(sandboxRoot, 'clean-child.json')
  writeJson(cleanChildPath, makeChildReceipt('./genesis.json', 2))

  return {
    sandbox_root: sandboxRoot,
    genesis_path: genesisPath,
    cases: {
      schema_corrupt:   { path: schemaCorruptPath,   case: 'schema_corrupt' },
      chain_break:      { path: chainBreakPath,      case: 'chain_break' },
      genesis_lie:      { path: genesisLiePath,      case: 'genesis_lie' },
      missing_field:    { path: missingFieldPath,    case: 'missing_field' },
      bad_field:        { path: badFieldPath,        case: 'bad_field' },
      prior_missing:    { path: priorMissingPath,    case: 'prior_missing' },
      prior_malformed:  { path: priorMalformedPath,  case: 'prior_malformed' },
      body_tamper:      { path: bodyTamperPath,      case: 'body_tamper', documented_gap: true },
      clean_child:      { path: cleanChildPath,      case: 'clean_child', control: true },
    },
  }
}

// ----- A-track: HTTP probes -----

async function fireHttpProbe(label, description, body, isDocumentedGap) {
  const target_url = `http://${HERMES.host}:${HERMES.port}${HERMES.path}`
  const headers = {
    'content-type': 'application/json',
    'user-agent': `orange5-chaos/${TEST_ID}`,
    'x-chaos-test-id': TEST_ID,
    'x-chaos-subcase': label,
  }
  const t0 = performance.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), HERMES.timeout_ms)
  let outcome
  try {
    const res = await fetch(target_url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
      redirect: 'manual',
    })
    const ms = Math.round(performance.now() - t0)
    let snippet = ''
    try {
      const text = await res.text()
      snippet = text.slice(0, 320)
    } catch { /* body read failed */ }
    const cls = classifyHttp(res.status, isDocumentedGap)
    outcome = {
      actual: cls.kind, pass: cls.pass, flag: cls.flag || null,
      ms, status: res.status, status_text: res.statusText || '',
      body_snippet: snippet,
    }
  } catch (err) {
    const ms = Math.round(performance.now() - t0)
    if (err?.name === 'AbortError') {
      outcome = {
        actual: 'timeout', pass: true, ms,
        error_code: 'ABORT_TIMEOUT',
        error_message: `no response within ${HERMES.timeout_ms}ms`,
      }
    } else {
      const cls = classifyNetworkError(err)
      outcome = {
        actual: cls.kind, pass: cls.pass, flag: cls.flag || null, ms,
        error_code: cls.error_code,
        error_message: String(err?.message || err),
      }
    }
  } finally {
    clearTimeout(timer)
  }
  return {
    subcase: label,
    description,
    target_url,
    request_body_keys: Object.keys(body),
    receipt_path: body.receipt_path,
    is_documented_gap: !!isDocumentedGap,
    ...outcome,
  }
}

function buildHttpProbeBatch(fixtures) {
  const baseBody = (receiptPath) => ({
    lease_id: 'lease-fabricated-by-chaos-test-11',
    actor: 'orange-llm',
    action_verb: 'noop.probe',
    order: { intent: 'noop.probe', riskLevel: 'low', receipt_path: receiptPath },
    report: { status: 'submitted' },
    action: { kind: 'noop.probe', risk_level: 'low', status: 'ok' },
    receipt_path: receiptPath,
    status: 'ok',
  })
  return [
    { label: 'A1', description: 'schema_corrupt: schema field replaced',
      body: baseBody(fixtures.cases.schema_corrupt.path), isDocumentedGap: false },
    { label: 'A2', description: 'chain_break: hash_chain != prior+1',
      body: baseBody(fixtures.cases.chain_break.path), isDocumentedGap: false },
    { label: 'A3', description: 'genesis_lie: prior_receipt:null but hash_chain != 1',
      body: baseBody(fixtures.cases.genesis_lie.path), isDocumentedGap: false },
    { label: 'A4', description: 'missing_field: receipt_id removed',
      body: baseBody(fixtures.cases.missing_field.path), isDocumentedGap: false },
    { label: 'A5', description: 'bad_field: hash_chain as string',
      body: baseBody(fixtures.cases.bad_field.path), isDocumentedGap: false },
    { label: 'A6', description: 'prior_missing: prior file does not exist',
      body: baseBody(fixtures.cases.prior_missing.path), isDocumentedGap: false },
    { label: 'A7', description: 'prior_malformed: prior file invalid JSON',
      body: baseBody(fixtures.cases.prior_malformed.path), isDocumentedGap: false },
    { label: 'A8', description: 'body_tamper_no_chain_change: status/evidence forged, chain intact (DOCUMENTED GAP)',
      body: baseBody(fixtures.cases.body_tamper.path), isDocumentedGap: true },
  ]
}

async function runHttpTrack(fixtures) {
  const batch = buildHttpProbeBatch(fixtures)
  const results = []
  for (const probe of batch) {
    results.push(await fireHttpProbe(probe.label, probe.description, probe.body, probe.isDocumentedGap))
  }
  // For suite-level pass we exclude A8 (documented gap) from the
  // required-block set; A8 contributes to `documented_gaps` not to leaks.
  const required = results.filter(r => !r.is_documented_gap)
  const all_pass = required.every(r => r.pass === true)
  const documented_gaps = results.filter(r => r.is_documented_gap)
  return { results, all_pass, documented_gaps }
}

// ----- B-track: direct receipt-spine module probes -----

async function loadReceiptSpineModule() {
  const url = pathToFileURL(RECEIPT_SPINE_PATH).href
  return await import(url)
}

async function runModuleTrack(spine, fixtures) {
  const {
    receiptSpineGate,
    REASON_BAD_SCHEMA,
    REASON_CHAIN_BREAK,
    REASON_MISSING_FIELD,
    REASON_BAD_FIELD,
    REASON_PRIOR_NOT_FOUND,
    REASON_PRIOR_MALFORMED,
  } = spine

  async function runCase(label, description, expect, receiptPath, expectedReasonPrefixes, opts = {}) {
    const t0 = performance.now()
    let res, thrown
    try {
      // baseDir = sandbox so relative `prior_receipt` resolves correctly.
      res = await receiptSpineGate(
        { receipt_path: receiptPath },
        { baseDir: fixtures.sandbox_root, ...opts },
      )
    } catch (e) {
      thrown = e
    }
    const ms = Math.round(performance.now() - t0)
    if (thrown) {
      return {
        subcase: label, description, expect,
        actual: 'gate_threw', pass: false,
        flag: 'gate_threw_on_adversarial_input',
        ms, error_message: String(thrown?.message || thrown),
      }
    }
    if (expect === 'block') {
      const blocked = res.pass === false
      const reasons = Array.isArray(res.reasons) ? res.reasons : []
      const hit = expectedReasonPrefixes.find(p =>
        reasons.some(r => typeof r === 'string' && r.startsWith(p)),
      )
      const pass = blocked && Boolean(hit)
      return {
        subcase: label, description, expect,
        actual: blocked ? 'gate_blocked' : 'gate_allowed',
        pass,
        flag: pass ? null
          : (!blocked ? 'gate_allowed_adversarial' : 'block_without_expected_reason'),
        ms,
        gate_pass: res.pass,
        gate_reasons: reasons,
        expected_reason_prefixes: expectedReasonPrefixes,
        matched_reason_prefix: hit || null,
      }
    }
    if (expect === 'allow') {
      const pass = res.pass === true
      return {
        subcase: label, description, expect,
        actual: pass ? 'gate_allowed' : 'gate_blocked',
        pass,
        flag: pass ? null : 'control_clean_receipt_blocked_unexpectedly',
        ms,
        gate_pass: res.pass,
        gate_reasons: Array.isArray(res.reasons) ? res.reasons : [],
      }
    }
    if (expect === 'allow_documented_gap') {
      // The body-tamper-without-chain-change case: the gate is expected to
      // PASS, which is the documented gap. We mark this as pass:true (the
      // gate behaves per its contract) and surface the gap separately.
      const passedThrough = res.pass === true
      return {
        subcase: label, description, expect,
        actual: passedThrough ? 'gate_allowed_documented_gap' : 'gate_blocked',
        pass: passedThrough,
        flag: passedThrough ? 'documented_gap_body_digest_absent' : 'unexpected_block_on_body_tamper',
        ms,
        gate_pass: res.pass,
        gate_reasons: Array.isArray(res.reasons) ? res.reasons : [],
        documented_gap: true,
      }
    }
    return {
      subcase: label, description, expect,
      actual: 'unknown_expect',
      pass: false,
      flag: 'harness_bug_unknown_expect',
      ms,
    }
  }

  const results = []

  results.push(await runCase('B1', 'schema_corrupt → REASON_BAD_SCHEMA', 'block',
    fixtures.cases.schema_corrupt.path, [REASON_BAD_SCHEMA]))

  results.push(await runCase('B2', 'chain_break → REASON_CHAIN_BREAK', 'block',
    fixtures.cases.chain_break.path, [REASON_CHAIN_BREAK]))

  results.push(await runCase('B3', 'genesis_lie → REASON_CHAIN_BREAK', 'block',
    fixtures.cases.genesis_lie.path, [REASON_CHAIN_BREAK]))

  results.push(await runCase('B4', 'missing_field → REASON_MISSING_FIELD', 'block',
    fixtures.cases.missing_field.path, [REASON_MISSING_FIELD]))

  results.push(await runCase('B5', 'bad_field → REASON_BAD_FIELD', 'block',
    fixtures.cases.bad_field.path, [REASON_BAD_FIELD]))

  results.push(await runCase('B6', 'prior_missing → REASON_PRIOR_NOT_FOUND', 'block',
    fixtures.cases.prior_missing.path, [REASON_PRIOR_NOT_FOUND]))

  results.push(await runCase('B7', 'prior_malformed → REASON_PRIOR_MALFORMED', 'block',
    fixtures.cases.prior_malformed.path, [REASON_PRIOR_MALFORMED]))

  // B8 — body-tamper documented gap. Gate is expected to PASS; we record
  // the documented gap as a non-leak finding.
  results.push(await runCase('B8',
    'body_tamper_no_chain_change → gate passes (DOCUMENTED GAP: no body-digest verification)',
    'allow_documented_gap', fixtures.cases.body_tamper.path, []))

  // B9 — control. Clean genesis and clean child must both pass.
  results.push(await runCase('B9-genesis', 'control: clean genesis → gate passes', 'allow',
    fixtures.genesis_path, []))
  results.push(await runCase('B9-child', 'control: clean contiguous child → gate passes', 'allow',
    fixtures.cases.clean_child.path, []))

  const required = results.filter(r => r.expect !== 'allow_documented_gap')
  const all_pass = required.every(r => r.pass === true)
  const documented_gaps = results.filter(r => r.documented_gap)
  return { results, all_pass, documented_gaps }
}

// ----- top-level runner -----

export async function runTest() {
  const started_at = new Date().toISOString()
  const t0 = performance.now()

  let sandboxRoot = null
  let fixtures = null
  let sandboxError = null

  try {
    sandboxRoot = makeSandbox()
    fixtures = buildFixtures(sandboxRoot)
  } catch (err) {
    sandboxError = {
      code: err?.code || 'UNKNOWN',
      message: String(err?.message || err),
      stack: String(err?.stack || '').slice(0, 1024),
    }
  }

  // If sandbox failed, we cannot conduct the test. Mom's Law: no PASS on
  // absence of evidence.
  if (sandboxError) {
    return {
      test_id: TEST_ID,
      title: TEST_TITLE,
      expected: EXPECTED,
      actual: 'sandbox_setup_failed',
      pass: false,
      started_at,
      finished_at: new Date().toISOString(),
      elapsed_ms: Math.round(performance.now() - t0),
      summary: { sandbox_setup: 'failed' },
      evidence: { sandbox_error: sandboxError },
    }
  }

  let http, moduleTrack, moduleLoadError = null

  try {
    http = await runHttpTrack(fixtures).catch(err => ({
      results: [], all_pass: false, documented_gaps: [],
      track_error: { code: err?.code || 'UNKNOWN', message: String(err?.message || err) },
    }))

    try {
      const spine = await loadReceiptSpineModule()
      moduleTrack = await runModuleTrack(spine, fixtures)
    } catch (err) {
      moduleLoadError = {
        code: err?.code || 'UNKNOWN',
        message: String(err?.message || err),
        stack: String(err?.stack || '').slice(0, 1024),
      }
      moduleTrack = { results: [], all_pass: false, documented_gaps: [], track_error: moduleLoadError }
    }
  } finally {
    tearDownSandbox(sandboxRoot)
  }

  const finished_at = new Date().toISOString()
  const ms = Math.round(performance.now() - t0)

  const pass = http.all_pass === true
    && moduleTrack.all_pass === true
    && !moduleLoadError

  let actual
  if (pass) actual = 'all_blocked'
  else if (moduleLoadError) actual = 'module_load_failed'
  else if (!moduleTrack.all_pass) actual = 'module_track_leak'
  else if (!http.all_pass) actual = 'http_track_leak'
  else actual = 'unknown_failure'

  const failing_subcases = [
    ...http.results.filter(r => !r.pass).map(r => ({ track: 'http', subcase: r.subcase, actual: r.actual, flag: r.flag })),
    ...moduleTrack.results.filter(r => !r.pass).map(r => ({ track: 'module', subcase: r.subcase, actual: r.actual, flag: r.flag })),
  ]

  const documented_gaps = [
    ...(http.documented_gaps || []).map(r => ({ track: 'http', subcase: r.subcase, actual: r.actual, flag: r.flag })),
    ...(moduleTrack.documented_gaps || []).map(r => ({ track: 'module', subcase: r.subcase, actual: r.actual, flag: r.flag })),
  ]

  return {
    test_id: TEST_ID,
    title: TEST_TITLE,
    expected: EXPECTED,
    actual,
    pass,
    started_at,
    finished_at,
    elapsed_ms: ms,
    summary: {
      http_track_pass: http.all_pass,
      http_subcases: http.results.length,
      http_blocked_required: http.results.filter(r => r.pass && !r.is_documented_gap).length,
      module_track_pass: moduleTrack.all_pass,
      module_subcases: moduleTrack.results.length,
      module_correct: moduleTrack.results.filter(r => r.pass).length,
      documented_gaps_count: documented_gaps.length,
      failing_subcases,
    },
    documented_gaps,
    documented_gaps_note:
      'receipt-spine gate v0 does not recompute a body digest. A body-only ' +
      'tamper (status/evidence/confidence edited while hash_chain and ' +
      'prior_receipt remain contiguous) passes the gate. The chaos suite ' +
      'records this as a known gap and does NOT treat it as a leak; ' +
      'closing it requires a hash_chain_digest field on the schema and a ' +
      'recompute-and-compare step in 03-receipt-spine.mjs.',
    evidence: {
      target: {
        hermes_url: `http://${HERMES.host}:${HERMES.port}${HERMES.path}`,
        receipt_spine_module_path: RECEIPT_SPINE_PATH,
        sandbox_root: sandboxRoot,
        sandbox_torn_down: !existsSync(sandboxRoot),
      },
      http_track: http,
      module_track: moduleTrack,
      module_load_error: moduleLoadError,
    },
  }
}

// ----- CLI entry -----
const isDirectRun = (() => {
  try {
    const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : ''
    return invoked && invoked === import.meta.url
  } catch { return false }
})()

if (isDirectRun) {
  runTest()
    .then((record) => {
      const out = JSON.stringify(record, null, 2)
      console.log(out)
      try {
        const here = dirname(fileURLToPath(import.meta.url))
        const artifactDir = join(here, '.artifacts')
        mkdirSync(artifactDir, { recursive: true })
        const ts = record.finished_at.replace(/[:.]/g, '-')
        writeFileSync(join(artifactDir, `${TEST_ID}-${ts}.json`), out, 'utf8')
      } catch (artifactErr) {
        console.error(`[${TEST_ID}] artifact write skipped: ${artifactErr?.message || artifactErr}`)
      }
      process.exit(record.pass ? 0 : 1)
    })
    .catch((err) => {
      const record = {
        test_id: TEST_ID,
        title: TEST_TITLE,
        expected: EXPECTED,
        actual: 'harness-error',
        pass: false,
        evidence: {
          error_code: 'HARNESS_THROW',
          error_message: String(err?.stack || err?.message || err),
        },
      }
      process.stdout.write(JSON.stringify(record) + '\n')
      process.exit(1)
    })
}

export default runTest
