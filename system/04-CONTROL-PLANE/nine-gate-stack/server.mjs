// server.mjs — 9-Gate Stack daemon (Bun :7450, loopback only).
//
// Wraps the pre-action gauntlet at ./runner.mjs behind a tiny HTTP surface
// so Hermes (and only Hermes, over loopback) can submit actions for
// gating. Designed to be the live, in-process pre-action gate that
// answers in ~200ms.
//
// Endpoints:
//   GET  /healthz   — liveness + gate load state. Returns 200 with
//                     { ok, uptime_ms, gates_loaded, gate_ids,
//                       last_run_at?, last_run_ok? }. Used by the
//                     supervisor and by the smoke test.
//   POST /run       — body { action, order, ctx? }. Returns the full
//                     gauntlet result from runGauntlet(). 400 on bad
//                     JSON / missing action+order. 200 with ok:false
//                     when the gauntlet itself short-circuits — a
//                     refused action is a NORMAL response, not an HTTP
//                     error.
//
// Smoke test:
//   When invoked with the --smoke flag (or env NINE_GATE_SMOKE=1), the
//   process boots the server, fires a self-test request at loopback,
//   asserts that the result has gates_run >= 1 and a well-shaped
//   schema, prints a one-line OK/FAIL receipt, then exits 0 / 1.
//
// Runtime contract:
//   Bun >= 1.0 OR Node 20+ (we feature-detect Bun and fall back to
//   node:http for portability — Bun is preferred for the speed but the
//   daemon is correct under either).
//   Loopback 127.0.0.1 only. We do not bind to 0.0.0.0. There is no
//   authentication on this socket — the security boundary is the OS
//   loopback interface.

import { runGauntlet, loadGates } from './runner.mjs'
import { fileURLToPath } from 'node:url'
import { createServer as createNodeHttpServer } from 'node:http'

export const HOST = '127.0.0.1'
export const PORT = 7450
const BOOTED_AT = Date.now()
const STATE = {
  gate_ids: [],
  last_run_at: null,
  last_run_ok: null,
  request_count: 0,
}

// ---- request handling (runtime-agnostic) -----------------------------------

async function handleRequest(method, url, bodyText) {
  if (method === 'GET' && url === '/healthz') {
    return json(200, {
      ok: true,
      service: '9-gate-stack',
      host: HOST,
      port: PORT,
      uptime_ms: Date.now() - BOOTED_AT,
      gates_loaded: STATE.gate_ids.length,
      gate_ids: STATE.gate_ids,
      last_run_at: STATE.last_run_at,
      last_run_ok: STATE.last_run_ok,
      request_count: STATE.request_count,
    })
  }

  if (method === 'POST' && url === '/run') {
    STATE.request_count += 1
    let payload
    try {
      payload = bodyText && bodyText.length ? JSON.parse(bodyText) : {}
    } catch (e) {
      return json(400, { ok: false, error: 'invalid_json', detail: String(e.message || e) })
    }
    const { action, order, ctx } = payload || {}
    if (!action || typeof action !== 'object') {
      return json(400, { ok: false, error: 'missing_action', detail: 'body.action must be an object' })
    }
    if (!order || typeof order !== 'object') {
      return json(400, { ok: false, error: 'missing_order', detail: 'body.order must be an object' })
    }
    let result
    try {
      result = await runGauntlet(action, order, ctx || {})
    } catch (e) {
      return json(500, { ok: false, error: 'gauntlet_exception', detail: String(e.message || e) })
    }
    STATE.last_run_at = result.finished_at
    STATE.last_run_ok = result.ok
    return json(200, result)
  }

  return json(404, { ok: false, error: 'not_found', method, url })
}

function json(status, body) {
  return {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  }
}

// ---- server bootstrap ------------------------------------------------------

async function preloadGates() {
  const gates = await loadGates()
  STATE.gate_ids = gates.map(g => g.id)
  return gates
}

export async function startServer({ port = PORT, host = HOST } = {}) {
  await preloadGates()  // fail fast if the lattice is broken

  // Prefer Bun.serve when available; fall back to node:http.
  if (typeof globalThis.Bun !== 'undefined' && globalThis.Bun.serve) {
    const server = globalThis.Bun.serve({
      hostname: host,
      port,
      async fetch(req) {
        const u = new URL(req.url)
        const body = req.method === 'GET' || req.method === 'HEAD' ? '' : await req.text()
        const r = await handleRequest(req.method, u.pathname, body)
        return new Response(r.body, { status: r.status, headers: r.headers })
      },
    })
    return {
      stop: () => server.stop(true),
      url: `http://${host}:${port}`,
      runtime: 'bun',
    }
  }

  // node:http fallback.
  const server = createNodeHttpServer(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const bodyText = Buffer.concat(chunks).toString('utf8')
    const u = req.url || '/'
    const pathOnly = u.split('?')[0]
    const r = await handleRequest(req.method || 'GET', pathOnly, bodyText)
    res.writeHead(r.status, r.headers)
    res.end(r.body)
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => { server.off('error', reject); resolve() })
  })
  return {
    stop: () => new Promise(r => server.close(() => r())),
    url: `http://${host}:${port}`,
    runtime: 'node',
  }
}

// ---- smoke test ------------------------------------------------------------

export async function smokeTest() {
  const handle = await startServer()
  const failures = []
  try {
    // 1. /healthz
    const hz = await fetch(`${handle.url}/healthz`)
    if (hz.status !== 200) failures.push(`/healthz status ${hz.status}`)
    const hzj = await hz.json()
    if (!hzj.ok) failures.push('/healthz ok=false')
    if (!Array.isArray(hzj.gate_ids) || hzj.gate_ids.length !== 10) {
      failures.push(`/healthz expected 10 gates, got ${hzj.gate_ids && hzj.gate_ids.length}`)
    }

    // 2. POST /run with a minimal action+order. We do NOT require pass=true here;
    //    the synthetic action is unlikely to clear every gate in a real lattice.
    //    What we DO require is a well-shaped response with gates_run >= 1, all
    //    timestamps present, and the gauntlet_id non-empty.
    const runResp = await fetch(`${handle.url}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: {
          scope: '04-CONTROL-PLANE/nine-gate-stack',
          intent: 'smoke',
          riskLevel: 'low',
          hash_chain: 1,
        },
        order: {
          scope: '04-CONTROL-PLANE/nine-gate-stack',
          department: 'AE13',
        },
        ctx: { offline: true, gate_stack_offline: true },
      }),
    })
    if (runResp.status !== 200) failures.push(`/run status ${runResp.status}`)
    const runJson = await runResp.json()
    if (!runJson.gauntlet_id) failures.push('/run missing gauntlet_id')
    if (!runJson.started_at || !runJson.finished_at) failures.push('/run missing timestamps')
    if (typeof runJson.ok !== 'boolean') failures.push('/run missing ok flag')
    if (!Array.isArray(runJson.gates) || runJson.gates.length < 1) {
      failures.push('/run gates array missing or empty')
    } else {
      const first = runJson.gates[0]
      if (!first.gate_id || typeof first.pass !== 'boolean' || typeof first.took_ms !== 'number') {
        failures.push('/run first gate result malformed')
      }
    }

    // 3. POST /run with garbage to verify 400 path.
    const bad = await fetch(`${handle.url}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    })
    if (bad.status !== 400) failures.push(`/run bad-json expected 400, got ${bad.status}`)
  } finally {
    await handle.stop()
  }

  if (failures.length === 0) {
    console.log(JSON.stringify({ smoke: 'OK', service: '9-gate-stack', runtime: handle.runtime }))
    return 0
  } else {
    console.log(JSON.stringify({ smoke: 'FAIL', service: '9-gate-stack', failures }))
    return 1
  }
}

// ---- entry point -----------------------------------------------------------

const invokedDirectly = (() => {
  try {
    return process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
  } catch { return false }
})()

if (invokedDirectly) {
  const wantSmoke = process.argv.includes('--smoke') || process.env.NINE_GATE_SMOKE === '1'
  if (wantSmoke) {
    smokeTest().then(code => {
      // Let libuv finish closing the loopback socket before we exit; on
      // Windows + node:http a synchronous process.exit here trips an
      // assertion in src/win/async.c. setImmediate is enough delay.
      setImmediate(() => process.exit(code))
    })
  } else {
    startServer().then(h => {
      console.log(JSON.stringify({
        service: '9-gate-stack',
        listening: h.url,
        runtime: h.runtime,
        gates_loaded: STATE.gate_ids.length,
      }))
    }).catch(e => {
      console.error(JSON.stringify({ service: '9-gate-stack', error: 'boot_failed', detail: String(e.message || e) }))
      process.exit(1)
    })
  }
}
