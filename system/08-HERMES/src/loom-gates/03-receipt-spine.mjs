// LOOM gate 3 — receipt_spine
//
// Hermes pre-flight gate 3 of 8. Confirms the receipt referenced by an
// incoming order/lease exists on disk, parses as a valid `orange5.receipt.v0`
// document, and — if it claims a `prior_receipt` — that the prior link
// resolves and the `hash_chain` counter is contiguous (current = prior + 1).
//
// Contract: gate 1 (order_schema) and gate 2 (report_schema) have already
// confirmed envelope shape. This gate is the first to touch the filesystem
// for the receipt spine itself. It is the integrity check that keeps
// Hermes from advancing on a forged or orphaned receipt chain. If this
// gate fails, the LOOM chain halts and the lease is refused.
//
// Module shape:
//   - default export: async function receiptSpineGate(input, opts?) → { pass, reasons, receipt }
//   - named exports:  receiptSpineGate, readReceipt, validateReceiptShape,
//                     verifyChainLink, resolveReceiptPath, GATE_ID, GATE_INDEX
//
// Input contract:
//   `input` is the order or lease object passed down the chain. The gate
//   looks for the receipt path in this order:
//     1. opts.receiptPath              — explicit override (tests, replay)
//     2. input.receipt_path            — order-level (most common)
//     3. input.lease?.receipt_path     — lease-wrapped
//     4. input.order?.receipt_path     — nested order envelope
//   If none is present the gate fails with REASON_NO_PATH.
//
// Honest gaps (read me):
//   - "Exists on disk" means a successful `fs.stat` on the absolute or
//     project-relative path. Symlinks are followed (default stat behaviour);
//     this is intentional so that receipts can live in a content-addressed
//     store and be symlinked into the chain dir.
//   - We do NOT recompute or verify a cryptographic hash here. `hash_chain`
//     in `orange5.receipt.v0` is a monotonic integer (per the schema:
//     `"type": "integer", "minimum": 1`), not a digest. Cryptographic
//     attestation lives in a separate gate (out of scope for this file).
//     If/when a `hash_chain_digest` field is added, extend `verifyChainLink`
//     and the README rather than overloading this gate.
//   - We walk at most ONE link backwards (current → prior). Walking the full
//     spine on every gate is O(n) per action; the operator's audit tooling
//     does the full walk out-of-band. This gate is the per-action check.
//   - `prior_receipt`, when non-null, is interpreted as a *path*: either
//     absolute, or relative to the directory containing the current
//     receipt file. It is NOT treated as a `receipt_id`. If the field
//     semantics ever shift to "id, look up in index", swap
//     `resolvePriorPath` and keep the gate surface unchanged.
//   - The receipt schema is reloaded via the same `09-SCHEMAS` path
//     convention used by gate 1; if the schema file moves, both gates
//     fail in the same way and surface the same load error.
//   - Pure JSON parsing; no JSON-Schema validator dependency. Required
//     fields and the `schema` const are checked by hand. If the schema
//     grows new required keywords, update `validateReceiptShape` —
//     `loadReceiptSchema` is exported so callers can do a full Ajv pass
//     out of band if they want.
//   - Requires Node 20+ (`node:fs/promises`, `import.meta.url`).

import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const GATE_ID = "receipt_spine";
export const GATE_INDEX = 3;

// Resolved at module load.
// 08-HERMES/src/loom-gates/03-receipt-spine.mjs → ../../../09-SCHEMAS/receipt.schema.json
const SCHEMA_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..", "..", "..",
  "09-SCHEMAS",
  "receipt.schema.json",
);

// Failure-reason tags. Stable strings so callers (and false_green_guard
// downstream) can switch on them without parsing prose.
export const REASON_NO_PATH        = "receipt_spine: no receipt_path on order/lease";
export const REASON_NOT_FOUND      = "receipt_spine: receipt file not found";
export const REASON_NOT_FILE       = "receipt_spine: receipt path is not a regular file";
export const REASON_UNREADABLE     = "receipt_spine: receipt file unreadable";
export const REASON_MALFORMED_JSON = "receipt_spine: receipt JSON malformed";
export const REASON_BAD_SCHEMA     = "receipt_spine: receipt schema marker mismatch";
export const REASON_MISSING_FIELD  = "receipt_spine: required field missing";
export const REASON_BAD_FIELD      = "receipt_spine: required field invalid";
export const REASON_PRIOR_NOT_FOUND = "receipt_spine: prior_receipt file not found";
export const REASON_PRIOR_UNREADABLE = "receipt_spine: prior_receipt unreadable";
export const REASON_PRIOR_MALFORMED  = "receipt_spine: prior_receipt malformed";
export const REASON_CHAIN_BREAK    = "receipt_spine: hash_chain non-contiguous";

let _schemaCache = null;

/**
 * Load the orange5.receipt.v0 schema. Cached after first read.
 * Exported so external auditors can run a full JSON-Schema pass; the gate
 * itself does not depend on a validator library.
 * @param {{ reload?: boolean }} [opts]
 * @returns {Promise<object>}
 */
export async function loadReceiptSchema({ reload = false } = {}) {
  if (_schemaCache && !reload) return _schemaCache;
  let raw;
  try {
    raw = await readFile(SCHEMA_PATH, "utf8");
  } catch (err) {
    const e = new Error(`receipt_spine: cannot read ${SCHEMA_PATH}: ${err.message}`);
    e.code = "RECEIPT_SCHEMA_LOAD_FAILED";
    e.cause = err;
    throw e;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const e = new Error(`receipt_spine: malformed JSON at ${SCHEMA_PATH}: ${err.message}`);
    e.code = "RECEIPT_SCHEMA_LOAD_FAILED";
    e.cause = err;
    throw e;
  }
  if (parsed?.$id !== "orange5.receipt.v0") {
    const e = new Error(`receipt_spine: schema $id mismatch — expected "orange5.receipt.v0", got "${parsed?.$id}"`);
    e.code = "RECEIPT_SCHEMA_LOAD_FAILED";
    throw e;
  }
  _schemaCache = parsed;
  return parsed;
}

/**
 * Pull a receipt path out of an order/lease/explicit-override input.
 * Returns `null` if no candidate path is present. Does NOT normalise
 * to absolute — that happens in `readReceipt`.
 *
 * @param {unknown} input
 * @param {{ receiptPath?: string }} [opts]
 * @returns {string | null}
 */
export function resolveReceiptPath(input, opts = {}) {
  if (typeof opts.receiptPath === "string" && opts.receiptPath.length > 0) {
    return opts.receiptPath;
  }
  if (!input || typeof input !== "object") return null;
  const o = /** @type {Record<string, any>} */ (input);
  if (typeof o.receipt_path === "string" && o.receipt_path.length > 0) {
    return o.receipt_path;
  }
  if (o.lease && typeof o.lease === "object" && typeof o.lease.receipt_path === "string" && o.lease.receipt_path.length > 0) {
    return o.lease.receipt_path;
  }
  if (o.order && typeof o.order === "object" && typeof o.order.receipt_path === "string" && o.order.receipt_path.length > 0) {
    return o.order.receipt_path;
  }
  return null;
}

/**
 * Read and parse a receipt file. Returns { ok, receipt?, reason?, absPath }.
 * Pure I/O + parse — no schema interpretation. `validateReceiptShape` is
 * the next step.
 *
 * @param {string} receiptPath  absolute or cwd-relative
 * @param {{ baseDir?: string }} [opts]  baseDir for relative paths (default: process.cwd())
 * @returns {Promise<{ ok: boolean, receipt?: object, reason?: string, detail?: string, absPath: string }>}
 */
export async function readReceipt(receiptPath, opts = {}) {
  const baseDir = opts.baseDir ?? process.cwd();
  const absPath = path.isAbsolute(receiptPath)
    ? receiptPath
    : path.resolve(baseDir, receiptPath);

  let st;
  try {
    st = await stat(absPath);
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return { ok: false, reason: REASON_NOT_FOUND, detail: absPath, absPath };
    }
    return { ok: false, reason: REASON_UNREADABLE, detail: `${absPath}: ${err.message}`, absPath };
  }
  if (!st.isFile()) {
    return { ok: false, reason: REASON_NOT_FILE, detail: absPath, absPath };
  }

  let raw;
  try {
    raw = await readFile(absPath, "utf8");
  } catch (err) {
    return { ok: false, reason: REASON_UNREADABLE, detail: `${absPath}: ${err.message}`, absPath };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, reason: REASON_MALFORMED_JSON, detail: `${absPath}: ${err.message}`, absPath };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: REASON_MALFORMED_JSON, detail: `${absPath}: receipt must be a JSON object`, absPath };
  }

  return { ok: true, receipt: parsed, absPath };
}

/**
 * Hand-written shape check for an `orange5.receipt.v0` document. Mirrors
 * the required-field set and the `schema` const from
 * `09-SCHEMAS/receipt.schema.json`. Not a full JSON-Schema validator —
 * see the "Honest gaps" note at the top of this file.
 *
 * @param {unknown} receipt
 * @returns {{ pass: boolean, reasons: string[] }}
 */
export function validateReceiptShape(receipt) {
  const reasons = [];
  if (receipt === null || typeof receipt !== "object" || Array.isArray(receipt)) {
    return { pass: false, reasons: [`${REASON_BAD_FIELD}: receipt must be a JSON object`] };
  }
  const r = /** @type {Record<string, any>} */ (receipt);

  // schema const — this is the load-bearing identity check.
  if (r.schema !== "orange5.receipt.v0") {
    reasons.push(`${REASON_BAD_SCHEMA}: expected "orange5.receipt.v0", got ${JSON.stringify(r.schema)}`);
  }

  // Required field presence (per receipt.schema.json).
  const REQUIRED = ["receipt_id", "generated_at", "schema", "actor", "status", "confidence", "hash_chain"];
  for (const k of REQUIRED) {
    if (!Object.prototype.hasOwnProperty.call(r, k)) {
      reasons.push(`${REASON_MISSING_FIELD}: ${k}`);
    }
  }

  // Required field types — only check if present.
  if (typeof r.receipt_id === "string" && r.receipt_id.length === 0) {
    reasons.push(`${REASON_BAD_FIELD}: receipt_id must be non-empty string`);
  } else if ("receipt_id" in r && typeof r.receipt_id !== "string") {
    reasons.push(`${REASON_BAD_FIELD}: receipt_id must be string, got ${typeof r.receipt_id}`);
  }
  if ("generated_at" in r && typeof r.generated_at !== "string") {
    reasons.push(`${REASON_BAD_FIELD}: generated_at must be string, got ${typeof r.generated_at}`);
  }
  if ("actor" in r && typeof r.actor !== "string") {
    reasons.push(`${REASON_BAD_FIELD}: actor must be string, got ${typeof r.actor}`);
  }
  if ("status" in r && typeof r.status !== "string") {
    reasons.push(`${REASON_BAD_FIELD}: status must be string, got ${typeof r.status}`);
  }
  if ("confidence" in r) {
    if (typeof r.confidence !== "number" || Number.isNaN(r.confidence) || r.confidence < 0 || r.confidence > 1) {
      reasons.push(`${REASON_BAD_FIELD}: confidence must be number in [0,1], got ${JSON.stringify(r.confidence)}`);
    }
  }
  if ("hash_chain" in r) {
    if (typeof r.hash_chain !== "number" || !Number.isInteger(r.hash_chain) || r.hash_chain < 1) {
      reasons.push(`${REASON_BAD_FIELD}: hash_chain must be integer >= 1, got ${JSON.stringify(r.hash_chain)}`);
    }
  }
  if ("prior_receipt" in r && r.prior_receipt !== null && typeof r.prior_receipt !== "string") {
    reasons.push(`${REASON_BAD_FIELD}: prior_receipt must be string or null, got ${typeof r.prior_receipt}`);
  }

  return { pass: reasons.length === 0, reasons };
}

/**
 * Resolve a `prior_receipt` value against the directory of the current
 * receipt file. Absolute paths win; otherwise resolve relative to the
 * current receipt's directory. This keeps content-addressed stores
 * portable.
 *
 * @param {string} priorRef
 * @param {string} currentAbsPath
 * @returns {string}
 */
export function resolvePriorPath(priorRef, currentAbsPath) {
  if (path.isAbsolute(priorRef)) return priorRef;
  return path.resolve(path.dirname(currentAbsPath), priorRef);
}

/**
 * Verify the single-link continuity of the chain. The current receipt
 * is already known good (caller has shape-checked it). We:
 *   - If `prior_receipt` is null, require `hash_chain === 1`. Genesis.
 *   - Otherwise, resolve the prior path, read it, shape-check it, and
 *     require `current.hash_chain === prior.hash_chain + 1`.
 *
 * @param {object} current  shape-validated receipt
 * @param {string} currentAbsPath  absolute path the current receipt was read from
 * @param {{ baseDir?: string }} [opts]
 * @returns {Promise<{ pass: boolean, reasons: string[], prior?: object, priorAbsPath?: string }>}
 */
export async function verifyChainLink(current, currentAbsPath, opts = {}) {
  const reasons = [];
  const prior = current.prior_receipt;

  if (prior === null || prior === undefined) {
    // Genesis link: chain must start at 1.
    if (current.hash_chain !== 1) {
      reasons.push(`${REASON_CHAIN_BREAK}: prior_receipt is null but hash_chain=${current.hash_chain} (expected 1 for genesis)`);
    }
    return { pass: reasons.length === 0, reasons };
  }

  if (typeof prior !== "string" || prior.length === 0) {
    // Caught by shape check normally, but guard anyway.
    reasons.push(`${REASON_BAD_FIELD}: prior_receipt must be non-empty string or null`);
    return { pass: false, reasons };
  }

  const priorAbsPath = resolvePriorPath(prior, currentAbsPath);
  const priorRead = await readReceipt(priorAbsPath, opts);
  if (!priorRead.ok) {
    // Re-tag the reason to make it clear which side of the link failed.
    const tag = priorRead.reason === REASON_NOT_FOUND
      ? REASON_PRIOR_NOT_FOUND
      : priorRead.reason === REASON_MALFORMED_JSON
        ? REASON_PRIOR_MALFORMED
        : REASON_PRIOR_UNREADABLE;
    reasons.push(`${tag}: ${priorRead.detail ?? priorAbsPath}`);
    return { pass: false, reasons, priorAbsPath };
  }

  const priorShape = validateReceiptShape(priorRead.receipt);
  if (!priorShape.pass) {
    // Prior is malformed at the schema layer — report each reason
    // prefixed so it's clear we're talking about the prior link, not
    // the current receipt.
    for (const reason of priorShape.reasons) {
      reasons.push(`prior_receipt at ${priorAbsPath}: ${reason}`);
    }
    return { pass: false, reasons, prior: priorRead.receipt, priorAbsPath };
  }

  const expected = priorRead.receipt.hash_chain + 1;
  if (current.hash_chain !== expected) {
    reasons.push(
      `${REASON_CHAIN_BREAK}: current.hash_chain=${current.hash_chain}, prior.hash_chain=${priorRead.receipt.hash_chain}, expected ${expected}`,
    );
  }

  return { pass: reasons.length === 0, reasons, prior: priorRead.receipt, priorAbsPath };
}

/**
 * LOOM gate 3 entry point. Never throws on validation failure — only on
 * unrecoverable I/O outside the receipt path itself (and even those are
 * caught and returned as failure reasons; the only re-throw path is if a
 * caller passes a structurally-broken `opts`).
 *
 * @param {unknown} input  the order or lease being processed
 * @param {{
 *   receiptPath?: string,
 *   baseDir?: string,
 *   verifyChain?: boolean,
 * }} [opts]
 *   - `receiptPath`: explicit override; bypasses path discovery on the order.
 *   - `baseDir`: directory to resolve relative `receipt_path` against.
 *                Default `process.cwd()`. Tests should pin this.
 *   - `verifyChain`: when false, skip the prior-link walk (default true).
 *                    Set false only for replay/audit tooling that has
 *                    already verified the chain out of band.
 * @returns {Promise<{ pass: boolean, reasons: string[], receipt?: object, absPath?: string }>}
 */
export async function receiptSpineGate(input, opts = {}) {
  const receiptPath = resolveReceiptPath(input, opts);
  if (receiptPath === null) {
    return { pass: false, reasons: [REASON_NO_PATH] };
  }

  const read = await readReceipt(receiptPath, { baseDir: opts.baseDir });
  if (!read.ok) {
    return {
      pass: false,
      reasons: [read.detail ? `${read.reason}: ${read.detail}` : read.reason],
      absPath: read.absPath,
    };
  }

  const shape = validateReceiptShape(read.receipt);
  if (!shape.pass) {
    return {
      pass: false,
      reasons: shape.reasons,
      receipt: read.receipt,
      absPath: read.absPath,
    };
  }

  if (opts.verifyChain === false) {
    return { pass: true, reasons: [], receipt: read.receipt, absPath: read.absPath };
  }

  const chain = await verifyChainLink(read.receipt, read.absPath, { baseDir: opts.baseDir });
  if (!chain.pass) {
    return {
      pass: false,
      reasons: chain.reasons,
      receipt: read.receipt,
      absPath: read.absPath,
    };
  }

  return { pass: true, reasons: [], receipt: read.receipt, absPath: read.absPath };
}

export default receiptSpineGate;
