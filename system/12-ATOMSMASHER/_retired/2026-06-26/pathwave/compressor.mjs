// pathwave/compressor.mjs
//
// AtomSmasher module #10 — Pathwave Compressor.
//
// Purpose:
//   Compress an execution trajectory (a sequence of
//   orange.order.v1 -> action -> orange.report.v1 -> receipt tuples)
//   into a Pathwave — the canonical, deterministic, content-addressed
//   shape needed to REPLAY a run, DIFF two runs, or COMPARE alternative
//   paths through the same task.
//
// Doctrine:
//   - A Pathwave preserves order, intent, action, outcome, confidence,
//     evidence identity, and receipt anchor for every step. It DROPS
//     verbose prose, log streams, runtime nonces, and anything that
//     varies run-to-run without changing meaning.
//   - Compression is deterministic given identical inputs. Same
//     trajectory => same pathwave_id, byte-for-byte. The id payload
//     excludes timestamps and warnings; only the meaning-bearing fields
//     participate.
//   - Honest gaps are first-class. A step missing a receipt when the
//     order required one is NOT silently filled — it surfaces as a
//     warning ('missing_receipt: step[<n>]') and the step's receipt_id
//     remains null. Mom's Law: no theater.
//   - The compressor refuses to reorder steps. If the caller hands in
//     steps out of execution order, that's the caller's bug; we don't
//     guess.
//   - Anti-fluff (LIVE): a task that is empty or fluff-only is hard-
//     rejected. The task is the meaning anchor of the trajectory.
//   - No external deps. Pure node:crypto. The compressor never writes
//     to disk, never opens a network, never calls a model. Sibling
//     modules (PENDING) will handle Flux persistence, SQLite index,
//     and gateway routes.
//
// What this file does NOT do:
//   - Persist to Flux or SQLite (sibling persist.mjs / store.mjs).
//   - Expose a gateway route (sibling
//     06-ORANGELLM/server/routes/atomsmasher-pathwave.mjs).
//   - Re-execute or simulate a run (replay belongs to a separate runner).
//
// Exports:
//   compressPathwave({ task, steps })           -> Pathwave object
//   validatePathwave(pathwave)                  -> { valid, errors }
//   diffPathwaves(a, b)                         -> { equal, divergence_index, reasons }
//   __internals                                 -> test-only helpers + constants

import crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const PATHWAVE_SCHEMA_ID = 'orange5.atomsmasher.pathwave.v0';

const SHA256_RE = /^[0-9a-f]{64}$/;

// Fluff-only patterns mirrored from sibling modules so the anti-fluff
// surface is consistent across AtomSmasher.
const FLUFF_ONLY_PATTERNS = Object.freeze([
  /^\s*(do the thing|handle it|figure it out|make it work|fix everything)\s*\.?\s*$/i,
  /^\s*(tbd|todo|wip|n\/a|na)\s*\.?\s*$/i,
  /^\s*\.{0,3}\s*$/,
]);

const FORBIDDEN_WORDS = Object.freeze([
  'green_assumed',
  'looks_ok',
  'probably',
  'should_work',
]);

const VALID_RISK_LEVELS = Object.freeze([
  'read_only', 'low', 'medium', 'high', 'destructive', 'production',
]);

// Hard cap to prevent a runaway trajectory from being silently accepted.
// 10k steps is well beyond any honest AtomEons mission; if a real workload
// ever exceeds this, raise the cap deliberately rather than in a hot fix.
const MAX_STEPS = 10000;

// ---------------------------------------------------------------------------
// Canonical JSON + sha256 — same convention as Commitment Atoms / Sparse
// Worksets / AIR Codec so verifier shape is uniform across AtomSmasher.
// ---------------------------------------------------------------------------

function canonicalStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalStringify).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  const parts = keys.map(
    (k) => JSON.stringify(k) + ':' + canonicalStringify(value[k]),
  );
  return '{' + parts.join(',') + '}';
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

// ---------------------------------------------------------------------------
// Anti-fluff helpers
// ---------------------------------------------------------------------------

function fluffReason(text) {
  if (typeof text !== 'string' || text.trim().length === 0) return 'empty';
  const lower = text.toLowerCase().trim();
  for (const word of FORBIDDEN_WORDS) {
    if (lower === word) return 'forbidden_only';
  }
  for (const pat of FLUFF_ONLY_PATTERNS) {
    if (pat.test(text)) return 'fluff_only';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Input shape validation — orange.order.v1, orange.report.v1, receipt
// ---------------------------------------------------------------------------

function isNonEmptyString(v, max = Infinity) {
  return typeof v === 'string' && v.length >= 1 && v.length <= max;
}

function validateOrder(order, idx) {
  if (order == null || typeof order !== 'object' || Array.isArray(order)) {
    return `steps[${idx}].order must be an object`;
  }
  if (order.schema !== 'orange.order.v1') {
    return `steps[${idx}].order.schema must be 'orange.order.v1', got ${JSON.stringify(order.schema)}`;
  }
  if (!isNonEmptyString(order.orderId) || order.orderId.length < 3) {
    return `steps[${idx}].order.orderId must be a string >= 3 chars`;
  }
  if (!isNonEmptyString(order.intent)) {
    return `steps[${idx}].order.intent must be a non-empty string`;
  }
  if (!Array.isArray(order.allowedActions)) {
    return `steps[${idx}].order.allowedActions must be an array`;
  }
  if (order.requiresReceipt !== true && order.requiresReceipt !== false) {
    return `steps[${idx}].order.requiresReceipt must be boolean`;
  }
  if (order.riskLevel != null && !VALID_RISK_LEVELS.includes(order.riskLevel)) {
    return `steps[${idx}].order.riskLevel '${order.riskLevel}' invalid`;
  }
  return null;
}

function validateReport(report, idx, orderId) {
  if (report == null || typeof report !== 'object' || Array.isArray(report)) {
    return `steps[${idx}].report must be an object`;
  }
  if (report.schema !== 'orange.report.v1') {
    return `steps[${idx}].report.schema must be 'orange.report.v1', got ${JSON.stringify(report.schema)}`;
  }
  if (report.orderId !== orderId) {
    return `steps[${idx}].report.orderId '${report.orderId}' != order.orderId '${orderId}'`;
  }
  if (!isNonEmptyString(report.status, 64) || report.status.length < 2) {
    return `steps[${idx}].report.status must be a 2..64 char string`;
  }
  if (
    typeof report.confidence !== 'number' ||
    report.confidence < 0 ||
    report.confidence > 1 ||
    Number.isNaN(report.confidence)
  ) {
    return `steps[${idx}].report.confidence must be a number in [0,1]`;
  }
  if (!Array.isArray(report.evidence)) {
    return `steps[${idx}].report.evidence must be an array`;
  }
  for (let i = 0; i < report.evidence.length; i++) {
    const ev = report.evidence[i];
    if (ev == null || typeof ev !== 'object' || Array.isArray(ev)) {
      return `steps[${idx}].report.evidence[${i}] must be an object`;
    }
  }
  if (!isNonEmptyString(report.receiptPath)) {
    return `steps[${idx}].report.receiptPath must be a non-empty string`;
  }
  return null;
}

function validateReceipt(receipt, idx) {
  // receipt is optional on the input; when supplied it must be well-shaped.
  if (receipt == null) return null;
  if (typeof receipt !== 'object' || Array.isArray(receipt)) {
    return `steps[${idx}].receipt must be an object or null`;
  }
  if (receipt.schema !== 'orange5.receipt.v0') {
    return `steps[${idx}].receipt.schema must be 'orange5.receipt.v0', got ${JSON.stringify(receipt.schema)}`;
  }
  if (!isNonEmptyString(receipt.receipt_id)) {
    return `steps[${idx}].receipt.receipt_id must be a non-empty string`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Step compression
// ---------------------------------------------------------------------------

/**
 * Compress a single (order, report, receipt?) tuple to its Pathwave step
 * form. Returns { step, warnings, input_bytes }.
 *
 * @param {Object} raw
 * @param {number} idx
 */
function compressStep(raw, idx) {
  const warnings = [];

  // The raw input shape:
  //   { order: orange.order.v1, report: orange.report.v1, receipt?: receipt.v0,
  //     action?: string  // optional explicit action label override }
  const { order, report, receipt, action: actionOverride } = raw;

  // intent_hash is sha256 of the raw intent text. Stable, never reorders.
  const intent_hash = sha256(order.intent);

  // action: prefer explicit override; else fall back to order.allowedActions[0];
  // else mark as 'unspecified' and warn.
  let action;
  if (typeof actionOverride === 'string' && actionOverride.length > 0) {
    action = actionOverride.slice(0, 200);
  } else if (Array.isArray(order.allowedActions) && order.allowedActions.length > 0) {
    const first = order.allowedActions[0];
    action = typeof first === 'string' && first.length > 0
      ? first.slice(0, 200)
      : 'unspecified';
    if (action === 'unspecified') {
      warnings.push(`unspecified_action: step[${idx}]`);
    }
  } else {
    action = 'unspecified';
    warnings.push(`unspecified_action: step[${idx}]`);
  }

  // status: normalized to lowercase, trimmed.
  const status = report.status.trim().toLowerCase();

  // evidence_hashes: sha256 of canonical JSON of each evidence object.
  // Preserves count and identity without storing payloads.
  const evidence_hashes = report.evidence.map(
    (ev) => sha256(canonicalStringify(ev)),
  );
  if (evidence_hashes.length === 0) {
    warnings.push(`no_evidence: step[${idx}]`);
  }

  // receipt_id: honest. The order may require a receipt; if so and we
  // don't have one, that's a warning, not a silent fabrication.
  let receipt_id = null;
  if (receipt && typeof receipt.receipt_id === 'string' && receipt.receipt_id.length > 0) {
    receipt_id = receipt.receipt_id;
  }
  if (order.requiresReceipt === true && receipt_id === null) {
    warnings.push(`missing_receipt: step[${idx}]`);
  }
  if (order.requiresReceipt === false && receipt_id !== null) {
    // Not fatal, but worth surfacing — the order said no receipt was needed
    // yet one exists. Could be benign (defensive logging) or a doctrine drift.
    warnings.push(`unexpected_receipt: step[${idx}]`);
  }

  // Optional carry-overs.
  const step = {
    index: idx,
    order_id: order.orderId,
    intent_hash,
    action,
    status,
    confidence: report.confidence,
    evidence_hashes,
    receipt_id,
  };

  if (typeof order.riskLevel === 'string' && VALID_RISK_LEVELS.includes(order.riskLevel)) {
    step.risk_level = order.riskLevel;
  }
  if (typeof report.nextAction === 'string' && report.nextAction.length > 0) {
    step.next_action = report.nextAction.slice(0, 200);
  }

  // input_bytes = char count of canonical JSON of the raw tuple. Honest
  // measure of what we were handed.
  const input_bytes = canonicalStringify({
    order,
    report,
    receipt: receipt ?? null,
  }).length;

  return { step, warnings, input_bytes };
}

// ---------------------------------------------------------------------------
// compressPathwave
// ---------------------------------------------------------------------------

/**
 * Compress an execution trajectory into a Pathwave.
 *
 * @param {Object} params
 * @param {string} params.task   - the task / mission label the trajectory ran under
 * @param {Array<{
 *   order:   Object,            // orange.order.v1
 *   report:  Object,            // orange.report.v1
 *   receipt?: Object | null,    // orange5.receipt.v0 (optional)
 *   action?: string,            // optional explicit action label override
 * }>} params.steps
 * @returns {{
 *   schema: string,
 *   pathwave_id: string,
 *   task: string,
 *   steps: Array<Object>,
 *   stats: {
 *     step_count: number,
 *     ok_count: number,
 *     fail_count: number,
 *     input_bytes: number,
 *     output_bytes: number,
 *     compression_ratio_bytes: number,
 *   },
 *   warnings: string[],
 *   created_at: string,
 * }}
 * @throws {Error} on invalid input shape, fluff task, or order/report mismatch
 */
export function compressPathwave({ task, steps } = {}) {
  // ---- task --------------------------------------------------------------
  if (typeof task !== 'string') {
    throw new Error('pathwave: task must be a string');
  }
  const taskReason = fluffReason(task);
  if (taskReason) {
    throw new Error(`pathwave: task rejected (${taskReason}) — provide a content-bearing task`);
  }
  if (task.length > 1000) {
    throw new Error('pathwave: task must be <= 1000 chars');
  }

  // ---- steps -------------------------------------------------------------
  if (!Array.isArray(steps)) {
    throw new Error('pathwave: steps must be an array');
  }
  if (steps.length > MAX_STEPS) {
    throw new Error(`pathwave: steps.length (${steps.length}) exceeds MAX_STEPS (${MAX_STEPS})`);
  }

  // Detect duplicate orderIds early — a real trajectory can't reuse an
  // orderId because each order is a fresh authorization envelope.
  const seenOrderIds = new Set();

  const compressedSteps = [];
  const allWarnings = [];
  let input_bytes = 0;
  let ok_count = 0;
  let fail_count = 0;

  for (let idx = 0; idx < steps.length; idx++) {
    const raw = steps[idx];
    if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`pathwave: steps[${idx}] must be an object`);
    }

    const oErr = validateOrder(raw.order, idx);
    if (oErr) throw new Error(`pathwave: ${oErr}`);
    const rErr = validateReport(raw.report, idx, raw.order.orderId);
    if (rErr) throw new Error(`pathwave: ${rErr}`);
    const recErr = validateReceipt(raw.receipt, idx);
    if (recErr) throw new Error(`pathwave: ${recErr}`);

    if (seenOrderIds.has(raw.order.orderId)) {
      throw new Error(
        `pathwave: duplicate order.orderId '${raw.order.orderId}' at step[${idx}] — ` +
        'each step must carry a unique orderId',
      );
    }
    seenOrderIds.add(raw.order.orderId);

    const { step, warnings, input_bytes: stepIn } = compressStep(raw, idx);
    compressedSteps.push(step);
    for (const w of warnings) allWarnings.push(w);
    input_bytes += stepIn;

    if (step.status === 'ok') ok_count++;
    else if (step.status === 'failed' || step.status === 'fail' || step.status === 'error') fail_count++;
  }

  // ---- id payload (timestamp- and warnings-independent) ------------------
  const idPayload = canonicalStringify({
    task,
    steps: compressedSteps.map((s) => ({
      order_id: s.order_id,
      intent_hash: s.intent_hash,
      action: s.action,
      status: s.status,
      confidence: s.confidence,
      evidence_hashes: s.evidence_hashes,
      receipt_id: s.receipt_id,
    })),
  });
  const pathwave_id = sha256(idPayload);

  // ---- output bytes ------------------------------------------------------
  const output_bytes = canonicalStringify(compressedSteps).length;
  const compression_ratio_bytes = input_bytes === 0
    ? 1
    : Number((output_bytes / input_bytes).toFixed(6));

  return {
    schema: PATHWAVE_SCHEMA_ID,
    pathwave_id,
    task,
    steps: compressedSteps,
    stats: {
      step_count: compressedSteps.length,
      ok_count,
      fail_count,
      input_bytes,
      output_bytes,
      compression_ratio_bytes,
    },
    warnings: allWarnings,
    created_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// validatePathwave — structural + accounting integrity check
// ---------------------------------------------------------------------------

/**
 * @param {unknown} pathwave
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validatePathwave(pathwave) {
  const errors = [];
  if (pathwave == null || typeof pathwave !== 'object' || Array.isArray(pathwave)) {
    return { valid: false, errors: ['pathwave must be a non-null object'] };
  }
  const required = ['schema', 'pathwave_id', 'task', 'steps', 'stats', 'warnings', 'created_at'];
  for (const k of required) {
    if (!(k in pathwave)) errors.push(`missing required field: ${k}`);
  }
  if (errors.length) return { valid: false, errors };

  if (pathwave.schema !== PATHWAVE_SCHEMA_ID) {
    errors.push(`schema must be '${PATHWAVE_SCHEMA_ID}', got '${pathwave.schema}'`);
  }
  if (!SHA256_RE.test(pathwave.pathwave_id)) {
    errors.push('pathwave_id must be 64-char lowercase hex (sha256)');
  }
  if (typeof pathwave.task !== 'string' || pathwave.task.length === 0) {
    errors.push('task must be a non-empty string');
  }
  if (!Array.isArray(pathwave.steps)) errors.push('steps must be an array');
  if (!Array.isArray(pathwave.warnings)) errors.push('warnings must be an array');
  if (pathwave.stats == null || typeof pathwave.stats !== 'object') {
    errors.push('stats must be an object');
  }
  if (typeof pathwave.created_at !== 'string' || Number.isNaN(Date.parse(pathwave.created_at))) {
    errors.push('created_at must be a parseable ISO 8601 string');
  }
  if (errors.length) return { valid: false, errors };

  // Per-step structural checks + index monotonicity.
  let priorIndex = -1;
  const seenOrderIds = new Set();
  for (let i = 0; i < pathwave.steps.length; i++) {
    const s = pathwave.steps[i];
    if (s == null || typeof s !== 'object' || Array.isArray(s)) {
      errors.push(`steps[${i}] must be an object`);
      continue;
    }
    if (s.index !== i) {
      errors.push(`steps[${i}].index (${s.index}) must equal array position ${i}`);
    }
    if (s.index <= priorIndex) {
      errors.push(`steps[${i}].index (${s.index}) must be strictly greater than prior (${priorIndex})`);
    }
    priorIndex = s.index;

    if (!isNonEmptyString(s.order_id)) errors.push(`steps[${i}].order_id must be non-empty string`);
    else {
      if (seenOrderIds.has(s.order_id)) errors.push(`steps[${i}].order_id '${s.order_id}' duplicated`);
      seenOrderIds.add(s.order_id);
    }
    if (!SHA256_RE.test(s.intent_hash || '')) errors.push(`steps[${i}].intent_hash must be sha256 hex`);
    if (!isNonEmptyString(s.action, 200)) errors.push(`steps[${i}].action must be 1..200 char string`);
    if (!isNonEmptyString(s.status, 64) || s.status.length < 2) {
      errors.push(`steps[${i}].status must be 2..64 char string`);
    }
    if (typeof s.confidence !== 'number' || s.confidence < 0 || s.confidence > 1 || Number.isNaN(s.confidence)) {
      errors.push(`steps[${i}].confidence must be number in [0,1]`);
    }
    if (!Array.isArray(s.evidence_hashes)) errors.push(`steps[${i}].evidence_hashes must be array`);
    else {
      for (let j = 0; j < s.evidence_hashes.length; j++) {
        if (!SHA256_RE.test(s.evidence_hashes[j] || '')) {
          errors.push(`steps[${i}].evidence_hashes[${j}] must be sha256 hex`);
          break;
        }
      }
    }
    if (s.receipt_id !== null && !isNonEmptyString(s.receipt_id)) {
      errors.push(`steps[${i}].receipt_id must be null or non-empty string`);
    }
    if (s.risk_level != null && !VALID_RISK_LEVELS.includes(s.risk_level)) {
      errors.push(`steps[${i}].risk_level invalid: '${s.risk_level}'`);
    }
  }

  // Accounting integrity.
  const { stats, steps } = pathwave;
  if (typeof stats.step_count !== 'number' || stats.step_count !== steps.length) {
    errors.push(`stats.step_count (${stats.step_count}) != steps.length (${steps.length})`);
  }
  for (const k of ['ok_count', 'fail_count', 'input_bytes', 'output_bytes']) {
    if (typeof stats[k] !== 'number' || stats[k] < 0) {
      errors.push(`stats.${k} must be a non-negative number`);
    }
  }
  if (typeof stats.compression_ratio_bytes !== 'number' || stats.compression_ratio_bytes < 0) {
    errors.push('stats.compression_ratio_bytes must be a non-negative number');
  }
  if (Array.isArray(steps)) {
    let ok = 0;
    let fail = 0;
    for (const s of steps) {
      if (s && s.status === 'ok') ok++;
      else if (s && (s.status === 'failed' || s.status === 'fail' || s.status === 'error')) fail++;
    }
    if (stats.ok_count !== ok) errors.push(`stats.ok_count (${stats.ok_count}) != observed (${ok})`);
    if (stats.fail_count !== fail) errors.push(`stats.fail_count (${stats.fail_count}) != observed (${fail})`);
  }

  for (const w of pathwave.warnings) {
    if (typeof w !== 'string' || w.length === 0) {
      errors.push('every warning must be a non-empty string');
      break;
    }
  }

  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// diffPathwaves — comparison primitive for replay / branch analysis
// ---------------------------------------------------------------------------

/**
 * Compare two pathwaves step by step. Returns:
 *   { equal: boolean, divergence_index: number|null, reasons: string[] }
 *
 * Two pathwaves are equal iff their pathwave_ids match. When they differ,
 * divergence_index is the 0-based step index of the FIRST step that doesn't
 * match (or the length of the shorter array if one is a prefix of the
 * other), and `reasons` enumerates which fields differed at that step or
 * called out a structural mismatch (task, length).
 *
 * @param {Object} a
 * @param {Object} b
 */
export function diffPathwaves(a, b) {
  const reasons = [];
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') {
    return { equal: false, divergence_index: null, reasons: ['both pathwaves must be objects'] };
  }
  if (a.schema !== PATHWAVE_SCHEMA_ID || b.schema !== PATHWAVE_SCHEMA_ID) {
    return { equal: false, divergence_index: null, reasons: [`schema mismatch: '${a.schema}' vs '${b.schema}'`] };
  }
  if (a.pathwave_id === b.pathwave_id) {
    return { equal: true, divergence_index: null, reasons: [] };
  }

  if (a.task !== b.task) {
    reasons.push(`task differs: '${a.task}' vs '${b.task}'`);
  }

  const aSteps = Array.isArray(a.steps) ? a.steps : [];
  const bSteps = Array.isArray(b.steps) ? b.steps : [];
  const minLen = Math.min(aSteps.length, bSteps.length);

  for (let i = 0; i < minLen; i++) {
    const sa = aSteps[i];
    const sb = bSteps[i];
    const fieldReasons = [];
    for (const k of ['order_id', 'intent_hash', 'action', 'status', 'confidence', 'receipt_id']) {
      if (sa[k] !== sb[k]) fieldReasons.push(`${k}: ${JSON.stringify(sa[k])} vs ${JSON.stringify(sb[k])}`);
    }
    const eaH = JSON.stringify(sa.evidence_hashes || []);
    const ebH = JSON.stringify(sb.evidence_hashes || []);
    if (eaH !== ebH) fieldReasons.push('evidence_hashes differ');
    if (fieldReasons.length) {
      reasons.push(`step[${i}]: ` + fieldReasons.join('; '));
      return { equal: false, divergence_index: i, reasons };
    }
  }

  if (aSteps.length !== bSteps.length) {
    reasons.push(`length differs: ${aSteps.length} vs ${bSteps.length}`);
    return { equal: false, divergence_index: minLen, reasons };
  }

  // Same id was false but no field-level divergence was found — should not
  // happen if ids are derived from the same fields. Surface honestly.
  reasons.push('pathwave_ids differ but no step-level divergence found — likely a derivation bug');
  return { equal: false, divergence_index: null, reasons };
}

// ---------------------------------------------------------------------------
// Internals (test-only)
// ---------------------------------------------------------------------------

export const __internals = Object.freeze({
  canonicalStringify,
  sha256,
  fluffReason,
  compressStep,
  PATHWAVE_SCHEMA_ID,
  FORBIDDEN_WORDS: [...FORBIDDEN_WORDS],
  VALID_RISK_LEVELS: [...VALID_RISK_LEVELS],
  MAX_STEPS,
});
