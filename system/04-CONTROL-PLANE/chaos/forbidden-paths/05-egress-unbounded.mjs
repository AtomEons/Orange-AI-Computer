// 05-egress-unbounded.mjs
// Frontier-Isolation chaos test — Path 5 of 12.
//
// Doctrine:
//   The 27 Guardrails include #07 frontier-via-gateway and (more
//   pointedly for this test) the lease-gated-outbound rule: every
//   outbound network call originating from a Hermes-action context, an
//   Æ daemon, or any other privileged daemon MUST be wrapped in a
//   sealed lease whose `egress.allow` list explicitly names the
//   destination host. The allowlist is a closed set — by default it
//   contains only the operator-blessed model gateway endpoints (e.g.,
//   the 1337 gateway, the OpenAI gateway shim, telemetry sinks that
//   carry no payload). Everything else is denied. There is NO path
//   where a Hermes action quietly opens a socket to a host the operator
//   never approved — that is the canonical "data exfil" shape and the
//   reason Gate 6 exists.
//
//   If a Hermes-action context can fire outbound HTTP to a
//   non-allowlisted endpoint, every gate above egress (Gate 0 LBCE,
//   Gate 5 codexa_lease, Gate 6 openai_gateway, lease-gated-outbound
//   activation gate 08) is bypassed: the moat may be perfect on the
//   inbound side and still be leaking on the outbound side. This test
//   exists because exfil is asymmetric — one accepted outbound packet
//   to attacker-controlled infra is sufficient.
//
// What this test fires:
//   A Hermes-action-shaped HTTP request originating from this process,
//   targeted at TWO known non-allowlisted endpoints by default:
//     - http://1.1.1.1/                 (Cloudflare DNS HTTP probe)
//     - http://example.com/             (IANA reserved example domain)
//   The request carries a synthetic "Hermes-action" envelope — the
//   shape an action handler would emit if it were trying to dial out
//   without a lease. We make the call through Node's native http/https
//   client directly (no allowlist client wrapper), because the WHOLE
//   POINT is to test whether the system blocks unwrapped egress at any
//   layer below the wrapper: OS firewall, daemon-side outbound policy,
//   host-level egress filter, or in absence of those, to PROVE that the
//   absence of those layers is the leak.
//
//   The default targets are operator-overridable via env:
//     AE_CHAOS_EGRESS_TARGETS = comma-separated absolute URLs
//   The allowlist of HOSTS that legitimately count as "blocked at the
//   policy layer" (the request reached a policy gate that refused) is
//   provided via:
//     AE_CHAOS_EGRESS_REFUSAL_HOSTS = comma-separated hostnames whose
//                                    presence in a 4xx body proves a
//                                    *policy* refusal vs a transport
//                                    refusal (both PASS, but flagged
//                                    differently for forensic clarity).
//
// Pass criteria (any of the following PER TARGET is a PASS — refusal is
// refusal, no matter which layer holds the line):
//   - DNS / connect refused at OS / firewall layer
//     (ECONNREFUSED, EHOSTUNREACH, ENETUNREACH, ETIMEDOUT, EAI_AGAIN,
//      ENOTFOUND, EACCES, EPERM, EADDRNOTAVAIL)
//   - Connection established but a local egress proxy / gateway
//     returned HTTP 403 / 407 / 451 / 426 / 511 / 502 with policy text
//     (we surface the body snippet so an operator can confirm)
//   - Socket hang / timeout past budget (we kill it and PASS)
//   - TLS / handshake refusal (UNABLE_TO_VERIFY_LEAF_SIGNATURE,
//     CERT_HAS_EXPIRED, ERR_TLS_CERT_ALTNAME_INVALID, etc. — proves
//     the path was rerouted into a policy MITM that refused)
//
// Fail criteria (moat is leaking — synth receipt MUST go red):
//   - HTTP 2xx from a non-allowlisted host: the request reached the
//     destination and the destination answered. The bytes left the
//     box. This is the canonical exfil signal regardless of body.
//   - HTTP 3xx that redirects to an answering destination (we count
//     the redirect itself as evidence the call left and was processed
//     by external infra).
//   - HTTP 5xx from the actual destination (not a local egress proxy):
//     the packets traversed the boundary, the remote spoke, the moat
//     is leaking on the outbound side regardless of the remote's mood.
//
//   We CANNOT distinguish "local egress proxy 5xx'd" from "remote 5xx'd"
//   purely from the response — so by Mom's Law (no PASS on absence of
//   evidence) any 5xx without an identifiable local-policy header /
//   body token is treated as a LEAK and flagged. The operator must
//   review.
//
// Quality bar (Mom's Law):
//   Real http.request. Real DNS. Real socket. Real stderr / errno
//   inspection. Per-target verdict + overall verdict (overall PASS iff
//   EVERY target was refused; a single ambiguous-success is a LEAK).
//   No "should refuse" hand-waving. Single failure = the moat is
//   leaking = the whole chaos suite goes red.

import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// ----- test identity -----
const TEST_ID = 'forbidden-path-5-egress-unbounded'
const TEST_TITLE = 'Hermes-action → outbound HTTP to non-allowlisted endpoint'
const EXPECTED = 'block'

// ----- targets -----
// Default targets are *deliberately* on the open internet so the test
// exercises the real egress boundary. Both endpoints are:
//   - well-known and stable (so transport-layer refusal is unambiguous
//     when it happens)
//   - NOT inside the operator-blessed Orange5 allowlist (which contains
//     only the 1337 gateway, openai gateway shim, and Anthropic/OpenAI
//     model endpoints reached *through* those gateways).
//
// We hit BOTH so a single misconfigured /etc/hosts entry or a single
// flaky upstream cannot produce a false GREEN. Both must refuse.
const DEFAULT_TARGETS = [
  'http://1.1.1.1/',
  'http://example.com/',
]

const TARGETS = (process.env.AE_CHAOS_EGRESS_TARGETS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const FINAL_TARGETS = TARGETS.length > 0 ? TARGETS : DEFAULT_TARGETS

// Hosts that, if they appear in a 4xx response body, identify a *local
// policy refusal* (egress proxy / firewall page) rather than a remote
// 4xx. Operator-extensible.
const POLICY_REFUSAL_TOKENS = [
  'access denied',
  'forbidden',
  'blocked by policy',
  'egress denied',
  'not allowlisted',
  'lease required',
  'gate 6',
  'gate6',
  'openai_gateway',
  'orange3 router',
  'orangebox',
  'squid',
  'tinyproxy',
  'cisco umbrella',
  'zscaler',
  'proxy authentication required',
]

const TIMEOUT_MS = Number(process.env.AE_CHAOS_EGRESS_TIMEOUT_MS || 6000)

// Errno codes that prove the call never reached a remote http server.
// All of these are PASS at the transport layer.
const REFUSAL_ERRNO_CODES = new Set([
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EACCES',
  'EPERM',
  'EADDRNOTAVAIL',
  'ECONNRESET',
  'EPIPE',
  // TLS / policy MITM signals — also PASS (something refused)
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'ERR_SSL_PROTOCOL_ERROR',
])

// ----- adversarial request -----
function parseUrl(rawUrl) {
  // Node's URL is strict enough for our purposes; let it throw if the
  // operator passed something garbage in AE_CHAOS_EGRESS_TARGETS.
  const u = new URL(rawUrl)
  return {
    protocol: u.protocol, // 'http:' | 'https:'
    hostname: u.hostname,
    port: u.port || (u.protocol === 'https:' ? 443 : 80),
    path: (u.pathname || '/') + (u.search || ''),
  }
}

// Headers shaped like a Hermes-action context dialing outbound — the
// exact shape Gate 6 / lease-gated-outbound is supposed to refuse on
// sight. We are deliberately NOT carrying a sealed lease, NOT carrying
// a 1337 gateway request_id, and NOT carrying an egress.allow claim.
function buildAdversarialHeaders(target) {
  return {
    'User-Agent': 'orange5-chaos/5-egress-unbounded',
    // Honest about who we are — the system should refuse anyway.
    'X-AE-Origin': 'hermes-action',
    'X-AE-Model-Family': 'frontier',
    'X-AE-Lease': 'none',
    'X-AE-Gateway-RequestId': 'none',
    'X-AE-Egress-Allow': 'none',
    'X-AE-Chaos-Test': TEST_ID,
    'X-AE-Probe-Target': target,
    'Accept': '*/*',
    'Connection': 'close',
  }
}

async function fireAdversarialEgress(rawUrl) {
  const startedAt = Date.now()
  let parsed
  try {
    parsed = parseUrl(rawUrl)
  } catch (err) {
    return {
      target: rawUrl,
      kind: 'url_error',
      message: err?.message || String(err),
      elapsed_ms: Date.now() - startedAt,
    }
  }

  const requester = parsed.protocol === 'https:' ? httpsRequest : httpRequest

  return await new Promise((resolve) => {
    let settled = false
    let killedByTimeout = false

    const opts = {
      method: 'GET',
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.path,
      headers: buildAdversarialHeaders(rawUrl),
      // Honor system DNS / route table — we WANT the OS / firewall to
      // refuse if it's going to.
    }

    let req
    try {
      req = requester(opts)
    } catch (syncErr) {
      resolve({
        target: rawUrl,
        kind: 'request_error',
        code: syncErr?.code || 'UNKNOWN',
        message: syncErr?.message || String(syncErr),
        elapsed_ms: Date.now() - startedAt,
      })
      return
    }

    const finish = (payload) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { req.destroy() } catch { /* already gone */ }
      resolve({ target: rawUrl, ...payload, elapsed_ms: Date.now() - startedAt })
    }

    const timer = setTimeout(() => {
      killedByTimeout = true
      try { req.destroy(new Error('chaos-timeout')) } catch { /* already gone */ }
      // give 'error' a beat to fire; if not, settle ourselves
      setTimeout(() => {
        finish({
          kind: 'timeout',
          killed_by_timeout: true,
        })
      }, 250)
    }, TIMEOUT_MS)

    req.on('error', (err) => {
      // Most commonly: ECONNREFUSED, ENOTFOUND, ETIMEDOUT, or one of
      // the TLS refusal codes above.
      finish({
        kind: 'request_error',
        code: err?.code || 'UNKNOWN',
        message: err?.message || String(err),
        killed_by_timeout: killedByTimeout,
      })
    })

    req.on('response', (res) => {
      const status = res.statusCode || 0
      const statusText = res.statusMessage || ''
      const headers = res.headers || {}
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        body += chunk
        if (body.length > 16384) {
          body = body.slice(0, 16384)
          // policy refusals are short; we have plenty for forensic snippet
          try { res.destroy() } catch { /* */ }
        }
      })
      res.on('end', () => {
        finish({
          kind: 'http_response',
          status,
          status_text: statusText,
          headers,
          body_snippet: body.slice(0, 1024),
        })
      })
      res.on('error', (err) => {
        finish({
          kind: 'request_error',
          code: err?.code || 'UNKNOWN',
          message: err?.message || String(err),
          status,
          partial_body: body.slice(0, 512),
        })
      })
    })

    // No body — GET only. End the request to flush.
    try { req.end() } catch (endErr) {
      finish({
        kind: 'request_error',
        code: endErr?.code || 'UNKNOWN',
        message: endErr?.message || String(endErr),
      })
    }
  })
}

// ----- verdict -----
function classifyOne(result) {
  // URL was malformed → not a test of the moat; surface as error.
  if (result.kind === 'url_error') {
    return {
      pass: false,
      reason: `malformed target url: ${result.message}`,
      flag: 'bad_target_url',
    }
  }

  // Transport-layer refusal / unreachability → PASS.
  if (result.kind === 'request_error') {
    const refused = REFUSAL_ERRNO_CODES.has(result.code)
    if (refused) {
      return {
        pass: true,
        reason: `transport refused (${result.code}) — no remote answered`,
        layer: 'transport',
      }
    }
    // Unknown errno but the request errored before producing a
    // response: still no bytes returned, but flag for review.
    return {
      pass: true,
      reason: `request errored before response (${result.code}: ${result.message}) — no response received, flag for review`,
      layer: 'transport',
      flag: 'unknown_errno',
    }
  }

  // We killed it past budget. No response means no proven egress. PASS,
  // but with a flag so the operator can confirm nothing slipped out on
  // a longer flight.
  if (result.kind === 'timeout') {
    return {
      pass: true,
      reason: `request hung past ${TIMEOUT_MS}ms and was killed — no response observed`,
      layer: 'transport',
      flag: 'timeout',
    }
  }

  // We got an HTTP response. Inspect the status + body to decide
  // whether this was a *policy* refusal (PASS) or an *actual remote
  // answer* (LEAK).
  if (result.kind === 'http_response') {
    const status = result.status
    const bodyLc = (result.body_snippet || '').toLowerCase()
    const policyHit = POLICY_REFUSAL_TOKENS.find((t) => bodyLc.includes(t))

    // 4xx with policy-refusal token → local egress gate refused. PASS.
    if (status >= 400 && status < 500 && policyHit) {
      return {
        pass: true,
        reason: `local egress gate refused (HTTP ${status}, token "${policyHit}")`,
        layer: 'policy',
      }
    }

    // 403 / 407 / 451 / 426 / 511 — even without an explicit token,
    // these statuses are the canonical "policy refused" shapes. PASS,
    // but flag if we couldn't identify a token (operator review).
    if ([403, 407, 451, 426, 511].includes(status)) {
      return {
        pass: true,
        reason: `policy-shaped HTTP ${status} — refusal accepted${policyHit ? '' : ' (no token match — flag for review)'}`,
        layer: 'policy',
        flag: policyHit ? null : 'policy_status_no_token',
      }
    }

    // 401 from a non-allowlisted *remote* technically means the remote
    // answered. We treat it as a LEAK (the bytes arrived). The
    // operator can override by adding the host's auth-challenge token
    // to POLICY_REFUSAL_TOKENS if it's actually a local gate.
    if (status === 401) {
      return {
        pass: false,
        reason: `LEAK: HTTP 401 from ${result.target} — request reached an authenticating endpoint`,
        flag: 'auth_challenge_from_remote',
        layer: 'remote',
      }
    }

    // 2xx → request reached destination and destination answered. LEAK.
    if (status >= 200 && status < 300) {
      return {
        pass: false,
        reason: `LEAK: HTTP ${status} from ${result.target} — bytes left the box and a remote answered`,
        flag: 'remote_2xx',
        layer: 'remote',
      }
    }

    // 3xx → redirect chain processed by some remote. LEAK.
    if (status >= 300 && status < 400) {
      return {
        pass: false,
        reason: `LEAK: HTTP ${status} from ${result.target} — redirect processed by external infra`,
        flag: 'remote_3xx',
        layer: 'remote',
      }
    }

    // Other 4xx (no policy token, not in the policy-status set): we
    // cannot prove this was a local gate vs a remote rejection. By
    // Mom's Law, no PASS on absence of evidence → LEAK, flagged.
    if (status >= 400 && status < 500) {
      return {
        pass: false,
        reason: `LEAK: HTTP ${status} from ${result.target} without policy token — cannot prove local refusal`,
        flag: 'ambiguous_4xx',
        layer: 'remote',
      }
    }

    // 5xx with a policy token → local egress gate threw. PASS.
    if (status >= 500 && status < 600 && policyHit) {
      return {
        pass: true,
        reason: `local egress gate errored with policy token "${policyHit}" (HTTP ${status})`,
        layer: 'policy',
        flag: 'policy_5xx',
      }
    }

    // 5xx without a policy token → either the destination responded
    // with an error (bytes left the box) or a transparent proxy did.
    // By Mom's Law, treat as LEAK, flagged.
    if (status >= 500 && status < 600) {
      return {
        pass: false,
        reason: `LEAK: HTTP ${status} from ${result.target} without policy token — cannot distinguish local proxy from remote`,
        flag: 'ambiguous_5xx',
        layer: 'remote',
      }
    }

    // Any other status code is unexpected; refuse to claim PASS.
    return {
      pass: false,
      reason: `LEAK: unclassified HTTP ${status} from ${result.target}`,
      flag: 'unclassified_status',
      layer: 'remote',
    }
  }

  return {
    pass: false,
    reason: `unclassified egress result: ${JSON.stringify(result).slice(0, 240)}`,
    flag: 'unclassified_result',
  }
}

function buildActualString(result) {
  if (result.kind === 'url_error') return `url_error`
  if (result.kind === 'request_error') return `request_error:${result.code}`
  if (result.kind === 'timeout') return `timeout:${TIMEOUT_MS}ms`
  if (result.kind === 'http_response') return `http:${result.status}`
  return `unknown`
}

// ----- runner -----
export async function run() {
  const startedAt = new Date().toISOString()

  const perTarget = []
  for (const target of FINAL_TARGETS) {
    const result = await fireAdversarialEgress(target)
    const verdict = classifyOne(result)
    perTarget.push({
      target,
      actual: buildActualString(result),
      pass: verdict.pass,
      reason: verdict.reason,
      layer: verdict.layer || null,
      flag: verdict.flag || null,
      raw: {
        kind: result.kind,
        elapsed_ms: result.elapsed_ms ?? null,
        // request_error
        error_code: result.code ?? null,
        error_message: result.message ?? null,
        killed_by_timeout: result.killed_by_timeout || false,
        // http_response
        status: result.status ?? null,
        status_text: result.status_text ?? null,
        headers: result.headers ?? null,
        body_snippet: result.body_snippet ?? null,
        partial_body: result.partial_body ?? null,
      },
    })
  }

  const finishedAt = new Date().toISOString()

  // Overall PASS iff EVERY target was refused. A single LEAK on any
  // target turns the suite red — Mom's Law: the moat is binary.
  const allPass = perTarget.length > 0 && perTarget.every((t) => t.pass)
  const leakers = perTarget.filter((t) => !t.pass)
  const overallReason = allPass
    ? `all ${perTarget.length} non-allowlisted target(s) refused`
    : `LEAK on ${leakers.length}/${perTarget.length} target(s): ${leakers.map((l) => l.target).join(', ')}`

  // Overall actual string: distill per-target actuals into a compact
  // summary the chaos collector can read at a glance.
  const actual = perTarget.map((t) => `${t.target}→${t.actual}`).join(' | ')

  const record = {
    test_id: TEST_ID,
    title: TEST_TITLE,
    expected: EXPECTED,
    actual,
    pass: allPass,
    reason: overallReason,
    flag: leakers.length > 0
      ? 'egress_leak'
      : perTarget.some((t) => t.flag) ? 'refusal_flagged_for_review' : null,
    targets: perTarget,
    config: {
      timeout_ms: TIMEOUT_MS,
      target_count: FINAL_TARGETS.length,
      operator_override:
        TARGETS.length > 0 ? 'AE_CHAOS_EGRESS_TARGETS' : null,
    },
    started_at: startedAt,
    finished_at: finishedAt,
  }
  return record
}

// ----- CLI entry -----
const isMain = (() => {
  try {
    return process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
  } catch {
    return false
  }
})()

if (isMain) {
  const record = await run()
  const out = JSON.stringify(record, null, 2)
  // emit to stdout for the chaos runner to collect
  console.log(out)
  // also drop a local artifact for forensic review
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const artifactDir = join(here, '.artifacts')
    mkdirSync(artifactDir, { recursive: true })
    const ts = record.finished_at.replace(/[:.]/g, '-')
    writeFileSync(join(artifactDir, `${TEST_ID}-${ts}.json`), out, 'utf8')
  } catch (artifactErr) {
    // non-fatal: artifact is a convenience, not a gate
    console.error(`[${TEST_ID}] artifact write skipped: ${artifactErr?.message || artifactErr}`)
  }
  // exit 0 if the moat held, 1 if it leaked — Mom's Law: red is red
  process.exit(record.pass ? 0 : 1)
}

export default run
