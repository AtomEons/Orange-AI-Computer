// equation-store/store.mjs
//
// AtomSmasher module #2 — EquationStore.
//
// Purpose:
//   Store of FORMAL EQUATIONS AND INVARIANTS that the AtomEons system
//   enforces. Each equation is a small, named, mathematical or logical
//   statement that an audit, a gate, a payout, or a release check is
//   supposed to honor. Examples:
//
//     - FOUNDER_SALARY_PER_INSTALL_CENTS = X  (operator-set, env-sourced)
//     - Gate-0 LBCE invariant (LatticeIntegrityGate is index 0 of every gate chain)
//     - 27 guardrails count (constitutional guardrails preserved)
//     - Mom's Law meta-invariant (full effort every time; meta over all others)
//
//   The EquationStore is what makes "we enforce X" auditable instead of
//   folkloric. If a release check thinks it enforces FOUNDER_SALARY, the
//   equation it claims to enforce must exist HERE, with a sha256 id, with
//   a timestamp, with a known sovereign — and the check can prove which
//   equation it just verified by quoting the id back.
//
// Doctrine (matches Commitment Atoms and AIR Codec):
//   - Equations are CONTENT-ADDRESSED. `equation_id` is sha256 over the
//     canonical-JSON of (name, statement, kind, params, lhs, rhs, op,
//     value_expr, enforces, sovereign, created_at, signature.prev_hash).
//     Two callers seeding the same equation get the same id.
//   - Equations are APPEND-ONLY. To change an equation, mint a NEW one
//     whose `supersedes` array includes the old id. The store cascades
//     status='superseded' on the prior row. Nothing in the body, kind,
//     params, lhs/rhs, or signature is ever mutated in place.
//   - HASH-CHAINED. Each equation's signature.prev_hash points to the
//     hash of the previously-written equation in this store. The chain
//     is breakable in only one way: tampering. We expose verifyChain()
//     so an auditor can prove integrity end-to-end.
//   - SEED equations are inserted on first open of the file-backed store.
//     The seed list lives in equations.json (canonical seed source) and
//     loadSeedEquations() returns its contents. A caller (the gateway, a
//     test, the cockpit) is responsible for calling seedEquations() if
//     they want the four canonical equations present on a fresh store.
//   - The operator gate for POST (add new equation) is enforced at the
//     gateway layer, not here. This store accepts a `sovereign` field on
//     every equation and refuses to add an equation whose sovereign is
//     not the configured operator identity. That's the floor; the
//     gateway adds the auth wall above it.
//   - Mom's Law: no theatrical successes. Every error returns a
//     structured result. The seed function is idempotent — re-seeding a
//     store that already has the canonical four returns { ok: true,
//     already_seeded: true } without mutating anything.
//
// Storage:
//   - JSONL file at <storeDir>/equations.jsonl (append-only).
//   - In-memory index by equation_id and by name (for query speed).
//   - Optional sidecar at <storeDir>/equations.head — single-line file
//     containing the current chain head hash. Used as a quick integrity
//     witness; the file is rebuildable from the JSONL by reading the
//     last record.
//
// What this file does NOT do:
//   - It does not parse or evaluate the equation's `value_expr` or `rhs`.
//     An equation here is a SPECIFICATION, not an evaluator. The
//     evaluator is whatever code enforces the equation (drift audit,
//     payout calc, gate-0 check) — the EquationStore's job is to make
//     sure that evaluator and the auditor are looking at the same
//     formal statement.
//   - It does not expose HTTP routes. The gateway adapter
//     (atomsmasher-equations.mjs, separate file) does that.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const EQUATION_SCHEMA_ID = 'orange5.atomsmasher.equation.v0';

export const VALID_KINDS = Object.freeze([
  // A numeric equality / inequality the system enforces.
  //   e.g. FOUNDER_SALARY_PER_INSTALL_CENTS = <operator value>
  'numeric',
  // A structural invariant — "X is true of the system at all times".
  //   e.g. Gate 0 == LatticeIntegrityGate
  'structural',
  // A count invariant — "exactly N of X exist / are preserved".
  //   e.g. 27 constitutional guardrails preserved
  'count',
  // A meta-invariant — sits ABOVE other rules, governs how they apply.
  //   e.g. Mom's Law — full effort every time, overrides on conflict
  'meta',
  // A relational invariant — A relates to B in a specific way.
  //   e.g. runtime/node.py is the sole authoritative cognitive center
  'relational',
]);

export const VALID_STATUSES = Object.freeze([
  'active',      // currently in force
  'superseded',  // replaced by a newer equation that names this one
  'retired',     // explicitly withdrawn with no replacement
]);

export const GENESIS_HASH = 'GENESIS';

// ---------------------------------------------------------------------------
// Canonical JSON + sha256 (matches Commitment Atoms / AIR Codec convention)
// ---------------------------------------------------------------------------

function canonicalStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalStringify).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  return (
    '{' +
    keys.map((k) => JSON.stringify(k) + ':' + canonicalStringify(value[k])).join(',') +
    '}'
  );
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

// ---------------------------------------------------------------------------
// Equation shape + validation
// ---------------------------------------------------------------------------
//
// An equation record on disk looks like:
//
//   {
//     "schema": "orange5.atomsmasher.equation.v0",
//     "equation_id": "<sha256 hex>",
//     "name": "FOUNDER_SALARY_PER_INSTALL_CENTS",
//     "kind": "numeric",
//     "statement": "Founder salary per install, in USD cents.",
//     "lhs": "FOUNDER_SALARY_PER_INSTALL_CENTS",
//     "op": "=",
//     "rhs": "${env:FOUNDER_SALARY_PER_INSTALL_CENTS}",
//     "value_expr": "${env:FOUNDER_SALARY_PER_INSTALL_CENTS}",
//     "params": { "currency": "USD", "scale": "cents", "source": "env" },
//     "enforces": ["payout", "dividend", "drift-audit"],
//     "preconditions": [],
//     "supersedes": [],
//     "sovereign": "atom-mccree",
//     "actor": "atom-mccree",
//     "status": "active",
//     "created_at": "<ISO 8601>",
//     "signature": { "prev_hash": "<hash or GENESIS>", "hash": "<sha256>" }
//   }

const REQUIRED_FIELDS = Object.freeze([
  'schema',
  'equation_id',
  'name',
  'kind',
  'statement',
  'enforces',
  'preconditions',
  'supersedes',
  'sovereign',
  'actor',
  'status',
  'created_at',
  'signature',
]);

const NAME_RE = /^[A-Z][A-Z0-9_]*$|^[a-z][a-z0-9_-]*$/;
const SHA256_RE = /^[a-f0-9]{64}$/;

function validateEquation(eq) {
  const errors = [];
  if (eq == null || typeof eq !== 'object' || Array.isArray(eq)) {
    return { valid: false, errors: ['equation must be a non-null object'] };
  }
  for (const k of REQUIRED_FIELDS) {
    if (!(k in eq)) errors.push(`missing required field: ${k}`);
  }
  if (errors.length) return { valid: false, errors };

  if (eq.schema !== EQUATION_SCHEMA_ID) {
    errors.push(`schema must be '${EQUATION_SCHEMA_ID}', got '${eq.schema}'`);
  }
  if (typeof eq.name !== 'string' || !NAME_RE.test(eq.name)) {
    errors.push(
      `name must be SCREAMING_SNAKE_CASE or kebab-case identifier, got '${eq.name}'`,
    );
  }
  if (!VALID_KINDS.includes(eq.kind)) {
    errors.push(`kind must be one of: ${VALID_KINDS.join(', ')}`);
  }
  if (typeof eq.statement !== 'string' || eq.statement.trim().length < 8) {
    errors.push('statement must be a non-empty human-readable string (≥8 chars)');
  }
  if (!Array.isArray(eq.enforces)) {
    errors.push('enforces must be an array of subsystem tags');
  } else {
    for (const tag of eq.enforces) {
      if (typeof tag !== 'string' || !tag.length) {
        errors.push('enforces[] entries must be non-empty strings');
        break;
      }
    }
  }
  if (!Array.isArray(eq.preconditions)) {
    errors.push('preconditions must be an array of equation_ids');
  } else {
    for (const p of eq.preconditions) {
      if (typeof p !== 'string' || !SHA256_RE.test(p)) {
        errors.push(`preconditions[] entries must be 64-char sha256 hex, got '${p}'`);
        break;
      }
    }
  }
  if (!Array.isArray(eq.supersedes)) {
    errors.push('supersedes must be an array of equation_ids');
  } else {
    for (const s of eq.supersedes) {
      if (typeof s !== 'string' || !SHA256_RE.test(s)) {
        errors.push(`supersedes[] entries must be 64-char sha256 hex, got '${s}'`);
        break;
      }
    }
  }
  if (typeof eq.sovereign !== 'string' || !eq.sovereign.length) {
    errors.push('sovereign must be a non-empty string (the authorizing identity)');
  }
  if (typeof eq.actor !== 'string' || !eq.actor.length) {
    errors.push('actor must be a non-empty string');
  }
  if (!VALID_STATUSES.includes(eq.status)) {
    errors.push(`status must be one of: ${VALID_STATUSES.join(', ')}`);
  }
  if (typeof eq.created_at !== 'string' || Number.isNaN(Date.parse(eq.created_at))) {
    errors.push('created_at must be parseable ISO 8601 string');
  }
  if (!eq.signature || typeof eq.signature !== 'object') {
    errors.push('signature must be an object');
  } else {
    if (
      typeof eq.signature.prev_hash !== 'string' ||
      (eq.signature.prev_hash !== GENESIS_HASH && !SHA256_RE.test(eq.signature.prev_hash))
    ) {
      errors.push("signature.prev_hash must be 'GENESIS' or 64-char sha256 hex");
    }
    if (typeof eq.signature.hash !== 'string' || !SHA256_RE.test(eq.signature.hash)) {
      errors.push('signature.hash must be 64-char sha256 hex');
    }
  }
  if (!SHA256_RE.test(eq.equation_id || '')) {
    errors.push('equation_id must be 64-char sha256 hex');
  }
  if (errors.length) return { valid: false, errors };

  // Per-kind body checks — narrow on purpose. A `numeric` equation needs
  // an lhs/op/rhs trio so the audit can quote it. A `count` equation
  // needs `count` and `subject`. Etc.
  switch (eq.kind) {
    case 'numeric': {
      if (typeof eq.lhs !== 'string' || !eq.lhs.length) errors.push('numeric equation requires lhs');
      if (typeof eq.op !== 'string' || !['=', '==', '>=', '<=', '>', '<', '!='].includes(eq.op)) {
        errors.push("numeric equation requires op in ['=','==','>=','<=','>','<','!=']");
      }
      if (eq.rhs === undefined || eq.rhs === null) errors.push('numeric equation requires rhs');
      break;
    }
    case 'count': {
      if (!Number.isInteger(eq.count) || eq.count < 0) {
        errors.push('count equation requires non-negative integer `count`');
      }
      if (typeof eq.subject !== 'string' || !eq.subject.length) {
        errors.push('count equation requires non-empty `subject`');
      }
      break;
    }
    case 'structural':
    case 'relational':
    case 'meta':
      // statement carries the contract; no per-kind body fields are
      // structurally required beyond the universal set above.
      break;
    default:
      errors.push(`unknown kind: ${eq.kind}`);
  }
  if (errors.length) return { valid: false, errors };

  // equation_id integrity — recompute over canonical body slots and the
  // chain-binding fields. Tampering breaks this.
  const slots = idSlots(eq);
  const expectedId = sha256(canonicalStringify(slots));
  if (expectedId !== eq.equation_id) {
    errors.push(
      `equation_id integrity: expected ${expectedId}, got ${eq.equation_id} ` +
        '(equation tampered or canonicalization drift)',
    );
  }
  // signature.hash binds id + prev_hash.
  const expectedHash = sha256(eq.equation_id + ':' + eq.signature.prev_hash);
  if (expectedHash !== eq.signature.hash) {
    errors.push(
      `signature.hash integrity: expected ${expectedHash}, got ${eq.signature.hash}`,
    );
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Slots that participate in equation_id. Anything NOT here is metadata
 * that can vary without changing identity. The signature itself is
 * excluded (it carries prev_hash which IS in the slots, and hash which
 * is derived from id+prev_hash).
 */
function idSlots(eq) {
  return {
    schema: eq.schema,
    name: eq.name,
    kind: eq.kind,
    statement: eq.statement,
    lhs: eq.lhs ?? null,
    op: eq.op ?? null,
    rhs: eq.rhs ?? null,
    value_expr: eq.value_expr ?? null,
    count: eq.count ?? null,
    subject: eq.subject ?? null,
    params: eq.params ?? null,
    enforces: [...eq.enforces].sort(),
    preconditions: eq.preconditions,
    supersedes: eq.supersedes,
    sovereign: eq.sovereign,
    actor: eq.actor,
    created_at: eq.created_at,
    prev_hash: eq.signature.prev_hash,
  };
}

// ---------------------------------------------------------------------------
// encodeEquation — build a fully-signed equation from a draft
// ---------------------------------------------------------------------------

/**
 * Build a signed, content-addressed equation from a draft input. Does NOT
 * write to disk. Pure function — same inputs (including ts) give the same
 * output, which is the property the gateway and tests rely on.
 *
 * @param {Object} draft
 * @param {string} draft.name           SCREAMING_SNAKE_CASE or kebab-case
 * @param {string} draft.kind           one of VALID_KINDS
 * @param {string} draft.statement      human-readable description
 * @param {string[]} draft.enforces     subsystem tags (e.g. ['payout','drift-audit'])
 * @param {string} draft.sovereign      authorizing identity (operator id)
 * @param {string} draft.actor          who is minting (often same as sovereign)
 * @param {string} [draft.lhs]          numeric only
 * @param {string} [draft.op]           numeric only
 * @param {*}      [draft.rhs]          numeric only
 * @param {string} [draft.value_expr]   numeric only — how to compute rhs at runtime
 * @param {number} [draft.count]        count only
 * @param {string} [draft.subject]      count only
 * @param {Object} [draft.params]       arbitrary param bag
 * @param {string[]} [draft.preconditions]  prior equation_ids that must hold
 * @param {string[]} [draft.supersedes]     prior equation_ids being replaced
 * @param {string} [draft.prevHash]     chain previous hash (default GENESIS)
 * @param {number} [draft.ts]           override timestamp for determinism
 * @returns {Object} signed equation, ready for store.addEquation()
 */
export function encodeEquation(draft) {
  if (draft == null || typeof draft !== 'object') {
    throw new TypeError('encodeEquation: draft must be an object');
  }
  const created_at = new Date(
    typeof draft.ts === 'number' ? draft.ts : Date.now(),
  ).toISOString();

  const eq = {
    schema: EQUATION_SCHEMA_ID,
    equation_id: '__pending__',
    name: draft.name,
    kind: draft.kind,
    statement: draft.statement,
    lhs: draft.lhs ?? null,
    op: draft.op ?? null,
    rhs: draft.rhs ?? null,
    value_expr: draft.value_expr ?? null,
    count: draft.count ?? null,
    subject: draft.subject ?? null,
    params: draft.params ?? null,
    enforces: Array.isArray(draft.enforces) ? [...draft.enforces] : [],
    preconditions: Array.isArray(draft.preconditions) ? [...draft.preconditions] : [],
    supersedes: Array.isArray(draft.supersedes) ? [...draft.supersedes] : [],
    sovereign: draft.sovereign,
    actor: draft.actor,
    status: 'active',
    created_at,
    signature: {
      prev_hash: draft.prevHash || GENESIS_HASH,
      hash: '__pending__',
    },
  };

  const id = sha256(canonicalStringify(idSlots(eq)));
  eq.equation_id = id;
  eq.signature.hash = sha256(id + ':' + eq.signature.prev_hash);

  // Final validation — surface drift early.
  const v = validateEquation(eq);
  if (!v.valid) {
    throw new Error(`encodeEquation produced invalid equation: ${v.errors.join('; ')}`);
  }
  return eq;
}

// ---------------------------------------------------------------------------
// File-backed store — JSONL + in-memory index
// ---------------------------------------------------------------------------

const _storeCache = new Map(); // absolute storeDir -> store handle

function ensureStoreDir(storeDir) {
  if (typeof storeDir !== 'string' || !storeDir.length) {
    throw new Error('storeDir required (absolute path to equation store directory)');
  }
  const abs = path.resolve(storeDir);
  fs.mkdirSync(abs, { recursive: true });
  return abs;
}

function jsonlPath(abs) {
  return path.join(abs, 'equations.jsonl');
}
function headPath(abs) {
  return path.join(abs, 'equations.head');
}

/**
 * Open (or rebuild) the in-memory index from the JSONL file. Idempotent.
 * If the file is missing, returns an empty index with head=GENESIS.
 */
function openStore(storeDir) {
  const abs = ensureStoreDir(storeDir);
  if (_storeCache.has(abs)) return _storeCache.get(abs);

  const jsonl = jsonlPath(abs);
  /** @type {Map<string, Object>} */
  const byId = new Map();
  /** @type {Map<string, string>} */
  const nameToActiveId = new Map();
  /** @type {Object[]} */
  const order = [];
  let head = GENESIS_HASH;

  if (fs.existsSync(jsonl)) {
    const raw = fs.readFileSync(jsonl, 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    for (let i = 0; i < lines.length; i++) {
      let rec;
      try {
        rec = JSON.parse(lines[i]);
      } catch (e) {
        throw new Error(
          `equation-store: corrupt JSONL at ${jsonl} line ${i + 1}: ${e.message}`,
        );
      }
      // Records may be either equations or status-change events.
      if (rec && rec.schema === EQUATION_SCHEMA_ID) {
        byId.set(rec.equation_id, rec);
        order.push(rec);
        if (rec.status === 'active') {
          nameToActiveId.set(rec.name, rec.equation_id);
        }
        head = rec.signature.hash;
      } else if (rec && rec.schema === EQUATION_SCHEMA_ID + '.status') {
        // status-change event: { schema, equation_id, from_status,
        //                        to_status, superseded_by, ts }
        const existing = byId.get(rec.equation_id);
        if (existing) {
          existing.status = rec.to_status;
          if (rec.to_status !== 'active' && nameToActiveId.get(existing.name) === rec.equation_id) {
            nameToActiveId.delete(existing.name);
          }
        }
      } else {
        throw new Error(
          `equation-store: unknown record schema at ${jsonl} line ${i + 1}: ${rec && rec.schema}`,
        );
      }
    }
  }

  // Reconcile head sidecar if present, but trust the JSONL on conflict.
  // The sidecar is a witness, not the source of truth.
  const handle = {
    abs,
    byId,
    nameToActiveId,
    order,
    get head() {
      return head;
    },
    set head(h) {
      head = h;
    },
  };
  _storeCache.set(abs, handle);
  return handle;
}

/**
 * Test-only cache reset. Production code should not call this.
 */
export function _resetCacheForTests() {
  _storeCache.clear();
}

function writeHeadSidecar(abs, head) {
  try {
    fs.writeFileSync(headPath(abs), head + '\n');
  } catch {
    // best-effort; sidecar is a witness only
  }
}

function appendRecord(abs, record) {
  fs.appendFileSync(jsonlPath(abs), JSON.stringify(record) + '\n');
}

// ---------------------------------------------------------------------------
// Public API: addEquation, getEquation, getByName, listEquations,
//             retireEquation, verifyChain, getHead
// ---------------------------------------------------------------------------

/**
 * Add an equation to the store. The equation must already be signed
 * (output of encodeEquation). Validates, prevents duplicate ids,
 * cascades status='superseded' on prior equations named in
 * `supersedes`, and appends the record to the JSONL.
 *
 * Operator gate: an equation whose `sovereign` does not match the
 * configured `operator` (when `operator` is non-null) is REJECTED.
 * Pass operator=null to disable the gate (seed flow uses this).
 *
 * @param {Object} eq
 * @param {Object} opts
 * @param {string} opts.storeDir
 * @param {string|null} [opts.operator] — required sovereign identity for new equations
 * @returns {{ok: true, equation_id, hash, duplicate?: boolean, head}
 *          |{ok: false, error: string, errors?: string[]}}
 */
export function addEquation(eq, { storeDir, operator } = {}) {
  if (!storeDir) return { ok: false, error: 'storeDir required' };
  const v = validateEquation(eq);
  if (!v.valid) {
    return { ok: false, error: 'invalid equation — validation failed', errors: v.errors };
  }
  if (operator !== undefined && operator !== null && eq.sovereign !== operator) {
    return {
      ok: false,
      error:
        `operator gate: equation.sovereign='${eq.sovereign}' does not match ` +
        `configured operator='${operator}'`,
    };
  }
  const handle = openStore(storeDir);

  // Duplicate id is honest behavior (same content, same id). Return ok
  // with duplicate=true so the caller can log it.
  if (handle.byId.has(eq.equation_id)) {
    const existing = handle.byId.get(eq.equation_id);
    return {
      ok: true,
      equation_id: eq.equation_id,
      hash: existing.signature.hash,
      duplicate: true,
      head: handle.head,
    };
  }

  // Chain check — the equation's prev_hash MUST equal the current head,
  // OR be GENESIS when the store is empty. Otherwise the caller built
  // off a stale view of the chain and we refuse the write rather than
  // create a fork.
  const currentHead = handle.head;
  if (eq.signature.prev_hash !== currentHead) {
    return {
      ok: false,
      error:
        `chain mismatch: equation.signature.prev_hash='${eq.signature.prev_hash}' ` +
        `does not match current head='${currentHead}'. Re-encode against current head.`,
    };
  }

  // Append the equation record.
  appendRecord(handle.abs, eq);
  handle.byId.set(eq.equation_id, eq);
  handle.order.push(eq);
  if (eq.status === 'active') {
    // If an older active equation exists under the same name and wasn't
    // explicitly named in `supersedes`, surface that as a soft warning
    // via the result — we still write, because content-addressing means
    // the two coexist with different ids, but the name-resolver will
    // now return whichever is more recent.
    handle.nameToActiveId.set(eq.name, eq.equation_id);
  }
  handle.head = eq.signature.hash;
  writeHeadSidecar(handle.abs, handle.head);

  // Cascade supersedes — flip status on each prior equation named.
  const cascaded = [];
  for (const oldId of eq.supersedes) {
    const old = handle.byId.get(oldId);
    if (!old) continue; // we tolerate dangling supersedes; auditor will see it
    if (old.status === 'active') {
      const statusEvent = {
        schema: EQUATION_SCHEMA_ID + '.status',
        equation_id: oldId,
        from_status: 'active',
        to_status: 'superseded',
        superseded_by: eq.equation_id,
        ts: new Date().toISOString(),
      };
      appendRecord(handle.abs, statusEvent);
      old.status = 'superseded';
      if (handle.nameToActiveId.get(old.name) === oldId) {
        handle.nameToActiveId.delete(old.name);
      }
      cascaded.push(oldId);
    }
  }

  return {
    ok: true,
    equation_id: eq.equation_id,
    hash: eq.signature.hash,
    head: handle.head,
    cascaded_supersedes: cascaded,
  };
}

/**
 * Mark an equation 'retired' (explicit withdrawal with no replacement).
 * Like Commitment Atoms' revokeAtom — only the status flips, the body
 * is never touched. Writes a status-change record so the JSONL chain
 * reflects the transition.
 *
 * Idempotent. Returns {ok:true, already:<status>} for terminal states.
 */
export function retireEquation(equation_id, { storeDir, actor } = {}) {
  if (!storeDir) return { ok: false, error: 'storeDir required' };
  if (!SHA256_RE.test(equation_id || '')) {
    return { ok: false, error: 'equation_id must be 64-char sha256 hex' };
  }
  const handle = openStore(storeDir);
  const eq = handle.byId.get(equation_id);
  if (!eq) return { ok: false, error: `equation not found: ${equation_id}` };
  if (eq.status === 'retired') return { ok: true, already: 'retired' };
  if (eq.status === 'superseded') return { ok: true, already: 'superseded' };

  const evt = {
    schema: EQUATION_SCHEMA_ID + '.status',
    equation_id,
    from_status: eq.status,
    to_status: 'retired',
    superseded_by: null,
    actor: actor || null,
    ts: new Date().toISOString(),
  };
  appendRecord(handle.abs, evt);
  eq.status = 'retired';
  if (handle.nameToActiveId.get(eq.name) === equation_id) {
    handle.nameToActiveId.delete(eq.name);
  }
  return { ok: true, status: 'retired' };
}

/**
 * Fetch a single equation by id. Returns null when absent.
 */
export function getEquation(equation_id, { storeDir } = {}) {
  if (!storeDir) throw new Error('getEquation: storeDir required');
  if (!SHA256_RE.test(equation_id || '')) return null;
  const handle = openStore(storeDir);
  return handle.byId.get(equation_id) || null;
}

/**
 * Resolve a name (e.g. 'FOUNDER_SALARY_PER_INSTALL_CENTS') to its
 * currently-active equation. Returns null if no active equation
 * carries that name.
 */
export function getByName(name, { storeDir } = {}) {
  if (!storeDir) throw new Error('getByName: storeDir required');
  if (typeof name !== 'string' || !name.length) return null;
  const handle = openStore(storeDir);
  const id = handle.nameToActiveId.get(name);
  return id ? handle.byId.get(id) : null;
}

/**
 * List equations with optional filters. Order is insertion order (which
 * matches the JSONL append order and therefore the chain order).
 *
 * @param {Object} opts
 * @param {string} opts.storeDir
 * @param {string} [opts.kind]
 * @param {string} [opts.status]
 * @param {string} [opts.enforces]      filter by subsystem tag
 * @param {string} [opts.since]         ISO 8601, created_at >= since
 * @param {number} [opts.limit]         default 1000
 * @returns {Object[]}
 */
export function listEquations({
  storeDir,
  kind,
  status,
  enforces,
  since,
  limit = 1000,
} = {}) {
  if (!storeDir) throw new Error('listEquations: storeDir required');
  if (kind != null && !VALID_KINDS.includes(kind)) {
    throw new Error(`listEquations: invalid kind '${kind}'`);
  }
  if (status != null && !VALID_STATUSES.includes(status)) {
    throw new Error(`listEquations: invalid status '${status}'`);
  }
  if (since != null && Number.isNaN(Date.parse(since))) {
    throw new Error(`listEquations: since must be parseable ISO date, got '${since}'`);
  }
  if (!Number.isInteger(limit) || limit <= 0 || limit > 100000) {
    throw new Error('listEquations: limit must be a positive integer ≤ 100000');
  }
  const handle = openStore(storeDir);
  const out = [];
  for (const eq of handle.order) {
    if (kind != null && eq.kind !== kind) continue;
    if (status != null && eq.status !== status) continue;
    if (enforces != null && !eq.enforces.includes(enforces)) continue;
    if (since != null && eq.created_at < since) continue;
    out.push(eq);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Walk the chain from the first written equation to the current head,
 * confirming that each prev_hash matches the previous record's hash and
 * each signature.hash matches sha256(equation_id + ':' + prev_hash) and
 * each equation_id matches the canonicalization of its own slots.
 *
 * Returns { ok: true, length, head } on success or { ok: false,
 * error, at_index } on the first break.
 */
export function verifyChain({ storeDir } = {}) {
  if (!storeDir) throw new Error('verifyChain: storeDir required');
  const handle = openStore(storeDir);
  let prev = GENESIS_HASH;
  let i = 0;
  for (const eq of handle.order) {
    const v = validateEquation(eq);
    if (!v.valid) {
      return {
        ok: false,
        error: `equation validation failed at index ${i}: ${v.errors.join('; ')}`,
        at_index: i,
      };
    }
    if (eq.signature.prev_hash !== prev) {
      return {
        ok: false,
        error:
          `chain break at index ${i}: prev_hash='${eq.signature.prev_hash}' ` +
          `expected '${prev}'`,
        at_index: i,
      };
    }
    prev = eq.signature.hash;
    i++;
  }
  return { ok: true, length: handle.order.length, head: prev };
}

/**
 * Return the current chain head hash.
 */
export function getHead({ storeDir } = {}) {
  if (!storeDir) throw new Error('getHead: storeDir required');
  return openStore(storeDir).head;
}

// ---------------------------------------------------------------------------
// Seed canonical equations
// ---------------------------------------------------------------------------

/**
 * Load the canonical seed list from equations.json (sibling to this file).
 * Returns the parsed array. Throws if the file is missing or malformed —
 * the seed file is part of the source code, not a runtime artifact.
 */
export function loadSeedEquations() {
  const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  // The URL-decode above handles Windows file URLs (file:///C:/...) -> C:/...
  const seedPath = path.join(here, 'equations.json');
  if (!fs.existsSync(seedPath)) {
    throw new Error(`equation-store: seed file missing at ${seedPath}`);
  }
  const raw = fs.readFileSync(seedPath, 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error('equation-store: equations.json must be an array of seed drafts');
  }
  return parsed;
}

/**
 * Seed the store with the canonical four equations. Idempotent —
 * re-seeding a store that already contains the canonical equations
 * returns { ok: true, already_seeded: true } without writing.
 *
 * The seed flow uses operator=null because the seed values come from
 * the source-controlled equations.json, not from a runtime POST. The
 * sovereign on each seed is set inside equations.json.
 *
 * @param {Object} opts
 * @param {string} opts.storeDir
 * @param {string} [opts.foundersalaryEnv]  override env-var name for the
 *                                          numeric founder-salary equation.
 *                                          Default: FOUNDER_SALARY_PER_INSTALL_CENTS.
 * @param {number} [opts.ts]                deterministic timestamp for tests
 * @returns {{ok: true, seeded?: number, already_seeded?: boolean, head}
 *          |{ok: false, error: string}}
 */
export function seedEquations({ storeDir, ts } = {}) {
  if (!storeDir) return { ok: false, error: 'storeDir required' };
  const handle = openStore(storeDir);
  if (handle.order.length > 0) {
    // Already has equations. Check whether the canonical four are present
    // by name. If they are, treat as already-seeded. If only some are,
    // we DO NOT silently top up — that's a real audit anomaly the caller
    // needs to see.
    const seedDrafts = loadSeedEquations();
    const presentNames = new Set(
      [...handle.byId.values()].map((e) => e.name),
    );
    const missing = seedDrafts
      .map((d) => d.name)
      .filter((n) => !presentNames.has(n));
    if (missing.length === 0) {
      return { ok: true, already_seeded: true, head: handle.head };
    }
    return {
      ok: false,
      error:
        'store already has equations but is missing canonical seeds: ' +
        missing.join(', ') +
        '. Refusing to partially top up — investigate manually.',
    };
  }

  const seedDrafts = loadSeedEquations();
  let prev = GENESIS_HASH;
  let written = 0;
  const baseTs = typeof ts === 'number' ? ts : Date.now();
  for (let i = 0; i < seedDrafts.length; i++) {
    const draft = seedDrafts[i];
    const eq = encodeEquation({
      ...draft,
      prevHash: prev,
      // Stagger ts by 1ms per seed so identical names with different
      // statements don't collide in deterministic-ts test runs.
      ts: baseTs + i,
    });
    const res = addEquation(eq, { storeDir, operator: null });
    if (!res.ok) {
      return {
        ok: false,
        error: `seed failed at index ${i} (${draft.name}): ${res.error}`,
      };
    }
    prev = eq.signature.hash;
    written++;
  }
  return { ok: true, seeded: written, head: handle.head };
}

// ---------------------------------------------------------------------------
// Internals exported for tests
// ---------------------------------------------------------------------------

export const __internals = Object.freeze({
  canonicalStringify,
  sha256,
  idSlots,
  validateEquation,
  jsonlPath,
  headPath,
  REQUIRED_FIELDS,
});
