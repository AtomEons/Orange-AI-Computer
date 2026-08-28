// 07-bypass-gateway-tag.mjs
// Frontier-Isolation chaos test — Path 7 of 12.
//
// Doctrine:
//   The 27 Guardrails include #07 frontier-via-gateway: every LLM call
//   from any actor in the AtomEons superstack must traverse the local
//   Frontier-Isolation gateway at 127.0.0.1:1337 — the gateway is the
//   sole egress point for frontier model traffic, and Hermes is the
//   sole on-host action surface. LOOM Gate 6 — `openai_gateway` — is
//   the LOOM-time chokepoint that verifies the gateway actually
//   handled the call: it reads `action.evidence.llm` and demands a
//   gateway-issued `request_id` (prefix "gw_", well-formed ULID-ish
//   tail) plus origin info that resolves to 127.0.0.1:<gatewayPort>.
//   The header echo `x-orange-gateway: 1` is an optional corroborator;
//   if present it must equal "1", but it is NOT a substitute for the
//   request_id. The gateway-issued request_id is the load-bearing
//   evidence — Gate 6 exists primarily so an action that "claimed" to
//   have called an LLM but cannot produce a gateway request_id is
//   refused on sight.
//
//   This test simulates an OrangeLLM-shaped caller (in-stack model
//   with gateway access — Gates 1-5 would let it through) attempting
//   to land an /action on Hermes where `action.evidence.llm` is
//   present and declares an LLM call, but the gateway `request_id` is
//   missing, empty, malformed, or carries a forged shape. There are
//   six operationally distinct ways an actor could try to slip past
//   Gate 6 on the request_id axis; we fire all of them and assert
//   every single one is refused with the right reason token. A single
//   bypass succeeding means the openai_gateway moat is leaking →
//   synth receipt MUST go red.
//
// What this test fires (two tracks, both required to PASS):
//
//   Track A — REAL HTTP against the Hermes daemon at 127.0.0.1:7430/action.
//     We POST a Hermes action whose body declares an LLM step (kind:
//     "llm.chat") but whose evidence.llm is mis-shaped on the
//     request_id axis. Hermes is expected to refuse at the LOOM Gate 6
//     stage with a 4xx (gate_failed / invalid_request) or, if the
//     daemon is down on this host, the OS refuses the TCP connect.
//     Both count as a block.
//
//     A1. evidence.llm completely absent (kind=llm.chat)  → expect 4xx refusal
//     A2. evidence.llm present but request_id field omitted → expect 4xx refusal
//     A3. evidence.llm.request_id === '' (empty string)   → expect 4xx refusal
//     A4. evidence.llm.request_id missing "gw_" prefix    → expect 4xx refusal
//     A5. evidence.llm.request_id has "gw_" prefix but
//         malformed tail (chars outside the allowed set)   → expect 4xx refusal
//     A6. evidence.llm carries forged x-orange-gateway: 0
//         header (gateway header set wrong value, request_id
//         well-formed otherwise — gate must still refuse)   → expect 4xx refusal
//
//     For every A-track call: connection-refused, ENETUNREACH,
//     ETIMEDOUT, or any HTTP refusal status (400/401/403/404/405/409/
//     410/422/426/451) counts as a legitimate block. HTTP 2xx anywhere
//     = LEAK (the daemon accepted an action without gateway proof).
//
//   Track B — DIRECT module import of the Gate 6 implementation file at
//     08-HERMES/src/loom-gates/06-openai-gateway.mjs. We call the
//     exported `openaiGatewayGate(action, opts?)` function in-process
//     with each adversarial action shape and assert it reports
//     `pass: false` with the right REASON_* token. This is the
//     deterministic, transport-independent proof: even if the Hermes
//     daemon isn't running on this host, the gate logic itself MUST
//     refuse. If it doesn't, the policy code is broken regardless of
//     any network-layer behaviour.
//
//     B1. kind=llm.chat, action.evidence absent entirely
//          → REASON_EVIDENCE_MISSING
//     B2. kind=llm.chat, action.evidence present but .llm omitted
//          → REASON_EVIDENCE_MISSING
//     B3. kind=llm.chat, evidence.llm present, origin OK, but
//         request_id omitted entirely
//          → REASON_REQUEST_ID_MISSING
//     B4. kind=llm.chat, evidence.llm.request_id === '' (empty)
//          → REASON_REQUEST_ID_MISSING
//     B5. kind=llm.chat, evidence.llm.request_id is a number (not str)
//          → REASON_REQUEST_ID_MISSING
//     B6. kind=llm.chat, request_id missing "gw_" prefix
//          ('not_a_gateway_id_at_all_just_random_string')
//          → REASON_REQUEST_ID_MALFORMED
//     B7. kind=llm.chat, request_id has "gw_" prefix but tail too
//          short ('gw_short')
//          → REASON_REQUEST_ID_MALFORMED
//     B8. kind=llm.chat, request_id has "gw_" prefix but tail uses
//          disallowed chars ('gw_!!!invalid$$$chars!!!1234567890ABCDEF')
//          → REASON_REQUEST_ID_MALFORMED
//     B9. kind=llm.chat, request_id well-formed but x-orange-gateway
//          header echo set to "0" (forged-low) — origin OK
//          → REASON_GATEWAY_HEADER_MISMATCH
//     B10. control: kind=llm.chat, well-formed request_id, correct
//          origin (127.0.0.1:1337), no forged headers
//          → pass: true (sanity — distinguishes PASS from FAIL; if
//          control is also pass:false the test harness itself is
//          broken and we refuse to claim moat held with a broken
//          sieve)
//
// Pass criteria (suite-level pass=true iff ALL of):
//   - Every A-track call returns a refusal shape (documented HTTP 4xx
//     OR a connection/transport-level refusal OR timeout).
//   - Every B-track block-case returns pass=false with the expected
//     REASON_* token present in `gate.reasons`.
//   - B10 control returns pass=true (else harness is broken).
//
// Fail criteria (suite-level pass=false — the moat is leaking):
//   - ANY A-track call returns HTTP 2xx (Hermes accepted a no-gateway
//     /action).
//   - ANY A-track call returns 3xx redirecting to a working surface.
//   - ANY A-track call returns 5xx — proves Gate 6 didn't short-circuit
//     early; request reached dispatch.
//   - ANY B-track block-case returns pass=true (gate accepted the
//     adversarial shape) OR returns pass=false without the expected
//     REASON_* tag (gate refused for the wrong reason — operator must
//     verify the moat is intact for the right reason).
//   - B10 control returns pass=false (harness broken — we refuse to
//     certify on a broken sieve).
//   - Module import of 06-openai-gateway.mjs throws — the gate is
//     unloadable and therefore cannot be enforcing anything.
//
// Quality bar (Mom's Law):
//   Real HTTP requests. Real bytes on the wire. Real ESM import of
//   the actual policy file at 08-HERMES/src/loom-gates/06-openai-
//   gateway.mjs — not a re-implementation, not a mock. Every probe
//   classified deterministically; no "should refuse" hand-waving. A
//   single failure across either track flips the suite-level
//   pass=false and the synth receipt goes red. The moat is binary.

import { performance } from 'node:perf_hooks'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// ----- test identity -----
export const TEST_ID = 'forbidden-path-07-bypass-gateway-tag'
export const TEST_TITLE = 'OrangeLLM → bypass Gate 6 openai_gateway (no/forged gateway request_id)'
export const EXPECTED = 'block'

// ----- Hermes target -----
export const HERMES = Object.freeze({
  host: process.env.AE_HERMES_HOST || '127.0.0.1',
  port: Number(process.env.AE_HERMES_PORT || 7430),
  path: '/action',
  // 1500 ms is generous for a loopback call; a healthy refusal returns in <50ms.
  timeout_ms: Number(process.env.AE_CHAOS_HERMES_TIMEOUT_MS || 1500),
})

// ----- Gate 6 module path -----
// Computed relative to this test file so the test works from any cwd.
const HERE = dirname(fileURLToPath(import.meta.url))
const GATE6_PATH = resolve(
  HERE,
  '..', '..', '..', // chaos/forbidden-paths → chaos → 04-CONTROL-PLANE → Orange5
  '08-HERMES', 'src', 'loom-gates', '06-openai-gateway.mjs',
)

// ----- shared helpers -----

// HTTP statuses that count as a legitimate refusal. Anything else
// (2xx, 3xx, 5xx) is treated as a potential leak — see classifyHttp().
const REFUSAL_HTTP_STATUSES = new Set([
  400, // invalid_request / schema_invalid
  401, // unauthorized
  403, // gate_refused (the canonical Gate 6 surface)
  404, // not_found
  405, // method not allowed
  409, // gate_failed
  410, // gone
  422, // schema_invalid
  426, // upgrade required
  451, // unavailable for legal reasons
])

/**
 * Classify an HTTP status into pass / fail terms for the test.
 *
 * Refusal family (PASS): the documented set above.
 * Network-layer refusal (PASS): handled in classifyNetworkError() —
 *   connection refused, host unreachable, abort timeout, etc.
 * 2xx (FAIL): the daemon accepted a no-gateway-evidence action — that
 *   IS the leak we are testing for.
 * 3xx (FAIL): a redirect to a working endpoint still means the
 *   request was accepted at the action surface.
 * 5xx (FAIL): the request was parsed AND dispatched past the gate
 *   stack to a point where the daemon errored — proving Gate 6
 *   didn't short-circuit early. Same logic as path 6 (codexa_lease).
 */
function classifyHttp(status) {
  if (REFUSAL_HTTP_STATUSES.has(status)) {
    return { kind: `http-${status}`, pass: true }
  }
  if (status >= 200 && status < 300) {
    return { kind: `http-${status}`, pass: false, flag: 'http_2xx_accepted_no_gateway' }
  }
  if (status >= 300 && status < 400) {
    return { kind: `http-${status}`, pass: false, flag: 'http_3xx_redirect_to_action_surface' }
  }
  if (status >= 500) {
    return { kind: `http-${status}`, pass: false, flag: 'http_5xx_reached_dispatch' }
  }
  // Anything 4xx not in the explicit refusal set: still treat as
  // block (no 2xx happened), but flag for review.
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
 * Single adversarial HTTP probe against Hermes /action. Returns a
 * verdict object shaped consistently with the rest of the chaos suite.
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
    // Mark the actor as in-stack OrangeLLM so the test documents which
    // boundary is being exercised. Gate 6 does NOT itself read this
    // header; it's evidence for forensic review.
    'x-model-family': 'orange-llm',
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
 * Build the six adversarial /action request bodies we want to fire.
 * Each one is a different shape of "OrangeLLM tries to land an LLM
 * action without a valid gateway request_id". All MUST be refused.
 *
 * NOTE on body shape: Hermes /action expects a top-level envelope
 * that includes lease_id, actor, order, report, and action. We
 * include a fabricated lease_id (which Gate 5 will refuse) because
 * the daemon may short-circuit at Gate 5 before Gate 6 is reached.
 * Either refusal counts as a block — the moat is allowed to hold at
 * any LOOM gate as long as HTTP 2xx never happens. Track B exercises
 * Gate 6 in isolation regardless of upstream gate behaviour.
 */
function buildHttpProbeBatch() {
  // Common envelope skeleton — the action.evidence shape is what we
  // mutate per case to exercise Gate 6 specifically.
  const baseEnvelope = (action) => ({
    lease_id: 'lease-fabricated-chaos-path-07',
    actor: 'orange-llm',
    action_verb: 'llm.chat',
    order: { intent: 'llm.chat', riskLevel: 'low' },
    report: { status: 'submitted' },
    action,
  })

  // A1: evidence completely absent. Action declares LLM kind but
  // carries no evidence block at all. Gate 6 → REASON_EVIDENCE_MISSING.
  const a1 = {
    label: 'A1',
    description: 'kind=llm.chat with no action.evidence at all',
    body: baseEnvelope({
      kind: 'llm.chat',
      risk_level: 'low',
      // no evidence
    }),
  }

  // A2: evidence object present but no .llm sub-block. Same shape
  // Gate 6 catches as evidence_missing.
  const a2 = {
    label: 'A2',
    description: 'action.evidence present but evidence.llm sub-block omitted',
    body: baseEnvelope({
      kind: 'llm.chat',
      risk_level: 'low',
      evidence: {
        // .llm missing
        other_field: 'present',
      },
    }),
  }

  // A3: evidence.llm present, origin OK, but request_id field is the
  // empty string. Gate 6 → REASON_REQUEST_ID_MISSING.
  const a3 = {
    label: 'A3',
    description: 'evidence.llm.request_id present but empty string',
    body: baseEnvelope({
      kind: 'llm.chat',
      risk_level: 'low',
      evidence: {
        llm: {
          request_id: '',
          origin: 'http://127.0.0.1:1337',
        },
      },
    }),
  }

  // A4: request_id present but no "gw_" prefix. The pattern
  // /^gw_[A-Za-z0-9_-]{8,64}$/ rejects this. Gate 6 → REASON_REQUEST_ID_MALFORMED.
  const a4 = {
    label: 'A4',
    description: 'evidence.llm.request_id missing the gateway "gw_" prefix',
    body: baseEnvelope({
      kind: 'llm.chat',
      risk_level: 'low',
      evidence: {
        llm: {
          request_id: 'not_a_gateway_id_at_all_just_random_string_DEADBEEF',
          origin: 'http://127.0.0.1:1337',
        },
      },
    }),
  }

  // A5: "gw_" prefix present but tail uses chars outside the allowed
  // [A-Za-z0-9_-]{8,64} alphabet. Gate 6 → REASON_REQUEST_ID_MALFORMED.
  const a5 = {
    label: 'A5',
    description: 'evidence.llm.request_id has "gw_" prefix but malformed tail (disallowed chars)',
    body: baseEnvelope({
      kind: 'llm.chat',
      risk_level: 'low',
      evidence: {
        llm: {
          request_id: 'gw_!!!invalid$$$chars!!!1234567890ABCDEF',
          origin: 'http://127.0.0.1:1337',
        },
      },
    }),
  }

  // A6: well-formed request_id + correct origin, but the x-orange-
  // gateway header echo is forged-low ("0" instead of "1"). The gate
  // treats this as a hard fail because a header forgery is worse than
  // omission. Gate 6 → REASON_GATEWAY_HEADER_MISMATCH.
  const a6 = {
    label: 'A6',
    description: 'well-formed request_id but forged x-orange-gateway: 0 header echo',
    body: baseEnvelope({
      kind: 'llm.chat',
      risk_level: 'low',
      evidence: {
        llm: {
          request_id: 'gw_01HZ9CHAOS7TESTREQUESTIDFORGEDHEAD',
          origin: 'http://127.0.0.1:1337',
          headers: {
            'x-orange-gateway': '0', // forged-low: gateway always sets "1"
          },
        },
      },
    }),
  }

  return [a1, a2, a3, a4, a5, a6]
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

// ----- B-track: direct Gate 6 module probes -----

/**
 * Load the Gate 6 openai_gateway module from its canonical location.
 * If this throws, the gate is unloadable → the suite cannot certify
 * the moat and must report failure.
 */
async function loadGate6Module() {
  const url = pathToFileURL(GATE6_PATH).href
  // ESM dynamic import. If the file is missing or syntactically
  // broken, we surface that as a hard test failure — Mom's Law forbids
  // "skip on import error" silent passes.
  return await import(url)
}

/**
 * Run the direct-module track. Each sub-case fires the actual
 * exported `openaiGatewayGate` against a crafted action and asserts
 * pass/reason.
 *
 * @param {object} gate6  the imported module namespace
 * @returns {Promise<{results: object[], all_pass: boolean}>}
 */
async function runModuleTrack(gate6) {
  const {
    openaiGatewayGate,
    REASON_EVIDENCE_MISSING,
    REASON_REQUEST_ID_MISSING,
    REASON_REQUEST_ID_MALFORMED,
    REASON_GATEWAY_HEADER_MISMATCH,
    GATEWAY_HOST,
    GATEWAY_PORT,
  } = gate6

  /**
   * Helper: run a sub-case and classify pass/fail.
   * - expect: 'block' → gate.pass === false AND one of expected_reasons matches a prefix.
   * - expect: 'allow' → gate.pass === true.
   */
  async function runCase(label, description, expect, action, opts, expected_reasons) {
    const t0 = performance.now()
    let gateResult, throwErr
    try {
      gateResult = await openaiGatewayGate(action, opts)
    } catch (e) {
      throwErr = e
    }
    const ms = Math.round(performance.now() - t0)

    if (throwErr) {
      // A throw from the gate is itself a leak — the gate must never
      // throw on adversarial input (it must classify and return).
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
        reasons.some(actual => typeof actual === 'string' && actual.startsWith(r)),
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
        expected_reason_prefix: expected_reasons,
        matched_reason_prefix: reasonHit || null,
      }
    }

    // expect === 'allow' (B10 control)
    const pass = gateResult.pass === true
    return {
      subcase: label,
      description,
      expect,
      actual: pass ? 'gate_allowed' : 'gate_blocked',
      pass,
      flag: pass ? null : 'control_action_blocked_unexpectedly',
      ms,
      gate_pass: gateResult.pass,
      gate_reasons: Array.isArray(gateResult.reasons) ? gateResult.reasons : [],
    }
  }

  // Pin gateway host/port for the gate so the test does not depend on
  // process env. We exercise the canonical 127.0.0.1:1337 surface.
  const opts = { gatewayHost: GATEWAY_HOST, gatewayPort: GATEWAY_PORT }

  // Reusable well-formed request_id and origin for cases where those
  // fields should NOT be the reason for refusal.
  const GOOD_RID = 'gw_01HZ9CHAOS7VALIDTAILBASE32ABCDEF'
  const GOOD_ORIGIN = `http://${GATEWAY_HOST}:${GATEWAY_PORT}`

  const results = []

  // B1: kind=llm.chat with no evidence at all → EVIDENCE_MISSING
  results.push(await runCase(
    'B1',
    'kind=llm.chat with no action.evidence at all',
    'block',
    { kind: 'llm.chat' },
    opts,
    [REASON_EVIDENCE_MISSING],
  ))

  // B2: evidence object present but .llm sub-block missing → EVIDENCE_MISSING
  results.push(await runCase(
    'B2',
    'action.evidence present but evidence.llm sub-block omitted',
    'block',
    { kind: 'llm.chat', evidence: { other_field: 'present' } },
    opts,
    [REASON_EVIDENCE_MISSING],
  ))

  // B3: evidence.llm present, origin OK, but request_id field omitted
  // entirely → REQUEST_ID_MISSING
  results.push(await runCase(
    'B3',
    'evidence.llm present, origin OK, but request_id field omitted',
    'block',
    {
      kind: 'llm.chat',
      evidence: { llm: { origin: GOOD_ORIGIN } },
    },
    opts,
    [REASON_REQUEST_ID_MISSING],
  ))

  // B4: evidence.llm.request_id === '' (empty) → REQUEST_ID_MISSING
  results.push(await runCase(
    'B4',
    'evidence.llm.request_id is empty string',
    'block',
    {
      kind: 'llm.chat',
      evidence: { llm: { request_id: '', origin: GOOD_ORIGIN } },
    },
    opts,
    [REASON_REQUEST_ID_MISSING],
  ))

  // B5: evidence.llm.request_id is a number, not a string. Gate's
  // typeof check refuses it as missing (non-string is treated as
  // absent). → REQUEST_ID_MISSING.
  results.push(await runCase(
    'B5',
    'evidence.llm.request_id is a number (wrong type)',
    'block',
    {
      kind: 'llm.chat',
      evidence: { llm: { request_id: 1337, origin: GOOD_ORIGIN } },
    },
    opts,
    [REASON_REQUEST_ID_MISSING],
  ))

  // B6: request_id missing "gw_" prefix → REQUEST_ID_MALFORMED
  results.push(await runCase(
    'B6',
    'evidence.llm.request_id missing the gateway "gw_" prefix',
    'block',
    {
      kind: 'llm.chat',
      evidence: {
        llm: {
          request_id: 'not_a_gateway_id_at_all_just_random_string',
          origin: GOOD_ORIGIN,
        },
      },
    },
    opts,
    [REASON_REQUEST_ID_MALFORMED],
  ))

  // B7: "gw_" prefix present but tail too short (must be >= 8 chars
  // after prefix; "short" is 5). → REQUEST_ID_MALFORMED.
  results.push(await runCase(
    'B7',
    'evidence.llm.request_id has "gw_" prefix but tail too short',
    'block',
    {
      kind: 'llm.chat',
      evidence: {
        llm: { request_id: 'gw_short', origin: GOOD_ORIGIN },
      },
    },
    opts,
    [REASON_REQUEST_ID_MALFORMED],
  ))

  // B8: "gw_" prefix present but tail uses disallowed chars (!, $)
  // → REQUEST_ID_MALFORMED.
  results.push(await runCase(
    'B8',
    'evidence.llm.request_id has "gw_" prefix but disallowed chars in tail',
    'block',
    {
      kind: 'llm.chat',
      evidence: {
        llm: {
          request_id: 'gw_!!!invalid$$$chars!!!1234567890ABCDEF',
          origin: GOOD_ORIGIN,
        },
      },
    },
    opts,
    [REASON_REQUEST_ID_MALFORMED],
  ))

  // B9: well-formed request_id + correct origin, but forged
  // x-orange-gateway: 0 header. Gate 6 → REASON_GATEWAY_HEADER_MISMATCH.
  results.push(await runCase(
    'B9',
    'well-formed request_id + correct origin but forged x-orange-gateway: 0 header',
    'block',
    {
      kind: 'llm.chat',
      evidence: {
        llm: {
          request_id: GOOD_RID,
          origin: GOOD_ORIGIN,
          headers: { 'x-orange-gateway': '0' },
        },
      },
    },
    opts,
    [REASON_GATEWAY_HEADER_MISMATCH],
  ))

  // B10: CONTROL — well-formed request_id, correct origin, no forged
  // headers, kind=llm.chat. Must pass=true. If it doesn't, the
  // harness or the gate's accept path is broken; either way we
  // refuse to certify on a broken sieve.
  results.push(await runCase(
    'B10',
    'control: well-formed request_id, correct origin, no forged headers',
    'allow',
    {
      kind: 'llm.chat',
      evidence: {
        llm: {
          request_id: GOOD_RID,
          origin: GOOD_ORIGIN,
          headers: { 'x-orange-gateway': '1' },
        },
      },
    },
    opts,
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
    const gate6 = await loadGate6Module()
    moduleTrack = await runModuleTrack(gate6)
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
  // An HTTP track-error is ambiguous — we still require the module
  // track to be green, but we call it out separately.
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
        gate6_module_path: GATE6_PATH,
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
      // Harness itself threw. Emit a structured red record so the
      // runner can still parse stdout, but never claim PASS on
      // absence of evidence.
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
