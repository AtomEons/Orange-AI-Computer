// 08-HERMES / lease-engine.mjs
//
// Hermes lease engine — bounded execution layer for every LLM action in the
// Orange5 superstack. Replaces "OpenClaw". Every action by any model
// (frontier, OrangeLLM, or otherwise) MUST pass through a lease check before
// it lands on the host. Frontier-Isolation: this module is only ever reached
// through the gateway (gateway proxies /v1/hermes/* → 127.0.0.1:7430). The
// frontier model never opens a socket here directly.
//
// Surface (the four exports the gateway and LOOM chain bind to):
//   createLease(opts)                — mint a lease, persist, return record
//   checkAction(lease, action, ctx)  — synchronous policy decision
//   revokeLease(id, reason)          — terminate a lease early
//   listActive()                     — enumerate non-expired non-revoked leases
//
// Refusal reasons (stable string codes — gateway maps to HTTP):
//   "lease_expired"               — lease.expires_at < now
//   "action_forbidden"            — action present in forbidden list
//   "operator_approval_required"  — requires_approval && !operator_approved
//   "scope_violation"             — action not in allowed list (closed-world)
//
// Storage: in-memory Map for hot path, SQLite at 08-HERMES/leases.db for
// durability across restarts. SQLite goes through the Orange5 bun:sqlite shim
// (bin/sqlite-shim.mjs) — Bun-only per operator law. Writes are synchronous
// (bun:sqlite is synchronous by design) — fine for the expected lease rate
// (handfuls per second per actor, not millions).
//
// Background reaper: setInterval sweep every REAPER_INTERVAL_MS that flips
// expired leases to status="expired" in SQLite and evicts them from the hot
// map. The interval is .unref()'d so it does not pin the process alive.
//
// Honest gaps (see also README.md):
//   - Storage runs on bun:sqlite via bin/sqlite-shim.mjs. This is Bun-only:
//     importing the shim on Node throws by design (operator law). Run under Bun.
//   - SQLite file is not encrypted at rest. Lease records are not secret
//     material on their own, but if you embed secrets in the `meta` field
//     you must encrypt before storing.
//   - The reaper is best-effort. If the process is killed between expiry
//     and the next sweep, a lease will be readable from disk as "active"
//     until the next process start (where the loader filters by expires_at).
//   - Clock is process-local (Date.now). Two Hermes daemons running against
//     the same DB file is undefined behavior — run exactly one.

import Database from "../../bin/sqlite-shim.mjs";
import { mkdirSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

// ─── constants ──────────────────────────────────────────────────────────────

const DEFAULT_FORBIDDEN = Object.freeze([
  "destructive_write",
  "production_deploy",
  "scope_expansion",
  "egress_unbounded",
]);

const RISK_LEVELS = new Set(["read_only", "low", "medium", "high", "destructive", "production"]);
const AUTO_APPROVAL_RISKS = new Set(["high", "destructive", "production"]);

const REFUSAL = Object.freeze({
  LEASE_EXPIRED: "lease_expired",
  ACTION_FORBIDDEN: "action_forbidden",
  OPERATOR_APPROVAL_REQUIRED: "operator_approval_required",
  SCOPE_VIOLATION: "scope_violation",
});

const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes
const REAPER_INTERVAL_MS = 30 * 1000;  // 30 seconds

// ─── module path resolution ─────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// src/ → 08-HERMES/leases.db
const DEFAULT_DB_PATH = resolve(__dirname, "..", "leases.db");

// ─── module state ───────────────────────────────────────────────────────────

/** @type {Map<string, HermesLease>} */
const active = new Map();
/** @type {Database | null} */
let db = null;
/** @type {NodeJS.Timeout | null} */
let reaperHandle = null;
let initialized = false;

// ─── types (JSDoc) ──────────────────────────────────────────────────────────

/**
 * @typedef {Object} HermesLease
 * @property {string} id
 * @property {string} actor             — which LLM / agent / subsystem holds it
 * @property {string[]} allowed         — closed-world allow list (verbs)
 * @property {string[]} forbidden       — deny list, DEFAULT_FORBIDDEN auto-merged
 * @property {string} targetProject     — e.g. "orange5"
 * @property {string} riskLevel         — RISK_LEVELS member
 * @property {number} expires_at        — Date.now() epoch ms
 * @property {number} created_at        — Date.now() epoch ms
 * @property {boolean} requires_approval
 * @property {string} status            — "active" | "expired" | "revoked"
 * @property {string | null} revoked_reason
 * @property {Record<string, unknown> | null} meta
 */

/**
 * @typedef {Object} CreateLeaseOpts
 * @property {string} actor
 * @property {string[]} [allowed]
 * @property {string[]} [forbidden]
 * @property {string} targetProject
 * @property {string} [riskLevel]
 * @property {number} [ttl_ms]
 * @property {boolean} [requires_approval]
 * @property {Record<string, unknown>} [meta]
 */

/**
 * @typedef {Object} CheckCtx
 * @property {boolean} [operator_approved]
 * @property {number}  [now]            — override clock for tests
 */

/**
 * @typedef {Object} CheckResult
 * @property {boolean} allowed
 * @property {string}  [reason]         — one of REFUSAL.*
 * @property {string}  [detail]         — human-readable expansion (e.g. the offending verb)
 */

// ─── structured errors ──────────────────────────────────────────────────────

export class HermesError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {Record<string, unknown>} [detail]
   */
  constructor(code, message, detail = {}) {
    super(message);
    this.name = "HermesError";
    this.code = code;
    this.detail = detail;
  }
}

// ─── init / teardown ────────────────────────────────────────────────────────

/**
 * Initialize the engine. Idempotent. Loads any active leases from disk.
 * Tests should pass { dbPath, startReaper:false } for hermetic runs.
 *
 * @param {{ dbPath?: string, startReaper?: boolean }} [opts]
 */
export function init({ dbPath = DEFAULT_DB_PATH, startReaper = true } = {}) {
  if (initialized) return;

  mkdirSync(dirname(dbPath), { recursive: true });
  db = new Database(dbPath);

  db.exec(`
    CREATE TABLE IF NOT EXISTS leases (
      id                TEXT PRIMARY KEY,
      actor             TEXT NOT NULL,
      allowed           TEXT NOT NULL,
      forbidden         TEXT NOT NULL,
      targetProject     TEXT NOT NULL,
      riskLevel         TEXT NOT NULL,
      created_at        INTEGER NOT NULL,
      expires_at        INTEGER NOT NULL,
      requires_approval INTEGER NOT NULL,
      status            TEXT NOT NULL,
      revoked_reason    TEXT,
      meta              TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_leases_status  ON leases(status);
    CREATE INDEX IF NOT EXISTS idx_leases_expires ON leases(expires_at);
  `);

  // Rehydrate the hot map with anything still-active per the clock.
  const now = Date.now();
  const rows = db
    .prepare(`SELECT * FROM leases WHERE status = 'active' AND expires_at > ?`)
    .all(now);
  for (const row of rows) {
    const lease = rowToLease(row);
    active.set(lease.id, lease);
  }
  // Mark anything past-due as expired so disk truth matches policy.
  db.prepare(`UPDATE leases SET status = 'expired' WHERE status = 'active' AND expires_at <= ?`)
    .run(now);

  if (startReaper) {
    reaperHandle = setInterval(() => reapOnce(), REAPER_INTERVAL_MS);
    reaperHandle.unref?.();
  }

  initialized = true;
}

/**
 * Close the engine. Stops the reaper and closes the DB handle. Primarily for
 * tests and clean shutdown. After close(), call init() again to resume.
 */
export function close() {
  if (reaperHandle) {
    clearInterval(reaperHandle);
    reaperHandle = null;
  }
  if (db) {
    db.close();
    db = null;
  }
  active.clear();
  initialized = false;
}

function ensureReady() {
  if (!initialized) init();
}

// ─── createLease ────────────────────────────────────────────────────────────

/**
 * Mint a Hermes lease.
 *
 * @param {CreateLeaseOpts} opts
 * @returns {HermesLease}
 */
export function createLease(opts) {
  ensureReady();

  if (!opts || typeof opts !== "object") {
    throw new HermesError("invalid_options", "createLease requires an options object");
  }
  const {
    actor,
    allowed = [],
    forbidden = [],
    targetProject,
    riskLevel = "low",
    ttl_ms = DEFAULT_TTL_MS,
    meta = null,
  } = opts;
  let { requires_approval = false } = opts;

  if (!actor || typeof actor !== "string") {
    throw new HermesError("invalid_actor", "actor must be a non-empty string");
  }
  if (!targetProject || typeof targetProject !== "string") {
    throw new HermesError("invalid_target", "targetProject must be a non-empty string");
  }
  if (!RISK_LEVELS.has(riskLevel)) {
    throw new HermesError("invalid_risk_level", `riskLevel must be one of ${[...RISK_LEVELS].join(", ")}`, { riskLevel });
  }
  if (!Array.isArray(allowed) || !allowed.every(s => typeof s === "string")) {
    throw new HermesError("invalid_allowed", "allowed must be string[]");
  }
  if (!Array.isArray(forbidden) || !forbidden.every(s => typeof s === "string")) {
    throw new HermesError("invalid_forbidden", "forbidden must be string[]");
  }
  if (typeof ttl_ms !== "number" || !Number.isFinite(ttl_ms) || ttl_ms <= 0) {
    throw new HermesError("invalid_ttl", "ttl_ms must be a positive finite number");
  }

  const mergedForbidden = Array.from(new Set([...DEFAULT_FORBIDDEN, ...forbidden]));

  // Closed-world conflict check: nothing in `allowed` may also be `forbidden`.
  for (const a of allowed) {
    if (mergedForbidden.includes(a)) {
      throw new HermesError(
        "lease_conflict",
        `action "${a}" is in both allowed and forbidden`,
        { action: a },
      );
    }
  }

  if (AUTO_APPROVAL_RISKS.has(riskLevel)) requires_approval = true;

  const now = Date.now();
  const lease = /** @type {HermesLease} */ ({
    id: `lease_${now}_${randomUUID().slice(0, 8)}`,
    actor,
    allowed: [...allowed],
    forbidden: mergedForbidden,
    targetProject,
    riskLevel,
    created_at: now,
    expires_at: now + ttl_ms,
    requires_approval,
    status: "active",
    revoked_reason: null,
    meta,
  });

  db.prepare(`
    INSERT INTO leases (id, actor, allowed, forbidden, targetProject, riskLevel,
                        created_at, expires_at, requires_approval, status,
                        revoked_reason, meta)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    lease.id,
    lease.actor,
    JSON.stringify(lease.allowed),
    JSON.stringify(lease.forbidden),
    lease.targetProject,
    lease.riskLevel,
    lease.created_at,
    lease.expires_at,
    lease.requires_approval ? 1 : 0,
    lease.status,
    lease.revoked_reason,
    lease.meta ? JSON.stringify(lease.meta) : null,
  );

  active.set(lease.id, lease);
  return lease;
}

// ─── checkAction ────────────────────────────────────────────────────────────

/**
 * Synchronous policy decision. No I/O — pure function over the lease record.
 * The gateway calls this for every action verb before it lands.
 *
 * Order of checks matters and is part of the contract:
 *   1. expiry      → lease_expired
 *   2. revocation  → lease_expired (revoked leases read as expired to callers)
 *   3. forbidden   → action_forbidden          (deny beats allow)
 *   4. allow-list  → scope_violation           (closed-world: not-listed = denied)
 *   5. approval    → operator_approval_required
 *
 * @param {HermesLease} lease
 * @param {string}      action
 * @param {CheckCtx}    [ctx]
 * @returns {CheckResult}
 */
export function checkAction(lease, action, ctx = {}) {
  if (!lease || typeof lease !== "object") {
    return { allowed: false, reason: REFUSAL.SCOPE_VIOLATION, detail: "no lease supplied" };
  }
  if (typeof action !== "string" || action.length === 0) {
    return { allowed: false, reason: REFUSAL.SCOPE_VIOLATION, detail: "action must be a non-empty string" };
  }

  const now = typeof ctx.now === "number" ? ctx.now : Date.now();

  if (lease.status === "revoked" || lease.status === "expired") {
    return { allowed: false, reason: REFUSAL.LEASE_EXPIRED, detail: `lease ${lease.status}` };
  }
  if (now >= lease.expires_at) {
    return { allowed: false, reason: REFUSAL.LEASE_EXPIRED, detail: "expires_at passed" };
  }
  if (lease.forbidden.includes(action)) {
    return { allowed: false, reason: REFUSAL.ACTION_FORBIDDEN, detail: action };
  }
  if (!lease.allowed.includes(action)) {
    return { allowed: false, reason: REFUSAL.SCOPE_VIOLATION, detail: action };
  }
  if (lease.requires_approval && !ctx.operator_approved) {
    return { allowed: false, reason: REFUSAL.OPERATOR_APPROVAL_REQUIRED, detail: action };
  }

  return { allowed: true };
}

// ─── revokeLease ────────────────────────────────────────────────────────────

/**
 * Terminate a lease early. Idempotent: revoking a missing or already-revoked
 * lease returns { ok:false } without throwing.
 *
 * @param {string} id
 * @param {string} reason
 * @returns {{ ok: boolean, lease?: HermesLease, error?: string }}
 */
export function revokeLease(id, reason) {
  ensureReady();
  if (!id || typeof id !== "string") {
    return { ok: false, error: "id must be a non-empty string" };
  }
  if (!reason || typeof reason !== "string") {
    return { ok: false, error: "reason must be a non-empty string" };
  }

  // Load from hot map first; fall back to disk so revocation works even on
  // a record that was loaded but never re-touched.
  let lease = active.get(id);
  if (!lease) {
    const row = db.prepare(`SELECT * FROM leases WHERE id = ?`).get(id);
    if (!row) return { ok: false, error: "lease not found" };
    lease = rowToLease(row);
  }
  if (lease.status !== "active") {
    return { ok: false, error: `lease already ${lease.status}` };
  }

  lease.status = "revoked";
  lease.revoked_reason = reason;
  db.prepare(`UPDATE leases SET status = 'revoked', revoked_reason = ? WHERE id = ?`)
    .run(reason, id);
  active.delete(id);

  return { ok: true, lease };
}

// ─── listActive ─────────────────────────────────────────────────────────────

/**
 * Return all currently-active leases. Filters by clock at call time so a
 * lease that expired between reaper runs is not surfaced as active.
 *
 * @returns {HermesLease[]}
 */
export function listActive() {
  ensureReady();
  const now = Date.now();
  const out = [];
  for (const lease of active.values()) {
    if (lease.status === "active" && lease.expires_at > now) out.push(lease);
  }
  // Stable order: oldest-created first.
  out.sort((a, b) => a.created_at - b.created_at);
  return out;
}

// ─── reaper ─────────────────────────────────────────────────────────────────

/**
 * Sweep once. Public so tests can drive the reaper deterministically without
 * waiting for the interval. Returns the count expired in this pass.
 *
 * @returns {number}
 */
export function reapOnce() {
  if (!initialized || !db) return 0;
  const now = Date.now();
  let expired = 0;
  for (const [id, lease] of active) {
    if (lease.expires_at <= now) {
      lease.status = "expired";
      active.delete(id);
      expired += 1;
    }
  }
  if (expired > 0) {
    db.prepare(`UPDATE leases SET status = 'expired' WHERE status = 'active' AND expires_at <= ?`)
      .run(now);
  }
  return expired;
}

// ─── helpers ────────────────────────────────────────────────────────────────

/** @returns {HermesLease} */
function rowToLease(row) {
  return {
    id: row.id,
    actor: row.actor,
    allowed: JSON.parse(row.allowed),
    forbidden: JSON.parse(row.forbidden),
    targetProject: row.targetProject,
    riskLevel: row.riskLevel,
    created_at: row.created_at,
    expires_at: row.expires_at,
    requires_approval: row.requires_approval === 1,
    status: row.status,
    revoked_reason: row.revoked_reason,
    meta: row.meta ? JSON.parse(row.meta) : null,
  };
}

// ─── exported constants (for the gateway and LOOM chain) ────────────────────

export {
  DEFAULT_FORBIDDEN,
  REFUSAL,
  REAPER_INTERVAL_MS,
  DEFAULT_TTL_MS,
  DEFAULT_DB_PATH,
};
