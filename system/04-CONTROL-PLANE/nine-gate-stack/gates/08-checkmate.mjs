// 08-checkmate.mjs — Gate 8 CHECKMATE of the 9-Gate Stack.
//
// Position in the 9-Gate Stack: NINTH (after LBCE, Scope, Department, Triad,
// HRE, Security, Drift, Receipt). Bypassable: false. Target: <30ms. Pure-ish:
// reads the receipt file and (when declared) a visual-proof artifact and a
// rollback artifact under the lattice root. No network. No mutation.
//
// Purpose: the final Atom Standard gate. Gates 0-7 have proven the action is
// well-located, well-routed, internally coherent, factually grounded, free of
// secrets / path traversal, constitutionally invariant, and carries a valid
// hash-chained receipt with honest prose. CHECKMATE asks the human-grade
// question Atom asks at the desk:
//
//   "Would I sign my name to this ship right now?"
//
// To answer yes, five Atom Standard checks must hold. All must hold:
//
//   M1. Tests passed
//       The action MUST declare test results. action.test_results is required
//       and MUST be an object with:
//         - command  (string, non-empty; typically "npm test" or "pytest")
//         - passed   (number, ≥ 0)
//         - failed   (number, === 0)
//         - total    (number, === passed + failed, > 0)
//         - exit_code (number, === 0)
//       A "no tests configured" claim is a refusal — Mom's Law: a build with
//       no test story is not "tests passed", it is "untested". The action may
//       instead declare action.test_results.kind === 'docs_only' and supply
//       action.is_docs_only === true; CHECKMATE then verifies the receipt and
//       diff really are documentation-only (no .js/.mjs/.ts/.tsx/.py/.go/.rs
//       extension under action.files_written) before accepting that escape.
//
//   M2. Visual proof captured (if UI changed)
//       If action.ui_changed === true OR action.files_written touches any
//       path matching the UI patterns (/**/ui/**, /**/components/**,
//       /**/web/**, /**/app/**, *.tsx, *.jsx, *.css, *.scss, *.svelte,
//       *.vue), then action.visual_proof_path is required and MUST point to
//       an existing file under the lattice root with a recognised image MIME
//       extension (.png .jpg .jpeg .webp .gif .svg .pdf). Empty files are a
//       refusal — visual proof means an artifact a human can open and verify.
//       If the action declares ui_changed === false AND no UI-shaped file is
//       in files_written, this check is N/A and passes.
//
//   M3. Security clean (Gate 5 result)
//       Gate 5 already ran upstream. CHECKMATE re-confirms by reading the
//       prior-gate result either from input.prior_gates (array of gate result
//       objects, the runtime-injected canonical form) or from
//       action.gates_run (operator-injected for tests). The Gate 5 entry
//       MUST be present AND pass === true. A missing Gate 5 entry is treated
//       as a refusal — CHECKMATE will not paper over a skipped security gate.
//       For runtime callers that always thread the stack in order, the daemon
//       at 127.0.0.1:7450 injects input.prior_gates; tests may inject via
//       action.gates_run.
//
//   M4. Rollback evidence in receipt
//       The receipt body (NOT the front-matter) MUST contain a rollback
//       section that names a concrete rollback artifact. Concretely:
//         - The body must contain a heading matching /^#{1,6}\s+rollback\b/i
//           (e.g. "## Rollback", "### Rollback plan").
//         - Under that section, at least one of:
//             a) action.rollback_path is set and resolves to an existing file
//                under the lattice root, OR
//             b) The section text contains either a `git revert <sha>` token
//                with a 7-40 char hex sha, OR a `git reset --hard <sha>` token
//                with the same shape, OR a backup artifact path matching
//                /\b\d{4}-\d{2}-\d{2}.*\.(zip|tar(\.gz)?|tgz|7z)\b/i.
//       "We can roll this back if needed" is not rollback evidence; the gate
//       refuses prose-only claims.
//
//   M5. Revision pressure applied (≥ 1 self-correction)
//       The action MUST carry evidence that revision pressure was applied
//       during authoring. Concretely, at least one of:
//         a) action.revisions is an array of length ≥ 1, where each entry has
//            { round: number ≥ 1, change: string, reason: string } and at
//            least one entry's reason is non-trivial (≥ 12 chars, not in the
//            soft-praise blocklist {"good", "ok", "fine", "polish", "tweak"}).
//         b) The receipt body contains a section heading matching
//            /^#{1,6}\s+(revisions?|self[- ]correction|second[- ]pass)\b/i
//            with at least 40 chars of non-whitespace prose underneath before
//            the next heading or EOF.
//       A first-draft ship is a refusal. Atom Standard means at least one
//       pass of self-pressure. (The default in the AE0 Factory is 3+ rounds;
//       CHECKMATE only enforces the floor.)
//
// Mom's Law: every refusal cites the exact check (M1..M5), the exact term
// that broke it (with paths fully echoed; paths are public-by-design), and a
// one-sentence reason an operator reading the receipt can act on. No
// "looks fine" passes. No silent fall-through.

import { readFileSync, existsSync, statSync } from 'node:fs'
import { resolve as pathResolve, isAbsolute as pathIsAbsolute, extname } from 'node:path'

const GATE_ID = 'gate-8-checkmate'
const GATE_NAME = 'CHECKMATE — Atom Standard final gate'
const BYPASSABLE = false
const POSITION_IN_STACK = 8
const TARGET_MS = 30

// -- Canon ------------------------------------------------------------------

// Default lattice root. Overridable via ctx.root for tests.

// Image / artifact MIME extensions accepted for visual proof.
const VISUAL_PROOF_EXTS = Object.freeze([
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.pdf',
])

// Code-file extensions that DISQUALIFY a docs_only escape from M1.
const CODE_FILE_EXTS = Object.freeze([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.go',
  '.rs', '.java', '.kt', '.swift', '.rb', '.php', '.c', '.cpp',
  '.h', '.hpp', '.cs', '.sh', '.ps1',
])

// UI-shaped extensions / path segments that trigger M2.
const UI_FILE_EXTS = Object.freeze(['.tsx', '.jsx', '.css', '.scss', '.svelte', '.vue'])
const UI_PATH_SEGMENTS = Object.freeze(['/ui/', '/components/', '/web/', '/app/'])

// Soft-praise reasons that do not count as revision pressure in M5.
const SOFT_PRAISE_REASONS = Object.freeze(new Set([
  'good', 'ok', 'okay', 'fine', 'polish', 'tweak', 'cleanup', 'nit',
]))

// Maximum receipt size we will read (mirrors Gate 7).
const MAX_RECEIPT_BYTES = 1 * 1024 * 1024

// -- Helpers ---------------------------------------------------------------

function nowNs() {
  if (typeof process !== 'undefined' && process.hrtime && process.hrtime.bigint) {
    return process.hrtime.bigint()
  }
  return BigInt(Date.now()) * 1000000n
}

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

// Resolve a possibly-relative path against the lattice root. Returns an
// absolute path with forward slashes. Does NOT touch the filesystem.
function resolveUnderRoot(p, root) {
  if (typeof p !== 'string' || p.length === 0) return ''
  const forward = p.replace(/\\/g, '/')
  if (pathIsAbsolute(forward) || /^[A-Za-z]:\//.test(forward)) return forward
  const joined = pathResolve(root, forward).replace(/\\/g, '/')
  return joined
}

// File existence + non-empty size + extension membership check.
// Returns { ok, reason, size, ext }.
function checkArtifact(absPath, allowedExts) {
  try {
    if (!existsSync(absPath)) return { ok: false, reason: 'not_found' }
    const st = statSync(absPath)
    if (!st.isFile()) return { ok: false, reason: 'not_a_file', size: st.size }
    if (st.size === 0) return { ok: false, reason: 'empty_file', size: 0 }
    const ext = extname(absPath).toLowerCase()
    if (Array.isArray(allowedExts) && allowedExts.length > 0
        && !allowedExts.includes(ext)) {
      return { ok: false, reason: 'wrong_extension', size: st.size, ext, allowed: allowedExts }
    }
    return { ok: true, size: st.size, ext }
  } catch (err) {
    return { ok: false, reason: 'stat_error', error: String(err && err.message || err) }
  }
}

// Read the receipt body once. Returns { ok, body, reason }. Receipt was
// already validated by Gate 7; here we just need its prose.
function readReceiptBody(receiptPath, root) {
  if (typeof receiptPath !== 'string' || receiptPath.length === 0) {
    return { ok: false, reason: 'receipt_path_missing' }
  }
  const abs = resolveUnderRoot(receiptPath, root)
  try {
    if (!existsSync(abs)) return { ok: false, reason: 'receipt_not_found', path: abs }
    const st = statSync(abs)
    if (!st.isFile()) return { ok: false, reason: 'receipt_not_a_file', path: abs }
    if (st.size > MAX_RECEIPT_BYTES) {
      return { ok: false, reason: 'receipt_too_large', path: abs, size: st.size }
    }
    let text = readFileSync(abs, 'utf8')
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
    // Strip front-matter; Gate 7 has already validated it. We want body only.
    if (/^---\s*\r?\n/.test(text)) {
      const afterOpen = text.replace(/^---\s*\r?\n/, '')
      const closeIdx = afterOpen.search(/\r?\n---\s*(\r?\n|$)/)
      if (closeIdx >= 0) {
        const body = afterOpen.slice(closeIdx).replace(/^\r?\n---\s*(\r?\n)?/, '')
        return { ok: true, body, path: abs }
      }
    }
    return { ok: true, body: text, path: abs }
  } catch (err) {
    return { ok: false, reason: 'receipt_read_error',
      path: abs, error: String(err && err.message || err) }
  }
}

// Does the action touch any UI-shaped path?
function actionTouchesUi(action) {
  if (action && action.ui_changed === true) return { hit: true, why: 'ui_changed_flag' }
  const files = Array.isArray(action && action.files_written) ? action.files_written : []
  for (const f of files) {
    if (typeof f !== 'string' || f.length === 0) continue
    const norm = f.replace(/\\/g, '/').toLowerCase()
    const ext = extname(norm)
    if (UI_FILE_EXTS.includes(ext)) return { hit: true, why: `ext:${ext}`, file: f }
    for (const seg of UI_PATH_SEGMENTS) {
      if (norm.includes(seg)) return { hit: true, why: `segment:${seg}`, file: f }
    }
  }
  return { hit: false }
}

// Does files_written contain ANY code file (disqualifies docs_only escape)?
function filesContainCode(action) {
  const files = Array.isArray(action && action.files_written) ? action.files_written : []
  for (const f of files) {
    if (typeof f !== 'string' || f.length === 0) continue
    const ext = extname(f.replace(/\\/g, '/')).toLowerCase()
    if (CODE_FILE_EXTS.includes(ext)) return { code: true, file: f, ext }
  }
  return { code: false }
}

// Extract the prose under a heading matching `headingRe` in markdown body.
// Returns the slice from after the heading to the next heading-of-same-or-
// higher-level or EOF. Returns '' when no match.
function sectionUnder(body, headingRe) {
  if (typeof body !== 'string' || body.length === 0) return ''
  const lines = body.split(/\r?\n/)
  let startLine = -1
  let startLevel = 0
  for (let i = 0; i < lines.length; i++) {
    const m = /^(#{1,6})\s+(.*\S)\s*$/.exec(lines[i])
    if (!m) continue
    if (headingRe.test(lines[i])) {
      startLine = i
      startLevel = m[1].length
      break
    }
  }
  if (startLine < 0) return ''
  const out = []
  for (let j = startLine + 1; j < lines.length; j++) {
    const m = /^(#{1,6})\s+\S/.exec(lines[j])
    if (m && m[1].length <= startLevel) break
    out.push(lines[j])
  }
  return out.join('\n')
}

// Find any of the concrete rollback evidence shapes inside a section's text.
// Returns { hit, kind, token } or { hit:false }.
function findRollbackToken(text) {
  if (typeof text !== 'string' || text.length === 0) return { hit: false }
  const gitRevert = /\bgit\s+revert\s+([0-9a-f]{7,40})\b/i.exec(text)
  if (gitRevert) return { hit: true, kind: 'git_revert', token: gitRevert[1] }
  const gitReset = /\bgit\s+reset\s+--hard\s+([0-9a-f]{7,40})\b/i.exec(text)
  if (gitReset) return { hit: true, kind: 'git_reset_hard', token: gitReset[1] }
  const backup = /\b(\d{4}-\d{2}-\d{2}[^\s]*\.(?:zip|tar\.gz|tar|tgz|7z))\b/i.exec(text)
  if (backup) return { hit: true, kind: 'backup_artifact', token: backup[1] }
  return { hit: false }
}

// Read a Gate 5 result from the canonical prior-gates feed, or from the
// operator-injected action.gates_run. Returns { found, pass, source } where
// source is 'prior_gates' or 'action.gates_run' or 'absent'.
function readGate5Result(input) {
  const candidates = []
  if (input && Array.isArray(input.prior_gates)) {
    candidates.push({ source: 'prior_gates', list: input.prior_gates })
  }
  if (input && input.action && Array.isArray(input.action.gates_run)) {
    candidates.push({ source: 'action.gates_run', list: input.action.gates_run })
  }
  for (const { source, list } of candidates) {
    for (const entry of list) {
      if (!entry || typeof entry !== 'object') continue
      const id = entry.gate_id || entry.gate || entry.id || entry.name
      if (typeof id !== 'string') continue
      if (/gate[-_ ]?5|security/i.test(id)) {
        return { found: true, pass: entry.pass === true, source, id, entry }
      }
    }
  }
  return { found: false, pass: false, source: 'absent' }
}

// -- Atom Standard checks --------------------------------------------------

function checkM1_tests(action) {
  const tr = action && action.test_results
  if (!tr || typeof tr !== 'object') {
    return { ok: false, reason: 'test_results_missing',
      detail: 'action.test_results is required' }
  }
  // Docs-only escape: explicit + verifiable.
  if (tr.kind === 'docs_only') {
    if (action.is_docs_only !== true) {
      return { ok: false, reason: 'docs_only_unflagged',
        detail: 'test_results.kind=docs_only requires action.is_docs_only===true' }
    }
    const code = filesContainCode(action)
    if (code.code) {
      return { ok: false, reason: 'docs_only_contradicted_by_files',
        detail: { code_file: code.file, ext: code.ext } }
    }
    return { ok: true, kind: 'docs_only' }
  }
  // Normal path: numeric proof.
  if (typeof tr.command !== 'string' || tr.command.length === 0) {
    return { ok: false, reason: 'test_command_missing' }
  }
  const { passed, failed, total, exit_code } = tr
  if (!Number.isFinite(passed) || passed < 0) {
    return { ok: false, reason: 'test_passed_invalid', detail: { passed } }
  }
  if (!Number.isFinite(failed) || failed !== 0) {
    return { ok: false, reason: 'tests_failed', detail: { failed } }
  }
  if (!Number.isFinite(total) || total <= 0) {
    return { ok: false, reason: 'test_total_invalid', detail: { total } }
  }
  if (passed + failed !== total) {
    return { ok: false, reason: 'test_counts_inconsistent',
      detail: { passed, failed, total } }
  }
  if (!Number.isFinite(exit_code) || exit_code !== 0) {
    return { ok: false, reason: 'test_nonzero_exit', detail: { exit_code } }
  }
  return { ok: true, kind: 'ran',
    command: tr.command, passed, failed, total, exit_code }
}

function checkM2_visualProof(action, root) {
  const ui = actionTouchesUi(action)
  if (!ui.hit) return { ok: true, kind: 'na', reason: 'no_ui_change' }
  const vp = action && action.visual_proof_path
  if (typeof vp !== 'string' || vp.length === 0) {
    return { ok: false, reason: 'visual_proof_missing',
      detail: { ui_signal: ui } }
  }
  const abs = resolveUnderRoot(vp, root)
  const art = checkArtifact(abs, VISUAL_PROOF_EXTS)
  if (!art.ok) {
    return { ok: false, reason: `visual_proof_${art.reason}`,
      detail: { path: abs, size: art.size, ext: art.ext, allowed: art.allowed } }
  }
  return { ok: true, kind: 'captured',
    path: abs, size: art.size, ext: art.ext, ui_signal: ui }
}

function checkM3_security(input) {
  const g5 = readGate5Result(input)
  if (!g5.found) {
    return { ok: false, reason: 'gate_5_result_absent',
      detail: 'no Gate 5 entry in input.prior_gates or action.gates_run' }
  }
  if (!g5.pass) {
    return { ok: false, reason: 'gate_5_did_not_pass',
      detail: { source: g5.source, gate_id: g5.id } }
  }
  return { ok: true, source: g5.source, gate_id: g5.id }
}

function checkM4_rollback(action, body, root) {
  if (typeof body !== 'string' || body.length === 0) {
    return { ok: false, reason: 'receipt_body_empty' }
  }
  const section = sectionUnder(body, /^#{1,6}\s+rollback\b/i)
  if (!section || section.trim().length === 0) {
    return { ok: false, reason: 'rollback_section_missing',
      detail: 'receipt body needs a # Rollback section' }
  }
  // Path-based evidence.
  if (typeof action.rollback_path === 'string' && action.rollback_path.length > 0) {
    const abs = resolveUnderRoot(action.rollback_path, root)
    const art = checkArtifact(abs, null)
    if (art.ok) {
      return { ok: true, kind: 'rollback_path',
        path: abs, size: art.size, ext: art.ext,
        section_chars: section.length }
    }
    // Path declared but unreadable — refuse rather than silently fall through.
    return { ok: false, reason: `rollback_path_${art.reason}`,
      detail: { path: abs, size: art.size, error: art.error } }
  }
  // Token-based evidence inside the section.
  const tok = findRollbackToken(section)
  if (tok.hit) {
    return { ok: true, kind: tok.kind, token: tok.token,
      section_chars: section.length }
  }
  return { ok: false, reason: 'rollback_evidence_prose_only',
    detail: 'Rollback section has no path, no git revert/reset sha, and no dated backup artifact' }
}

function checkM5_revisionPressure(action, body) {
  // Path A: structured action.revisions array.
  if (Array.isArray(action && action.revisions) && action.revisions.length >= 1) {
    let qualifying = 0
    const seen_rounds = new Set()
    for (const r of action.revisions) {
      if (!r || typeof r !== 'object') continue
      if (!Number.isFinite(r.round) || r.round < 1) continue
      if (typeof r.change !== 'string' || r.change.length === 0) continue
      if (typeof r.reason !== 'string') continue
      const reasonNorm = r.reason.trim().toLowerCase()
      if (reasonNorm.length < 12) continue
      if (SOFT_PRAISE_REASONS.has(reasonNorm)) continue
      qualifying += 1
      seen_rounds.add(r.round)
    }
    if (qualifying >= 1) {
      return { ok: true, kind: 'structured',
        revisions: action.revisions.length,
        qualifying_revisions: qualifying,
        rounds_seen: [...seen_rounds].sort((a, b) => a - b) }
    }
    return { ok: false, reason: 'revisions_all_soft',
      detail: { entries: action.revisions.length,
        rule: 'each entry needs {round≥1, change, reason length≥12 not in soft-praise set}' } }
  }
  // Path B: receipt section.
  if (typeof body === 'string' && body.length > 0) {
    const section = sectionUnder(body,
      /^#{1,6}\s+(revisions?|self[- ]correction|second[- ]pass)\b/i)
    if (section) {
      const nonws = section.replace(/\s+/g, '').length
      if (nonws >= 40) {
        return { ok: true, kind: 'receipt_section',
          section_chars: section.length, non_whitespace_chars: nonws }
      }
      return { ok: false, reason: 'revisions_section_too_short',
        detail: { non_whitespace_chars: nonws, floor: 40 } }
    }
  }
  return { ok: false, reason: 'revision_pressure_absent',
    detail: 'no action.revisions and no # Revisions section in receipt' }
}

// -- Main gate -------------------------------------------------------------

export function gate8Checkmate(input, ctx = {}) {
  const startedAt = nowNs()
  const evidence = { checks: [] }

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

  const root = (ctx && typeof ctx.root === 'string' && ctx.root.length > 0)
    ? ctx.root.replace(/\\/g, '/')
    : DEFAULT_ROOT

  // Pull the receipt body once; M4 needs it. Receipt path was validated by
  // Gate 7 already, but CHECKMATE is independently bypass-safe — we re-read.
  const recRead = readReceiptBody(action.receipt_path, root)
  if (!recRead.ok) {
    evidence.checks.push({ name: 'receipt_body_read', pass: false,
      reason: recRead.reason, path: recRead.path, error: recRead.error })
    return finish(false, `receipt_${recRead.reason}`, {
      reason: 'CHECKMATE could not read receipt body for rollback verification',
      ...evidence,
    }, startedAt)
  }
  evidence.receipt_path_resolved = recRead.path
  evidence.receipt_body_chars = recRead.body.length

  // -- M1. Tests passed -------------------------------------------------
  const m1 = checkM1_tests(action)
  if (!m1.ok) {
    evidence.checks.push({ name: 'M1_tests', pass: false,
      reason: m1.reason, detail: m1.detail })
    return finish(false, `M1_${m1.reason}`, {
      reason: 'CHECKMATE M1 (tests passed) failed',
      detail: m1.detail, ...evidence,
    }, startedAt)
  }
  evidence.checks.push({ name: 'M1_tests', pass: true, ...m1 })

  // -- M2. Visual proof (if UI changed) --------------------------------
  const m2 = checkM2_visualProof(action, root)
  if (!m2.ok) {
    evidence.checks.push({ name: 'M2_visual_proof', pass: false,
      reason: m2.reason, detail: m2.detail })
    return finish(false, `M2_${m2.reason}`, {
      reason: 'CHECKMATE M2 (visual proof captured) failed',
      detail: m2.detail, ...evidence,
    }, startedAt)
  }
  evidence.checks.push({ name: 'M2_visual_proof', pass: true, ...m2 })

  // -- M3. Security clean (Gate 5 result) ------------------------------
  const m3 = checkM3_security(input)
  if (!m3.ok) {
    evidence.checks.push({ name: 'M3_security', pass: false,
      reason: m3.reason, detail: m3.detail })
    return finish(false, `M3_${m3.reason}`, {
      reason: 'CHECKMATE M3 (security clean) failed',
      detail: m3.detail, ...evidence,
    }, startedAt)
  }
  evidence.checks.push({ name: 'M3_security', pass: true, ...m3 })

  // -- M4. Rollback evidence in receipt --------------------------------
  const m4 = checkM4_rollback(action, recRead.body, root)
  if (!m4.ok) {
    evidence.checks.push({ name: 'M4_rollback', pass: false,
      reason: m4.reason, detail: m4.detail })
    return finish(false, `M4_${m4.reason}`, {
      reason: 'CHECKMATE M4 (rollback evidence) failed',
      detail: m4.detail, ...evidence,
    }, startedAt)
  }
  evidence.checks.push({ name: 'M4_rollback', pass: true, ...m4 })

  // -- M5. Revision pressure applied -----------------------------------
  const m5 = checkM5_revisionPressure(action, recRead.body)
  if (!m5.ok) {
    evidence.checks.push({ name: 'M5_revision_pressure', pass: false,
      reason: m5.reason, detail: m5.detail })
    return finish(false, `M5_${m5.reason}`, {
      reason: 'CHECKMATE M5 (revision pressure) failed',
      detail: m5.detail, ...evidence,
    }, startedAt)
  }
  evidence.checks.push({ name: 'M5_revision_pressure', pass: true, ...m5 })

  // All five Atom Standard checks held.
  evidence.atom_standard = 'signed'
  return finish(true, 'ok', evidence, startedAt)
}

// ---- Exports --------------------------------------------------------------

export const GATE_ID_EXPORT = GATE_ID
export const GATE_NAME_EXPORT = GATE_NAME

// Compatibility with prior gates' named export shape.
export const evaluate = gate8Checkmate

export default {
  id: GATE_ID,
  name: GATE_NAME,
  position: POSITION_IN_STACK,
  bypassable: BYPASSABLE,
  target_ms: TARGET_MS,
  evaluate: gate8Checkmate,
  // Exposed for tests / introspection — not part of the runtime contract.
  _internals: {
    DEFAULT_ROOT,
    VISUAL_PROOF_EXTS,
    CODE_FILE_EXTS,
    UI_FILE_EXTS,
    UI_PATH_SEGMENTS,
    SOFT_PRAISE_REASONS,
    MAX_RECEIPT_BYTES,
    resolveUnderRoot,
    checkArtifact,
    readReceiptBody,
    actionTouchesUi,
    filesContainCode,
    sectionUnder,
    findRollbackToken,
    readGate5Result,
    checkM1_tests,
    checkM2_visualProof,
    checkM3_security,
    checkM4_rollback,
    checkM5_revisionPressure,
  },
}
import { ORANGE5_ROOT as DEFAULT_ROOT } from '../root.mjs'
