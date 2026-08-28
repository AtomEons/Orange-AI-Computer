// 08-HERMES/src/pre-action/override.mjs
//
// Hermes pre-action SIGNED OPERATOR OVERRIDE for the AE Misfit second-opinion
// gate.
//
// When the AE Misfit gate returns REFUSE on a proposed action, the action is
// blocked by default. This module is the ONLY lawful path to bypass that
// REFUSE: a signed approval file the operator (Sovereign Atom McCree) has
// dropped at:
//
//   08-HERMES/approvals/override-{action_id}.json
//
// Shape of the approval file (canonical JSON, stable key order):
//
//   {
//     "schema": "orange5.hermes.override.v0",
//     "action_id": "<the action_id being overridden>",
//     "issued_at": "<ISO-8601 UTC timestamp>",
//     "expires_at": "<ISO-8601 UTC timestamp; <= issued_at + 1h>",
//     "operator": "atom-mccree",
//     "reason": "<short human reason string>",
//     "misfit_verdict": "REFUSE",              // what we are overriding
//     "signature": "<base64 Ed25519 signature over the canonical payload>"
//   }
//
// The signed payload is the canonical-JSON of the same object with the
// `signature` field removed. Canonical JSON here is: keys sorted
// lexicographically, no whitespace, UTF-8.
//
// Public key:
//   - Read from env ATOM_OPERATOR_PUBKEY.
//   - Accepted formats:
//       * base64 raw 32-byte Ed25519 public key
//       * PEM ("-----BEGIN PUBLIC KEY-----...") SubjectPublicKeyInfo block
//   - If unset or unparseable, override is REFUSED with reason 'no-public-key'.
//     Mom's Law: no key means no override. We do not fall back to "trust the
//     filename." A missing key is a loud failure.
//
// Expiry:
//   - Hard ceiling: 1 hour from `issued_at`. Files that claim a longer life
//     are rejected with reason 'expiry-too-far'.
//   - `expires_at` must be in the future at decision time, else reason
//     'expired'.
//
// Bypass scope:
//   - This module ONLY bypasses a Misfit REFUSE. It does NOT bypass:
//       * LOOM 8 gates (downstream — they still run)
//       * Human approval requirements (critical risk still needs it)
//       * The kill-switch (separate operator escape hatch)
//   - The caller is responsible for routing the override decision into the
//     middleware in a way that preserves those layers.
//
// Audit:
//   - Every decision (allow / refuse / error) emits a Thought Flux event
//     `thought_flux.misfit_override.<verdict>` via the injected logger.
//   - The audit envelope carries: action_id, verdict, reason, operator,
//     misfit_verdict, issued_at, expires_at, file_sha256, signature_valid,
//     and the bypass scope statement. No secrets, no raw bytes.
//
// Mom's Law: real signature verification (Ed25519 via node:crypto), real
// expiry math, real path containment (the action_id must not escape the
// approvals dir), real logging. No theater. No silent success on a bad sig.
//
// Schema: orange5.hermes.override.v0
// Sovereign: Atom McCree

import { readFile, stat } from "node:fs/promises";
import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ----------------------------------------------------------------------------
// Constants

export const SCHEMA = "orange5.hermes.override.v0";

export const PUBKEY_ENV_VAR = "ATOM_OPERATOR_PUBKEY";

// Hard maximum lifetime of an approval file, measured from `issued_at`.
// One hour. Not configurable — this is doctrine.
export const MAX_LIFETIME_MS = 60 * 60 * 1000;

// Small grace window for clock skew between the operator's signer and this
// host, applied ONLY to the "not yet valid" check. 60 seconds. Expiry has
// no grace — once it's past `expires_at`, it's dead.
export const NOT_YET_VALID_SKEW_MS = 60 * 1000;

// The Misfit verdict we are allowed to override.
const TARGET_MISFIT_VERDICT = "REFUSE";

// Allowed operator identity. Override is the Sovereign's lever only.
const ALLOWED_OPERATOR = "atom-mccree";

// Reasons the verdict can carry. Stable strings — they end up in the audit.
export const REASONS = Object.freeze({
  OK: "ok",
  NO_OVERRIDE_NEEDED: "no-override-needed",
  NO_FILE: "no-file",
  INVALID_ACTION_ID: "invalid-action-id",
  INVALID_JSON: "invalid-json",
  SCHEMA_MISMATCH: "schema-mismatch",
  ACTION_ID_MISMATCH: "action-id-mismatch",
  WRONG_MISFIT_VERDICT: "wrong-misfit-verdict",
  WRONG_OPERATOR: "wrong-operator",
  MISSING_FIELD: "missing-field",
  EXPIRY_TOO_FAR: "expiry-too-far",
  NOT_YET_VALID: "not-yet-valid",
  EXPIRED: "expired",
  NO_PUBLIC_KEY: "no-public-key",
  BAD_PUBLIC_KEY: "bad-public-key",
  BAD_SIGNATURE_ENCODING: "bad-signature-encoding",
  SIGNATURE_INVALID: "signature-invalid",
  IO_ERROR: "io-error",
});

// The default approvals directory, relative to repo root. The repo root is
// computed from this file's URL (this file lives at
// 08-HERMES/src/pre-action/override.mjs, so root is three levels up plus the
// HERMES prefix). Tests can override via opts.approvalsDir.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// __dirname == .../08-HERMES/src/pre-action
// approvals  == .../08-HERMES/approvals
const DEFAULT_APPROVALS_DIR = resolve(__dirname, "..", "..", "approvals");

// action_id must be a non-empty string of safe filename chars. We accept
// the same shape Hermes uses elsewhere: letters, digits, underscore, dash,
// dot (no path separators, no leading dot). This is the second line of
// defense; the first is path-resolve containment below.
const ACTION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.\-]{0,127}$/;

// Required fields on an approval file payload (i.e. excluding `signature`).
const REQUIRED_FIELDS = Object.freeze([
  "schema",
  "action_id",
  "issued_at",
  "expires_at",
  "operator",
  "reason",
  "misfit_verdict",
]);

// ----------------------------------------------------------------------------
// Helpers (pure)

function defaultNow() {
  return Date.now();
}

function defaultLogger(level, payload) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    source: "08-HERMES/override",
    ...payload,
  });
  if (level === "warn" || level === "error") {
    // eslint-disable-next-line no-console
    console.warn(line);
  } else {
    // eslint-disable-next-line no-console
    console.log(line);
  }
}

function parseIsoTimestamp(s) {
  if (typeof s !== "string" || s.length === 0) return null;
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return null;
  return t;
}

function sha256Hex(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

// Canonical JSON: keys sorted lexicographically at every level, no
// whitespace. Used for both the signing payload and (incidentally) the
// file digest in the audit envelope.
function canonicalize(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalize).join(",") + "]";
  }
  const keys = Object.keys(value).sort();
  const parts = keys.map((k) => JSON.stringify(k) + ":" + canonicalize(value[k]));
  return "{" + parts.join(",") + "}";
}

function loadPublicKey(env) {
  const raw = env && env[PUBKEY_ENV_VAR];
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { ok: false, reason: REASONS.NO_PUBLIC_KEY };
  }
  const trimmed = raw.trim();
  try {
    if (trimmed.startsWith("-----BEGIN")) {
      const key = createPublicKey({ key: trimmed, format: "pem" });
      if (key.asymmetricKeyType !== "ed25519") {
        return { ok: false, reason: REASONS.BAD_PUBLIC_KEY };
      }
      return { ok: true, key };
    }
    // Treat as base64 raw 32-byte Ed25519 public key.
    const bytes = Buffer.from(trimmed, "base64");
    if (bytes.length !== 32) {
      return { ok: false, reason: REASONS.BAD_PUBLIC_KEY };
    }
    // Wrap in SPKI DER so node:crypto accepts it as an Ed25519 public key.
    // Ed25519 SPKI prefix (12 bytes): 302a300506032b6570032100
    const spki = Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      bytes,
    ]);
    const key = createPublicKey({ key: spki, format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ed25519") {
      return { ok: false, reason: REASONS.BAD_PUBLIC_KEY };
    }
    return { ok: true, key };
  } catch (_err) {
    return { ok: false, reason: REASONS.BAD_PUBLIC_KEY };
  }
}

function decodeSignature(sigStr) {
  if (typeof sigStr !== "string" || sigStr.length === 0) {
    return { ok: false, reason: REASONS.BAD_SIGNATURE_ENCODING };
  }
  try {
    const buf = Buffer.from(sigStr, "base64");
    if (buf.length !== 64) {
      return { ok: false, reason: REASONS.BAD_SIGNATURE_ENCODING };
    }
    return { ok: true, buf };
  } catch (_err) {
    return { ok: false, reason: REASONS.BAD_SIGNATURE_ENCODING };
  }
}

function approvalPathFor(approvalsDir, actionId) {
  // Resolve and ensure containment: the resolved path must live strictly
  // inside the approvals directory. Defense in depth on top of the
  // ACTION_ID_RE shape check.
  const fname = `override-${actionId}.json`;
  const candidate = resolve(approvalsDir, fname);
  const dirResolved = resolve(approvalsDir);
  // Ensure candidate starts with dirResolved + path separator (or equals
  // dirResolved/fname). Using string prefix is safe here because both sides
  // went through resolve().
  if (
    candidate !== join(dirResolved, fname) ||
    !candidate.startsWith(dirResolved)
  ) {
    return null;
  }
  return candidate;
}

// ----------------------------------------------------------------------------
// Verdict shape

function refuse(reason, extras = {}) {
  return {
    schema: SCHEMA,
    allow: false,
    reason,
    ...extras,
  };
}

function allow(extras = {}) {
  return {
    schema: SCHEMA,
    allow: true,
    reason: REASONS.OK,
    ...extras,
  };
}

// ----------------------------------------------------------------------------
// Public API

/**
 * Check for a signed operator override authorizing bypass of a Misfit REFUSE.
 *
 * @param {Object} input
 * @param {string} input.action_id        - the action id under decision
 * @param {string} [input.misfit_verdict] - the Misfit gate's verdict; only
 *                                          'REFUSE' is overridable. Anything
 *                                          else returns no-override-needed.
 *
 * @param {Object} [opts]
 * @param {string}   [opts.approvalsDir]  - override the approvals dir (tests)
 * @param {Object}   [opts.env]           - env override (defaults process.env)
 * @param {Function} [opts.now]           - clock override () => ms
 * @param {Function} [opts.logger]        - logger override (level, payload)=>void
 * @param {Function} [opts.readFile]      - readFile override (path)=>Promise<Buffer>
 *
 * @returns {Promise<{
 *   schema: string,
 *   allow: boolean,
 *   reason: string,
 *   action_id?: string,
 *   approval_path?: string,
 *   file_sha256?: string,
 *   operator?: string,
 *   issued_at?: string,
 *   expires_at?: string,
 *   misfit_verdict?: string,
 *   signature_valid?: boolean,
 *   bypass_scope?: string,
 * }>}
 */
export async function checkOverride(input = {}, opts = {}) {
  const env = opts.env || (typeof process !== "undefined" ? process.env : {});
  const now = typeof opts.now === "function" ? opts.now : defaultNow;
  const logger = typeof opts.logger === "function" ? opts.logger : defaultLogger;
  const approvalsDir = opts.approvalsDir || DEFAULT_APPROVALS_DIR;
  const readFn = typeof opts.readFile === "function" ? opts.readFile : readFile;

  const action_id = typeof input.action_id === "string" ? input.action_id : "";
  const misfit_verdict =
    typeof input.misfit_verdict === "string" ? input.misfit_verdict.toUpperCase() : "";

  // Fast path: nothing to override if Misfit did not REFUSE.
  if (misfit_verdict !== TARGET_MISFIT_VERDICT) {
    const v = refuse(REASONS.NO_OVERRIDE_NEEDED, {
      action_id,
      misfit_verdict,
    });
    // No audit on no-op — this would flood Thought Flux on every CONFIRM.
    return v;
  }

  // Validate action_id shape before touching the filesystem.
  if (!ACTION_ID_RE.test(action_id)) {
    const v = refuse(REASONS.INVALID_ACTION_ID, { action_id });
    emitAudit(logger, "warn", v);
    return v;
  }

  const approvalPath = approvalPathFor(approvalsDir, action_id);
  if (approvalPath === null) {
    const v = refuse(REASONS.INVALID_ACTION_ID, { action_id });
    emitAudit(logger, "warn", v);
    return v;
  }

  // Read the approval file. ENOENT is a normal "no override present" path.
  let raw;
  try {
    raw = await readFn(approvalPath);
  } catch (err) {
    if (err && (err.code === "ENOENT" || err.code === "ENOTDIR")) {
      const v = refuse(REASONS.NO_FILE, { action_id, approval_path: approvalPath });
      // Quiet: missing file is the steady-state. Not every action has an override.
      return v;
    }
    const v = refuse(REASONS.IO_ERROR, {
      action_id,
      approval_path: approvalPath,
      io_error: err && err.code ? err.code : "unknown",
    });
    emitAudit(logger, "error", v);
    return v;
  }

  const fileBuf = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), "utf8");
  const file_sha256 = sha256Hex(fileBuf);

  // Parse JSON.
  let body;
  try {
    body = JSON.parse(fileBuf.toString("utf8"));
  } catch (_err) {
    const v = refuse(REASONS.INVALID_JSON, {
      action_id,
      approval_path: approvalPath,
      file_sha256,
    });
    emitAudit(logger, "warn", v);
    return v;
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    const v = refuse(REASONS.INVALID_JSON, {
      action_id,
      approval_path: approvalPath,
      file_sha256,
    });
    emitAudit(logger, "warn", v);
    return v;
  }

  // Required fields.
  for (const f of REQUIRED_FIELDS) {
    if (typeof body[f] !== "string" || body[f].length === 0) {
      const v = refuse(REASONS.MISSING_FIELD, {
        action_id,
        approval_path: approvalPath,
        file_sha256,
        missing_field: f,
      });
      emitAudit(logger, "warn", v);
      return v;
    }
  }
  if (typeof body.signature !== "string" || body.signature.length === 0) {
    const v = refuse(REASONS.MISSING_FIELD, {
      action_id,
      approval_path: approvalPath,
      file_sha256,
      missing_field: "signature",
    });
    emitAudit(logger, "warn", v);
    return v;
  }

  // Schema lock.
  if (body.schema !== SCHEMA) {
    const v = refuse(REASONS.SCHEMA_MISMATCH, {
      action_id,
      approval_path: approvalPath,
      file_sha256,
      got_schema: body.schema,
    });
    emitAudit(logger, "warn", v);
    return v;
  }

  // The action_id in the file MUST match the action under decision. This
  // prevents replay of a valid override against a different action.
  if (body.action_id !== action_id) {
    const v = refuse(REASONS.ACTION_ID_MISMATCH, {
      action_id,
      approval_path: approvalPath,
      file_sha256,
      file_action_id: body.action_id,
    });
    emitAudit(logger, "warn", v);
    return v;
  }

  // The file must be overriding the same verdict we observed (REFUSE).
  if (String(body.misfit_verdict).toUpperCase() !== TARGET_MISFIT_VERDICT) {
    const v = refuse(REASONS.WRONG_MISFIT_VERDICT, {
      action_id,
      approval_path: approvalPath,
      file_sha256,
      file_misfit_verdict: body.misfit_verdict,
    });
    emitAudit(logger, "warn", v);
    return v;
  }

  // Operator identity lock.
  if (body.operator !== ALLOWED_OPERATOR) {
    const v = refuse(REASONS.WRONG_OPERATOR, {
      action_id,
      approval_path: approvalPath,
      file_sha256,
      file_operator: body.operator,
    });
    emitAudit(logger, "warn", v);
    return v;
  }

  // Time math.
  const nowMs = now();
  const issuedAtMs = parseIsoTimestamp(body.issued_at);
  const expiresAtMs = parseIsoTimestamp(body.expires_at);
  if (issuedAtMs === null || expiresAtMs === null) {
    const v = refuse(REASONS.MISSING_FIELD, {
      action_id,
      approval_path: approvalPath,
      file_sha256,
      missing_field: issuedAtMs === null ? "issued_at" : "expires_at",
    });
    emitAudit(logger, "warn", v);
    return v;
  }

  // Hard ceiling: expires_at must be no more than MAX_LIFETIME_MS after
  // issued_at. A file claiming a longer life is rejected outright.
  if (expiresAtMs - issuedAtMs > MAX_LIFETIME_MS) {
    const v = refuse(REASONS.EXPIRY_TOO_FAR, {
      action_id,
      approval_path: approvalPath,
      file_sha256,
      issued_at: body.issued_at,
      expires_at: body.expires_at,
      max_lifetime_ms: MAX_LIFETIME_MS,
    });
    emitAudit(logger, "warn", v);
    return v;
  }

  // Not-yet-valid: small skew tolerance only.
  if (issuedAtMs - nowMs > NOT_YET_VALID_SKEW_MS) {
    const v = refuse(REASONS.NOT_YET_VALID, {
      action_id,
      approval_path: approvalPath,
      file_sha256,
      issued_at: body.issued_at,
      now: new Date(nowMs).toISOString(),
    });
    emitAudit(logger, "warn", v);
    return v;
  }

  // Expired: no grace.
  if (nowMs >= expiresAtMs) {
    const v = refuse(REASONS.EXPIRED, {
      action_id,
      approval_path: approvalPath,
      file_sha256,
      expires_at: body.expires_at,
      now: new Date(nowMs).toISOString(),
    });
    emitAudit(logger, "warn", v);
    return v;
  }

  // Signature verification.
  const pk = loadPublicKey(env);
  if (!pk.ok) {
    const v = refuse(pk.reason, {
      action_id,
      approval_path: approvalPath,
      file_sha256,
      env_var: PUBKEY_ENV_VAR,
    });
    // Loud: a missing or malformed public key is an operator misconfig that
    // SILENTLY DISABLES override. Make sure they see it.
    emitAudit(logger, "error", v);
    return v;
  }

  const sig = decodeSignature(body.signature);
  if (!sig.ok) {
    const v = refuse(sig.reason, {
      action_id,
      approval_path: approvalPath,
      file_sha256,
    });
    emitAudit(logger, "warn", v);
    return v;
  }

  // Build the signed payload: same body, signature stripped, canonicalized.
  const payload = { ...body };
  delete payload.signature;
  const signedBytes = Buffer.from(canonicalize(payload), "utf8");

  let valid = false;
  try {
    // Ed25519 in node:crypto uses verify(null, data, key, signature).
    valid = cryptoVerify(null, signedBytes, pk.key, sig.buf);
  } catch (_err) {
    valid = false;
  }

  if (!valid) {
    const v = refuse(REASONS.SIGNATURE_INVALID, {
      action_id,
      approval_path: approvalPath,
      file_sha256,
      operator: body.operator,
      issued_at: body.issued_at,
      expires_at: body.expires_at,
      signature_valid: false,
    });
    emitAudit(logger, "error", v);
    return v;
  }

  // All gates passed. Allow the bypass of THIS REFUSE only.
  const v = allow({
    action_id,
    approval_path: approvalPath,
    file_sha256,
    operator: body.operator,
    issued_at: body.issued_at,
    expires_at: body.expires_at,
    misfit_verdict: body.misfit_verdict,
    operator_reason: body.reason,
    signature_valid: true,
    bypass_scope:
      "misfit-refuse-only: LOOM 8 gates and human approval still apply",
  });
  emitAudit(logger, "warn", v);
  return v;
}

// Emit a Thought Flux audit event describing the decision. Verdict is the
// raw object returned to the caller; we use its `allow` and `reason` fields
// to label the event.
function emitAudit(logger, level, verdict) {
  const event = verdict.allow
    ? "thought_flux.misfit_override.allow"
    : "thought_flux.misfit_override.refuse";
  logger(level, {
    event,
    schema: SCHEMA,
    allow: verdict.allow,
    reason: verdict.reason,
    action_id: verdict.action_id || null,
    approval_path: verdict.approval_path || null,
    file_sha256: verdict.file_sha256 || null,
    operator: verdict.operator || null,
    issued_at: verdict.issued_at || null,
    expires_at: verdict.expires_at || null,
    misfit_verdict: verdict.misfit_verdict || null,
    signature_valid:
      typeof verdict.signature_valid === "boolean" ? verdict.signature_valid : null,
    bypass_scope: verdict.bypass_scope || null,
    operator_reason: verdict.operator_reason || null,
    extras: pickAuditExtras(verdict),
  });
}

function pickAuditExtras(v) {
  const out = {};
  if ("missing_field" in v) out.missing_field = v.missing_field;
  if ("got_schema" in v) out.got_schema = v.got_schema;
  if ("file_action_id" in v) out.file_action_id = v.file_action_id;
  if ("file_misfit_verdict" in v) out.file_misfit_verdict = v.file_misfit_verdict;
  if ("file_operator" in v) out.file_operator = v.file_operator;
  if ("now" in v) out.now = v.now;
  if ("max_lifetime_ms" in v) out.max_lifetime_ms = v.max_lifetime_ms;
  if ("env_var" in v) out.env_var = v.env_var;
  if ("io_error" in v) out.io_error = v.io_error;
  return Object.keys(out).length > 0 ? out : null;
}

// ----------------------------------------------------------------------------
// Test hooks

export const __internals = Object.freeze({
  SCHEMA,
  PUBKEY_ENV_VAR,
  MAX_LIFETIME_MS,
  NOT_YET_VALID_SKEW_MS,
  TARGET_MISFIT_VERDICT,
  ALLOWED_OPERATOR,
  REASONS,
  REQUIRED_FIELDS,
  ACTION_ID_RE,
  DEFAULT_APPROVALS_DIR,
  canonicalize,
  parseIsoTimestamp,
  sha256Hex,
  loadPublicKey,
  decodeSignature,
  approvalPathFor,
  defaultNow,
  defaultLogger,
});
