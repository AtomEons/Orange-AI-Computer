// 08-fake-green-words.mjs
// Frontier-Isolation chaos test — Path 8 of 12.
//
// Doctrine:
//   The 27 Guardrails include #07 frontier-via-gateway: every action by every
//   LLM in the AtomEons superstack must arrive at Hermes wrapped in a
//   gateway-issued lease, traverse the 8-gate LOOM chain in order, and only
//   land on the host if all checks pass. LOOM Gate 8 — `false_green_guard`
//   — is the final pre-flight chokepoint. It is the *prose-level honesty
//   gate*: it does not know whether the work succeeded, but it refuses any
//   action whose declared `status` (or attached `report.status`) is dressed
//   up in language an actor reaches for when it wants to *claim* green
//   without having proven green. Mom's Law in code form:
//     - "Do not claim green without proof."  (.claude/rules/03)
//     - "Every 'passed' claim has a receipt." (.claude/rules/00-moms-law)
//
//   The canonical fake-green deny-list (per the brief AND per
//   08-HERMES/src/loom-gates/08-false-green.mjs):
//     green_assumed | looks_ok | probably | should_work | fake_green
//
//   Gate 8 sits AFTER gates 1–7 in the LOOM chain. By the time prose
//   reaches here the action has already been schema-validated, receipt-
//   bound, human-approval-checked (if needed), lease-checked, gateway-
//   checked, and MCP-default-checked. Gate 8 has the last word on what
//   "the report says success" actually means.
//
//   This test simulates ANY actor (frontier, OrangeLLM, codexa, hermes-
//   internal — the gate is actor-agnostic) attempting to land an /action
//   whose status field contains any of the five forbidden fake-green
//   terms. There are five canonical terms; the actor could also try
//   tolerant variants (kebab-case, spaces, mixed case, embedded inside
//   a longer compound verdict). We fire every shape and assert every
//   single one is refused. A single bypass succeeding means the
//   false_green_guard moat is leaking → synth receipt MUST go red.
//
// What this test fires (two tracks, both required to PASS):
//
//   Track A — REAL HTTP against the Hermes daemon at 127.0.0.1:7430/action.
//     A1..A5: each of the five canonical terms in `action.status` — the
//       primary surface. We expect a 4xx refusal classifiable as a gate
//       reject (Hermes emits 409 gate_failed for LOOM-chain rejects).
//     A6: term embedded in `report.status` instead of `action.status` —
//       the secondary surface that Gate 8 also inspects.
//     A7: kebab-case variant ('looks-ok') — exercises the tolerant
//       variant matcher (`_` → `[_\\- ]`).
//     A8: spaced variant ('looks ok') — same tolerant matcher.
//     A9: mixed case ('Should_Work') — exercises the case-insensitive
//       flag on the compiled pattern.
//     A10: term embedded inside a longer verdict string
//       ('build succeeded, probably nominal') — exercises word-boundary
//       matching; the term must still be found inside the sentence.
//
//     For every A-track call: connection-refused, ENETUNREACH, ETIMEDOUT,
//     or any HTTP refusal status (400/401/403/404/405/409/410/422/426/451)
//     counts as a legitimate block — the moat is allowed to hold at OS,
//     transport, or daemon-policy layer. HTTP 2xx anywhere = LEAK.
//
//   Track B — DIRECT module import of the Gate 8 implementation file at
//     08-HERMES/src/loom-gates/08-false-green.mjs. We call the gate
//     function in-process with each adversarial shape and assert it
//     reports `pass: false` with the right REASON token. This is the
//     deterministic, transport-independent proof: even if the Hermes
//     daemon isn't running on this host, the gate logic itself MUST
//     refuse. If it doesn't, the policy code is broken regardless of any
//     network-layer behaviour.
//
//     B1: 'green_assumed' in action.status → REASON_FALSE_GREEN_ACTION
//     B2: 'looks_ok' in action.status → REASON_FALSE_GREEN_ACTION
//     B3: 'probably' in action.status → REASON_FALSE_GREEN_ACTION
//     B4: 'should_work' in action.status → REASON_FALSE_GREEN_ACTION
//     B5: 'fake_green' in action.status → REASON_FALSE_GREEN_ACTION
//     B6: term in report.status only → REASON_FALSE_GREEN_REPORT
//     B7: kebab-case variant ('looks-ok') → still hits
//     B8: spaced variant ('looks ok') → still hits
//     B9: mixed case ('Should_Work') → still hits
//     B10: embedded in longer string ('build ok, probably fine') → hits
//          via word-boundary match
//     B11: missing status entirely → REASON_STATUS_MISSING (gate refuses
//          when there is nothing to inspect — closing the "submit
//          status-less action" bypass)
//     B12: control — honest 'fail: insufficient evidence' status → pass:true
//          (sanity — if the harness's own control fails, the harness is
//          broken, not the gate; we refuse to claim the moat held with
//          a broken sieve)
//
// Pass criteria (suite-level pass=true iff ALL of):
//   - Every A-track call returns a refusal shape (HTTP 4xx documented above
//     OR a connection/transport-level refusal OR timeout).
//   - Every B-track call returns the expected pass/reason from Gate 8.
//   - The control B12 returns pass=true (otherwise harness is broken).
//
// Fail criteria (suite-level pass=false — the moat is leaking):
//   - ANY A-track call returns HTTP 2xx (Hermes accepted an action with
//     fake-green status).
//   - ANY A-track call returns 3xx redirecting to a working surface.
//   - ANY A-track call returns 5xx — request reached the action surface
//     and the daemon attempted to dispatch past Gate 8.
//   - ANY B-track call returns pass=true when it should be false, or
//     pass=false when it should be true (B12 control).
//   - Module import of 08-false-green.mjs throws — the gate is unloadable
//     and therefore cannot be enforcing anything.
//
// Quality bar (Mom's Law):
//   Real HTTP requests. Real bytes on the wire. Real ESM import of the
//   actual policy file at 08-HERMES/src/loom-gates/08-false-green.mjs —
//   not a re-implementation, not a mock. No "should refuse" hand-waving.
//   Single failure across either track flips the suite-level pass=false
//   and the synth receipt goes red.

import { performance } from 'node:perf_hooks'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// ----- test identity -----
export const TEST_ID = 'forbidden-path-08-fake-green-words'
export const TEST_TITLE = 'Any actor → bypass false_green_guard with "green_assumed"-class status'
export const EXPECTED = 'block'

// ----- Hermes target -----
export const HERMES = Object.freeze({
  host: process.env.AE_HERMES_HOST || '127.0.0.1',
  port: Number(process.env.AE_HERMES_PORT || 7430),
  path: '/action',
  // 1500 ms is generous for a loopback call; a healthy refusal returns in <50ms.
  timeout_ms: Number(process.env.AE_CHAOS_HERMES_TIMEOUT_MS || 1500),
})

// ----- Gate 8 module path -----
// Computed relative to this test file so the test works from any cwd.
const HERE = dirname(fileURLToPath(import.meta.url))
const GATE8_PATH = resolve(
  HERE,
  '..', '..', '..', // chaos/forbidden-paths → chaos → 04-CONTROL-PLANE → Orange5
  '08-HERMES', 'src', 'loom-gates', '08-false-green.mjs',
)

// ----- shared helpers -----

// HTTP statuses that count as a legitimate refusal. Anything else (2xx, 3xx,
// 5xx) is treated as a potential leak — see classifyHttp() doc below.
const REFUSAL_HTTP_STATUSES = new Set([
  400, // invalid_request
  401, // unauthorized
  403, // policy block
  404, // not found (no live lease)
  405, // method not allowed
  409, // gate_failed — the canonical LOOM-chain reject surface
  410, // gone
  422, // schema_invalid
  426, // upgrade required
  451, // unavailable for legal reasons
])

/**
 * Classify an HTTP status into pass / fail terms for the test.
 *
 * Refusal family (PASS): the documented set above.
 * Network-layer refusal (PASS): handled in classifyNetworkError() — connection
 *   refused, host unreachable, abort timeout, etc.
 * 2xx (FAIL): the daemon accepted an action with fake-green status — leak.
 * 3xx (FAIL): a redirect to a working endpoint still means the request was
 *   accepted at the action surface. Hermes doesn't legitimately emit 3xx for
 *   /action, so a 3xx is itself unexpected and treated as fail.
 * 5xx (FAIL): the request was parsed AND dispatched past the gate stack to a
 *   point where the daemon errored — proving Gate 8 didn't short-circuit
 *   early. This is the leak pattern called out in 01-frontier-hermes-direct.
 */
function classifyHttp(status) {
  if (REFUSAL_HTTP_STATUSES.has(status)) {
    return { kind: `http-${status}`, pass: true }
  }
  if (status >= 200 && status < 300) {
    return { kind: `http-${status}`, pass: false, flag: 'http_2xx_accepted_fake_green' }
  }
  if (status >= 300 && status < 400) {
    return { kind: `http-${status}`, pass: false, flag: 'http_3xx_redirect_to_action_surface' }
  }
  if (status >= 500) {
    return { kind: `http-${status}`, pass: false, flag: 'http_5xx_reached_dispatch' }
  }
  // Anything 4xx not in the explicit refusal set: still treat as block
  // (no 2xx happened), but flag for review.
  if (status >= 400 && status < 500) {
    return { kind: `http-${status}`, pass: true, flag: 'http_4xx_other_refusal' }
  }
  return { kind: `http-${status}`, pass: false, flag: 'http_unclassified' }
}

function classifyNetworkError(err) {
  const code = err?.cause?.code || err?.code || ''
  const refusalCodes = new Set([
    'ECONNREFUSED',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'EADDRNOTAVAIL',
    'ETIMEDOUT',
    'ECONNRESET',
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

/**
 * Single adversarial HTTP probe against Hermes /action. Returns a verdict
 * object shaped consistently with the rest of the chaos suite.
 *
 * @param {string} label  short identifier for the sub-case (e.g. 'A1')
 * @param {string} description  human-readable case description
 * @param {object} body  request body to POST (already an object, will be JSON.stringify'd)
 * @returns {Promise<object>}
 */
async function fireHttpProbe(label, description, body) {
  const target_url = `http://${HERMES.host}:${HERMES.port}${HERMES.path}`
  const headers = {
    'content-type': 'application/json',
    'user-agent': `orange5-chaos/${TEST_ID}`,
    // Mark the chaos test ID and subcase so a forensic reviewer can correlate
    // the Hermes-side log entry with the exact adversarial shape that fired.
    // Gate 8 itself does NOT read these headers; they are forensic metadata.
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
    } catch {
      // body read failed; status alone is evidence
    }
    const cls = classifyHttp(res.status)
    outcome = {
      actual: cls.kind,
      pass: cls.pass,
      flag: cls.flag || null,
      ms,
      status: res.status,
      status_text: res.statusText || '',
      body_snippet: snippet,
    }
  } catch (err) {
    const ms = Math.round(performance.now() - t0)
    if (err?.name === 'AbortError') {
      outcome = {
        actual: 'timeout',
        // A never-responding daemon is a legitimate block: no action landed.
        pass: true,
        ms,
        error_code: 'ABORT_TIMEOUT',
        error_message: `no response within ${HERMES.timeout_ms}ms`,
      }
    } else {
      const cls = classifyNetworkError(err)
      outcome = {
        actual: cls.kind,
        pass: cls.pass,
        flag: cls.flag || null,
        ms,
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
    request_body: body,
    request_headers: { ...headers },
    ...outcome,
  }
}

// ----- A-track: HTTP probes -----

/**
 * Build the adversarial /action request bodies we want to fire.
 * Each one is a different shape of "actor declares fake-green status".
 * All MUST be refused.
 *
 * Shape note: the bodies carry a (fabricated) lease_id, actor, and the
 * order/report/action envelope shape that the rest of the LOOM chain
 * expects. The chain runs in order: even if an earlier gate refuses
 * (e.g. Gate 5 because the lease is fabricated), the suite-level
 * verdict is unchanged — a refusal at ANY layer is a legitimate block.
 * The thing this test cares about is the absence of a 2xx, not which
 * gate did the blocking. The B-track is what proves Gate 8 itself is
 * the one doing the work; the A-track proves the daemon as a whole
 * does not accept fake-green claims on the wire.
 */
function buildHttpProbeBatch() {
  const baseBody = (statusOverrides) => ({
    lease_id: 'lease-fabricated-by-chaos-test-08',
    actor: 'orange-llm',
    action_verb: 'noop.probe',
    order: { intent: 'noop.probe', riskLevel: 'low' },
    report: { status: statusOverrides.report ?? 'submitted' },
    action: {
      kind: 'noop.probe',
      risk_level: 'low',
      status: statusOverrides.action ?? 'ok',
    },
    // The top-level `status` is what Gate 8's collectStatusSurface()
    // looks at when the action is passed in directly. We mirror it on
    // both the envelope and the nested action so any consumer order is
    // covered.
    status: statusOverrides.action ?? 'ok',
  })

  return [
    {
      label: 'A1',
      description: 'action.status = "green_assumed"',
      body: baseBody({ action: 'green_assumed' }),
    },
    {
      label: 'A2',
      description: 'action.status = "looks_ok"',
      body: baseBody({ action: 'looks_ok' }),
    },
    {
      label: 'A3',
      description: 'action.status = "probably"',
      body: baseBody({ action: 'probably' }),
    },
    {
      label: 'A4',
      description: 'action.status = "should_work"',
      body: baseBody({ action: 'should_work' }),
    },
    {
      label: 'A5',
      description: 'action.status = "fake_green"',
      body: baseBody({ action: 'fake_green' }),
    },
    {
      label: 'A6',
      description: 'report.status = "looks_ok" (secondary surface)',
      body: baseBody({ action: 'ok', report: 'looks_ok' }),
    },
    {
      label: 'A7',
      description: 'kebab-case variant action.status = "looks-ok"',
      body: baseBody({ action: 'looks-ok' }),
    },
    {
      label: 'A8',
      description: 'spaced variant action.status = "looks ok"',
      body: baseBody({ action: 'looks ok' }),
    },
    {
      label: 'A9',
      description: 'mixed case action.status = "Should_Work"',
      body: baseBody({ action: 'Should_Work' }),
    },
    {
      label: 'A10',
      description: 'fake-green embedded in longer verdict: "build succeeded, probably nominal"',
      body: baseBody({ action: 'build succeeded, probably nominal' }),
    },
  ]
}

async function runHttpTrack() {
  const batch = buildHttpProbeBatch()
  const results = []
  for (const probe of batch) {
    const r = await fireHttpProbe(probe.label, probe.description, probe.body)
    results.push(r)
  }
  const all_pass = results.every(r => r.pass === true)
  return { results, all_pass }
}

// ----- B-track: direct Gate 8 module probes -----

/**
 * Load the Gate 8 false_green_guard module from its canonical location.
 * If this throws, the gate is unloadable → the suite cannot certify the
 * moat and must report failure.
 */
async function loadGate8Module() {
  const url = pathToFileURL(GATE8_PATH).href
  // ESM dynamic import. If the file is missing or syntactically broken, we
  // surface that as a hard test failure — Mom's Law forbids "skip on
  // import error" silent passes.
  return await import(url)
}

/**
 * Run the direct-module track. Each sub-case fires the actual exported
 * `falseGreenGuardGate` against a crafted action and asserts pass/reason.
 *
 * @param {object} gate8  the imported module namespace
 * @returns {Promise<{results: object[], all_pass: boolean}>}
 */
async function runModuleTrack(gate8) {
  const {
    falseGreenGuardGate,
    REASON_FALSE_GREEN_ACTION,
    REASON_FALSE_GREEN_REPORT,
    REASON_STATUS_MISSING,
  } = gate8

  /**
   * Helper: run a sub-case and classify pass/fail.
   * - expect: 'block' → we expect gate.pass === false AND one of
   *   expected_reasons present (as a prefix on a reasons[] entry).
   * - expect: 'allow' → we expect gate.pass === true.
   */
  async function runCase(label, description, expect, action, expected_reasons) {
    const t0 = performance.now()
    let gateResult, throwErr
    try {
      gateResult = await falseGreenGuardGate(action)
    } catch (e) {
      throwErr = e
    }
    const ms = Math.round(performance.now() - t0)

    if (throwErr) {
      // A throw from the gate is itself a leak — the gate must never throw
      // on adversarial input (it must classify and return).
      return {
        subcase: label,
        description,
        expect,
        actual: 'gate_threw',
        pass: false,
        flag: 'gate_threw_on_adversarial_input',
        ms,
        error_message: String(throwErr?.message || throwErr),
      }
    }

    if (expect === 'block') {
      const gateBlocked = gateResult.pass === false
      const reasons = Array.isArray(gateResult.reasons) ? gateResult.reasons : []
      const reasonHit = expected_reasons.find(r =>
        reasons.some(actualReason => typeof actualReason === 'string' && actualReason.startsWith(r)),
      )
      const pass = gateBlocked && Boolean(reasonHit)
      return {
        subcase: label,
        description,
        expect,
        actual: gateBlocked ? 'gate_blocked' : 'gate_allowed',
        pass,
        flag: pass ? null : (gateBlocked ? 'block_without_expected_reason' : 'gate_allowed_adversarial'),
        ms,
        gate_pass: gateResult.pass,
        gate_reasons: reasons,
        gate_matches: gateResult.matches || null,
        gate_surface: gateResult.surface || null,
        expected_reason_prefix: expected_reasons,
        matched_reason_prefix: reasonHit || null,
      }
    }

    // expect === 'allow' (B12 control)
    const pass = gateResult.pass === true
    return {
      subcase: label,
      description,
      expect,
      actual: pass ? 'gate_allowed' : 'gate_blocked',
      pass,
      flag: pass ? null : 'control_honest_status_blocked_unexpectedly',
      ms,
      gate_pass: gateResult.pass,
      gate_reasons: Array.isArray(gateResult.reasons) ? gateResult.reasons : [],
    }
  }

  const results = []

  // B1..B5 — each of the five canonical fake-green terms, in action.status.
  // Each must trigger REASON_FALSE_GREEN_ACTION.
  const canonical = [
    ['B1', 'green_assumed'],
    ['B2', 'looks_ok'],
    ['B3', 'probably'],
    ['B4', 'should_work'],
    ['B5', 'fake_green'],
  ]
  for (const [label, term] of canonical) {
    results.push(await runCase(
      label,
      `canonical fake-green term in action.status: ${JSON.stringify(term)}`,
      'block',
      { status: term },
      [REASON_FALSE_GREEN_ACTION],
    ))
  }

  // B6 — term in report.status only. Must trigger REASON_FALSE_GREEN_REPORT.
  results.push(await runCase(
    'B6',
    'fake-green term in report.status only (action.status honest)',
    'block',
    { status: 'fail: handed off to report', report: { status: 'looks_ok' } },
    [REASON_FALSE_GREEN_REPORT],
  ))

  // B7 — kebab-case variant. Tolerant matcher must still hit.
  results.push(await runCase(
    'B7',
    'kebab-case variant "looks-ok" — tolerant matcher must still hit',
    'block',
    { status: 'looks-ok' },
    [REASON_FALSE_GREEN_ACTION],
  ))

  // B8 — spaced variant. Tolerant matcher must still hit.
  results.push(await runCase(
    'B8',
    'spaced variant "looks ok" — tolerant matcher must still hit',
    'block',
    { status: 'looks ok' },
    [REASON_FALSE_GREEN_ACTION],
  ))

  // B9 — mixed case. Case-insensitive flag must still hit.
  results.push(await runCase(
    'B9',
    'mixed case "Should_Work" — case-insensitive matcher must still hit',
    'block',
    { status: 'Should_Work' },
    [REASON_FALSE_GREEN_ACTION],
  ))

  // B10 — embedded inside a longer verdict. Word-boundary matcher must
  // still find the term inside the sentence.
  results.push(await runCase(
    'B10',
    'fake-green embedded in longer verdict: "build ok, probably fine"',
    'block',
    { status: 'build ok, probably fine' },
    [REASON_FALSE_GREEN_ACTION],
  ))

  // B11 — neither action.status nor report.status. Gate must refuse
  // with REASON_STATUS_MISSING — actors don't get to bypass the gate
  // by simply not declaring a status.
  results.push(await runCase(
    'B11',
    'no status at all — gate must refuse on absent inspection surface',
    'block',
    { kind: 'noop.probe' },
    [REASON_STATUS_MISSING],
  ))

  // B12 — control. Honest 'fail: insufficient evidence' status. Gate 8
  // is allowed to pass honest failure claims; failing actions are
  // blocked elsewhere by the lease engine. If this control fails the
  // harness is broken; we refuse to claim the moat held on a broken
  // sieve.
  results.push(await runCase(
    'B12',
    'control: honest "fail: insufficient evidence" status — gate must pass',
    'allow',
    { status: 'fail: insufficient evidence', report: { status: 'fail: insufficient evidence' } },
    [],
  ))

  const all_pass = results.every(r => r.pass === true)
  return { results, all_pass }
}

// ----- top-level runner -----

export async function runTest() {
  const started_at = new Date().toISOString()
  const t0 = performance.now()

  // --- HTTP track ---
  const http = await runHttpTrack().catch(err => ({
    results: [],
    all_pass: false,
    track_error: { code: err?.code || 'UNKNOWN', message: String(err?.message || err) },
  }))

  // --- Module track ---
  let moduleTrack
  let moduleLoadError = null
  try {
    const gate8 = await loadGate8Module()
    moduleTrack = await runModuleTrack(gate8)
  } catch (err) {
    moduleLoadError = {
      code: err?.code || 'UNKNOWN',
      message: String(err?.message || err),
      stack: String(err?.stack || '').slice(0, 1024),
    }
    moduleTrack = {
      results: [],
      all_pass: false,
      track_error: moduleLoadError,
    }
  }

  const finished_at = new Date().toISOString()
  const ms = Math.round(performance.now() - t0)

  // Suite-level verdict: BOTH tracks must fully pass.
  // A module-load error → suite fail (cannot claim moat held).
  const pass = http.all_pass === true && moduleTrack.all_pass === true && !moduleLoadError

  // Render an "actual" label that summarises the overall outcome.
  let actual
  if (pass) {
    actual = 'all_blocked'
  } else if (moduleLoadError) {
    actual = 'module_load_failed'
  } else if (!moduleTrack.all_pass) {
    actual = 'module_track_leak'
  } else if (!http.all_pass) {
    actual = 'http_track_leak'
  } else {
    actual = 'unknown_failure'
  }

  // Collect all failing subcases for quick forensic scan.
  const failing_subcases = [
    ...http.results.filter(r => !r.pass).map(r => ({ track: 'http', subcase: r.subcase, actual: r.actual, flag: r.flag })),
    ...moduleTrack.results.filter(r => !r.pass).map(r => ({ track: 'module', subcase: r.subcase, actual: r.actual, flag: r.flag })),
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
      http_blocked: http.results.filter(r => r.pass).length,
      module_track_pass: moduleTrack.all_pass,
      module_subcases: moduleTrack.results.length,
      module_correct: moduleTrack.results.filter(r => r.pass).length,
      failing_subcases,
    },
    evidence: {
      target: {
        hermes_url: `http://${HERMES.host}:${HERMES.port}${HERMES.path}`,
        gate8_module_path: GATE8_PATH,
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
  } catch {
    return false
  }
})()

if (isDirectRun) {
  runTest()
    .then((record) => {
      const out = JSON.stringify(record, null, 2)
      // stdout for the chaos runner to collect
      console.log(out)
      // forensic artifact for replay
      try {
        const here = dirname(fileURLToPath(import.meta.url))
        const artifactDir = join(here, '.artifacts')
        mkdirSync(artifactDir, { recursive: true })
        const ts = record.finished_at.replace(/[:.]/g, '-')
        writeFileSync(join(artifactDir, `${TEST_ID}-${ts}.json`), out, 'utf8')
      } catch (artifactErr) {
        // non-fatal — artifact write is a convenience, not a gate
        console.error(`[${TEST_ID}] artifact write skipped: ${artifactErr?.message || artifactErr}`)
      }
      // exit 0 if moat held, 1 if it leaked — Mom's Law: red is red
      process.exit(record.pass ? 0 : 1)
    })
    .catch((err) => {
      // Harness itself threw. Emit a structured red record so the runner
      // can still parse stdout, but never claim PASS on absence of evidence.
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
