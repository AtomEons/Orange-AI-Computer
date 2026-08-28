// 05-security.mjs — Gate 5 Security of the 9-Gate Stack.
//
// Position in the 9-Gate Stack: SIXTH (after LBCE, Scope, Department, Triad,
// HRE). Bypassable: false. Target: <30ms. Pure function, no I/O, no network.
//
// Purpose: refuse any action whose materials would (a) bypass the egress
// posture the operator declared for this order, (b) leak secret material into
// receipts, doctrine, or shipped artifacts, or (c) reach outside the lattice
// via path-traversal in any file reference.
//
// Gates 0-4 have proven the action is well-located, well-routed, internally
// coherent, and factually grounded. Gate 5 is the last line of defense before
// the action gets to touch anything that could embarrass the lattice — keys,
// tokens, or files outside the declared scope.
//
// Three checks, all must hold:
//
//   A. Egress mode check
//      The action's declared egress (action.egress) must be ≤ the order's
//      authorised egress (order.egress). The lattice egress ladder is:
//        'none' < 'loopback' < 'lan' < 'internet'
//      An action that asks for a stronger posture than the order grants is a
//      refusal. Actions that omit egress default to 'none'; orders that omit
//      egress default to 'none' as well (deny by default).
//
//   B. Secret scan
//      Scan action.diff (and any string field meant to land in the lattice:
//      action.summary, action.body, action.receipt) for tokens that match
//      the canonical secret prefixes:
//        - sk-…       (OpenAI / Anthropic-style API keys)
//        - ghp_… / gho_… / ghs_… / ghu_…  (GitHub tokens)
//        - AIza…      (Google API keys)
//        - AKIA…      (AWS access key IDs)
//        - xox[abprs]-…  (Slack tokens)
//        - hf_…       (Hugging Face tokens, lower-case prefix)
//      The first match → refusal with the prefix and the field that carried
//      it. The value itself is NOT echoed back in evidence — Mom's Law plus
//      basic operational hygiene: a refusal must not become the new leak.
//      Evidence shows the prefix kind, the field, the byte offset, and a
//      redacted preview (prefix + '…').
//
//   C. Path-traversal refusal
//      Every file reference in action.files (array of strings) and any path
//      embedded in action.diff (lines like 'diff --git a/… b/…',
//      '--- a/…', '+++ b/…') must be lattice-relative or under the Orange5
//      root, and must not contain a '..' segment or an absolute drive prefix
//      pointing outside the root. We also refuse NUL bytes, URL-encoded
//      traversal ('%2e%2e'), and Windows-style '..\\' segments.
//
// Mom's Law: every refusal cites the exact rule broken and the exact term
// that broke it (with secrets redacted). No "looks fine" passes. No silent
// normalization of a path that walked out of the lattice and back in.

const GATE_ID = 'gate-5-security'
const GATE_NAME = 'Security — egress, secrets, traversal'
const BYPASSABLE = false
const POSITION_IN_STACK = 5
const TARGET_MS = 30

// -- Egress ladder ----------------------------------------------------------
//
// Lower index = more restrictive. An action's egress level must be ≤ the
// order's egress level. Unknown values → refusal.
const EGRESS_LADDER = Object.freeze(['none', 'loopback', 'lan', 'internet'])

function egressRank(value) {
  if (typeof value !== 'string') return -1
  const i = EGRESS_LADDER.indexOf(value.toLowerCase())
  return i // -1 means unknown
}

// -- Secret patterns --------------------------------------------------------
//
// Each entry: {kind, regex, prefix_for_evidence}. Regex is intentionally
// anchored to word boundaries / non-token chars so we don't false-positive on
// prose containing the literal letters "sk-" inside another word. The capture
// group is the matched token; we never echo the capture in evidence — only
// the prefix kind and a short prefix preview.
//
// Conservative lengths chosen to match the realistic minimum length of each
// vendor's tokens. False negatives are acceptable (Gate 5 is defense in
// depth, not the only secret scan); false positives that block a receipt
// from landing are also acceptable — the operator can rewrite the diff.
const SECRET_PATTERNS = Object.freeze([
  { kind: 'openai_or_anthropic_key', re: /(?<![A-Za-z0-9_])sk-[A-Za-z0-9_-]{20,}/g,    preview: 'sk-' },
  { kind: 'github_pat',              re: /(?<![A-Za-z0-9_])ghp_[A-Za-z0-9]{36,}/g,    preview: 'ghp_' },
  { kind: 'github_oauth',            re: /(?<![A-Za-z0-9_])gho_[A-Za-z0-9]{36,}/g,    preview: 'gho_' },
  { kind: 'github_server',           re: /(?<![A-Za-z0-9_])ghs_[A-Za-z0-9]{36,}/g,    preview: 'ghs_' },
  { kind: 'github_user',             re: /(?<![A-Za-z0-9_])ghu_[A-Za-z0-9]{36,}/g,    preview: 'ghu_' },
  { kind: 'google_api_key',          re: /(?<![A-Za-z0-9_])AIza[A-Za-z0-9_-]{35}/g,   preview: 'AIza' },
  { kind: 'aws_access_key_id',       re: /(?<![A-Za-z0-9_])AKIA[A-Z0-9]{16}/g,        preview: 'AKIA' },
  { kind: 'slack_token',             re: /(?<![A-Za-z0-9_])xox[abprs]-[A-Za-z0-9-]{10,}/g, preview: 'xox?-' },
  { kind: 'huggingface_token',       re: /(?<![A-Za-z0-9_])hf_[A-Za-z0-9]{30,}/g,     preview: 'hf_' },
])

// Fields we scan for secrets. action.diff carries the bulk of risk; the
// other three carry narrative text that operators sometimes paste keys into
// by accident. action.receipt may be a string or an object — if it's an
// object we serialise it deterministically for the scan only (we do not
// mutate the input).
const SECRET_SCAN_FIELDS = Object.freeze(['diff', 'summary', 'body', 'receipt'])

// -- Path-traversal patterns ------------------------------------------------
//
// Any of these in a file reference → refusal. We check on the normalised
// (forward-slash, lower-case for drive letter compare) form, but the regex
// list below works on the raw input first so we catch obfuscated traversal
// (URL-encoded, backslash) before normalisation hides it.
const TRAVERSAL_PATTERNS = Object.freeze([
  { kind: 'parent_segment',          re: /(^|[\/\\])\.\.([\/\\]|$)/ },
  { kind: 'urlencoded_parent',       re: /%2e%2e/i },
  { kind: 'nul_byte',                re: /\x00/ },
  { kind: 'backslash_parent',        re: /\.\.\\/ },
])

// Match strings inside diff/patch headers that name a path.
//   diff --git a/<p> b/<p>
//   --- a/<p>         (or "--- <p>" without a/)
//   +++ b/<p>         (or "+++ <p>" without b/)
//   rename from <p>   /   rename to <p>
//   copy from <p>     /   copy to <p>
//
// We deliberately strip the leading "a/" or "b/" prefix that git uses so the
// path we check is the real intended target. /dev/null is a unix convention
// for "file does not exist on this side" and is never a real file reference.
const DIFF_PATH_LINE = /^(?:diff --git\s+(?:a\/)?(\S+)\s+(?:b\/)?(\S+)|---\s+(?:a\/)?(\S+)|\+\+\+\s+(?:b\/)?(\S+)|rename from\s+(\S+)|rename to\s+(\S+)|copy from\s+(\S+)|copy to\s+(\S+))\s*$/

function extractDiffPaths(diff) {
  if (typeof diff !== 'string' || diff.length === 0) return []
  const out = []
  const lines = diff.split(/\r?\n/)
  for (const line of lines) {
    const m = DIFF_PATH_LINE.exec(line)
    if (!m) continue
    for (let i = 1; i < m.length; i++) {
      const p = m[i]
      if (typeof p === 'string' && p.length > 0 && p !== '/dev/null') out.push(p)
    }
  }
  return out
}

// Normalise a path for root containment check: forward slashes, no trailing
// slash. Does NOT resolve '..' — that's exactly the thing we refuse.
function normalisePath(p) {
  if (typeof p !== 'string') return ''
  let n = p.replace(/\\/g, '/')
  // collapse only runs of slashes (not '..')
  n = n.replace(/\/+/g, '/')
  // strip trailing slash unless it's the root
  if (n.length > 1 && n.endsWith('/')) n = n.slice(0, -1)
  return n
}

// Decide if `p` is absolute (Windows drive or POSIX root).
function isAbsolutePath(p) {
  return /^[A-Za-z]:\//.test(p) || p.startsWith('/')
}

// Is the normalised absolute path under the Orange5 root? Comparison is
// case-insensitive on the drive/path prefix to match Windows semantics.
function underRoot(normalised, root) {
  const r = normalisePath(root).toLowerCase()
  const n = normalised.toLowerCase()
  if (n === r) return true
  return n.startsWith(r + '/')
}

// Run every traversal pattern against the raw and normalised forms.
// Returns the first matching kind, or null if clean.
function traversalKind(rawPath) {
  for (const t of TRAVERSAL_PATTERNS) {
    if (t.re.test(rawPath)) return t.kind
  }
  return null
}

// Scan a single string for secrets. Returns the first hit as
// {kind, field, offset, preview} or null. Field is set by caller.
function firstSecretIn(str, field) {
  if (typeof str !== 'string' || str.length === 0) return null
  for (const p of SECRET_PATTERNS) {
    p.re.lastIndex = 0
    const m = p.re.exec(str)
    if (m) {
      return {
        kind: p.kind,
        field,
        offset: m.index,
        preview: p.preview + '…', // never echo the captured token
      }
    }
  }
  return null
}

// Convert action.receipt (string | object | undefined) to a scannable string.
// We do not mutate the input; we only stringify for the scan.
function receiptToScanString(receipt) {
  if (receipt == null) return ''
  if (typeof receipt === 'string') return receipt
  try {
    return JSON.stringify(receipt)
  } catch {
    return ''
  }
}

export function gate5Security(input, ctx = {}) {
  const startedAt = nowNs()
  const evidence = { checks: [] }

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

  // --- A. Egress mode check ------------------------------------------------
  //
  // Both order.egress and action.egress default to 'none' (deny by default).
  // Unknown egress strings → refusal (we won't silently treat 'public' as
  // 'internet' or vice versa).
  const orderEgress  = (typeof order.egress  === 'string') ? order.egress.toLowerCase()  : 'none'
  const actionEgress = (typeof action.egress === 'string') ? action.egress.toLowerCase() : 'none'
  const orderRank  = egressRank(orderEgress)
  const actionRank = egressRank(actionEgress)

  evidence.order_egress  = orderEgress
  evidence.action_egress = actionEgress
  evidence.egress_ladder = EGRESS_LADDER

  if (orderRank < 0) {
    evidence.checks.push({ name: 'egress', pass: false,
      reason: 'order.egress is not a recognised level', value: orderEgress })
    return finish(false, 'egress_unknown_order', {
      reason: 'order.egress must be one of the lattice egress levels',
      value: orderEgress, allowed: EGRESS_LADDER, ...evidence,
    }, startedAt)
  }
  if (actionRank < 0) {
    evidence.checks.push({ name: 'egress', pass: false,
      reason: 'action.egress is not a recognised level', value: actionEgress })
    return finish(false, 'egress_unknown_action', {
      reason: 'action.egress must be one of the lattice egress levels',
      value: actionEgress, allowed: EGRESS_LADDER, ...evidence,
    }, startedAt)
  }
  if (actionRank > orderRank) {
    evidence.checks.push({ name: 'egress', pass: false,
      order_egress: orderEgress, action_egress: actionEgress })
    return finish(false, 'egress_exceeds_order', {
      reason: 'action requests a stronger egress than the order authorised',
      order_egress: orderEgress, action_egress: actionEgress,
      ladder: EGRESS_LADDER, ...evidence,
    }, startedAt)
  }
  evidence.checks.push({ name: 'egress', pass: true,
    order_egress: orderEgress, action_egress: actionEgress })

  // --- B. Secret scan ------------------------------------------------------
  //
  // We scan a fixed set of fields. The first hit short-circuits to refusal.
  for (const field of SECRET_SCAN_FIELDS) {
    let value
    if (field === 'receipt') {
      value = receiptToScanString(action.receipt)
    } else {
      value = action[field]
    }
    if (typeof value !== 'string' || value.length === 0) continue
    const hit = firstSecretIn(value, field)
    if (hit) {
      evidence.checks.push({ name: 'secret_scan', pass: false,
        kind: hit.kind, field: hit.field, offset: hit.offset, preview: hit.preview })
      return finish(false, 'secret_detected', {
        reason: 'a secret-shaped token was detected in action payload',
        kind: hit.kind, field: hit.field, offset: hit.offset, preview: hit.preview,
        ...evidence,
      }, startedAt)
    }
  }
  evidence.checks.push({ name: 'secret_scan', pass: true,
    scanned_fields: SECRET_SCAN_FIELDS.filter(f => {
      const v = f === 'receipt' ? receiptToScanString(action.receipt) : action[f]
      return typeof v === 'string' && v.length > 0
    }) })

  // --- C. Path-traversal refusal -------------------------------------------
  //
  // Collect every file reference: action.files (string[]) + any path embedded
  // in action.diff. For each, refuse traversal patterns first (on the raw
  // string), then refuse absolute paths that don't sit under the Orange5
  // root. Lattice-relative paths are accepted as-is (Gate 1 already checked
  // their containment under order.scope).
  const fileRefs = []
  if (Array.isArray(action.files)) {
    for (const f of action.files) {
      if (typeof f === 'string' && f.length > 0) {
        fileRefs.push({ path: f, origin: 'action.files' })
      }
    }
  }
  for (const p of extractDiffPaths(action.diff)) {
    fileRefs.push({ path: p, origin: 'action.diff' })
  }
  evidence.file_refs_count = fileRefs.length

  for (const ref of fileRefs) {
    const raw = ref.path

    // Pattern check on the RAW string — catches '..', '%2e%2e', NUL, '..\\'.
    const tk = traversalKind(raw)
    if (tk) {
      evidence.checks.push({ name: 'path_traversal', pass: false,
        kind: tk, path: raw, origin: ref.origin })
      return finish(false, 'path_traversal_detected', {
        reason: 'file reference contains a traversal pattern',
        kind: tk, path: raw, origin: ref.origin, ...evidence,
      }, startedAt)
    }

    // Containment check for absolute paths.
    const norm = normalisePath(raw)
    if (isAbsolutePath(norm)) {
      if (!underRoot(norm, root)) {
        evidence.checks.push({ name: 'path_traversal', pass: false,
          kind: 'outside_root', path: raw, origin: ref.origin, root })
        return finish(false, 'path_outside_root', {
          reason: 'absolute file reference is outside the Orange5 lattice root',
          path: raw, origin: ref.origin, root, ...evidence,
        }, startedAt)
      }
    }
  }
  evidence.checks.push({ name: 'path_traversal', pass: true,
    file_refs_count: fileRefs.length })

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
  // Fallback: synthesise nanoseconds from Date.now().
  return BigInt(Date.now()) * 1000000n
}

// Default export: the evaluator + metadata, matching the runner's expected shape.
export const GATE_ID_EXPORT = GATE_ID
export const GATE_NAME_EXPORT = GATE_NAME

// Compatibility: prior gates export `evaluate` and a named function. Match.
export const evaluate = gate5Security

export default {
  id: GATE_ID,
  name: GATE_NAME,
  position: POSITION_IN_STACK,
  bypassable: BYPASSABLE,
  target_ms: TARGET_MS,
  evaluate: gate5Security,
  // Exposed for tests / introspection — not part of the runtime contract.
  _internals: {
    EGRESS_LADDER,
    SECRET_PATTERNS,
    SECRET_SCAN_FIELDS,
    TRAVERSAL_PATTERNS,
    DIFF_PATH_LINE,
    egressRank,
    extractDiffPaths,
    normalisePath,
    isAbsolutePath,
    underRoot,
    traversalKind,
    firstSecretIn,
    receiptToScanString,
  },
}
import { ORANGE5_ROOT } from '../root.mjs'
