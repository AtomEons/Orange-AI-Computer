// 04-hre.mjs — Gate 4 HRE (Hallucination Reduction Engine) of the 9-Gate Stack.
//
// Position in the 9-Gate Stack: FIFTH. After Gate 0 LBCE (lattice integrity),
// Gate 1 Scope (exact scope match), Gate 2 Department (lane routing), and
// Gate 3 Triad (intent ↔ scope ↔ action coherence), Gate 4 HRE asks the
// epistemic question:
//
//   "Is every claim this action makes actually supported by ground truth?"
//
// Ground truth lives in Mirage. Mirage is Orange5's memory-of-record: a
// loopback daemon at 127.0.0.1:7450 that returns a StateBrief — a snapshot of
// what the system can currently swear to (extant receipts by hash, known
// citations by id, doctrine anchors, schema versions in force, lattice file
// presence). HRE does NOT trust the action's self-report; it consults Mirage.
//
// What HRE refuses:
//   1. Citations in action.evidence[*].cite (or .citation / .source / .url
//      / .doi / .receipt_id / .anchor) that Mirage cannot vouch for.
//   2. Receipt path refs (action.receipt_path, action.prior_receipt,
//      action.evidence[*].receipt_path) that point to nonexistent files OR
//      to files whose recorded SHA-256 disagrees with Mirage's record.
//   3. Quoted claims (action.evidence[*].quote) attributed to a source Mirage
//      cannot confirm — a quote without a verifiable source is theater.
//   4. Fake-green vocabulary in claim strings ("should work", "looks fine",
//      "probably correct", "TBD", "TODO") — HRE refuses claims that don't
//      commit. Mom's Law: "every refusal cites the exact rule and the exact
//      offending value." The inverse holds for claims: a claim that refuses
//      to commit cannot be fact-checked, so it cannot pass HRE.
//
// What HRE does NOT do:
//   - Verify hash-chain integrity end-to-end. That is Gate 7.
//   - Re-check lattice membership of paths. That is Gate 0.
//   - Decide release. That is Gate 8 / Gate 9.
//
// Mirage protocol:
//   POST http://127.0.0.1:7450/v1/memory/state-brief
//   Content-Type: application/json
//   Body: {
//     "ask": {
//       "receipts":   [absolute_path, ...],   // verify file presence + hash
//       "citations":  [cite_token, ...],      // verify the citation is known
//       "quotes":     [{ source, text }, ...] // verify source attests to text
//     },
//     "client": "gate-4-hre",
//     "request_id": "<uuid-ish>"
//   }
//   Response: {
//     "ok": true,
//     "receipts":  { "<path>": { "exists": true, "sha256": "...", "known": true } | { ... known: false } },
//     "citations": { "<cite>": { "known": true, "anchor": "...", "kind": "doctrine|receipt|external" } | { known: false } },
//     "quotes":    { "<source>::<hash(text)>": { "supported": true } | { supported: false, reason: "..." } },
//     "as_of": "<iso8601>",
//     "version": "mirage/1"
//   }
//
// Network policy:
//   - Loopback only. The endpoint host MUST be 127.0.0.1 (or "localhost" that
//     resolves to 127.0.0.1). Any other host is treated as a configuration
//     bug and the gate refuses with a network_policy_violation reason.
//   - Hard timeout (default 800ms). On timeout: gate fails closed with reason
//     "mirage_unreachable". A silent pass on Mirage outage would let
//     unsupported claims through — that is exactly what HRE exists to stop.
//   - No retries inside the gate. The runner can re-submit the action; HRE
//     is a single-shot, stateless evaluator.
//
// Pure-function exception: HRE necessarily touches the filesystem (for the
// receipt-existence cross-check) and the network (for the Mirage call). Both
// are bounded, loopback-only, and small. Every other gate in this stack is
// pure; HRE is the one gate that consults ground truth, and that is the
// point of HRE.
//
// Real Node 20+, ESM. Dependencies: node:fs, node:path, node:crypto, plus the
// global fetch() shipped with Node 18+. No external packages.
//
// Mom's Law: every refusal cites the exact rule, the exact offending value,
// and the Mirage verdict (or lack thereof). No "looks fine" passes. No
// fake-green. If Mirage cannot confirm, HRE refuses.

import { existsSync, statSync, readFileSync } from 'node:fs'
import { resolve, normalize, isAbsolute } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

export const GATE_ID = 'gate-4-hre'
export const GATE_NAME = 'HRE — Hallucination Reduction Engine'
export const BYPASSABLE = false
export const POSITION_IN_STACK = 4
export const TARGET_MS = 50           // budget inside the ~200ms total target

// Mirage loopback contract.
export const MIRAGE_DEFAULT_URL = 'http://127.0.0.1:7450/v1/memory/state-brief'
export const MIRAGE_TIMEOUT_MS = 800
const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost'])

// Orange5 root (mirrors Gate 0's constant; kept local so this gate stays
// loadable without importing 00-lbce.mjs — the runner loads gates in order
// but each gate must be independently testable).
export { ORANGE5_ROOT } from '../root.mjs'
import { ORANGE5_ROOT } from '../root.mjs'

// Vocabulary HRE refuses to see inside claim strings. These are the
// fake-green phrases that mark an unverifiable commitment. Case-insensitive,
// substring match — if any of these appears in a claim, we treat the claim
// as non-committal and refuse.
const FAKE_GREEN_PATTERNS = Object.freeze([
  'should work',
  'should be fine',
  'looks fine',
  'looks good',
  'probably correct',
  'probably works',
  'i think',
  'i believe',
  'seems to work',
  'seems fine',
  'tbd',
  'todo',
  'fixme',
  'unsure',
  'not sure',
  'unverified',
  '???',
])

// Field names on an evidence entry that we treat as a citation reference.
// Mirage will be asked to vouch for every value found in these fields.
const CITATION_FIELDS = Object.freeze([
  'cite', 'citation', 'source', 'url', 'doi', 'receipt_id',
  'anchor', 'doctrine_anchor', 'ref',
])

// Field names that carry the actual textual claim we want to scan for
// fake-green vocabulary.
const CLAIM_FIELDS = Object.freeze([
  'claim', 'statement', 'assertion', 'finding', 'note', 'summary',
])

// Exported so the runner / tests can override (test fixtures may stub
// fetch via a custom ctx.fetch).
export function _internals() {
  return {
    FAKE_GREEN_PATTERNS,
    CITATION_FIELDS,
    CLAIM_FIELDS,
    ALLOWED_HOSTS,
  }
}

// ---------------------------------------------------------------------------
// Public entrypoint. Returns a structured result. Never throws on a normal
// fail. Throws ONLY on a programming error (e.g. ctx.fetch is provided but
// is not a function). Mirage outage = pass:false, not throw.
// ---------------------------------------------------------------------------
export async function evaluate(action, order, ctx = {}) {
  const started = nowMs()
  const reasons = []
  const evidence = []

  // --- Shape checks --------------------------------------------------------
  if (!action || typeof action !== 'object') {
    return fail(['action is missing or not an object'], evidence, started)
  }
  if (!order || typeof order !== 'object') {
    return fail(['order is missing or not an object'], evidence, started)
  }

  const root = normSlash(ctx.root || ORANGE5_ROOT)
  const mirageUrl = String(ctx.mirage_url || MIRAGE_DEFAULT_URL)
  const timeoutMs = Number.isFinite(ctx.mirage_timeout_ms)
    ? Math.max(1, ctx.mirage_timeout_ms | 0)
    : MIRAGE_TIMEOUT_MS

  // --- Network policy: loopback only --------------------------------------
  const urlVerdict = checkMirageUrl(mirageUrl)
  if (!urlVerdict.ok) {
    return fail(
      [`network_policy_violation: ${urlVerdict.why} (url=${mirageUrl})`],
      evidence,
      started,
    )
  }
  evidence.push({ check: 'mirage_url_loopback', ok: true, url: mirageUrl })

  // --- Collect claims, citations, quotes, receipt refs --------------------
  const collected = collectFromAction(action, root)
  evidence.push({
    check: 'collected',
    citations: collected.citations.length,
    quotes: collected.quotes.length,
    receipts: collected.receipts.length,
    claims: collected.claims.length,
  })

  // --- Fake-green scan on claim strings (pre-Mirage; cheap to fail fast) --
  for (const c of collected.claims) {
    const hit = findFakeGreen(c.value)
    if (hit) {
      reasons.push(
        `fake_green: ${c.field}="${truncate(c.value, 200)}" contains non-committal vocabulary "${hit}"`,
      )
    }
  }

  // --- Local receipt presence + hash (the cheap half of receipt check) ----
  // Gate 0 already verified topology + existence for receipt_path fields it
  // collected. We re-check here for two reasons: (a) HRE may see receipt
  // refs inside evidence entries that Gate 0's collector didn't recognise as
  // receipts (e.g. ones outside 10-RECEIPTS that the action falsely claims
  // as receipts), and (b) we compute the local SHA-256 to compare against
  // Mirage's recorded hash, so disagreement is detectable.
  const localReceiptHashes = new Map()  // abs -> { exists, sha256? }
  for (const r of collected.receipts) {
    const abs = absolveUnderRoot(r.value, root)
    if (!abs) {
      reasons.push(`receipt_unresolvable: ${r.field}="${r.value}" cannot be resolved under ROOT`)
      continue
    }
    if (!existsSync(abs)) {
      reasons.push(`receipt_nonexistent: ${r.field}="${r.value}" — no file at "${abs}"`)
      localReceiptHashes.set(abs, { exists: false })
      continue
    }
    try {
      const st = statSync(abs)
      if (!st.isFile()) {
        reasons.push(`receipt_not_a_file: ${r.field}="${r.value}"`)
        localReceiptHashes.set(abs, { exists: false })
        continue
      }
      const sha = sha256OfFile(abs)
      localReceiptHashes.set(abs, { exists: true, sha256: sha })
      evidence.push({
        check: 'receipt_local_hash',
        field: r.field,
        value: r.value,
        abs,
        sha256: sha,
      })
    } catch (e) {
      reasons.push(`receipt_stat_failed: ${r.field}="${r.value}" — ${String((e && e.message) || e)}`)
      localReceiptHashes.set(abs, { exists: false })
    }
  }

  // --- Build the Mirage ask ------------------------------------------------
  const ask = {
    receipts: [...localReceiptHashes.keys()].filter(k => localReceiptHashes.get(k).exists),
    citations: dedupeStrings(collected.citations.map(c => c.value)),
    quotes: dedupeQuotes(collected.quotes),
  }
  evidence.push({
    check: 'mirage_ask',
    receipts: ask.receipts.length,
    citations: ask.citations.length,
    quotes: ask.quotes.length,
  })

  // If there is literally nothing to verify and no local-only failures, the
  // gate passes. (A zero-evidence action is unusual but not in itself a HRE
  // failure — other gates speak to that. HRE only refuses unsupported
  // claims; the absence of claims is a Triad/Department concern.)
  const nothingToAsk = ask.receipts.length === 0 && ask.citations.length === 0 && ask.quotes.length === 0
  if (nothingToAsk && reasons.length === 0) {
    evidence.push({ check: 'no_external_claims', ok: true })
    return pass(evidence, started)
  }

  // --- Call Mirage ---------------------------------------------------------
  let brief = null
  if (!nothingToAsk) {
    const fetchImpl = pickFetch(ctx)
    if (typeof fetchImpl !== 'function') {
      return fail(
        ['mirage_unreachable: no fetch implementation available (Node 18+ required, or pass ctx.fetch)'],
        evidence,
        started,
      )
    }
    const requestId = (typeof randomUUID === 'function') ? randomUUID() : `gate4-${Date.now()}`
    const briefVerdict = await callMirage(fetchImpl, mirageUrl, timeoutMs, {
      ask,
      client: 'gate-4-hre',
      request_id: requestId,
    })
    if (!briefVerdict.ok) {
      reasons.push(`mirage_unreachable: ${briefVerdict.why}`)
      evidence.push({ check: 'mirage_call', ok: false, why: briefVerdict.why })
      // HRE fails closed on Mirage outage. Any other policy would let
      // unsupported claims through during an outage — which defeats the gate.
      return fail(reasons, evidence, started)
    }
    brief = briefVerdict.brief
    evidence.push({
      check: 'mirage_call',
      ok: true,
      as_of: brief && brief.as_of,
      version: brief && brief.version,
      request_id: requestId,
    })
  }

  // --- Cross-check Mirage's verdict against our local picture --------------
  if (brief) {
    // Receipts: every asked receipt must come back known:true and the hash
    // must match. Mirage saying "known: false" on a path we just hashed
    // means the receipt is not in the canonical ledger — refuse.
    const briefReceipts = (brief && brief.receipts) || {}
    for (const abs of ask.receipts) {
      const r = briefReceipts[abs]
      const local = localReceiptHashes.get(abs)
      if (!r || r.known !== true) {
        reasons.push(`receipt_unknown_to_mirage: "${abs}" is not in Mirage's receipt ledger`)
        continue
      }
      if (!r.exists) {
        // Local says yes; Mirage says no. Mirage is the canonical store.
        reasons.push(`receipt_orphan_in_mirage: "${abs}" exists locally but Mirage does not record it`)
        continue
      }
      if (r.sha256 && local && local.sha256 && r.sha256.toLowerCase() !== local.sha256.toLowerCase()) {
        reasons.push(
          `receipt_hash_mismatch: "${abs}" local=${local.sha256} mirage=${r.sha256}`,
        )
        continue
      }
      evidence.push({ check: 'receipt_confirmed', abs, sha256: r.sha256 || (local && local.sha256) })
    }

    // Citations: every asked citation must come back known:true.
    const briefCites = (brief && brief.citations) || {}
    for (const c of ask.citations) {
      const v = briefCites[c]
      if (!v || v.known !== true) {
        reasons.push(`citation_unsupported: "${truncate(c, 200)}" — Mirage cannot vouch for this source`)
        continue
      }
      evidence.push({ check: 'citation_confirmed', cite: c, anchor: v.anchor, kind: v.kind })
    }

    // Quotes: keyed by "<source>::<sha256(text)>". Mirage must say supported:true.
    const briefQuotes = (brief && brief.quotes) || {}
    for (const q of ask.quotes) {
      const key = quoteKey(q)
      const v = briefQuotes[key]
      if (!v || v.supported !== true) {
        const why = (v && v.reason) ? v.reason : 'no support recorded'
        reasons.push(
          `quote_unsupported: source="${truncate(q.source, 100)}" text="${truncate(q.text, 120)}" — ${why}`,
        )
        continue
      }
      evidence.push({ check: 'quote_confirmed', source: q.source, key })
    }
  }

  if (reasons.length === 0) return pass(evidence, started)
  return fail(reasons, evidence, started)
}

// ---------------------------------------------------------------------------
// Mirage transport
// ---------------------------------------------------------------------------

async function callMirage(fetchImpl, url, timeoutMs, body) {
  let controller
  let timer
  try {
    controller = new AbortController()
    timer = setTimeout(() => controller.abort(new Error(`timeout_${timeoutMs}ms`)), timeoutMs)
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!res || typeof res.status !== 'number') {
      return { ok: false, why: 'mirage returned a non-Response object' }
    }
    if (res.status < 200 || res.status >= 300) {
      return { ok: false, why: `mirage HTTP ${res.status}` }
    }
    let json
    try {
      json = await res.json()
    } catch (e) {
      return { ok: false, why: `mirage response was not JSON: ${String((e && e.message) || e)}` }
    }
    if (!json || typeof json !== 'object') {
      return { ok: false, why: 'mirage response was not an object' }
    }
    if (json.ok !== true) {
      return { ok: false, why: `mirage replied ok:false (${String(json.reason || 'no reason')})` }
    }
    return { ok: true, brief: json }
  } catch (e) {
    const msg = String((e && e.message) || e)
    if (msg.startsWith('timeout_') || /abort/i.test(msg)) {
      return { ok: false, why: `mirage timeout after ${timeoutMs}ms` }
    }
    return { ok: false, why: `mirage fetch failed: ${msg}` }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function pickFetch(ctx) {
  if (ctx && typeof ctx.fetch === 'function') return ctx.fetch
  if (typeof fetch === 'function') return fetch
  return null
}

function checkMirageUrl(url) {
  let u
  try {
    u = new URL(url)
  } catch (e) {
    return { ok: false, why: `invalid URL: ${String((e && e.message) || e)}` }
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, why: `unsupported protocol "${u.protocol}"` }
  }
  if (!ALLOWED_HOSTS.has(u.hostname)) {
    return { ok: false, why: `mirage host "${u.hostname}" is not loopback (allowed: 127.0.0.1, localhost)` }
  }
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Collection: walk action.evidence (and a few top-level fields) to harvest
// citations, quotes, receipt refs, and claim strings.
// ---------------------------------------------------------------------------

function collectFromAction(action, root) {
  const citations = []      // { field, value }
  const quotes = []         // { field, source, text }
  const receipts = []       // { field, value }
  const claims = []         // { field, value }

  // Top-level receipt fields (Gate 0 already topologically validated, but we
  // re-collect for hash comparison against Mirage).
  for (const k of ['receipt_path', 'prior_receipt']) {
    const v = action[k]
    if (typeof v === 'string' && v.length > 0) {
      receipts.push({ field: k, value: v })
    }
  }

  if (!Array.isArray(action.evidence)) {
    return { citations, quotes, receipts, claims }
  }

  for (let i = 0; i < action.evidence.length; i++) {
    const e = action.evidence[i]
    if (!e || typeof e !== 'object') continue
    const prefix = `evidence[${i}]`

    // citations
    for (const cf of CITATION_FIELDS) {
      const v = e[cf]
      if (typeof v === 'string' && v.trim().length > 0) {
        citations.push({ field: `${prefix}.${cf}`, value: v.trim() })
      } else if (Array.isArray(v)) {
        for (let j = 0; j < v.length; j++) {
          const s = v[j]
          if (typeof s === 'string' && s.trim().length > 0) {
            citations.push({ field: `${prefix}.${cf}[${j}]`, value: s.trim() })
          }
        }
      }
    }

    // quote (with required source attribution)
    if (typeof e.quote === 'string' && e.quote.trim().length > 0) {
      const src = pickQuoteSource(e)
      if (src) {
        quotes.push({ field: `${prefix}.quote`, source: src, text: e.quote.trim() })
      } else {
        // A quote without an attributable source is itself a HRE failure
        // category. We surface it as a "quote without source" claim so the
        // claim-scan step catches it.
        claims.push({ field: `${prefix}.quote`, value: `[unsourced quote] ${e.quote}` })
      }
    }

    // receipts inside an evidence entry
    if (typeof e.receipt_path === 'string' && e.receipt_path.length > 0) {
      receipts.push({ field: `${prefix}.receipt_path`, value: e.receipt_path })
    }

    // claim strings
    for (const cf of CLAIM_FIELDS) {
      const v = e[cf]
      if (typeof v === 'string' && v.trim().length > 0) {
        claims.push({ field: `${prefix}.${cf}`, value: v.trim() })
      }
    }
  }

  return { citations, quotes, receipts, claims }
}

function pickQuoteSource(e) {
  for (const k of ['source', 'cite', 'citation', 'url', 'doi', 'anchor', 'ref']) {
    const v = e[k]
    if (typeof v === 'string' && v.trim().length > 0) return v.trim()
  }
  return null
}

// ---------------------------------------------------------------------------
// Fake-green scanner
// ---------------------------------------------------------------------------

function findFakeGreen(text) {
  if (typeof text !== 'string') return null
  const lower = text.toLowerCase()
  for (const pat of FAKE_GREEN_PATTERNS) {
    if (lower.includes(pat)) return pat
  }
  return null
}

// ---------------------------------------------------------------------------
// Path / hash helpers (mirrors Gate 0's discipline without importing it)
// ---------------------------------------------------------------------------

function absolveUnderRoot(value, root) {
  if (typeof value !== 'string' || value.length === 0) return null
  if (value.includes('..')) return null
  try {
    let abs
    if (/^[A-Za-z]:[\\/]/.test(value)) {
      abs = normalize(value).replace(/\\/g, '/')
    } else if (value.startsWith('/')) {
      return null
    } else {
      abs = normalize(resolve(root, value)).replace(/\\/g, '/')
    }
    const a = abs.toLowerCase()
    if (!a.startsWith(root.toLowerCase())) return null
    return abs
  } catch {
    return null
  }
}

function sha256OfFile(abs) {
  const buf = readFileSync(abs)
  return createHash('sha256').update(buf).digest('hex')
}

function quoteKey(q) {
  const h = createHash('sha256').update(String(q.text || ''), 'utf8').digest('hex')
  return `${q.source}::${h}`
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function dedupeStrings(arr) {
  const seen = new Set()
  const out = []
  for (const s of arr) {
    if (typeof s !== 'string') continue
    if (seen.has(s)) continue
    seen.add(s)
    out.push(s)
  }
  return out
}

function dedupeQuotes(arr) {
  const seen = new Set()
  const out = []
  for (const q of arr) {
    if (!q || typeof q !== 'object') continue
    const k = quoteKey(q)
    if (seen.has(k)) continue
    seen.add(k)
    out.push(q)
  }
  return out
}

function truncate(s, n) {
  const str = String(s == null ? '' : s)
  if (str.length <= n) return str
  return str.slice(0, n - 1) + '…'
}

function normSlash(p) {
  return String(p).replace(/\\/g, '/').replace(/\/+$/, '')
}

function nowMs() {
  return (typeof performance !== 'undefined' && performance.now)
    ? performance.now()
    : Date.now()
}

function pass(evidence, started) {
  return {
    gate: GATE_ID,
    gate_id: GATE_ID,
    name: GATE_NAME,
    position: POSITION_IN_STACK,
    bypassable: BYPASSABLE,
    pass: true,
    reason: 'ok',
    reasons: [],
    evidence,
    took_ms: Math.max(0, Math.round((nowMs() - started) * 1000) / 1000),
  }
}

function fail(reasons, evidence, started) {
  return {
    gate: GATE_ID,
    gate_id: GATE_ID,
    name: GATE_NAME,
    position: POSITION_IN_STACK,
    bypassable: BYPASSABLE,
    pass: false,
    reason: reasons[0] || 'hre_refused',
    reasons,
    evidence,
    took_ms: Math.max(0, Math.round((nowMs() - started) * 1000) / 1000),
  }
}

// Default export: the evaluator + metadata, matching the runner's expected shape.
export default {
  id: GATE_ID,
  name: GATE_NAME,
  position: POSITION_IN_STACK,
  bypassable: BYPASSABLE,
  target_ms: TARGET_MS,
  evaluate,
  _internals,
}
