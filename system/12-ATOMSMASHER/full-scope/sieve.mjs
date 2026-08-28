// AtomSmasher Full-Scope — sieve.mjs
//
// Pillar 5, AtomSmasher 2 — the in-line compression pass that runs on EVERY
// orange.order.v1 / orange.report.v1 before it crosses the boundary. This is
// the AE Cobra sieve on the river of data described in the Master Plan §9 and
// the Operational Theory §8 (steps 1-2, 11-12): every order/report gets a
// compression pass before dispatch / before it leaves the boundary.
//
// Scope of THIS file (and only this file):
//   - export sieveOrder(order)   -> { ok, crossing, frame, debt, warnings }
//   - export sieveReport(report) -> { ok, crossing, frame, debt, warnings }
//   - export sievePair(order, report) -> both, plus a pathwave-shape summary
//   - export the debt-receipt builder + reversible codec as __internals
//
// It ADDS the missing dispatcher-path gate. It does NOT modify engines.mjs,
// storage.mjs, or any existing green test file. It imports the LIVE pure
// sibling primitives (sparse-workset trim, least-action route) and the LIVE
// utils (sha256Text) — it never edits them.
//
// -------------------------------------------------------------------------
// HONESTY DOCTRINE (Operational Theory §6.2, §15, Mom's Law)
// -------------------------------------------------------------------------
//   - AIR / sparse-workset / anti-fluff produce a STRUCTURAL VIEW (a frame).
//     Structural compression is NOT gzip. For short dense JSON the frame can
//     be LARGER than the input. That is not a bug; it is accounted for as
//     compression debt with a regression_flag. We never inflate a ratio.
//   - The CROSSING payload — the bytes that actually leave the boundary and
//     must be reconstructable — goes through a genuinely REVERSIBLE codec
//     (DEFLATE via Bun's native zlib). lossless:true is asserted ONLY after a
//     sha256 roundtrip proves decode(encode(x)) === x byte-for-byte. If the
//     roundtrip ever fails, or the compressed form is not smaller than raw,
//     the sieve ships IDENTITY (raw passthrough) and says so — it never ships
//     a payload it cannot rebuild, and never ships bytes bigger than raw.
//   - Every number in the debt receipt is a measured byte count, not an
//     estimate. compressed_bytes is the true binary deflate length (the wire
//     cost); base64 transport inflation is reported separately, never hidden.
//
// No external deps. node:crypto + Bun native zlib (node:zlib fallback), plus
// live in-repo pure modules.

import crypto from 'node:crypto';

import { sha256Text } from './utils.mjs';
// LIVE pure sibling primitives (no Store, no SQLite, deterministic).
import { compressWorkset } from '../sparse-worksets/compressor.mjs';
import { route as leastActionRoute } from '../least-action/router.mjs';

// ===========================================================================
// Constants
// ===========================================================================

export const SIEVE_SCHEMA_ID = 'orange5.atomsmasher.sieve.v1';
export const DEBT_SCHEMA_ID = 'orange5.atomsmasher.compression_debt.v1';

const SHA256_RE = /^[0-9a-f]{64}$/;

// Anti-fluff surface — mirrored from the live AtomSmasher modules
// (engagements AIR strip + retired pathwave anti-fluff) so the sieve's
// fluff verdict is consistent with the rest of Pillar 5. Kept local so the
// sieve has zero write-side dependency.
const FLUFF_ONLY_PATTERNS = Object.freeze([
  /^\s*(do the thing|handle it|figure it out|make it work|fix everything)\s*\.?\s*$/i,
  /^\s*(tbd|todo|wip|n\/a|na)\s*\.?\s*$/i,
  /^\s*\.{0,3}\s*$/,
]);

// Filler phrases stripped from prose during the AIR structural pass. These are
// conversational sludge that carry no load-bearing meaning for a machine
// consumer. Removal here only affects the (lossy) frame, never the crossing.
const FLUFF_PHRASES = Object.freeze([
  'basically', 'essentially', 'just to be clear', 'as you know',
  'it should be noted that', 'needless to say', 'at the end of the day',
  'in order to', 'the fact that', 'kind of', 'sort of', 'really',
]);

// Fake-green / theatrical-certainty tokens. Presence in a report status or
// prose is surfaced as an anti-fluff warning (§6.12: "No 'probably green'").
const FAKE_GREEN = Object.freeze([
  'probably', 'should work', 'looks ok', 'looks good', 'green_assumed',
  'seems fine', 'i think it works', 'more or less',
]);

// AIR atom-type prefixes — same scheme as CommitmentCodec.atomToAir in
// engines.mjs (L/D/V/T/F/E/P/A). Local copy so no Store is needed.
const AIR_PREFIX = Object.freeze({
  law: 'L', decision: 'D', void: 'V', task: 'T',
  fact: 'F', equation: 'E', preference: 'P', other: 'A',
});

// The prose-bearing fields of each envelope. Only these feed the structural
// (AIR / fluff / workset) passes. Everything else in the object is still
// carried byte-exact by the reversible crossing codec.
const ORDER_TEXT_FIELDS = Object.freeze(['intent', 'scope', 'targetProject']);
const REPORT_TEXT_FIELDS = Object.freeze(['status', 'nextAction']);

// Risk level -> numeric hint for the least-action router (0..10).
const RISK_NUM = Object.freeze({
  read_only: 0, low: 2, medium: 4, high: 7, destructive: 9, production: 9,
});

// ===========================================================================
// Canonical helpers (byte-level)
// ===========================================================================

function sha256(s) {
  return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
}

// utf8 byte length — the honest wire measure, NOT string .length (which
// counts UTF-16 code units and would misreport any non-ASCII payload).
function byteLen(s) {
  return Buffer.byteLength(String(s), 'utf8');
}

// ===========================================================================
// Reversible crossing codec  (the LOSSLESS lane)
// ===========================================================================
//
// The crossing must be genuinely reversible AND actually smaller to be worth
// shipping. Naive dictionary/substring packing does NOT win on a single
// envelope because canonical orange.* JSON keys appear only once, so a
// dictionary header costs more than it saves — the exact §6.2 lesson
// ("structural compression is not gzip; for short dense inputs the envelope
// can be larger"). So the reversible backend here is DEFLATE via Bun's native
// zlib bindings (Bun.deflateSync / Bun.inflateSync): byte-exact, reversible,
// and a real win on real envelopes (~1.6-1.7x measured on canonical orders).
//
// This is Method-19-class reuse — a standard lossless codec, no new research.
// The honest byte accounting is the BINARY deflate length (what a boundary
// would actually ship on the wire). A JSON-string transport of that binary
// needs base64, which inflates ~33%; that transport cost is reported
// separately and never conflated with the true compressed size.
//
// The frame the caller ships is a compact JSON line:
//   {"v":1,"z":"<base64 of deflate(raw)>"}

const __enc = new TextEncoder();
const __dec = new TextDecoder('utf-8', { fatal: false });

function deflateBytes(u8) {
  if (typeof Bun !== 'undefined' && typeof Bun.deflateSync === 'function') {
    return Bun.deflateSync(u8);
  }
  // Fallback for non-Bun runtimes so the module stays importable elsewhere.
  // node:zlib deflateSync is byte-compatible with Bun's.
  const zlib = require('node:zlib');
  return new Uint8Array(zlib.deflateSync(Buffer.from(u8)));
}

function inflateBytes(u8) {
  if (typeof Bun !== 'undefined' && typeof Bun.inflateSync === 'function') {
    return Bun.inflateSync(u8);
  }
  const zlib = require('node:zlib');
  return new Uint8Array(zlib.inflateSync(Buffer.from(u8)));
}

function toB64(u8) {
  return Buffer.from(u8).toString('base64');
}
function fromB64(s) {
  return new Uint8Array(Buffer.from(s, 'base64'));
}

/**
 * Encode a raw string into the reversible (deflate) crossing frame.
 * @param {string} raw
 * @returns {{ frame: string, binary_bytes: number }}
 *   frame        JSON-string transport of the deflated payload (base64 body)
 *   binary_bytes true wire size of the compressed payload (deflate bytes)
 */
function crossEncode(raw) {
  const u8 = __enc.encode(String(raw));
  const z = deflateBytes(u8);
  const frame = JSON.stringify({ v: 1, z: toB64(z) });
  return { frame, binary_bytes: z.length };
}

/**
 * Decode a crossing frame back to the exact original string.
 * @param {string} frame
 * @returns {string}
 */
function crossDecode(frame) {
  const obj = JSON.parse(frame);
  if (!obj || obj.v !== 1 || typeof obj.z !== 'string') {
    throw new Error('sieve.crossDecode: malformed frame');
  }
  const z = fromB64(obj.z);
  const u8 = inflateBytes(z);
  return __dec.decode(u8);
}

// ===========================================================================
// Anti-fluff gate  (LIVE verdict, pure)
// ===========================================================================

/**
 * Classify a whole-string as fluff-only / fake-green / clean.
 * @param {string} text
 * @returns {{ verdict:'pass'|'warn'|'reject', reasons:string[] }}
 */
function antiFluff(text) {
  const reasons = [];
  if (typeof text !== 'string' || text.trim().length === 0) {
    return { verdict: 'reject', reasons: ['empty'] };
  }
  const lower = text.toLowerCase().trim();
  for (const pat of FLUFF_ONLY_PATTERNS) {
    if (pat.test(text)) return { verdict: 'reject', reasons: ['fluff_only'] };
  }
  for (const g of FAKE_GREEN) {
    if (lower.includes(g)) reasons.push(`fake_green:${g}`);
  }
  return { verdict: reasons.length ? 'warn' : 'pass', reasons };
}

/**
 * Strip filler phrases from prose for the AIR frame (lossy, view-only).
 * Collapses resulting double spaces. Never touches the crossing payload.
 * @param {string} text
 * @returns {{ stripped:string, dropped_chars:number }}
 */
function stripFluff(text) {
  const original = String(text);
  let out = original;
  for (const phrase of FLUFF_PHRASES) {
    // word-boundary, case-insensitive, global
    const re = new RegExp(`\\b${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
    out = out.replace(re, ' ');
  }
  out = out.replace(/\s{2,}/g, ' ').trim();
  return { stripped: out, dropped_chars: Math.max(0, original.length - out.length) };
}

// ===========================================================================
// AIR structural encode  (pure, view-only)
// ===========================================================================
//
// Turns the prose fields of an envelope into typed AIR lines, mirroring the
// CommitmentCodec.atomToAir prefix scheme from engines.mjs. This is a lossy
// structural view: it drops filler and keeps the load-bearing claim per
// field. It is NOT the reconstruction source.

function classifyField(fieldName) {
  switch (fieldName) {
    case 'intent': return 'task';
    case 'scope': return 'decision';
    case 'targetProject': return 'fact';
    case 'status': return 'fact';
    case 'nextAction': return 'task';
    default: return 'other';
  }
}

/**
 * @param {Object} env      the envelope (order or report)
 * @param {readonly string[]} textFields
 * @returns {{ air:string[], input_chars:number, output_chars:number,
 *             dropped_chars:number, fluff:{verdict:string,reasons:string[]} }}
 */
function airEncode(env, textFields) {
  const lines = [];
  let inputChars = 0;
  let droppedChars = 0;
  const fluffReasons = [];
  let worstVerdict = 'pass';

  for (const f of textFields) {
    const v = env == null ? undefined : env[f];
    if (typeof v !== 'string' || v.length === 0) continue;
    inputChars += v.length;

    const ff = antiFluff(v);
    if (ff.verdict === 'reject') worstVerdict = 'reject';
    else if (ff.verdict === 'warn' && worstVerdict === 'pass') worstVerdict = 'warn';
    for (const r of ff.reasons) fluffReasons.push(`${f}:${r}`);

    const { stripped, dropped_chars } = stripFluff(v);
    droppedChars += dropped_chars;
    const type = classifyField(f);
    const prefix = AIR_PREFIX[type] || AIR_PREFIX.other;
    lines.push(`${prefix}: ${stripped}`);
  }

  const outputChars = lines.reduce((a, l) => a + l.length, 0);
  return {
    air: lines,
    input_chars: inputChars,
    output_chars: outputChars,
    dropped_chars: droppedChars,
    fluff: { verdict: worstVerdict, reasons: fluffReasons },
  };
}

// ===========================================================================
// Sparse-workset trim  (LIVE pure sibling, guarded)
// ===========================================================================
//
// Feeds the envelope's action/prose items into the live compressWorkset()
// pure compressor to get an honest workset compression ratio + drop reasons.
// Guarded: if the sibling throws on a shape it dislikes, the sieve records the
// skip rather than crashing the boundary.

function worksetTrim(task, contextItems) {
  try {
    const ws = compressWorkset(
      { task: task && task.length ? task : 'sieve-order', context: contextItems },
      {},
    );
    return {
      ok: true,
      workset_id: ws.workset_id,
      kept: Array.isArray(ws.working_set) ? ws.working_set.length : 0,
      dropped: Array.isArray(ws.dropped) ? ws.dropped.length : 0,
      ratio: typeof ws.compression_ratio === 'number' ? ws.compression_ratio : null,
      warnings: Array.isArray(ws.warnings) ? ws.warnings : [],
    };
  } catch (e) {
    return { ok: false, skipped: true, reason: String(e && e.message || e) };
  }
}

// ===========================================================================
// Least-action route hint  (LIVE pure sibling, guarded)
// ===========================================================================

function routeHint(order) {
  try {
    const complexity = Math.min(
      10,
      Math.max(1, Math.ceil(((order && order.intent) || '').length / 40)),
    );
    const risk = RISK_NUM[order && order.riskLevel] ?? 4;
    const decision = leastActionRoute({
      intent_complexity: complexity,
      risk_level: risk,
      latency_budget_ms: 2000,
      capabilities: Array.isArray(order && order.allowedActions) ? order.allowedActions : [],
    });
    return {
      ok: !decision.error,
      chosen_tier: decision.chosen_tier ?? null,
      decision_id: decision.decision_id ?? null,
    };
  } catch (e) {
    return { ok: false, skipped: true, reason: String(e && e.message || e) };
  }
}

// ===========================================================================
// Compression-debt receipt builder
// ===========================================================================
//
// The canonical output of the sieve. Aligned with Operational Theory §6.8
// (Compression Debt Ledger): verbose_char_count, compressed, savings,
// regression_flag. The task-required core keys are always present:
//   { raw_bytes, compressed_bytes, ratio, modules_applied, lossless }
//
// ratio is defined as raw_bytes / compressed_bytes (>1 means the crossing got
// smaller). compressed_bytes is the TRUE binary deflate length. When the
// compressed form is not smaller than raw (pathological / already-dense
// input) the sieve ships identity, sets regression_flag, and reports
// compressed_bytes == raw_bytes so ratio == 1 — honest debt, never a hidden
// loss and never a payload bigger than raw.

function buildDebt({
  kind, rawBytes, binaryBytes, transportBytes, crossSha, rawSha, lossless,
  smaller, modulesApplied, extra,
}) {
  const shippedBytes = smaller ? binaryBytes : rawBytes;
  const shippedForm = smaller ? 'deflate' : 'identity';
  const ratio = shippedBytes === 0 ? 1 : Number((rawBytes / shippedBytes).toFixed(6));

  return {
    schema: DEBT_SCHEMA_ID,
    kind,                                  // 'order' | 'report'
    // --- task-required core keys ---
    raw_bytes: rawBytes,
    compressed_bytes: shippedBytes,        // true binary wire size of shipped form
    ratio,
    modules_applied: modulesApplied,
    lossless,
    // --- honest debt-ledger extras (Operational Theory §6.8) ---
    shipped_form: shippedForm,             // 'deflate' | 'identity'
    deflate_bytes: binaryBytes,            // binary deflate size regardless of ship choice
    transport_base64_bytes: transportBytes, // JSON-string transport cost (base64 inflates ~33%)
    savings_bytes: rawBytes - shippedBytes,
    regression_flag: !smaller,             // true => compressed form did not shrink raw
    verbose_char_count: rawBytes,
    sha256_raw: rawSha,
    sha256_crossing: crossSha,             // sha of the reversible frame transport
    roundtrip_ok: lossless,                // decode(encode(raw)) === raw proven
    created_at: new Date().toISOString(),
    ...(extra ? { structural: extra } : {}),
  };
}

// ===========================================================================
// Core: run the full sieve on one envelope
// ===========================================================================

function sieveEnvelope(env, { kind, textFields, contextBuilder, routeBuilder }) {
  const warnings = [];

  // ---- 0. Shape guard (soft) -------------------------------------------
  if (env == null || typeof env !== 'object' || Array.isArray(env)) {
    throw new Error(`sieve: ${kind} must be a non-null object`);
  }
  const expectedSchema = kind === 'order' ? 'orange.order.v1' : 'orange.report.v1';
  if (env.schema !== expectedSchema) {
    warnings.push(`schema_mismatch: expected '${expectedSchema}', got ${JSON.stringify(env.schema)}`);
  }

  // ---- 1. LOSSLESS crossing (reversible deflate + sha256 roundtrip) -----
  // The raw payload is the EXACT JSON string of the envelope. That is the
  // thing that must reconstruct byte-for-byte.
  const raw = JSON.stringify(env);
  const rawBytes = byteLen(raw);
  const rawSha = sha256Text(raw);

  const { frame, binary_bytes: binaryBytes } = crossEncode(raw);
  const transportBytes = byteLen(frame);
  const crossSha = sha256Text(frame);

  // Prove losslessness. Decode the frame and compare byte-for-byte via sha256.
  let lossless = false;
  try {
    const decoded = crossDecode(frame);
    lossless = sha256Text(decoded) === rawSha && decoded === raw;
  } catch (e) {
    warnings.push(`crossing_decode_failed: ${String(e && e.message || e)}`);
    lossless = false;
  }
  if (!lossless) {
    warnings.push('crossing_not_lossless: degrading to identity passthrough');
  }

  // Ship the deflated frame only if it is BOTH lossless AND smaller than raw.
  const smaller = lossless && binaryBytes < rawBytes;

  // ---- 2. STRUCTURAL passes (lossy view; modules_applied) ---------------
  const modulesApplied = [];

  // AIR encode + anti-fluff (both pure, view-only).
  const air = airEncode(env, textFields);
  modulesApplied.push('air_encode');
  modulesApplied.push('anti_fluff_gate');
  if (air.fluff.verdict === 'reject') {
    warnings.push(`anti_fluff_reject: ${air.fluff.reasons.join(',')}`);
  } else if (air.fluff.verdict === 'warn') {
    warnings.push(`anti_fluff_warn: ${air.fluff.reasons.join(',')}`);
  }

  // Sparse-workset trim (live pure sibling).
  const ctx = contextBuilder(env);
  const task = kind === 'order'
    ? (env.intent || env.orderId || 'order')
    : (env.status || env.orderId || 'report');
  const ws = worksetTrim(task, ctx);
  modulesApplied.push('sparse_workset_trim');
  if (!ws.ok) warnings.push(`sparse_workset_skipped: ${ws.reason}`);
  for (const w of ws.warnings || []) warnings.push(`workset:${w}`);

  // Least-action route hint (order only; reports don't route).
  let route = null;
  if (routeBuilder) {
    route = routeBuilder(env);
    modulesApplied.push('least_action_route');
    if (!route.ok && route.skipped) warnings.push(`route_skipped: ${route.reason}`);
  }

  // Pathwave-shape tag: the sieve marks this envelope's identity so a
  // downstream pathwave compressor can anchor the step without re-hashing.
  modulesApplied.push('pathwave_anchor');
  const pathwaveAnchor = kind === 'order'
    ? { order_id: env.orderId ?? null, intent_hash: env.intent ? sha256(env.intent) : null }
    : { order_id: env.orderId ?? null, status: (env.status || '').toLowerCase() || null,
        evidence_count: Array.isArray(env.evidence) ? env.evidence.length : 0 };

  const frameView = {
    air: air.air,
    air_chars_in: air.input_chars,
    air_chars_out: air.output_chars,
    air_dropped_chars: air.dropped_chars,
    fluff_verdict: air.fluff.verdict,
    workset: ws,
    route,
    pathwave_anchor: pathwaveAnchor,
  };

  // ---- 3. Debt receipt --------------------------------------------------
  const debt = buildDebt({
    kind,
    rawBytes,
    binaryBytes,
    transportBytes,
    crossSha,
    rawSha,
    lossless,
    smaller,
    modulesApplied,
    extra: {
      air_ratio: air.input_chars === 0 ? null
        : Number((air.input_chars / Math.max(1, air.output_chars)).toFixed(6)),
      air_dropped_chars: air.dropped_chars,
      workset_ratio: ws.ratio,
      fluff_verdict: air.fluff.verdict,
    },
  });

  return {
    schema: SIEVE_SCHEMA_ID,
    ok: air.fluff.verdict !== 'reject',
    kind,
    crossing: {
      form: smaller ? 'deflate' : 'identity',
      payload: smaller ? frame : raw,        // reversible frame, or raw JSON
      raw_sha256: rawSha,
      lossless,
      // reconstruct: 'sieve.crossDecode' for a frame, 'identity' for raw.
      decode: smaller ? 'sieve.crossDecode' : 'identity',
    },
    frame: frameView,
    debt,
    warnings,
  };
}

// ===========================================================================
// Public API
// ===========================================================================

/**
 * Run the compression sieve on an orange.order.v1 before it crosses the
 * dispatch boundary.
 * @param {Object} order  orange.order.v1
 * @returns {Object} { schema, ok, kind:'order', crossing, frame, debt, warnings }
 */
export function sieveOrder(order) {
  return sieveEnvelope(order, {
    kind: 'order',
    textFields: ORDER_TEXT_FIELDS,
    contextBuilder: (o) => {
      const items = [];
      if (typeof o.intent === 'string') items.push({ id: 'intent', content: o.intent, pinned: true });
      if (typeof o.scope === 'string') items.push({ id: 'scope', content: o.scope });
      for (const a of (Array.isArray(o.allowedActions) ? o.allowedActions : [])) {
        if (typeof a === 'string' && a.length) items.push({ id: `allow:${a}`, content: a });
      }
      for (const a of (Array.isArray(o.forbiddenActions) ? o.forbiddenActions : [])) {
        if (typeof a === 'string' && a.length) items.push({ id: `forbid:${a}`, content: a });
      }
      return items;
    },
    routeBuilder: routeHint,
  });
}

/**
 * Run the compression sieve on an orange.report.v1 before it crosses the
 * boundary (return-to-caller / receipt write).
 * @param {Object} report  orange.report.v1
 * @returns {Object} { schema, ok, kind:'report', crossing, frame, debt, warnings }
 */
export function sieveReport(report) {
  return sieveEnvelope(report, {
    kind: 'report',
    textFields: REPORT_TEXT_FIELDS,
    contextBuilder: (r) => {
      const items = [];
      if (typeof r.status === 'string') items.push({ id: 'status', content: r.status, pinned: true });
      if (typeof r.nextAction === 'string') items.push({ id: 'nextAction', content: r.nextAction });
      for (const a of (Array.isArray(r.actionsTaken) ? r.actionsTaken : [])) {
        if (typeof a === 'string' && a.length) items.push({ id: `action:${a}`, content: a });
      }
      for (const b of (Array.isArray(r.blockers) ? r.blockers : [])) {
        if (typeof b === 'string' && b.length) items.push({ id: `blocker:${b}`, content: b });
      }
      return items;
    },
    routeBuilder: null, // reports don't route
  });
}

/**
 * Sieve an order and its resulting report together, returning both crossings
 * plus a combined pathwave-shape summary (order -> report step).
 * @param {Object} order
 * @param {Object} report
 * @returns {Object}
 */
export function sievePair(order, report) {
  const o = sieveOrder(order);
  const r = sieveReport(report);
  const totalRaw = o.debt.raw_bytes + r.debt.raw_bytes;
  const totalShipped = o.debt.compressed_bytes + r.debt.compressed_bytes;
  return {
    schema: SIEVE_SCHEMA_ID,
    order: o,
    report: r,
    pair: {
      order_id: (order && order.orderId) ?? null,
      both_lossless: o.crossing.lossless && r.crossing.lossless,
      total_raw_bytes: totalRaw,
      total_shipped_bytes: totalShipped,
      total_ratio: totalShipped === 0 ? 1 : Number((totalRaw / totalShipped).toFixed(6)),
      modules_applied: Array.from(new Set([...o.debt.modules_applied, ...r.debt.modules_applied])),
    },
  };
}

// ===========================================================================
// Internals (test-only)
// ===========================================================================

export const __internals = Object.freeze({
  crossEncode,
  crossDecode,
  deflateBytes,
  inflateBytes,
  antiFluff,
  stripFluff,
  airEncode,
  worksetTrim,
  routeHint,
  buildDebt,
  byteLen,
  sha256,
  SIEVE_SCHEMA_ID,
  DEBT_SCHEMA_ID,
  SHA256_RE,
  ORDER_TEXT_FIELDS,
  REPORT_TEXT_FIELDS,
});
