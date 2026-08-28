// expansion-warrants/warrants.mjs
//
// AtomSmasher module #6 — Expansion Warrants.
//
// An Expansion Warrant is an explicit, operator-signed, time-bounded
// authorization token that lets a downstream module move from one scope to a
// strictly LARGER scope. Scope expansion is rare and dangerous; without a
// warrant in hand, callers must refuse to expand.
//
// Doctrine (from AtomSmasher spec §7):
//   1. A warrant is content-addressed: `id = sha256(canonical({
//        scope_from, scope_to, operator_signature, expires_at, max_uses,
//        nonce
//      }))`. The id is deterministic over the authorization, NOT over
//      consumption state, so two callers minting the same authorization arrive
//      at the same id and collide. Consumption (used_count) is index state,
//      not identity.
//   2. Warrants are NEVER edited. `consume` increments `used_count` in the
//      index and emits a consumption event. The minted warrant body in the
//      Reality lane is byte-identical forever.
//   3. `scope_to` must be a STRICT SUPERSET of `scope_from`. A warrant that
//      removes capability or moves laterally is not a warrant — it is a new
//      decision and must be filed as a Commitment Atom of kind `decision`.
//   4. Expiry is a hard wall. A warrant past `expires_at` is dead and cannot
//      be consumed even if `used_count < max_uses`. Time is measured against
//      the consumer's clock at consume-time, NOT against the warrant's own
//      created_at — clock skew between gateway and consumer is the consumer's
//      problem to bound.
//   5. `operator_signature` is a signature over the canonical warrant body
//      (excluding the signature field itself and excluding used_count). This
//      module does NOT verify the cryptographic provenance of the signature
//      string; that is the operator-key module's job. We treat the signature
//      as an opaque, non-empty, structural credential, and we record it on
//      the warrant exactly as supplied. If the signature is empty / missing /
//      not a string, the warrant is rejected at mint time.
//   6. Anti-fluff (inherited from AtomSmasher LIVE pattern): forbidden words
//      in scope strings cause a hard reject. A warrant whose scope claims it
//      "probably" expands something is not a warrant.
//
// What this file is:
//   - The pure encoder, validator, and in-process index for Expansion
//     Warrants. No SQLite, no Æ Cobra Flux writer, no HTTP — those land in
//     sibling files (`store.mjs`, gateway routes) per the AtomSmasher LIVE
//     pattern. The index here is a Map keyed by warrant_id and exists so
//     `consume` is testable without persistence.
//
// What this file is NOT:
//   - It is not a permissions engine. It does not decide whether the
//     SCOPE strings themselves are coherent or hierarchical. Scope semantics
//     belong to the caller. We only enforce: the strings differ, they are
//     non-empty, and the operator signed off.
//
// This file exports:
//   VALID_SCOPE_FIELDS, FORBIDDEN_WORDS, WARRANT_SCHEMA_ID
//   encodeWarrant({scope_from, scope_to, operator_signature, expires_at, max_uses, nonce?, ts?})
//   validateWarrant(warrant)
//   createWarrantIndex() -> {register, get, consume, list, has}
//   isExpired(warrant, nowMs)
//   isExhausted(warrantState)
//   WARRANT_SCHEMA

import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const WARRANT_SCHEMA_ID = "orange5.atomsmasher.expansion-warrant.v0";

// Fields that participate in the warrant content hash. `used_count` is index
// state and is INTENTIONALLY excluded; consumption never changes warrant_id.
export const VALID_SCOPE_FIELDS = Object.freeze([
  "scope_from",
  "scope_to",
  "operator_signature",
  "expires_at",
  "max_uses",
  "nonce",
]);

const FORBIDDEN_WORDS = Object.freeze([
  "green_assumed",
  "looks_ok",
  "probably",
  "should_work",
]);

// Reasonable upper bound to keep warrants from being abused as bulk-blanket
// authorizations. 1000 uses is already a smell; we cap at that and surface
// the rejection rather than silently truncating.
const MAX_USES_HARD_CEILING = 1000;

// ---------------------------------------------------------------------------
// Canonical JSON + sha256 (mirrors commitment-atoms encoder exactly)
// ---------------------------------------------------------------------------

function canonicalStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalStringify).join(",") + "]";
  }
  const keys = Object.keys(value).sort();
  const parts = keys.map(
    (k) => JSON.stringify(k) + ":" + canonicalStringify(value[k]),
  );
  return "{" + parts.join(",") + "}";
}

function sha256(s) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

// ---------------------------------------------------------------------------
// Anti-fluff scan
// ---------------------------------------------------------------------------

function scanForbidden(value) {
  const hits = new Set();
  const stack = [value];
  while (stack.length) {
    const v = stack.pop();
    if (v == null) continue;
    if (typeof v === "string") {
      const lower = v.toLowerCase();
      for (const word of FORBIDDEN_WORDS) {
        if (lower.includes(word)) hits.add(word);
      }
    } else if (Array.isArray(v)) {
      for (const item of v) stack.push(item);
    } else if (typeof v === "object") {
      for (const k of Object.keys(v)) {
        const lk = k.toLowerCase();
        for (const word of FORBIDDEN_WORDS) {
          if (lk.includes(word)) hits.add(word);
        }
        stack.push(v[k]);
      }
    }
  }
  return [...hits].sort();
}

// ---------------------------------------------------------------------------
// Encoder
// ---------------------------------------------------------------------------

/**
 * Encode an Expansion Warrant.
 *
 * @param {Object} params
 * @param {string} params.scope_from           non-empty identifier of the
 *                                             current scope the caller has.
 * @param {string} params.scope_to             non-empty identifier of the
 *                                             expanded scope. MUST differ
 *                                             from scope_from.
 * @param {string} params.operator_signature   non-empty opaque signature
 *                                             credential (verified upstream).
 * @param {string} params.expires_at           ISO 8601 timestamp. Must parse
 *                                             AND must be in the future
 *                                             relative to ts.
 * @param {number} params.max_uses             positive integer, <= 1000.
 * @param {string} [params.nonce]              optional opaque uniqueness
 *                                             token. If omitted, a random
 *                                             16-byte hex string is used so
 *                                             two semantically identical
 *                                             authorizations created at
 *                                             different moments do NOT
 *                                             collide. Pass an explicit nonce
 *                                             if you want collision-on-equal
 *                                             behavior (e.g. idempotent
 *                                             retries from a caller that
 *                                             already has its own dedup key).
 * @param {number} [params.ts]                 unix ms for created_at;
 *                                             defaults to Date.now().
 * @returns {Object} warrant (with used_count=0)
 * @throws {Error} on validation or anti-fluff failure
 */
export function encodeWarrant({
  scope_from,
  scope_to,
  operator_signature,
  expires_at,
  max_uses,
  nonce,
  ts,
} = {}) {
  // ---- input shape -------------------------------------------------------
  if (typeof scope_from !== "string" || scope_from.length === 0) {
    throw new Error("expansion-warrant: scope_from must be a non-empty string");
  }
  if (typeof scope_to !== "string" || scope_to.length === 0) {
    throw new Error("expansion-warrant: scope_to must be a non-empty string");
  }
  if (scope_from === scope_to) {
    throw new Error(
      "expansion-warrant: scope_to must differ from scope_from (a warrant that does not expand is not a warrant)",
    );
  }
  if (typeof operator_signature !== "string" || operator_signature.length === 0) {
    throw new Error(
      "expansion-warrant: operator_signature must be a non-empty string (operator gate)",
    );
  }
  if (typeof expires_at !== "string" || expires_at.length === 0) {
    throw new Error("expansion-warrant: expires_at must be a non-empty ISO 8601 string");
  }
  const expMs = Date.parse(expires_at);
  if (Number.isNaN(expMs)) {
    throw new Error(`expansion-warrant: expires_at not parseable as ISO date: ${expires_at}`);
  }
  if (!Number.isInteger(max_uses) || max_uses < 1) {
    throw new Error("expansion-warrant: max_uses must be a positive integer");
  }
  if (max_uses > MAX_USES_HARD_CEILING) {
    throw new Error(
      `expansion-warrant: max_uses ${max_uses} exceeds hard ceiling ${MAX_USES_HARD_CEILING}`,
    );
  }
  if (nonce !== undefined && (typeof nonce !== "string" || nonce.length === 0)) {
    throw new Error("expansion-warrant: nonce must be a non-empty string when provided");
  }

  const createdMs = typeof ts === "number" ? ts : Date.now();
  if (expMs <= createdMs) {
    throw new Error(
      `expansion-warrant: expires_at (${expires_at}) must be in the future relative to created_at`,
    );
  }

  // ---- anti-fluff (hard reject) -----------------------------------------
  const forbidden = scanForbidden({ scope_from, scope_to });
  if (forbidden.length > 0) {
    throw new Error(
      `expansion-warrant: anti-fluff reject — scope contains forbidden words: ${forbidden.join(", ")}`,
    );
  }

  // ---- assemble + id-hash ------------------------------------------------
  // nonce default: 16 bytes of randomness, hex-encoded. Random nonce makes the
  // warrant_id stably unique per mint event even when scope/sig/expires/max
  // collide — important because two distinct authorization grants for the
  // SAME scope_to should be independently consumable. Callers who want
  // collision-on-equal semantics (idempotent retries) pass their own nonce.
  const finalNonce = typeof nonce === "string" && nonce.length > 0
    ? nonce
    : crypto.randomBytes(16).toString("hex");

  const idPayload = canonicalStringify({
    scope_from,
    scope_to,
    operator_signature,
    expires_at,
    max_uses,
    nonce: finalNonce,
  });
  const id = sha256(idPayload);

  const warrant = {
    schema: WARRANT_SCHEMA_ID,
    id,
    scope_from,
    scope_to,
    operator_signature,
    expires_at,
    used_count: 0,
    max_uses,
    nonce: finalNonce,
    created_at: new Date(createdMs).toISOString(),
  };

  return warrant;
}

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

export const WARRANT_SCHEMA = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: WARRANT_SCHEMA_ID,
  title: "Orange5 AtomSmasher Expansion Warrant v0",
  type: "object",
  required: [
    "schema",
    "id",
    "scope_from",
    "scope_to",
    "operator_signature",
    "expires_at",
    "used_count",
    "max_uses",
    "nonce",
    "created_at",
  ],
  properties: {
    schema: { const: WARRANT_SCHEMA_ID },
    id: { type: "string", pattern: "^[a-f0-9]{64}$" },
    scope_from: { type: "string", minLength: 1 },
    scope_to: { type: "string", minLength: 1 },
    operator_signature: { type: "string", minLength: 1 },
    expires_at: { type: "string", minLength: 1 },
    used_count: { type: "integer", minimum: 0 },
    max_uses: { type: "integer", minimum: 1, maximum: MAX_USES_HARD_CEILING },
    nonce: { type: "string", minLength: 1 },
    created_at: { type: "string", minLength: 1 },
  },
  additionalProperties: false,
});

/**
 * Validate a warrant's STRUCTURE + content-id integrity + anti-fluff. Does
 * NOT check expiry or usage; those are runtime checks (`isExpired`,
 * `isExhausted`) because they depend on wall-clock + index state.
 *
 * @param {unknown} warrant
 * @returns {{valid: boolean, errors: string[]}}
 */
export function validateWarrant(warrant) {
  const errors = [];

  if (warrant == null || typeof warrant !== "object" || Array.isArray(warrant)) {
    return { valid: false, errors: ["warrant must be a non-null object"] };
  }

  for (const key of WARRANT_SCHEMA.required) {
    if (!(key in warrant)) errors.push(`missing required field: ${key}`);
  }
  for (const key of Object.keys(warrant)) {
    if (!(key in WARRANT_SCHEMA.properties)) {
      errors.push(`unknown field: ${key}`);
    }
  }
  if (errors.length > 0) return { valid: false, errors };

  if (warrant.schema !== WARRANT_SCHEMA_ID) {
    errors.push(`schema must be '${WARRANT_SCHEMA_ID}', got '${warrant.schema}'`);
  }
  if (!/^[a-f0-9]{64}$/.test(warrant.id)) {
    errors.push("id must be 64-char lowercase hex (sha256)");
  }
  for (const sf of ["scope_from", "scope_to", "operator_signature", "nonce", "expires_at", "created_at"]) {
    if (typeof warrant[sf] !== "string" || warrant[sf].length === 0) {
      errors.push(`${sf} must be a non-empty string`);
    }
  }
  if (warrant.scope_from === warrant.scope_to) {
    errors.push("scope_to must differ from scope_from");
  }
  if (Number.isNaN(Date.parse(warrant.expires_at))) {
    errors.push(`expires_at not parseable as ISO date: ${warrant.expires_at}`);
  }
  if (Number.isNaN(Date.parse(warrant.created_at))) {
    errors.push(`created_at not parseable as ISO date: ${warrant.created_at}`);
  }
  if (!Number.isInteger(warrant.used_count) || warrant.used_count < 0) {
    errors.push("used_count must be a non-negative integer");
  }
  if (!Number.isInteger(warrant.max_uses) || warrant.max_uses < 1) {
    errors.push("max_uses must be a positive integer");
  }
  if (Number.isInteger(warrant.max_uses) && warrant.max_uses > MAX_USES_HARD_CEILING) {
    errors.push(`max_uses exceeds hard ceiling ${MAX_USES_HARD_CEILING}`);
  }
  if (
    Number.isInteger(warrant.used_count) &&
    Number.isInteger(warrant.max_uses) &&
    warrant.used_count > warrant.max_uses
  ) {
    errors.push("used_count cannot exceed max_uses (index corruption)");
  }

  if (errors.length > 0) return { valid: false, errors };

  // anti-fluff
  const forbidden = scanForbidden({
    scope_from: warrant.scope_from,
    scope_to: warrant.scope_to,
  });
  if (forbidden.length > 0) {
    errors.push(`anti-fluff: scope contains forbidden words: ${forbidden.join(", ")}`);
  }

  // content-id integrity. `used_count` and `created_at` are NOT in the id
  // payload — they are mint-time and runtime state respectively.
  const expectedId = sha256(
    canonicalStringify({
      scope_from: warrant.scope_from,
      scope_to: warrant.scope_to,
      operator_signature: warrant.operator_signature,
      expires_at: warrant.expires_at,
      max_uses: warrant.max_uses,
      nonce: warrant.nonce,
    }),
  );
  if (expectedId !== warrant.id) {
    errors.push(
      `id integrity: expected ${expectedId}, got ${warrant.id} (tampered or wrong canonicalization)`,
    );
  }

  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Runtime predicates
// ---------------------------------------------------------------------------

/**
 * Is the warrant expired relative to a given wall-clock?
 *
 * @param {Object} warrant
 * @param {number} [nowMs] defaults to Date.now()
 * @returns {boolean}
 */
export function isExpired(warrant, nowMs) {
  if (!warrant || typeof warrant.expires_at !== "string") return true;
  const exp = Date.parse(warrant.expires_at);
  if (Number.isNaN(exp)) return true;
  const now = typeof nowMs === "number" ? nowMs : Date.now();
  return now >= exp;
}

/**
 * Has the warrant been consumed past its allowance?
 *
 * @param {{used_count?: number, max_uses?: number}} warrantState
 * @returns {boolean}
 */
export function isExhausted(warrantState) {
  if (!warrantState) return true;
  const u = Number.isInteger(warrantState.used_count) ? warrantState.used_count : 0;
  const m = Number.isInteger(warrantState.max_uses) ? warrantState.max_uses : 0;
  if (m < 1) return true;
  return u >= m;
}

// ---------------------------------------------------------------------------
// In-process index
// ---------------------------------------------------------------------------

/**
 * Create an in-process warrant index. The index is the runtime authority on
 * `used_count`: the minted warrant body in the Reality lane is immutable, and
 * consumption events live alongside it (in the persistent store this module
 * delegates to). The Map returned here is the unit-testable surface — the
 * persistent store wraps this same shape.
 *
 * Contract:
 *   register(warrant)
 *     - Validates structure + id integrity. Throws on failure.
 *     - Refuses to register an already-expired warrant (caller bug: the mint
 *       happened in the past and is dead-on-arrival; surface the error
 *       instead of silently accepting garbage).
 *     - Idempotent on the same id: re-registering returns the existing
 *       index entry without bumping used_count.
 *   get(id) -> warrant state | null
 *   has(id) -> boolean
 *   consume(id, opts?) -> {ok, warrant, used_count, remaining}
 *     - Atomically increments used_count if and only if the warrant exists,
 *       has not expired, and has remaining uses. Returns ok=false with a
 *       reason otherwise. Never partially mutates.
 *     - opts.nowMs overrides wall-clock for tests.
 *   list({scope_to?, scope_from?}) -> warrant[]
 *     - Filtered shallow copy. Order: insertion order (Map iteration order).
 *
 * @returns {{
 *   register: (w: Object) => Object,
 *   get: (id: string) => Object|null,
 *   has: (id: string) => boolean,
 *   consume: (id: string, opts?: {nowMs?: number}) => {ok: boolean, warrant?: Object, used_count?: number, remaining?: number, reason?: string},
 *   list: (filter?: {scope_to?: string, scope_from?: string}) => Object[],
 * }}
 */
export function createWarrantIndex() {
  // Map<id, warrantState>. We store a clone, not a reference, so the caller
  // cannot mutate index state by holding the object they passed in.
  const index = new Map();

  function clone(w) {
    return JSON.parse(JSON.stringify(w));
  }

  return {
    register(warrant) {
      const v = validateWarrant(warrant);
      if (!v.valid) {
        throw new Error(`expansion-warrant register: invalid warrant — ${v.errors.join("; ")}`);
      }
      if (isExpired(warrant)) {
        throw new Error(
          `expansion-warrant register: warrant ${warrant.id} is already expired at register-time (expires_at=${warrant.expires_at})`,
        );
      }
      const existing = index.get(warrant.id);
      if (existing) {
        // Idempotent re-register: keep existing usage state, do not reset.
        return clone(existing);
      }
      const stored = clone(warrant);
      // Defensive: if a caller hands us a warrant with non-zero used_count,
      // accept it (replay from persistent store) but never let it exceed
      // max_uses — that would be index corruption surfacing.
      if (stored.used_count > stored.max_uses) {
        throw new Error(
          `expansion-warrant register: used_count ${stored.used_count} > max_uses ${stored.max_uses} (corrupt input)`,
        );
      }
      index.set(stored.id, stored);
      return clone(stored);
    },

    get(id) {
      if (typeof id !== "string") return null;
      const w = index.get(id);
      return w ? clone(w) : null;
    },

    has(id) {
      return typeof id === "string" && index.has(id);
    },

    consume(id, opts = {}) {
      if (typeof id !== "string" || id.length === 0) {
        return { ok: false, reason: "id_required" };
      }
      const w = index.get(id);
      if (!w) {
        return { ok: false, reason: "warrant_not_found" };
      }
      const now = typeof opts.nowMs === "number" ? opts.nowMs : Date.now();
      if (isExpired(w, now)) {
        return {
          ok: false,
          reason: "warrant_expired",
          warrant: clone(w),
          used_count: w.used_count,
          remaining: Math.max(0, w.max_uses - w.used_count),
        };
      }
      if (isExhausted(w)) {
        return {
          ok: false,
          reason: "warrant_exhausted",
          warrant: clone(w),
          used_count: w.used_count,
          remaining: 0,
        };
      }
      // Atomic increment in this single-threaded JS context. The persistent
      // store sibling wraps this same semantic in a SQL transaction.
      w.used_count += 1;
      return {
        ok: true,
        warrant: clone(w),
        used_count: w.used_count,
        remaining: w.max_uses - w.used_count,
      };
    },

    list(filter = {}) {
      const out = [];
      for (const w of index.values()) {
        if (filter.scope_to && w.scope_to !== filter.scope_to) continue;
        if (filter.scope_from && w.scope_from !== filter.scope_from) continue;
        out.push(clone(w));
      }
      return out;
    },
  };
}

// ---------------------------------------------------------------------------
// Re-exports for downstream tooling
// ---------------------------------------------------------------------------

export const __internals = Object.freeze({
  canonicalStringify,
  sha256,
  scanForbidden,
  FORBIDDEN_WORDS: [...FORBIDDEN_WORDS],
  MAX_USES_HARD_CEILING,
});
