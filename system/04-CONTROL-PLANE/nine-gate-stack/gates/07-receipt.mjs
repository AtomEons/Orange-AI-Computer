// 07-receipt.mjs — Gate 7 Receipt of the 9-Gate Stack.
//
// Position in the 9-Gate Stack: EIGHTH (after LBCE, Scope, Department, Triad,
// HRE, Security, Drift). Bypassable: false. Target: <30ms (loopback file I/O
// only, no network). Pure-ish: reads up to two files under the lattice root.
//
// Purpose: refuse any action whose receipt is missing, structurally invalid,
// chain-broken, or polluted with fake-green vocabulary. Gate 6 has proven the
// invariants are intact; Gate 7 asks the audit question:
//
//   "Did this action actually write a receipt, does it conform to the
//    orange5.receipt.v0 contract, does it extend the prior hash chain, and is
//    its prose honest?"
//
// Three checks, all must hold:
//
//   A. Receipt path exists
//      action.receipt_path is required and MUST point to an existing file on
//      disk under the configured OrangeFive lattice root. The path may also be
//      provided lattice-relative (e.g. "10-RECEIPTS/orange5-build/foo.md") and
//      is resolved against ctx.root. The file is read into memory once and
//      reused by the schema and hash-chain checks. Mom's Law: a missing
//      receipt is not "no news"; it is a refusal.
//
//   B. Schema validates
//      The receipt body is parsed as Markdown-with-YAML-front-matter (the
//      canonical Orange5 receipt shape, mirrored in
//      06-CONTROL-PLANE/receipts/schema.sql). The front-matter MUST carry the
//      orange5.receipt.v0 contract:
//        - receipt_id    (string, non-empty, matches /^[A-Za-z0-9._:\/-]+$/)
//        - schema        (string, equal to "orange5.receipt.v0")
//        - generated_at  (string, ISO-8601 with timezone designator)
//        - status        (string, one of OPEN|CLOSED|REVOKED|SUPERSEDED)
//        - actor         (string, non-empty)
//        - sovereign     (string, non-empty)
//        - hash_chain    (string, sha256 hex OR "#NNN<hex>" indexed form)
//        - prior_receipt (string OR null; null only when hash_chain is "#001…"
//                          i.e. this is genesis for its lane)
//      The body MUST also contain at least one section heading after the
//      front-matter (a non-empty receipt is the whole point).
//
//   C. Hash chain continues
//      If prior_receipt is non-null:
//        1. The prior file MUST exist (same root-resolution rules as A).
//        2. Compute sha256 of the prior file's bytes (Node 20+ crypto).
//        3. The current receipt's hash_chain MUST contain that hex digest
//           (whole or as a clearly-tagged segment) AND the current digest of
//           the body-before-hash-chain (i.e. the receipt commits to its own
//           content). We accept both bare-hex and "#NNNhex" indexed forms.
//      The chain-continuity check uses substring containment after lower-
//      casing — operators sometimes record the chain as "prev: <hex> | self:
//      <hex>" or as a "#022abc..." marker. Substring containment is strict
//      enough to detect a chain break (the prior digest is 64 hex chars; the
//      chance of accidental collision in a receipt header is nil) and lenient
//      enough to survive operator-chosen formatting.
//      If prior_receipt is null:
//        - hash_chain MUST be an explicit genesis marker: either start with
//          "#001" or contain the literal token "GENESIS". A null prior with a
//          non-genesis chain is a refusal — Mom's Law: no orphan chains.
//
//   D. No fake-green words
//      The receipt body (everything after the front-matter) is scanned for
//      the canonical fake-green vocabulary maintained in the bakeoff doctrine
//      (04-CONTROL-PLANE/bakeoff/dimensions/refusal-discipline.mjs). One hit
//      → refusal with the offending phrase, line number, and a short
//      context window. We refuse "looks good", "lgtm", "ship it", "all green",
//      "we're good", "should be fine", "trust me", and siblings. A receipt
//      that wants to say "this passed" must say "this passed" with the gate
//      ids and the evidence, not "lgtm".
//
// Mom's Law: every refusal cites the exact rule broken and the exact term
// that broke it. Hash digests are echoed in full (they are public-by-design).
// File contents are not echoed — only the offending span with a few chars of
// context. No "looks fine" passes. No silent fall-through to "ok" when the
// receipt file is empty or the chain is broken.

import { readFileSync, existsSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve as pathResolve, isAbsolute as pathIsAbsolute } from 'node:path'

const GATE_ID = 'gate-7-receipt'
const GATE_NAME = 'Receipt — path, schema, hash chain, honest prose'
const BYPASSABLE = false
const POSITION_IN_STACK = 7
const TARGET_MS = 30

// -- Canon ------------------------------------------------------------------

const RECEIPT_SCHEMA_TAG = 'orange5.receipt.v0'

const ALLOWED_STATUS = Object.freeze(['OPEN', 'CLOSED', 'REVOKED', 'SUPERSEDED'])

// receipt_id grammar: alnum plus dot, underscore, colon, slash, dash. Mirrors
// the markdown filename grammar Orange5 uses under 10-RECEIPTS/.
const RECEIPT_ID_RE = /^[A-Za-z0-9._:\/-]+$/

// ISO-8601 with a timezone designator (Z or ±HH:MM). Loose on milliseconds.
const ISO8601_TZ_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})$/

// 64-char lowercase hex sha256.
const SHA256_HEX_RE = /\b[0-9a-f]{64}\b/g

// Genesis marker forms accepted when prior_receipt is null.
const GENESIS_INDEX_RE = /(^|[^0-9])#0*1\b/
const GENESIS_LITERAL = 'genesis'

// Fake-green vocabulary — kept in lock-step with refusal-discipline.mjs.
// Any of these in the receipt body → refusal. Phrases are matched
// case-insensitively against the prose; word boundaries are enforced for
// "lgtm" so we don't false-positive on URLs / hex strings that happen to
// contain those letters. Multi-word phrases are matched literally.
const FAKE_GREEN_WORDS = Object.freeze([
  'all green',
  'all good',
  'all set',
  'all systems go',
  "everything's fine",
  'everything is fine',
  'everything works',
  'looks good',
  'lgtm',
  'ship it',
  "we're good",
  'should be fine',
  'trust me',
])

// Maximum receipt size we will accept (megabytes). A 1 MiB ceiling is
// generous for a markdown receipt; anything larger is almost certainly a
// log-dump that doesn't belong in 10-RECEIPTS/. Refuse rather than read.
const MAX_RECEIPT_BYTES = 1 * 1024 * 1024

// Default lattice root. Overridable via ctx.root for tests.

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

// Read a file as bytes. Returns { ok, bytes, size, reason }.
function readBytes(absPath) {
  try {
    if (!existsSync(absPath)) {
      return { ok: false, reason: 'not_found' }
    }
    const st = statSync(absPath)
    if (!st.isFile()) {
      return { ok: false, reason: 'not_a_file', size: st.size }
    }
    if (st.size > MAX_RECEIPT_BYTES) {
      return { ok: false, reason: 'too_large', size: st.size, limit: MAX_RECEIPT_BYTES }
    }
    const bytes = readFileSync(absPath)
    return { ok: true, bytes, size: st.size }
  } catch (err) {
    return { ok: false, reason: 'read_error', error: String(err && err.message || err) }
  }
}

function sha256Hex(bytes) {
  const h = createHash('sha256')
  h.update(bytes)
  return h.digest('hex')
}

// Parse a Markdown receipt with YAML front-matter. Minimal parser: we accept
// only the front-matter shape `---\n<key>: <value>\n...\n---\n<body>`. Values
// are scalars (string | null) — front-matter is intentionally flat. A line
// like `prior_receipt: null` parses to null. A bare string with no quotes is
// taken verbatim (trimmed). Quoted strings strip the surrounding quotes.
//
// Returns { ok, frontmatter, body, body_offset, reason }.
function parseReceipt(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return { ok: false, reason: 'empty_receipt' }
  }
  // Allow UTF-8 BOM.
  let src = text
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1)
  // Front-matter delimiter must be the very first non-empty content.
  if (!/^---\s*\r?\n/.test(src)) {
    return { ok: false, reason: 'missing_frontmatter' }
  }
  const afterOpen = src.replace(/^---\s*\r?\n/, '')
  const closeIdx = afterOpen.search(/\r?\n---\s*(\r?\n|$)/)
  if (closeIdx < 0) {
    return { ok: false, reason: 'unterminated_frontmatter' }
  }
  const fmBlock = afterOpen.slice(0, closeIdx)
  const after = afterOpen.slice(closeIdx).replace(/^\r?\n---\s*(\r?\n)?/, '')
  const body = after
  const body_offset = src.length - body.length

  const frontmatter = {}
  const lines = fmBlock.split(/\r?\n/)
  for (const raw of lines) {
    if (!raw || /^\s*#/.test(raw)) continue
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(raw)
    if (!m) continue
    const key = m[1]
    let val = m[2].trim()
    if (val === '' || val === 'null' || val === '~') {
      frontmatter[key] = null
      continue
    }
    // Strip matching surrounding quotes.
    if ((val.startsWith('"') && val.endsWith('"') && val.length >= 2)
     || (val.startsWith("'") && val.endsWith("'") && val.length >= 2)) {
      val = val.slice(1, -1)
    }
    frontmatter[key] = val
  }
  return { ok: true, frontmatter, body, body_offset }
}

// Find the first fake-green hit in body text. Returns { phrase, line, col,
// context } or null.
function firstFakeGreen(body) {
  if (typeof body !== 'string' || body.length === 0) return null
  const lower = body.toLowerCase()
  let earliest = null
  for (const phrase of FAKE_GREEN_WORDS) {
    let from = 0
    // "lgtm" needs word boundaries; the rest are multi-word and self-bounding.
    const needsBoundary = phrase === 'lgtm'
    while (true) {
      const idx = lower.indexOf(phrase, from)
      if (idx < 0) break
      if (needsBoundary) {
        const before = idx > 0 ? lower.charCodeAt(idx - 1) : 0
        const after = idx + phrase.length < lower.length ? lower.charCodeAt(idx + phrase.length) : 0
        const isWord = (c) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95
        if (isWord(before) || isWord(after)) { from = idx + phrase.length; continue }
      }
      if (earliest === null || idx < earliest.idx) {
        earliest = { idx, phrase }
      }
      break
    }
  }
  if (earliest === null) return null
  // Line / column / short context.
  const upto = body.slice(0, earliest.idx)
  const line = (upto.match(/\r?\n/g) || []).length + 1
  const lastNl = upto.lastIndexOf('\n')
  const col = earliest.idx - (lastNl + 1) + 1
  const start = Math.max(0, earliest.idx - 24)
  const end = Math.min(body.length, earliest.idx + earliest.phrase.length + 24)
  const context = body.slice(start, end).replace(/\r?\n/g, ' ⏎ ')
  return { phrase: earliest.phrase, line, col, context }
}

// Recompute a "self" digest of the receipt body, omitting the hash_chain line
// itself. Receipts commit to their own content minus the line that records
// the commit; otherwise the digest would chase its own tail. We strip ONLY
// the `hash_chain: ...` line from the front-matter and rehash the rest.
function selfDigestExcludingHashChain(text) {
  // Operate on the original src after BOM stripping.
  let src = text
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1)
  const stripped = src.replace(/^(hash_chain\s*:.*\r?\n)/m, '')
  return sha256Hex(Buffer.from(stripped, 'utf8'))
}

// Validate the front-matter against orange5.receipt.v0.
// Returns { ok, reason, detail } — detail names the field on failure.
function validateFrontmatter(fm) {
  if (!fm || typeof fm !== 'object') {
    return { ok: false, reason: 'frontmatter_not_object' }
  }
  // schema tag
  if (fm.schema !== RECEIPT_SCHEMA_TAG) {
    return { ok: false, reason: 'schema_mismatch',
      detail: { expected: RECEIPT_SCHEMA_TAG, got: fm.schema ?? null } }
  }
  // receipt_id
  if (typeof fm.receipt_id !== 'string' || fm.receipt_id.length === 0) {
    return { ok: false, reason: 'receipt_id_missing' }
  }
  if (!RECEIPT_ID_RE.test(fm.receipt_id)) {
    return { ok: false, reason: 'receipt_id_invalid', detail: { value: fm.receipt_id } }
  }
  // generated_at
  if (typeof fm.generated_at !== 'string' || !ISO8601_TZ_RE.test(fm.generated_at)) {
    return { ok: false, reason: 'generated_at_invalid', detail: { value: fm.generated_at ?? null } }
  }
  // status
  if (typeof fm.status !== 'string' || !ALLOWED_STATUS.includes(fm.status)) {
    return { ok: false, reason: 'status_invalid',
      detail: { value: fm.status ?? null, allowed: ALLOWED_STATUS } }
  }
  // actor
  if (typeof fm.actor !== 'string' || fm.actor.length === 0) {
    return { ok: false, reason: 'actor_missing' }
  }
  // sovereign
  if (typeof fm.sovereign !== 'string' || fm.sovereign.length === 0) {
    return { ok: false, reason: 'sovereign_missing' }
  }
  // hash_chain
  if (typeof fm.hash_chain !== 'string' || fm.hash_chain.length === 0) {
    return { ok: false, reason: 'hash_chain_missing' }
  }
  // prior_receipt: must be present as a key; value may be null.
  if (!('prior_receipt' in fm)) {
    return { ok: false, reason: 'prior_receipt_key_missing' }
  }
  if (fm.prior_receipt !== null && typeof fm.prior_receipt !== 'string') {
    return { ok: false, reason: 'prior_receipt_invalid_type' }
  }
  return { ok: true }
}

// Look for a 64-hex token inside the hash_chain field. Returns the FIRST hex
// digest found, or null. Used as a sanity check that the chain field actually
// contains a digest (vs. the literal string "GENESIS").
function firstHexInChain(chain) {
  if (typeof chain !== 'string') return null
  SHA256_HEX_RE.lastIndex = 0
  const m = SHA256_HEX_RE.exec(chain.toLowerCase())
  return m ? m[0] : null
}

// Does the body contain at least one section heading after the front-matter?
function bodyHasSection(body) {
  if (typeof body !== 'string') return false
  // Match an ATX heading (one or more '#' + space + text), allowing leading
  // whitespace. We require the body to be non-trivial.
  return /^\s*#{1,6}\s+\S/m.test(body) && body.trim().length > 0
}

// -- Main gate -------------------------------------------------------------

export function gate7Receipt(input, ctx = {}) {
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

  // ---- A. Receipt path exists ------------------------------------------
  const rawPath = action.receipt_path
  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    evidence.checks.push({ name: 'receipt_path', pass: false,
      reason: 'action.receipt_path is required' })
    return finish(false, 'receipt_path_missing', {
      reason: 'action must declare receipt_path pointing to a markdown receipt',
      ...evidence,
    }, startedAt)
  }
  const absPath = resolveUnderRoot(rawPath, root)
  evidence.receipt_path = rawPath
  evidence.receipt_path_resolved = absPath

  const read = readBytes(absPath)
  if (!read.ok) {
    evidence.checks.push({ name: 'receipt_path', pass: false,
      reason: read.reason, path: absPath, size: read.size,
      limit: read.limit, error: read.error })
    const code = read.reason === 'not_found'  ? 'receipt_path_not_found'
              : read.reason === 'not_a_file' ? 'receipt_path_not_a_file'
              : read.reason === 'too_large'  ? 'receipt_too_large'
                                             : 'receipt_read_error'
    return finish(false, code, {
      reason: `receipt file failed read: ${read.reason}`,
      path: absPath, size: read.size, limit: read.limit, error: read.error,
      ...evidence,
    }, startedAt)
  }
  const text = read.bytes.toString('utf8')
  const ownSha = sha256Hex(read.bytes)
  evidence.receipt_size = read.size
  evidence.receipt_sha256 = ownSha
  evidence.checks.push({ name: 'receipt_path', pass: true,
    path: absPath, size: read.size, sha256: ownSha })

  // ---- B. Schema validates ---------------------------------------------
  const parsed = parseReceipt(text)
  if (!parsed.ok) {
    evidence.checks.push({ name: 'schema', pass: false, reason: parsed.reason })
    return finish(false, `schema_${parsed.reason}`, {
      reason: `receipt parse failed: ${parsed.reason}`,
      ...evidence,
    }, startedAt)
  }
  const fm = parsed.frontmatter
  const fmCheck = validateFrontmatter(fm)
  if (!fmCheck.ok) {
    evidence.checks.push({ name: 'schema', pass: false,
      reason: fmCheck.reason, detail: fmCheck.detail })
    return finish(false, `schema_${fmCheck.reason}`, {
      reason: `front-matter failed orange5.receipt.v0: ${fmCheck.reason}`,
      detail: fmCheck.detail, ...evidence,
    }, startedAt)
  }
  if (!bodyHasSection(parsed.body)) {
    evidence.checks.push({ name: 'schema', pass: false,
      reason: 'body_has_no_section' })
    return finish(false, 'schema_body_empty', {
      reason: 'receipt body must contain at least one markdown section',
      ...evidence,
    }, startedAt)
  }
  evidence.frontmatter = {
    receipt_id:    fm.receipt_id,
    schema:        fm.schema,
    generated_at:  fm.generated_at,
    status:        fm.status,
    actor:         fm.actor,
    sovereign:     fm.sovereign,
    hash_chain:    fm.hash_chain,
    prior_receipt: fm.prior_receipt,
  }
  evidence.checks.push({ name: 'schema', pass: true,
    receipt_id: fm.receipt_id, schema: fm.schema })

  // ---- C. Hash chain continues -----------------------------------------
  const chainLower = String(fm.hash_chain).toLowerCase()
  const chainHasOwn = chainLower.includes(ownSha)
  // Also accept the "self-excluding" digest, for receipts that commit to
  // their own content minus the chain line itself.
  const selfExcl = selfDigestExcludingHashChain(text)
  const chainHasSelfExcl = chainLower.includes(selfExcl)
  if (!chainHasOwn && !chainHasSelfExcl) {
    evidence.checks.push({ name: 'hash_chain', pass: false,
      reason: 'chain_does_not_commit_to_self',
      receipt_sha256: ownSha,
      self_excluding_sha256: selfExcl,
      hash_chain: fm.hash_chain })
    return finish(false, 'hash_chain_self_commit_missing', {
      reason: 'hash_chain field does not contain a sha256 of the receipt body',
      receipt_sha256: ownSha,
      self_excluding_sha256: selfExcl,
      hash_chain: fm.hash_chain,
      ...evidence,
    }, startedAt)
  }

  if (fm.prior_receipt === null) {
    // Genesis path: chain must be marked as genesis.
    const isGenesis = GENESIS_INDEX_RE.test(fm.hash_chain)
                  || chainLower.includes(GENESIS_LITERAL)
    if (!isGenesis) {
      evidence.checks.push({ name: 'hash_chain', pass: false,
        reason: 'orphan_chain_no_genesis_marker',
        hash_chain: fm.hash_chain })
      return finish(false, 'hash_chain_orphan', {
        reason: 'prior_receipt is null but hash_chain has no genesis marker (#001 / GENESIS)',
        hash_chain: fm.hash_chain, ...evidence,
      }, startedAt)
    }
    evidence.chain_kind = 'genesis'
    evidence.checks.push({ name: 'hash_chain', pass: true,
      kind: 'genesis', hash_chain: fm.hash_chain, receipt_sha256: ownSha })
  } else {
    // Continuation path: prior file must exist and its digest must appear.
    const priorAbs = resolveUnderRoot(fm.prior_receipt, root)
    const priorRead = readBytes(priorAbs)
    if (!priorRead.ok) {
      evidence.checks.push({ name: 'hash_chain', pass: false,
        reason: 'prior_receipt_unreadable',
        prior_path: priorAbs, error: priorRead.reason })
      return finish(false, 'hash_chain_prior_missing', {
        reason: `prior_receipt does not resolve to a readable file: ${priorRead.reason}`,
        prior_path: priorAbs, error: priorRead.reason, ...evidence,
      }, startedAt)
    }
    const priorSha = sha256Hex(priorRead.bytes)
    if (!chainLower.includes(priorSha)) {
      evidence.checks.push({ name: 'hash_chain', pass: false,
        reason: 'prior_digest_not_in_chain',
        prior_sha256: priorSha,
        hash_chain: fm.hash_chain })
      return finish(false, 'hash_chain_break', {
        reason: 'hash_chain does not contain the sha256 of prior_receipt',
        prior_path: priorAbs, prior_sha256: priorSha,
        hash_chain: fm.hash_chain, ...evidence,
      }, startedAt)
    }
    // Sanity: the chain string should contain a hex token at all.
    if (firstHexInChain(fm.hash_chain) === null) {
      evidence.checks.push({ name: 'hash_chain', pass: false,
        reason: 'chain_has_no_hex_token', hash_chain: fm.hash_chain })
      return finish(false, 'hash_chain_no_hex', {
        reason: 'hash_chain field contains no 64-char hex digest',
        hash_chain: fm.hash_chain, ...evidence,
      }, startedAt)
    }
    evidence.chain_kind = 'continuation'
    evidence.prior_sha256 = priorSha
    evidence.checks.push({ name: 'hash_chain', pass: true,
      kind: 'continuation', prior_sha256: priorSha, receipt_sha256: ownSha })
  }

  // ---- D. No fake-green words ------------------------------------------
  const hit = firstFakeGreen(parsed.body)
  if (hit) {
    evidence.checks.push({ name: 'fake_green', pass: false,
      phrase: hit.phrase, line: hit.line, col: hit.col, context: hit.context })
    return finish(false, 'fake_green_detected', {
      reason: 'receipt body contains fake-green vocabulary; rewrite with the actual evidence',
      phrase: hit.phrase, line: hit.line, col: hit.col, context: hit.context,
      vocabulary: FAKE_GREEN_WORDS,
      ...evidence,
    }, startedAt)
  }
  evidence.checks.push({ name: 'fake_green', pass: true,
    vocabulary_size: FAKE_GREEN_WORDS.length, body_chars: parsed.body.length })

  return finish(true, 'ok', evidence, startedAt)
}

// ---- Exports --------------------------------------------------------------

export const GATE_ID_EXPORT = GATE_ID
export const GATE_NAME_EXPORT = GATE_NAME

// Compatibility with prior gates' named export shape.
export const evaluate = gate7Receipt

export default {
  id: GATE_ID,
  name: GATE_NAME,
  position: POSITION_IN_STACK,
  bypassable: BYPASSABLE,
  target_ms: TARGET_MS,
  evaluate: gate7Receipt,
  // Exposed for tests / introspection — not part of the runtime contract.
  _internals: {
    RECEIPT_SCHEMA_TAG,
    ALLOWED_STATUS,
    RECEIPT_ID_RE,
    ISO8601_TZ_RE,
    SHA256_HEX_RE,
    GENESIS_INDEX_RE,
    GENESIS_LITERAL,
    FAKE_GREEN_WORDS,
    MAX_RECEIPT_BYTES,
    DEFAULT_ROOT,
    resolveUnderRoot,
    readBytes,
    sha256Hex,
    parseReceipt,
    validateFrontmatter,
    selfDigestExcludingHashChain,
    firstFakeGreen,
    firstHexInChain,
    bodyHasSection,
  },
}
import { ORANGE5_ROOT as DEFAULT_ROOT } from '../root.mjs'
