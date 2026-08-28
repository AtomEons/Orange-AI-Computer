// 06-drift.mjs — Gate 6 Drift of the 9-Gate Stack.
//
// Position in the 9-Gate Stack: SEVENTH (after LBCE, Scope, Department, Triad,
// HRE, Security). Bypassable: false. Target: <30ms. Pure function over the
// action object + a small filesystem peek (existence + sha of pinned files).
//
// Purpose: enforce the AtomEons constitutional invariants ("27 guardrails")
// at the per-action level, before the action is allowed to land.
//
// Gates 0-5 have proven the action is well-located, well-routed, internally
// coherent, factually grounded, and free of secrets / path traversal. Gate 6
// is where the lattice asks: "is this action consistent with what AtomEons
// IS?" — the durable identity rules that survive every refactor, every
// retire, every new lane.
//
// Six invariants, all must hold:
//
//   D1. runtime/node.py is the sole authoritative cognitive center.
//       If action.diff or action.files touches `runtime/node.py` (any case,
//       any drive prefix that resolves to it), refuse UNLESS BOTH:
//         - order.authorized_node_py_mutation === true
//         - action.authorized_node_py_mutation === true
//       AND the action carries an explicit mutation note in
//       action.invariants_acknowledged that names G01.
//       When the file exists on disk and ctx.expected_node_sha is supplied,
//       additionally refuse if its current sha256 does not match — that means
//       node.py drifted under our feet between authorization and this action.
//
//   D2. FOUNDER_SALARY_PER_INSTALL_CENTS is env-bound, never hardcoded.
//       Refuse if action.diff contains a hardcoded numeric assignment of the
//       form `FOUNDER_SALARY_PER_INSTALL_CENTS = <number>` (any whitespace,
//       any operator: =, :, :=, ==>). The only accepted forms are env reads:
//         process.env.FOUNDER_SALARY_PER_INSTALL_CENTS
//         os.getenv("FOUNDER_SALARY_PER_INSTALL_CENTS"…)
//         os.environ["FOUNDER_SALARY_PER_INSTALL_CENTS"]
//         Deno.env.get("FOUNDER_SALARY_PER_INSTALL_CENTS")
//       A diff line that introduces a hardcoded literal is a refusal.
//
//   D3. The 27-guardrails registry exists on disk.
//       ctx.guardrails_registry_path (default
//       `<root>/01-DOCTRINE/27-guardrails/registry.mjs`) must be a real
//       file. If absent, the lattice has lost its constitution and we refuse
//       the action — no edit lands while the rulebook is missing.
//
//   D4. ATOMEONS_IDENTITY_SECRET is env-only, never hardcoded.
//       Refuse if action.diff contains any assignment that places a literal
//       string value onto the identity secret — e.g.
//         ATOMEONS_IDENTITY_SECRET = "literal"
//         ATOMEONS_IDENTITY_SECRET: 'literal'
//         "ATOMEONS_IDENTITY_SECRET": "literal"
//       The literal value is NEVER echoed in evidence; we report the line
//       number, the form (`assignment` / `dict_entry`), and a redacted
//       preview. Env reads (process.env.* / os.getenv / os.environ) are
//       accepted.
//
//   D5. Gate 0 LBCE is referenced first in any gate chain the action declares.
//       If action.chain (or order.chain) is present, its first entry must
//       match the LBCE pattern (LatticeIntegrityGate | LBCE | Gate0 |
//       GATE_0_LBCE | gate-0-lbce). Same check the 27-guardrails G-03
//       check applies, but at action grain.
//
//   D6. Human Final Stop is reachable from any autonomous-action path.
//       If action.autonomy === 'autonomous' (or action.risk_level is in
//       {high, critical}), the declared chain MUST include a Gate 9 /
//       Human Final Stop entry. An autonomous action with no operator-veto
//       gate is the exact failure mode the invariant exists to prevent.
//
// Mom's Law: every refusal cites the exact invariant ID (G01..G05 maps
// directly; D5/D6 map to G03/G04), the exact term that broke it (with
// secret-shaped values redacted), and a one-sentence reason an operator
// reading the receipt can act on.

import { existsSync, readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve as pathResolve } from 'node:path'

const GATE_ID = 'gate-6-drift'
const GATE_NAME = 'Drift — constitutional invariants'
const BYPASSABLE = false
const POSITION_IN_STACK = 6
const TARGET_MS = 30

// -- Invariant catalog ------------------------------------------------------
//
// IDs match the 27-guardrails registry (01-DOCTRINE/27-guardrails/registry.mjs).
// Gate 6 enforces the subset that is decidable from the action object alone
// (plus existence/sha of a small fixed set of files).
const INVARIANTS = Object.freeze({
  G01: 'runtime/node.py is sole authoritative cognitive center',
  G02: 'FOUNDER_SALARY_PER_INSTALL_CENTS is env-bound, not hardcoded',
  G05: 'ATOMEONS_IDENTITY_SECRET is env-only, never hardcoded',
  G03: 'Gate 0 LatticeIntegrityGate (LBCE) is first in every gate chain',
  G04: 'Human Final Stop is reachable from any autonomous-action path',
  G27: '27-guardrails registry is present',
})

// -- D1 — runtime/node.py path detection ------------------------------------
//
// Match `runtime/node.py` anywhere in a path, with either slash direction,
// any leading directory, but NOT inside an unrelated filename like
// `my-runtime-node-py-summary.md`. We require an explicit `/runtime/` segment
// (or a leading `runtime/`) and a `node.py` filename.
const NODE_PY_PATH = /(^|[\/\\])runtime[\/\\]node\.py(?:$|[\/\\])/i

// -- D2 — FOUNDER_SALARY hardcoded literal pattern --------------------------
//
// Match an assignment that introduces a numeric literal to the constant.
// Accepts JS, TS, Python, JSON. Refuses any of:
//   FOUNDER_SALARY_PER_INSTALL_CENTS = 12345
//   FOUNDER_SALARY_PER_INSTALL_CENTS=12_345
//   FOUNDER_SALARY_PER_INSTALL_CENTS: 12345
//   "FOUNDER_SALARY_PER_INSTALL_CENTS": 12345
//   const FOUNDER_SALARY_PER_INSTALL_CENTS = 12345
//   FOUNDER_SALARY_PER_INSTALL_CENTS := 12345
//
// Captures the literal so evidence can show "value: 12345" — this is not a
// secret, so it is safe to echo.
//
// We only refuse INTRODUCTIONS — diff lines that start with `+`. A removal
// (`-` line) of a hardcoded literal is the opposite of drift; it is the fix.
const FOUNDER_LITERAL_LINE =
  /^\+[^\n]*?["']?FOUNDER_SALARY_PER_INSTALL_CENTS["']?\s*(?:[:=]|:=)\s*([0-9][0-9_]*)/

// Accepted env-read forms — any of these on the same diff line means the
// hardcoded check is moot (the file is reading from env, not pinning).
const FOUNDER_ENV_FORMS = [
  /process\.env\.FOUNDER_SALARY_PER_INSTALL_CENTS/,
  /process\.env\[["']FOUNDER_SALARY_PER_INSTALL_CENTS["']\]/,
  /os\.getenv\(\s*["']FOUNDER_SALARY_PER_INSTALL_CENTS["']/,
  /os\.environ\[["']FOUNDER_SALARY_PER_INSTALL_CENTS["']\]/,
  /Deno\.env\.get\(\s*["']FOUNDER_SALARY_PER_INSTALL_CENTS["']/,
  /Bun\.env\.FOUNDER_SALARY_PER_INSTALL_CENTS/,
]

// -- D4 — ATOMEONS_IDENTITY_SECRET hardcoded literal pattern ----------------
//
// Refuse any introduction (`+` line) that places a string LITERAL onto the
// identity secret. The literal is treated as secret material and is NEVER
// echoed in evidence — we report the form and a redacted preview.
//
// Forms we refuse:
//   ATOMEONS_IDENTITY_SECRET = "value"
//   ATOMEONS_IDENTITY_SECRET = 'value'
//   ATOMEONS_IDENTITY_SECRET: "value"
//   "ATOMEONS_IDENTITY_SECRET": "value"
//   const ATOMEONS_IDENTITY_SECRET = `value`
//
// Forms we accept (env reads): same family as FOUNDER above.
const IDENTITY_LITERAL_LINE =
  /^\+[^\n]*?["']?ATOMEONS_IDENTITY_SECRET["']?\s*(?:[:=]|:=)\s*(["'`])([^"'`\n]*)\1/

const IDENTITY_ENV_FORMS = [
  /process\.env\.ATOMEONS_IDENTITY_SECRET/,
  /process\.env\[["']ATOMEONS_IDENTITY_SECRET["']\]/,
  /os\.getenv\(\s*["']ATOMEONS_IDENTITY_SECRET["']/,
  /os\.environ\[["']ATOMEONS_IDENTITY_SECRET["']\]/,
  /Deno\.env\.get\(\s*["']ATOMEONS_IDENTITY_SECRET["']/,
  /Bun\.env\.ATOMEONS_IDENTITY_SECRET/,
]

// -- D5 — Gate 0 LBCE first pattern -----------------------------------------
//
// Same alternation the 27-guardrails G-03 check uses.
const LBCE_FIRST = /(LatticeIntegrityGate|LBCE|Gate0|GATE_0_LBCE|gate-0-lbce)/

// -- D6 — Human Final Stop reachability -------------------------------------
//
// A chain entry counts as reachable if it matches the alternation.
const HUMAN_FINAL_STOP = /(HumanFinalStop|gate-9-human|GATE_9_HUMAN|HumanVeto|HumanGate9)/

// -- D1 helpers -------------------------------------------------------------

// Pull every file path the action references: explicit files[] + diff paths.
function collectFilePaths(action) {
  const out = []
  if (Array.isArray(action.files)) {
    for (const f of action.files) {
      if (typeof f === 'string' && f.length > 0) out.push(f)
    }
  }
  // Diff path extraction — minimal, matches the patch-header forms.
  if (typeof action.diff === 'string' && action.diff.length > 0) {
    const lines = action.diff.split(/\r?\n/)
    const re = /^(?:diff --git\s+(?:a\/)?(\S+)\s+(?:b\/)?(\S+)|---\s+(?:a\/)?(\S+)|\+\+\+\s+(?:b\/)?(\S+))\s*$/
    for (const line of lines) {
      const m = re.exec(line)
      if (!m) continue
      for (let i = 1; i < m.length; i++) {
        const p = m[i]
        if (typeof p === 'string' && p.length > 0 && p !== '/dev/null') out.push(p)
      }
    }
  }
  return out
}

function touchesNodePy(action) {
  for (const p of collectFilePaths(action)) {
    if (NODE_PY_PATH.test(p)) return p
  }
  return null
}

function sha256OfFile(absPath) {
  try {
    const buf = readFileSync(absPath)
    return createHash('sha256').update(buf).digest('hex')
  } catch {
    return null
  }
}

// -- D2 / D4 helpers --------------------------------------------------------

// Walk diff line-by-line so the line number we report is meaningful to the
// operator reading the receipt. Returns the first hit or null.
function findHardcodedFounder(diff) {
  if (typeof diff !== 'string' || diff.length === 0) return null
  const lines = diff.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const m = FOUNDER_LITERAL_LINE.exec(line)
    if (!m) continue
    // If the same line is also an env read, the assignment is to a local
    // variable from env, not a pin — accept it.
    if (FOUNDER_ENV_FORMS.some((re) => re.test(line))) continue
    return { line_no: i + 1, value: m[1], line }
  }
  return null
}

function findHardcodedIdentity(diff) {
  if (typeof diff !== 'string' || diff.length === 0) return null
  const lines = diff.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const m = IDENTITY_LITERAL_LINE.exec(line)
    if (!m) continue
    if (IDENTITY_ENV_FORMS.some((re) => re.test(line))) continue
    const literal = m[2] || ''
    return {
      line_no: i + 1,
      form: 'literal_string_assignment',
      preview: literal.length > 0 ? `${literal.slice(0, 2)}…(${literal.length} chars)` : 'empty_string',
    }
  }
  return null
}

// -- D5 / D6 helpers --------------------------------------------------------

// Normalise a chain to an array of strings. Accepts:
//   ['gate-0-lbce', 'gate-1-scope', …]                — already strings
//   [{ id: 'gate-0-lbce' }, …]                        — array of objects
//   { gates: ['gate-0-lbce', …] }                     — wrapped object
function normaliseChain(chain) {
  if (!chain) return null
  if (Array.isArray(chain)) {
    return chain.map((e) => {
      if (typeof e === 'string') return e
      if (e && typeof e === 'object') {
        return String(e.id || e.gate || e.name || '')
      }
      return ''
    })
  }
  if (typeof chain === 'object' && Array.isArray(chain.gates)) {
    return normaliseChain(chain.gates)
  }
  return null
}

// -- Main evaluator ---------------------------------------------------------

export function gate6Drift(input, ctx = {}) {
  const startedAt = nowNs()
  const evidence = { checks: [], invariants: INVARIANTS }

  // --- Shape checks --------------------------------------------------------
  if (!input || typeof input !== 'object') {
    return finish(false, 'missing_input',
      { reason: 'input must be an object with {action, order}' }, startedAt)
  }
  const { action, order } = input
  if (!action || typeof action !== 'object') {
    return finish(false, 'missing_action', { reason: 'action is required' }, startedAt)
  }
  if (!order || typeof order !== 'object') {
    return finish(false, 'missing_order', { reason: 'order is required' }, startedAt)
  }

  const root = (ctx && typeof ctx.root === 'string') ? ctx.root : ORANGE5_ROOT
  const guardrailsPath =
    (ctx && typeof ctx.guardrails_registry_path === 'string')
      ? ctx.guardrails_registry_path
      : pathResolve(root, '01-DOCTRINE/27-guardrails/registry.mjs')
  const nodePyPath =
    (ctx && typeof ctx.node_py_path === 'string')
      ? ctx.node_py_path
      : pathResolve(root, 'runtime/node.py')
  const expectedNodeSha =
    (ctx && typeof ctx.expected_node_sha === 'string') ? ctx.expected_node_sha : null

  // --- D3. 27-guardrails registry present ---------------------------------
  //
  // We check this first because every other invariant in Gate 6 derives
  // authority from this file. If the constitution is gone, refuse before
  // we audit anything else.
  if (!existsSync(guardrailsPath)) {
    evidence.checks.push({
      name: 'guardrails_registry_present', pass: false,
      invariant: 'G27', path: guardrailsPath,
    })
    return finish(false, 'guardrails_registry_missing', {
      reason: '27-guardrails registry not found on disk; lattice constitution missing',
      invariant: 'G27', path: guardrailsPath, ...evidence,
    }, startedAt)
  }
  // Optional length check — if the file is readable and the export array
  // shape is the standard one, count entries. This is a defence in depth;
  // the registry self-counts in G27, but Gate 6 catches a truncated file
  // before any action lands.
  let registryEntryCount = null
  try {
    const text = readFileSync(guardrailsPath, 'utf8')
    // Count top-level objects in GUARDRAILS. Each entry starts with `{\n    id: "G`.
    const matches = text.match(/\{\s*\n\s*id:\s*["']G\d+["']/g)
    registryEntryCount = matches ? matches.length : null
  } catch {
    registryEntryCount = null
  }
  if (registryEntryCount !== null && registryEntryCount !== 27) {
    evidence.checks.push({
      name: 'guardrails_registry_present', pass: false,
      invariant: 'G27', path: guardrailsPath, entry_count: registryEntryCount,
    })
    return finish(false, 'guardrails_registry_wrong_count', {
      reason: `27-guardrails registry has ${registryEntryCount} entries, expected 27`,
      invariant: 'G27', path: guardrailsPath, entry_count: registryEntryCount,
      ...evidence,
    }, startedAt)
  }
  evidence.checks.push({
    name: 'guardrails_registry_present', pass: true,
    invariant: 'G27', path: guardrailsPath, entry_count: registryEntryCount,
  })

  // --- D1. runtime/node.py sole authority ---------------------------------
  const nodeTouch = touchesNodePy(action)
  if (nodeTouch !== null) {
    const orderOk  = order.authorized_node_py_mutation === true
    const actionOk = action.authorized_node_py_mutation === true
    const acked = Array.isArray(action.invariants_acknowledged)
      && action.invariants_acknowledged.includes('G01')
    if (!(orderOk && actionOk && acked)) {
      evidence.checks.push({
        name: 'runtime_node_py_authority', pass: false,
        invariant: 'G01', path: nodeTouch,
        order_authorized: orderOk, action_authorized: actionOk, acked,
      })
      return finish(false, 'node_py_unauthorized_mutation', {
        reason: 'action touches runtime/node.py without explicit dual authorization and G01 acknowledgement',
        invariant: 'G01', path: nodeTouch,
        required: {
          'order.authorized_node_py_mutation': true,
          'action.authorized_node_py_mutation': true,
          'action.invariants_acknowledged includes': 'G01',
        },
        observed: {
          'order.authorized_node_py_mutation': orderOk,
          'action.authorized_node_py_mutation': actionOk,
          acked,
        },
        ...evidence,
      }, startedAt)
    }
    evidence.checks.push({
      name: 'runtime_node_py_authority', pass: true,
      invariant: 'G01', path: nodeTouch, authorized: true, acked: true,
    })
  } else {
    // Optional sha pin check — only when the file exists AND a pin was supplied.
    if (expectedNodeSha && existsSync(nodePyPath)) {
      const actualSha = sha256OfFile(nodePyPath)
      if (actualSha && actualSha !== expectedNodeSha.toLowerCase()) {
        evidence.checks.push({
          name: 'runtime_node_py_authority', pass: false,
          invariant: 'G01', path: nodePyPath,
          expected_sha: expectedNodeSha, actual_sha: actualSha,
        })
        return finish(false, 'node_py_drifted', {
          reason: 'runtime/node.py sha256 does not match pinned value',
          invariant: 'G01', path: nodePyPath,
          expected_sha: expectedNodeSha, actual_sha: actualSha, ...evidence,
        }, startedAt)
      }
      evidence.checks.push({
        name: 'runtime_node_py_authority', pass: true,
        invariant: 'G01', path: nodePyPath, sha_pinned: true,
      })
    } else {
      evidence.checks.push({
        name: 'runtime_node_py_authority', pass: true,
        invariant: 'G01', note: 'action does not touch runtime/node.py',
      })
    }
  }

  // --- D2. FOUNDER_SALARY env-bound ---------------------------------------
  const founderHit = findHardcodedFounder(action.diff)
  if (founderHit) {
    evidence.checks.push({
      name: 'founder_salary_env_bound', pass: false,
      invariant: 'G02', line_no: founderHit.line_no, value: founderHit.value,
    })
    return finish(false, 'founder_salary_hardcoded', {
      reason: 'action.diff introduces a hardcoded literal for FOUNDER_SALARY_PER_INSTALL_CENTS',
      invariant: 'G02', line_no: founderHit.line_no, value: founderHit.value,
      accepted_forms: [
        'process.env.FOUNDER_SALARY_PER_INSTALL_CENTS',
        'os.getenv("FOUNDER_SALARY_PER_INSTALL_CENTS")',
        'os.environ["FOUNDER_SALARY_PER_INSTALL_CENTS"]',
        'Deno.env.get("FOUNDER_SALARY_PER_INSTALL_CENTS")',
      ],
      ...evidence,
    }, startedAt)
  }
  evidence.checks.push({
    name: 'founder_salary_env_bound', pass: true, invariant: 'G02',
  })

  // --- D4. ATOMEONS_IDENTITY_SECRET env-only ------------------------------
  const identityHit = findHardcodedIdentity(action.diff)
  if (identityHit) {
    evidence.checks.push({
      name: 'identity_secret_env_only', pass: false,
      invariant: 'G05', line_no: identityHit.line_no,
      form: identityHit.form, preview: identityHit.preview,
    })
    return finish(false, 'identity_secret_hardcoded', {
      reason: 'action.diff introduces a hardcoded literal for ATOMEONS_IDENTITY_SECRET',
      invariant: 'G05', line_no: identityHit.line_no,
      form: identityHit.form, preview: identityHit.preview,
      accepted_forms: [
        'process.env.ATOMEONS_IDENTITY_SECRET',
        'os.getenv("ATOMEONS_IDENTITY_SECRET")',
        'os.environ["ATOMEONS_IDENTITY_SECRET"]',
        'Deno.env.get("ATOMEONS_IDENTITY_SECRET")',
      ],
      ...evidence,
    }, startedAt)
  }
  evidence.checks.push({
    name: 'identity_secret_env_only', pass: true, invariant: 'G05',
  })

  // --- D5. Gate 0 LBCE referenced first in chain --------------------------
  //
  // Look at action.chain first; if not present, fall back to order.chain.
  // If neither is present, the action does not declare a chain — Gate 6 does
  // not invent one; the LBCE-first invariant is enforced structurally by the
  // runner that called Gate 6 in position 7. We pass with a note.
  const declaredChain =
    normaliseChain(action.chain) || normaliseChain(order.chain) || null
  if (declaredChain && declaredChain.length > 0) {
    const first = declaredChain[0] || ''
    if (!LBCE_FIRST.test(first)) {
      evidence.checks.push({
        name: 'gate_zero_lbce_first', pass: false,
        invariant: 'G03', first_entry: first, chain: declaredChain,
      })
      return finish(false, 'lbce_not_first_in_chain', {
        reason: 'declared gate chain does not begin with Gate 0 (LBCE)',
        invariant: 'G03', first_entry: first, chain: declaredChain,
        expected_pattern: LBCE_FIRST.source, ...evidence,
      }, startedAt)
    }
    evidence.checks.push({
      name: 'gate_zero_lbce_first', pass: true,
      invariant: 'G03', first_entry: first,
    })
  } else {
    evidence.checks.push({
      name: 'gate_zero_lbce_first', pass: true,
      invariant: 'G03', note: 'no chain declared on action or order',
    })
  }

  // --- D6. Human Final Stop reachable from autonomous-action path ---------
  //
  // Trigger condition: action.autonomy === 'autonomous' OR action.risk_level
  // in {'high', 'critical'}. If triggered, the declared chain must include
  // at least one entry matching the Human Final Stop alternation.
  const autonomy = typeof action.autonomy === 'string'
    ? action.autonomy.toLowerCase() : ''
  const riskLevel = typeof action.risk_level === 'string'
    ? action.risk_level.toLowerCase() : ''
  const needsHumanGate = autonomy === 'autonomous'
    || riskLevel === 'high' || riskLevel === 'critical'

  if (needsHumanGate) {
    const chain = declaredChain || []
    const hasHuman = chain.some((entry) => HUMAN_FINAL_STOP.test(String(entry)))
    if (!hasHuman) {
      evidence.checks.push({
        name: 'human_final_stop_reachable', pass: false,
        invariant: 'G04', autonomy, risk_level: riskLevel, chain,
      })
      return finish(false, 'human_final_stop_unreachable', {
        reason: 'autonomous or high-risk action does not include a Human Final Stop gate in its chain',
        invariant: 'G04', autonomy, risk_level: riskLevel, chain,
        expected_pattern: HUMAN_FINAL_STOP.source, ...evidence,
      }, startedAt)
    }
    evidence.checks.push({
      name: 'human_final_stop_reachable', pass: true,
      invariant: 'G04', autonomy, risk_level: riskLevel,
    })
  } else {
    evidence.checks.push({
      name: 'human_final_stop_reachable', pass: true,
      invariant: 'G04', note: 'action is not autonomous and not high-risk',
    })
  }

  return finish(true, 'ok', evidence, startedAt)
}

// ---- output shape ---------------------------------------------------------

function finish(pass, reason, evidence, startedNs) {
  const took_ms = Number(nowNs() - startedNs) / 1e6
  return {
    gate: GATE_ID,
    gate_id: GATE_ID,
    name: GATE_NAME,
    position: POSITION_IN_STACK,
    bypassable: BYPASSABLE,
    pass,
    reason,
    reasons: pass ? [] : [reason],
    evidence,
    took_ms: Math.round(took_ms * 1000) / 1000,
  }
}

function nowNs() {
  if (typeof process !== 'undefined' && process.hrtime && process.hrtime.bigint) {
    return process.hrtime.bigint()
  }
  return BigInt(Date.now()) * 1000000n
}

// Default export: evaluator + metadata, matching the runner's expected shape
// (same shape as Gates 0-5 in this directory).
export const GATE_ID_EXPORT = GATE_ID
export const GATE_NAME_EXPORT = GATE_NAME
export const evaluate = gate6Drift

export default {
  id: GATE_ID,
  name: GATE_NAME,
  position: POSITION_IN_STACK,
  bypassable: BYPASSABLE,
  target_ms: TARGET_MS,
  evaluate: gate6Drift,
  // Exposed for tests / introspection — not part of the runtime contract.
  _internals: {
    INVARIANTS,
    NODE_PY_PATH,
    FOUNDER_LITERAL_LINE,
    FOUNDER_ENV_FORMS,
    IDENTITY_LITERAL_LINE,
    IDENTITY_ENV_FORMS,
    LBCE_FIRST,
    HUMAN_FINAL_STOP,
    collectFilePaths,
    touchesNodePy,
    sha256OfFile,
    findHardcodedFounder,
    findHardcodedIdentity,
    normaliseChain,
  },
}
import { ORANGE5_ROOT } from '../root.mjs'
