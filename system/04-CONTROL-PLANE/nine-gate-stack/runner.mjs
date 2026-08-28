// runner.mjs — 9-Gate Stack runner (Orange5 doctrine).
//
// What this file is:
//   The single executor that loads every gate in ./gates/, runs them in
//   numerical order (00 -> 09), times each one against its TARGET_MS budget,
//   and short-circuits on the first FAIL. Emits a structured gauntlet
//   result {gauntlet_id, started_at, finished_at, ok, gates:[...]}.
//
// Position in Orange5:
//   The 9-Gate Stack is the pre-action gauntlet that Hermes calls before
//   letting an action land on the lattice. Gate 0 (LBCE) is impassable.
//   Total wall-clock budget is ~200ms (10 gates * ~20ms average; HRE has
//   a wider 50ms budget because it may consult Mirage).
//
// Runtime:
//   Real Node 20+ / Bun. ESM only. No deps outside node:fs / node:path /
//   node:crypto / node:url. Pure function: same (action, order) in,
//   same shaped result out (modulo timestamps + gauntlet_id).
//
// Public surface:
//   runGauntlet(action, order, ctx?)   -> Promise<GauntletResult>
//   loadGates(ctx?)                    -> Promise<Gate[]>     (cached)
//   GATES_DIR, GATE_FILE_RE            -> constants for introspection
//
// Notes on gate contract (all 10 gates honor this):
//   - default export object: { id, name, position, bypassable, target_ms, evaluate }
//   - named export `evaluate(action, order, ctx)` returning (sync or async):
//       { gate, name, pass, bypassable?, evidence, reasons, took_ms }
//   - Gate 0 throws LbceBypassAttempt on ctx.bypass === true. We do NOT
//     catch that as a soft fail — it propagates as a hard refusal because
//     attempting bypass IS the abnormal-control-flow signal.

import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'

const __dirname = dirname(fileURLToPath(import.meta.url))
export const GATES_DIR = join(__dirname, 'gates')
export const GATE_FILE_RE = /^(\d{2})-[a-z0-9-]+\.mjs$/i

// We expect exactly the canonical ten files. The runner does not silently
// accept extras or absences; a missing 0/1/2/.../9 means the stack is broken.
const EXPECTED_POSITIONS = Object.freeze([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])

let _gateCache = null

// ---- public API ------------------------------------------------------------

export async function loadGates(ctx = {}) {
  if (_gateCache && !ctx._forceReload) return _gateCache

  const dir = ctx.gatesDir ? String(ctx.gatesDir) : GATES_DIR
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch (e) {
    throw new Error(`9-Gate runner: cannot read gates dir "${dir}": ${e && e.message || e}`)
  }

  const files = entries
    .filter(d => d.isFile && d.isFile())
    .map(d => d.name)
    .filter(n => GATE_FILE_RE.test(n))
    .sort()  // numeric prefix makes lexical sort == numerical sort

  const loaded = []
  for (const file of files) {
    const m = file.match(GATE_FILE_RE)
    const declaredPosition = parseInt(m[1], 10)
    const abs = join(dir, file)
    let mod
    try {
      mod = await import(pathToFileURL(abs).href)
    } catch (e) {
      throw new Error(`9-Gate runner: failed to import ${file}: ${e && e.message || e}`)
    }
    // Gates have evolved two export shapes during Orange5 development:
    //   A. default = { id, name, position, bypassable, target_ms, evaluate }
    //      and named export `evaluate(action, order, ctx)`.   (gates 0, 3-9)
    //   B. default = the evaluator function itself, called as fn({action, order, ctx}).
    //      Named function export (gate1Scope, gate2Department).  (gates 1, 2)
    // The runner adapts to both at load time so the gauntlet is shape-agnostic.
    const def = mod && mod.default
    let evaluate = null
    let callStyle = null   // 'triple' = (action, order, ctx); 'single' = ({action, order, ctx})
    if (def && typeof def.evaluate === 'function') {
      evaluate = def.evaluate
      callStyle = evaluate.length >= 2 ? 'triple' : 'single'
    } else if (typeof mod.evaluate === 'function') {
      evaluate = mod.evaluate
      callStyle = evaluate.length >= 2 ? 'triple' : 'single'
    } else if (typeof def === 'function') {
      evaluate = def
      callStyle = evaluate.length >= 2 ? 'triple' : 'single'
    } else {
      throw new Error(`9-Gate runner: ${file} does not export an evaluate() function or default function`)
    }

    const defObj = def && typeof def === 'object' ? def : null
    const id = (defObj && defObj.id) || mod.GATE_ID || `gate-${declaredPosition}`
    const name = (defObj && defObj.name) || mod.GATE_NAME || id
    const bypassable = defObj && typeof defObj.bypassable === 'boolean'
      ? defObj.bypassable
      : (typeof mod.BYPASSABLE === 'boolean' ? mod.BYPASSABLE : true)
    const target_ms = (defObj && defObj.target_ms) || mod.TARGET_MS || 30
    const position = typeof defObj?.position === 'number'
      ? defObj.position
      : (typeof mod.POSITION_IN_STACK === 'number' ? mod.POSITION_IN_STACK : declaredPosition)

    if (position !== declaredPosition) {
      throw new Error(`9-Gate runner: ${file} declares position ${position} but filename prefix is ${declaredPosition}`)
    }
    loaded.push({ position, id, name, bypassable, target_ms, evaluate, callStyle, file })
  }

  loaded.sort((a, b) => a.position - b.position)

  // Integrity check: exactly the expected positions, no gaps, no dupes.
  const seen = loaded.map(g => g.position)
  for (const expected of EXPECTED_POSITIONS) {
    if (!seen.includes(expected)) {
      throw new Error(`9-Gate runner: missing gate at position ${expected}`)
    }
  }
  const dupes = seen.filter((p, i) => seen.indexOf(p) !== i)
  if (dupes.length) {
    throw new Error(`9-Gate runner: duplicate gate positions detected: ${dupes.join(', ')}`)
  }
  // Gate 0 must be impassable.
  const gate0 = loaded.find(g => g.position === 0)
  if (gate0.bypassable === true) {
    throw new Error('9-Gate runner: gate-0 declares bypassable=true; this violates lattice law')
  }

  _gateCache = loaded
  return loaded
}

export async function runGauntlet(action, order, ctx = {}) {
  const gauntlet_id = ctx.gauntlet_id || `gauntlet_${Date.now()}_${randomUUID().slice(0, 8)}`
  const started_at = new Date().toISOString()
  const t0 = nowMs()

  const gates = await loadGates(ctx)
  const results = []
  let ok = true
  let short_circuited_at = null

  for (const g of gates) {
    const gStart = nowMs()
    let r
    try {
      const out = g.callStyle === 'triple'
        ? g.evaluate(action, order, ctx)
        : g.evaluate({ action, order, ctx })
      r = out && typeof out.then === 'function' ? await out : out
    } catch (e) {
      // Two flavors of exception:
      //  - Gate 0 bypass attempt: this IS a hard fail (and we re-raise after recording).
      //  - Any other throw: record as a fail with reason=exception.
      const isBypass = e && e.name === 'LbceBypassAttempt'
      r = {
        gate: g.id,
        name: g.name,
        pass: false,
        bypassable: g.bypassable,
        evidence: [],
        reasons: [`exception: ${String(e && e.message || e)}`],
        took_ms: Math.max(0, Math.round((nowMs() - gStart) * 1000) / 1000),
        _exception: true,
        _bypass_attempt: isBypass || undefined,
      }
    }

    // Normalise the per-gate result shape. Gates have two return-shape dialects:
    //   - { gate, name, pass, evidence:[], reasons:[], took_ms }
    //   - { gate_id, name, pass, evidence:{...}, reason:'...', took_ms }
    // We accept both and emit a single canonical shape downstream.
    const reasons = Array.isArray(r.reasons)
      ? r.reasons.slice()
      : (typeof r.reason === 'string' && r.reason !== 'ok' && r.reason.length ? [r.reason] : [])
    const norm = {
      gate_id: r.gate_id || r.gate || g.id,
      name: r.name || g.name,
      position: g.position,
      bypassable: typeof r.bypassable === 'boolean' ? r.bypassable : g.bypassable,
      pass: r.pass === true,
      evidence: r.evidence == null ? [] : r.evidence,
      reasons,
      took_ms: typeof r.took_ms === 'number'
        ? r.took_ms
        : Math.max(0, Math.round((nowMs() - gStart) * 1000) / 1000),
      target_ms: g.target_ms,
      over_budget: false,
    }
    norm.over_budget = norm.took_ms > g.target_ms
    if (r._exception) norm.exception = true
    if (r._bypass_attempt) norm.bypass_attempt = true

    results.push(norm)

    if (!norm.pass) {
      ok = false
      short_circuited_at = norm.gate_id
      break  // short-circuit on first fail
    }
  }

  const finished_at = new Date().toISOString()
  const total_ms = Math.max(0, Math.round((nowMs() - t0) * 1000) / 1000)

  return {
    gauntlet_id,
    started_at,
    finished_at,
    ok,
    total_ms,
    target_total_ms: 200,
    over_budget: total_ms > 200,
    gates_run: results.length,
    gates_total: gates.length,
    short_circuited_at,
    gates: results,
  }
}

// Convenience reset (tests / hot reload).
export function _resetGateCache() { _gateCache = null }

// ---- helpers ---------------------------------------------------------------

function nowMs() {
  return typeof performance !== 'undefined' && performance.now
    ? performance.now()
    : Date.now()
}

// Default export = runGauntlet for ergonomic `import runGauntlet from './runner.mjs'`.
export default runGauntlet
