// 01-frontier-hermes-direct.mjs
// Forbidden path #1 of the Frontier-Isolation chaos suite.
//
// Doctrine (27 Guardrails #07 — frontier-via-gateway):
//   A frontier model MUST NEVER reach Hermes, an Æ daemon, or local disk
//   directly. Every frontier-shaped request must transit the 1337 gateway,
//   which attaches a request_id, applies the Gate 0 LBCE lattice check,
//   runs the 9-Gate Stack, and (only on PASS) hands a sealed lease to
//   Hermes on 7430. The Hermes daemon itself binds 127.0.0.1 (loopback)
//   and is firewalled so the only legitimate caller is the gateway
//   running on the same host. Anything else — a tool-call shaped as
//   a frontier model dialing 7430 — is a moat breach.
//
// What this test does:
//   Simulates a frontier-model-shaped HTTP POST landing directly on
//   127.0.0.1:7430/action without any 1337 gateway hop. The request
//   carries the giveaway frontier headers (no gateway request_id, no
//   sealed lease, no Gate 0 LBCE token, model_family=frontier) — a
//   shape Hermes is required to refuse on sight.
//
// Pass criteria (any ONE of these is a legitimate block; the moat is
// allowed to hold the line at OS, transport, or daemon-policy layer):
//   - TCP connect is refused (daemon down OR bound to a different
//     interface OR firewall drop) → ECONNREFUSED / EHOSTUNREACH /
//     ENETUNREACH / ETIMEDOUT.
//   - Daemon answers but returns HTTP 403 (explicit policy block).
//   - Daemon answers but returns HTTP 401 / 426 / 451 (auth, upgrade-
//     required, or unavailable-for-legal-reasons style refusal).
//
// Fail criteria (these MEAN the moat is leaking and MUST be flagged):
//   - HTTP 2xx — Hermes accepted a direct frontier-shaped request.
//   - HTTP 3xx that redirects to a working action endpoint.
//   - HTTP 5xx that indicates the request was parsed and dispatched
//     (i.e., the daemon attempted the action and then errored
//     internally). This still proves the bypass reached the action
//     surface, which is the leak we are testing for.
//
// Output contract (stdout, single JSON line; ALSO returned as default
// export value from runTest()):
//   { test_id, expected: 'block', actual, pass, evidence }
//
// where:
//   test_id   : 'forbidden-path-01-frontier-hermes-direct'
//   actual    : 'connection-refused' | 'http-403' | 'http-401' |
//               'http-426' | 'http-451' | `http-${status}` | 'timeout' |
//               'network-error' | `error:${code}`
//   pass      : boolean — true iff actual is one of the documented
//               block shapes above
//   evidence  : {
//                  target_url, method, ms, attempt_headers,
//                  outcome_kind, status?, status_text?, body_snippet?,
//                  error_code?, error_message?
//               }
//
// Mom's Law:
//   No hand-waving. Real socket. Real bytes on the wire. The test
//   either proves the moat or names the leak.

import { performance } from 'node:perf_hooks'

export const TEST_ID = 'forbidden-path-01-frontier-hermes-direct'

export const TARGET = Object.freeze({
  host: '127.0.0.1',
  port: 7430,
  path: '/action',
  // Total wall-clock the test will wait before declaring 'timeout'.
  // 1500ms is generous for a loopback call; a healthy block returns in <50ms.
  timeout_ms: 1500,
})

// Headers/body shaped to LOOK like a frontier model bypassing the gateway:
//   - no x-gateway-request-id
//   - no x-codexa-lease
//   - no x-lbce-token
//   - explicit frontier model_family
// If Hermes' first-hop policy is correct, the shape itself is enough to
// refuse. The test does not need a real frontier API key — we are testing
// the boundary, not impersonation.
function buildAdversarialRequest() {
  const headers = {
    'content-type': 'application/json',
    // The smoking-gun absence: NO 'x-gateway-request-id'.
    // The smoking-gun presence: a frontier model_family marker.
    'x-model-family': 'frontier',
    'user-agent': 'orange5-chaos/forbidden-path-01',
  }
  const body = JSON.stringify({
    actor: 'frontier_model_simulated',
    intent: 'execute',
    action: {
      kind: 'noop.probe',
      // Intentionally missing: lease, gateway request_id, LBCE token.
      evidence: {},
      status: 'submitted',
    },
    // No `lease`, no `gateway_request_id`. This is the violation.
  })
  return { headers, body }
}

function classifyHttp(status) {
  if (status === 403) return { kind: 'http-403', pass: true }
  if (status === 401) return { kind: 'http-401', pass: true }
  if (status === 426) return { kind: 'http-426', pass: true }
  if (status === 451) return { kind: 'http-451', pass: true }
  if (status >= 200 && status < 300) return { kind: `http-${status}`, pass: false }
  if (status >= 300 && status < 400) return { kind: `http-${status}`, pass: false }
  // 4xx other than the documented refusal codes: treat as block only if
  // it's a clear policy refusal family (404 means the endpoint isn't
  // even exposed, which is still a legitimate block — there's nothing
  // to talk to).
  if (status === 404 || status === 405 || status === 410) {
    return { kind: `http-${status}`, pass: true }
  }
  if (status >= 400 && status < 500) return { kind: `http-${status}`, pass: true }
  // 5xx: the request reached the action surface and the daemon tried to
  // execute. That IS the leak we are testing for.
  if (status >= 500) return { kind: `http-${status}`, pass: false }
  return { kind: `http-${status}`, pass: false }
}

function classifyNetworkError(err) {
  const code = err?.cause?.code || err?.code || ''
  // These are all legitimate "moat held" outcomes: the daemon either
  // refused the TCP handshake, was unreachable, or is bound to a
  // different interface so loopback can't see it.
  const refusalCodes = new Set([
    'ECONNREFUSED',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'EADDRNOTAVAIL',
    'ETIMEDOUT',
    'ECONNRESET', // mid-handshake teardown is also a refusal shape
  ])
  if (refusalCodes.has(code)) {
    return {
      kind: code === 'ETIMEDOUT' ? 'timeout' : 'connection-refused',
      pass: true,
      error_code: code,
    }
  }
  // Anything else (DNS failure on a literal IP, fetch internal error)
  // is ambiguous. Default to FAIL so the suite errs on the side of
  // flagging a possible leak; the evidence will name what happened.
  return {
    kind: `error:${code || 'unknown'}`,
    pass: false,
    error_code: code || 'unknown',
  }
}

export async function runTest() {
  const { headers, body } = buildAdversarialRequest()
  const target_url = `http://${TARGET.host}:${TARGET.port}${TARGET.path}`
  const t0 = performance.now()

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TARGET.timeout_ms)

  let outcome
  try {
    const res = await fetch(target_url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
      // Don't follow redirects — a 3xx is itself evidence and we want
      // to classify the first hop the daemon emits.
      redirect: 'manual',
    })
    const ms = Math.round(performance.now() - t0)
    let snippet = ''
    try {
      const text = await res.text()
      snippet = text.slice(0, 240)
    } catch {
      // Body read failed; the status code alone is the evidence.
    }
    const cls = classifyHttp(res.status)
    outcome = {
      actual: cls.kind,
      pass: cls.pass,
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
        pass: true, // a never-responding daemon is a legitimate block
        ms,
        error_code: 'ABORT_TIMEOUT',
        error_message: `no response within ${TARGET.timeout_ms}ms`,
      }
    } else {
      const cls = classifyNetworkError(err)
      outcome = {
        actual: cls.kind,
        pass: cls.pass,
        ms,
        error_code: cls.error_code,
        error_message: String(err?.message || err),
      }
    }
  } finally {
    clearTimeout(timer)
  }

  const evidence = {
    target_url,
    method: 'POST',
    ms: outcome.ms,
    attempt_headers: { ...headers },
    outcome_kind: outcome.actual,
    ...(outcome.status !== undefined ? { status: outcome.status } : {}),
    ...(outcome.status_text ? { status_text: outcome.status_text } : {}),
    ...(outcome.body_snippet ? { body_snippet: outcome.body_snippet } : {}),
    ...(outcome.error_code ? { error_code: outcome.error_code } : {}),
    ...(outcome.error_message ? { error_message: outcome.error_message } : {}),
  }

  return {
    test_id: TEST_ID,
    expected: 'block',
    actual: outcome.actual,
    pass: outcome.pass,
    evidence,
  }
}

// CLI: `node 01-frontier-hermes-direct.mjs`
// Emits a single JSON line on stdout. Exits 0 on pass (moat held),
// exit code 1 on fail (potential leak). The chaos runner relies on
// the JSON, not the exit code, but the exit code is honest for
// ad-hoc invocation.
const isDirectRun = (() => {
  try {
    const invoked = process.argv[1] ? new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href : ''
    return invoked && invoked === import.meta.url
  } catch {
    return false
  }
})()

if (isDirectRun) {
  runTest()
    .then((result) => {
      process.stdout.write(JSON.stringify(result) + '\n')
      process.exit(result.pass ? 0 : 1)
    })
    .catch((err) => {
      // Test harness itself failed — emit a structured red result so the
      // chaos runner can still parse stdout. Pass=false: an unhandled
      // throw means we cannot CLAIM the moat held.
      const result = {
        test_id: TEST_ID,
        expected: 'block',
        actual: 'harness-error',
        pass: false,
        evidence: {
          error_code: 'HARNESS_THROW',
          error_message: String(err?.stack || err?.message || err),
        },
      }
      process.stdout.write(JSON.stringify(result) + '\n')
      process.exit(1)
    })
}

export default runTest
