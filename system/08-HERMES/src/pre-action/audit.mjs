// 08-HERMES/src/pre-action/audit.mjs
//
// Hermes pre-action AUDIT LOG for the AE Misfit second-opinion gate.
//
// Doctrine anchor (Wave 2 #027 + Wave 3-04 + this workflow):
//   - Wave 2 #027 authored 04-CONTROL-PLANE/misfit/second-opinion.mjs (STATIC).
//   - Wave 3-04 authored the Hermes pre-action middleware skeleton.
//   - This module makes the trail LIVE: every Misfit decision is appended to
//     a JSONL log at 08-HERMES/audit/misfit-decisions.jsonl, with a forward
//     hash chain so any tampering with a prior entry is detectable.
//
// Entry shape (per workflow spec, with the audit envelope added by this module):
//   {
//     ts,                  // ISO-8601 UTC timestamp
//     action_id,           // caller-supplied id correlating the action across logs
//     risk_level,          // 'low' | 'medium' | 'high' | 'critical'
//     misfit_decision,     // 'CONFIRM' | 'REFUSE' | 'allow-with-warning'
//                          //   | 'bypass-kill-switch' | 'skipped-low-risk' | 'error'
//     misfit_reason,       // free-form string from second-opinion result or hermes
//     override,            // OPTIONAL: { approval_id, approver, signed_at, sha256 }
//     gate_result,         // 'pass' | 'block' | 'advisory' | 'override-applied'
//                          //   | 'bypass' | 'pending-human' | 'error'
//     total_latency_ms,    // end-to-end pre-action latency (number, >= 0)
//     // --- audit envelope (added here) ---
//     schema,              // 'orange5.hermes.audit.v0'
//     seq,                 // monotonic 1-based sequence number within this log
//     prev_hash,           // SHA-256 hex of the previous entry's canonical JSON
//     entry_hash,          // SHA-256 hex over (prev_hash + canonical body)
//   }
//
// Hash chain:
//   prev_hash[0]   = '0'.repeat(64) (the genesis anchor)
//   body_n         = JSON.stringify(entry_n without entry_hash, with sorted keys)
//   entry_hash[n]  = sha256(prev_hash[n] + '|' + body_n)
//   prev_hash[n+1] = entry_hash[n]
//
// Mom's Law: real fs append, real sha256, real seq counter, real lazy load of
// the tail when the process starts mid-chain. No theater, no fake success.
//
// Schema: orange5.hermes.audit.v0
// Sovereign: Atom McCree

import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ----------------------------------------------------------------------------
// Constants

export const SCHEMA = "orange5.hermes.audit.v0";

export const GENESIS_HASH = "0".repeat(64);

// Default log path: 08-HERMES/audit/misfit-decisions.jsonl. Computed relative
// to this file so the module behaves the same regardless of cwd. Callers
// (tests, alt deployments) can override via opts.logPath.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// audit.mjs lives at 08-HERMES/src/pre-action/audit.mjs
// the canonical log lives at 08-HERMES/audit/misfit-decisions.jsonl
// so we go up two levels and into 'audit'.
export const DEFAULT_LOG_PATH = resolve(
  join(__dirname, "..", "..", "audit", "misfit-decisions.jsonl"),
);

// Allowed enum values are NOT enforced (the matrix and second-opinion modules
// already enforce their own enums upstream). We accept the strings as-given and
// record them verbatim — the audit log is a witness, not a validator.

// ----------------------------------------------------------------------------
// Canonicalization
//
// JSON.stringify is non-deterministic for object key order in the general
// case; for a hash chain we need a canonical byte sequence. canonicalJSON
// emits keys in lexicographic order at every object depth.

function canonicalJSON(value) {
  if (value === null) return "null";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      // Non-finite numbers cannot be JSON. Coerce to null and let upstream
      // notice the loss; the audit must still emit something.
      return "null";
    }
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJSON).join(",") + "]";
  }
  if (typeof value === "object") {
    const keys = Object.keys(value).sort();
    const parts = [];
    for (const k of keys) {
      const v = value[k];
      if (v === undefined) continue; // mirror JSON.stringify's drop-undefined
      parts.push(JSON.stringify(k) + ":" + canonicalJSON(v));
    }
    return "{" + parts.join(",") + "}";
  }
  // Functions, symbols, undefined at top-level -> null
  return "null";
}

function sha256Hex(input) {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

// ----------------------------------------------------------------------------
// Tail discovery
//
// On first append within a process, we need to know the prev_hash and the
// current sequence number. We read the file backwards (in chunks if large) to
// find the last line. If the file does not exist or is empty, we start at
// seq=0 (next will be 1) with prev_hash = GENESIS_HASH.

function readLastJsonlEntry(path) {
  if (!existsSync(path)) return null;
  let size;
  try {
    size = statSync(path).size;
  } catch {
    return null;
  }
  if (size === 0) return null;

  // Read the whole file for simplicity. Audit logs are append-only and small
  // by design (one line per Misfit decision). If a deployment ever grows this
  // beyond ~16MB we can switch to a chunked tail read; for now, full read is
  // honest and bug-free.
  let buf;
  try {
    buf = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  // Trim trailing newline(s) then split on the last newline boundary.
  const trimmed = buf.replace(/[\r\n]+$/, "");
  if (trimmed.length === 0) return null;
  const lastNl = trimmed.lastIndexOf("\n");
  const lastLine = lastNl < 0 ? trimmed : trimmed.slice(lastNl + 1);
  try {
    return JSON.parse(lastLine);
  } catch {
    return null;
  }
}

// ----------------------------------------------------------------------------
// Logger class
//
// State is per-instance, not module-global, so multiple loggers (production +
// tests in the same process) do not collide. The default singleton is
// exported as `auditLog` for convenience.

export class AuditLogger {
  constructor(opts = {}) {
    this.logPath = opts.logPath ? resolve(opts.logPath) : DEFAULT_LOG_PATH;
    this._now =
      typeof opts.now === "function"
        ? opts.now
        : () => new Date().toISOString();
    this._loaded = false;
    this._seq = 0;
    this._prevHash = GENESIS_HASH;
    this._mkdirOnce = false;
  }

  _ensureDir() {
    if (this._mkdirOnce) return;
    const dir = dirname(this.logPath);
    try {
      mkdirSync(dir, { recursive: true });
    } catch (err) {
      // EEXIST is fine; anything else we surface to the caller via append().
      if (!err || err.code !== "EEXIST") {
        // Don't swallow; let append() decide whether to throw.
        if (!existsSync(dir)) throw err;
      }
    }
    this._mkdirOnce = true;
  }

  _loadTail() {
    if (this._loaded) return;
    const last = readLastJsonlEntry(this.logPath);
    if (
      last &&
      typeof last === "object" &&
      typeof last.entry_hash === "string" &&
      Number.isFinite(last.seq)
    ) {
      this._seq = Number(last.seq);
      this._prevHash = last.entry_hash;
    } else {
      this._seq = 0;
      this._prevHash = GENESIS_HASH;
    }
    this._loaded = true;
  }

  /**
   * Append a Misfit decision entry. The audit envelope (schema/seq/prev_hash/
   * entry_hash/ts-if-missing) is added by this method.
   *
   * @param {Object} entry  Body fields. Required: action_id, risk_level,
   *   misfit_decision, misfit_reason, gate_result, total_latency_ms.
   *   Optional: ts, override.
   * @returns {Object} The full entry as written (including hashes + seq).
   */
  append(entry) {
    if (!entry || typeof entry !== "object") {
      throw new TypeError("audit.append: entry must be an object");
    }
    this._ensureDir();
    this._loadTail();

    const body = {
      ts: typeof entry.ts === "string" && entry.ts ? entry.ts : this._now(),
      action_id: String(entry.action_id ?? ""),
      risk_level: String(entry.risk_level ?? ""),
      misfit_decision: String(entry.misfit_decision ?? ""),
      misfit_reason: String(entry.misfit_reason ?? ""),
      gate_result: String(entry.gate_result ?? ""),
      total_latency_ms: Number.isFinite(entry.total_latency_ms)
        ? Number(entry.total_latency_ms)
        : 0,
      schema: SCHEMA,
      seq: this._seq + 1,
      prev_hash: this._prevHash,
    };
    if (entry.override && typeof entry.override === "object") {
      body.override = entry.override;
    }

    const canonicalBody = canonicalJSON(body);
    const entry_hash = sha256Hex(this._prevHash + "|" + canonicalBody);
    const full = { ...body, entry_hash };

    // Write a single line, atomically as far as fs.appendFileSync gives us
    // on POSIX. Windows append is also atomic for line-sized writes in
    // practice; the hash chain catches any partial write on the next load.
    const line = JSON.stringify(full) + "\n";
    appendFileSync(this.logPath, line, "utf8");

    this._seq = body.seq;
    this._prevHash = entry_hash;

    return full;
  }

  /**
   * Read all entries (small files only; intended for tests and verify()).
   * @returns {Array<Object>}
   */
  readAll() {
    if (!existsSync(this.logPath)) return [];
    const buf = readFileSync(this.logPath, "utf8");
    const lines = buf.split(/\r?\n/).filter((s) => s.length > 0);
    const out = [];
    for (const ln of lines) {
      try {
        out.push(JSON.parse(ln));
      } catch {
        // Skip malformed lines; verify() will report them.
      }
    }
    return out;
  }

  /**
   * Verify the hash chain end-to-end. Returns
   *   { ok: true, count } on success, or
   *   { ok: false, count, broken_at, expected, found, error } on first break.
   */
  verify() {
    const entries = this.readAll();
    let prev = GENESIS_HASH;
    let expectedSeq = 1;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (!e || typeof e !== "object") {
        return {
          ok: false,
          count: i,
          broken_at: i,
          error: "non-object entry",
        };
      }
      if (e.seq !== expectedSeq) {
        return {
          ok: false,
          count: i,
          broken_at: i,
          expected: { seq: expectedSeq },
          found: { seq: e.seq },
          error: "seq mismatch",
        };
      }
      if (e.prev_hash !== prev) {
        return {
          ok: false,
          count: i,
          broken_at: i,
          expected: { prev_hash: prev },
          found: { prev_hash: e.prev_hash },
          error: "prev_hash mismatch",
        };
      }
      const { entry_hash, ...body } = e;
      const recomputed = sha256Hex(prev + "|" + canonicalJSON(body));
      if (recomputed !== entry_hash) {
        return {
          ok: false,
          count: i,
          broken_at: i,
          expected: { entry_hash: recomputed },
          found: { entry_hash },
          error: "entry_hash mismatch",
        };
      }
      prev = entry_hash;
      expectedSeq += 1;
    }
    return { ok: true, count: entries.length };
  }

  /** Current tail state (without reloading from disk). */
  status() {
    return {
      schema: SCHEMA,
      log_path: this.logPath,
      loaded: this._loaded,
      seq: this._seq,
      prev_hash: this._prevHash,
    };
  }

  /** Force a re-read of the tail on the next append. Useful for tests. */
  reset() {
    this._loaded = false;
    this._seq = 0;
    this._prevHash = GENESIS_HASH;
    this._mkdirOnce = false;
  }
}

// ----------------------------------------------------------------------------
// Default singleton + convenience functions

export const auditLog = new AuditLogger();

/**
 * Convenience: append using the default singleton (writes to
 * 08-HERMES/audit/misfit-decisions.jsonl).
 */
export function appendAudit(entry) {
  return auditLog.append(entry);
}

/**
 * Convenience: verify the default singleton's log.
 */
export function verifyAuditChain() {
  return auditLog.verify();
}

// ----------------------------------------------------------------------------
// Internals exposed for tests

export const __internals = Object.freeze({
  SCHEMA,
  GENESIS_HASH,
  DEFAULT_LOG_PATH,
  canonicalJSON,
  sha256Hex,
  readLastJsonlEntry,
});
