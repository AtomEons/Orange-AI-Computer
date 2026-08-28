// party-line.mjs — append-only JSONL inter-department status stream.
//
// ─────────────────────────────────────────────────────────────────────────────
// What this is
// ─────────────────────────────────────────────────────────────────────────────
//
// The party-line is the shared bus every AE department can listen to. When
// FATCAT dispatches a call (dial.mjs) it writes a structured line here so that
// AE7 (review), AE11 (security), AE10 (ops), AE13 (automation) and the human
// operator can all see the same conversation in real time.
//
// Design choices, all deliberate:
//
//   * JSONL, not a database. Append-only, line-buffered, recoverable with
//     `tail -f` and `jq`. Receipts > theater.
//   * Line-atomic writes via a single `fs.appendFile` call per entry. Node's
//     fs.appendFile uses a single write(2) for payloads < PIPE_BUF (4 KiB on
//     POSIX, 8 KiB on Windows); every entry must serialize to under that limit
//     so concurrent writers do not interleave bytes mid-line. Enforced.
//   * No fsync per line. The operator can force one with {fsync:true}; default
//     is OS-buffered for throughput. Crash window is acceptable for status
//     stream, NOT for receipts (those go to 10-RECEIPTS).
//   * Each entry carries a monotonic sequence number from a writer-local
//     counter so a reader can detect gaps if it tails from a snapshot.
//   * Entries are normalized: required keys always present (null when unknown)
//     so jq/awk pipelines do not have to defend against schema drift.
//
// ─────────────────────────────────────────────────────────────────────────────
// Entry schema (party.line.v0)
// ─────────────────────────────────────────────────────────────────────────────
//
// {
//   "schema": "party.line.v0",
//   "seq": 17,                              // monotonic int, per-process
//   "logged_at_iso": "2026-06-24T15:00:00.000Z",
//   "call_id": "call-rp-pkt-...-2026-06-24T15:00:00.000Z",
//   "dialed_at_iso": "2026-06-24T15:00:00.000Z",
//   "status": "ROUTED|COMPLETED|FAILED|REJECTED|BLOCKED",
//   "reason": "GATES_MISSING" | null,
//   "dial_code": 106,                       // or null if pre-resolution failure
//   "dial_name": "AE6_CODE",
//   "from": {"lane": "operator", "operator_id": "atom"},
//   "to_department": "AE6_CODE",
//   "to_extension": "x06",
//   "risk_level": "medium",
//   "priority": 3,
//   "action_verb": "ship",
//   "artifact_primary": "Orange5",
//   "correlation_id": "pkt-...",
//   "extra": { ... }                        // dial-specific addendum
// }
//
// Mom's Law: every byte earns its place. No padding, no decoration.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1 — Constants.
// ─────────────────────────────────────────────────────────────────────────────

export const PARTY_LINE_SCHEMA = "party.line.v0";

/** Hard cap per serialized line in bytes (leaves headroom under PIPE_BUF). */
export const MAX_LINE_BYTES = 4 * 1024;

/** Statuses dial.mjs is allowed to emit. */
export const PARTY_STATUSES = Object.freeze([
  "ROUTED",     // call accepted, handler about to run
  "COMPLETED",  // handler returned ok:true
  "FAILED",     // handler threw OR returned ok:false from an exception path
  "REJECTED",   // handler returned ok:false without throwing
  "BLOCKED",    // pre-handler rejection (invalid packet, no dial code, no handler, missing gates)
]);

/**
 * Default party-line file. Lives under the control plane, NOT under
 * 10-RECEIPTS (which is for ledger-grade artifacts). This file is best-effort.
 *
 * Resolved relative to THIS module so the path works no matter who imports it
 * or what cwd they ran from.
 */
const _here = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_PARTY_LINE_PATH = path.resolve(_here, "party-line.jsonl");

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2 — Sequence counter.
//
// Per-process monotonic. Survives across imports because the module is cached.
// On process restart sequence numbers restart at 1 — readers must key on
// (logged_at_iso, call_id, seq), never on seq alone.
// ─────────────────────────────────────────────────────────────────────────────

let _seq = 0;
function _nextSeq() { _seq += 1; return _seq; }

/** Reset the sequence counter. Test fixtures only. */
export function _resetSeqForTests() { _seq = 0; }

/** Read current sequence value without advancing. */
export function currentSeq() { return _seq; }

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3 — Entry normalization & validation.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} PartyLineEntry
 * @property {string} call_id
 * @property {string} dialed_at_iso
 * @property {string} status                    PARTY_STATUSES member
 * @property {string|null} [reason]
 * @property {number|null} [dial_code]
 * @property {string|null} [dial_name]
 * @property {Object|null} [from]
 * @property {string|null} [to_department]
 * @property {string|null} [to_extension]
 * @property {string|null} [risk_level]
 * @property {number|null} [priority]
 * @property {string|null} [action_verb]
 * @property {string|null} [artifact_primary]
 * @property {string|null} [correlation_id]
 * @property {Object} [extra]
 */

/**
 * Normalize a raw entry into a canonical, fully-keyed object ready for
 * JSON.stringify. Always returns an object with EVERY required key present
 * (null when caller did not supply). Throws on missing required keys or
 * disallowed status values.
 *
 * @param {PartyLineEntry} raw
 * @param {string} loggedAtIso
 * @param {number} seq
 * @returns {Object}
 */
export function normalizeEntry(raw, loggedAtIso, seq) {
  if (!raw || typeof raw !== "object") {
    throw new Error("party-line: entry must be object");
  }
  if (typeof raw.call_id !== "string" || raw.call_id.length === 0) {
    throw new Error("party-line: entry.call_id required (non-empty string)");
  }
  if (typeof raw.dialed_at_iso !== "string" || raw.dialed_at_iso.length === 0) {
    throw new Error("party-line: entry.dialed_at_iso required (non-empty string)");
  }
  if (!PARTY_STATUSES.includes(raw.status)) {
    throw new Error(`party-line: entry.status must be one of ${PARTY_STATUSES.join(",")}, got "${raw.status}"`);
  }

  return {
    schema: PARTY_LINE_SCHEMA,
    seq,
    logged_at_iso: loggedAtIso,
    call_id: raw.call_id,
    dialed_at_iso: raw.dialed_at_iso,
    status: raw.status,
    reason: raw.reason ?? null,
    dial_code: Number.isInteger(raw.dial_code) ? raw.dial_code : null,
    dial_name: raw.dial_name ?? null,
    from: raw.from ?? null,
    to_department: raw.to_department ?? null,
    to_extension: raw.to_extension ?? null,
    risk_level: raw.risk_level ?? null,
    priority: Number.isInteger(raw.priority) ? raw.priority : (raw.priority ?? null),
    action_verb: raw.action_verb ?? null,
    artifact_primary: raw.artifact_primary ?? null,
    correlation_id: raw.correlation_id ?? null,
    extra: (raw.extra && typeof raw.extra === "object") ? raw.extra : {},
  };
}

/**
 * Structural validator for an entry already serialized/parsed back out.
 * Used by readers and tests.
 *
 * @param {Object} entry
 * @returns {{ ok: boolean, errors: Array<{code:string,message:string,path:string}> }}
 */
export function validatePartyLineEntry(entry) {
  const errs = [];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return { ok: false, errors: [{ code: "E_ROOT_TYPE", message: "entry must be object", path: "$" }] };
  }
  if (entry.schema !== PARTY_LINE_SCHEMA) {
    errs.push({ code: "E_SCHEMA", message: `bad schema "${entry.schema}"`, path: "$.schema" });
  }
  if (!Number.isInteger(entry.seq) || entry.seq < 1) {
    errs.push({ code: "E_SEQ", message: "seq must be ≥1 integer", path: "$.seq" });
  }
  if (typeof entry.logged_at_iso !== "string") {
    errs.push({ code: "E_LOGGED_AT", message: "logged_at_iso required", path: "$.logged_at_iso" });
  }
  if (typeof entry.call_id !== "string" || entry.call_id.length === 0) {
    errs.push({ code: "E_CALL_ID", message: "call_id required", path: "$.call_id" });
  }
  if (typeof entry.dialed_at_iso !== "string") {
    errs.push({ code: "E_DIALED_AT", message: "dialed_at_iso required", path: "$.dialed_at_iso" });
  }
  if (!PARTY_STATUSES.includes(entry.status)) {
    errs.push({ code: "E_STATUS", message: `bad status "${entry.status}"`, path: "$.status" });
  }
  return { ok: errs.length === 0, errors: errs };
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 4 — Append (the actual writer).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} AppendOptions
 * @property {string} [path]            - target JSONL file; defaults to DEFAULT_PARTY_LINE_PATH
 * @property {string} [now]             - ISO timestamp for logged_at_iso; defaults to Date.now()
 * @property {boolean} [fsync]          - force fsync after write (slower; rarely needed)
 * @property {boolean} [allow_oversize] - if true, throw on oversize lines; default false (truncate extras)
 */

/**
 * Append a single entry. Resolves with the canonical entry object that was
 * actually written. Throws on validation failure BEFORE touching disk —
 * partial writes are never acceptable.
 *
 * @param {PartyLineEntry} raw
 * @param {AppendOptions} [opts]
 * @returns {Promise<Object>}
 */
export async function appendPartyLine(raw, opts = {}) {
  const filePath = opts.path || DEFAULT_PARTY_LINE_PATH;
  const loggedAt = _coerceISO(opts.now) || new Date().toISOString();
  const seq = _nextSeq();

  const entry = normalizeEntry(raw, loggedAt, seq);

  // Serialize, enforce line-atomic size budget. If oversize, prune `extra`
  // first (largest variable field), then truncate stringly fields if still
  // too big. We never silently drop required keys.
  let line = JSON.stringify(entry) + "\n";
  if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
    if (opts.allow_oversize === false) {
      throw new Error(`party-line: entry exceeds MAX_LINE_BYTES (${MAX_LINE_BYTES})`);
    }
    entry.extra = { _truncated: true, _original_extra_keys: Object.keys(entry.extra || {}) };
    line = JSON.stringify(entry) + "\n";
    if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
      // Final defense — strip non-essential string fields. Keep schema/seq/
      // logged_at/call_id/dialed_at/status because readers depend on them.
      entry.action_verb = null;
      entry.artifact_primary = null;
      entry.reason = "TRUNCATED";
      line = JSON.stringify(entry) + "\n";
    }
  }

  // Ensure parent dir exists. Cheap, idempotent.
  await fsp.mkdir(path.dirname(filePath), { recursive: true });

  if (opts.fsync) {
    // Open / write / fsync / close — explicit control when caller demands durability.
    const fh = await fsp.open(filePath, "a");
    try {
      await fh.write(line, null, "utf8");
      await fh.sync();
    } finally {
      await fh.close();
    }
  } else {
    // Single-call appendFile is the line-atomic fast path.
    await fsp.appendFile(filePath, line, "utf8");
  }

  return entry;
}

/**
 * Append many entries in order. NOT a single-call atomic batch — each entry is
 * its own appendFile call so a crash mid-batch leaves a prefix of valid lines.
 * That is the correct behavior for a status stream.
 *
 * @param {PartyLineEntry[]} entries
 * @param {AppendOptions} [opts]
 * @returns {Promise<Object[]>}
 */
export async function appendMany(entries, opts = {}) {
  if (!Array.isArray(entries)) throw new Error("party-line: appendMany requires array");
  const out = [];
  for (const e of entries) {
    out.push(await appendPartyLine(e, opts));
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 5 — Read helpers (small; the file is meant for `tail` / `jq`, not
// heavy in-process consumption).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read all entries from a party-line file. Skips blank lines and lines that
 * fail JSON.parse, returning their byte offsets in `skipped`. Does NOT throw
 * on a corrupt line — preserves recovery ergonomics.
 *
 * @param {string} [filePath]
 * @returns {Promise<{ entries: Object[], skipped: Array<{line:number,reason:string}> }>}
 */
export async function readAllPartyLines(filePath = DEFAULT_PARTY_LINE_PATH) {
  let raw;
  try {
    raw = await fsp.readFile(filePath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return { entries: [], skipped: [] };
    throw err;
  }
  const lines = raw.split("\n");
  const entries = [];
  const skipped = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.length === 0) continue;
    try {
      const obj = JSON.parse(l);
      entries.push(obj);
    } catch (err) {
      skipped.push({ line: i + 1, reason: err.message });
    }
  }
  return { entries, skipped };
}

/**
 * Synchronous variant for short-lived test fixtures. Production callers
 * should use the async reader.
 */
export function readAllPartyLinesSync(filePath = DEFAULT_PARTY_LINE_PATH) {
  if (!fs.existsSync(filePath)) return { entries: [], skipped: [] };
  const raw = fs.readFileSync(filePath, "utf8");
  const lines = raw.split("\n");
  const entries = [];
  const skipped = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.length === 0) continue;
    try { entries.push(JSON.parse(l)); }
    catch (err) { skipped.push({ line: i + 1, reason: err.message }); }
  }
  return { entries, skipped };
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 6 — Tiny utilities.
// ─────────────────────────────────────────────────────────────────────────────

function _coerceISO(s) {
  if (typeof s !== "string" || s.length === 0) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 7 — CLI: tail-style dump.
//
//   node party-line.mjs                          # dump default file
//   node party-line.mjs path/to/party.jsonl
//   node party-line.mjs --validate < file.jsonl  # validate stdin entries
// ─────────────────────────────────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`) {
  const args = process.argv.slice(2);
  if (args[0] === "--validate") {
    let raw = "";
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) raw += chunk;
    const lines = raw.split("\n").filter(l => l.length > 0);
    const results = lines.map((l, i) => {
      try {
        const obj = JSON.parse(l);
        const v = validatePartyLineEntry(obj);
        return { line: i + 1, ok: v.ok, errors: v.errors };
      } catch (err) {
        return { line: i + 1, ok: false, errors: [{ code: "E_JSON", message: err.message, path: "$" }] };
      }
    });
    const ok = results.every(r => r.ok);
    console.log(JSON.stringify({ ok, count: results.length, results }, null, 2));
    process.exit(ok ? 0 : 1);
  }
  const target = args[0] || DEFAULT_PARTY_LINE_PATH;
  const { entries, skipped } = await readAllPartyLines(target);
  console.log(JSON.stringify({ file: target, count: entries.length, skipped, entries }, null, 2));
  process.exit(0);
}
