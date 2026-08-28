// 11-MIRAGE/adapters/atoms.mjs — READY (Wave-3).
//
// AtomSmasher Commitment Atoms mount. Memory family — Sovereign read-write,
// no per-call Hermes lease (writes_require_approval=false per index manifest).
// The Commitment Atoms store itself is the audit chain: Æ Cobra Flux Reality
// lane is the canonical record, SQLite is a derived index. Writes here go
// through 12-ATOMSMASHER/commitment-atoms/persist.mjs so encoder anti-fluff
// rules, signature continuity, and Flux audit emission all run before any row
// lands. revokeAtom routes through store.mjs revokeAtom() so the revocation
// is also mirrored to Flux as a commitment-revocation event.
//
//   read  : { op: 'get', atom_id } | { op: 'list', kind?, status?, since?, limit? }
//   write : { op: 'create', kind, body, actor, ... }   -> persist.persist()
//           { op: 'revoke', atom_id, superseded_by? }  -> store.revokeAtom()
//   healthz : verifies SQLite index reachability via listAtoms({limit:1}).
//             Honest stub when better-sqlite3 missing or store paths absent —
//             never throws.
//
// Spec: 11-MIRAGE/SPEC.md#atoms
// Backing module: 12-ATOMSMASHER/commitment-atoms/{store,persist}.mjs
//
// Reality always overrides Thought on conflict. Receipts override recollection.

import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SPEC = '11-MIRAGE/SPEC.md#atoms';

// Resolve canonical AtomSmasher paths relative to THIS file so the adapter
// works regardless of process.cwd(). Same trick persist.mjs uses internally.
//   <orange5>/11-MIRAGE/adapters/atoms.mjs
//   -> <orange5>/12-ATOMSMASHER/commitment-atoms/{store,persist}.mjs
//   -> <orange5>/06-ORANGELLM/memory/ae-cobra/flux
//   -> <orange5>/06-ORANGELLM/memory/commitment-atoms.db
const __dirname = dirname(fileURLToPath(import.meta.url));
const ORANGE5_ROOT = resolve(__dirname, '..', '..');

const DEFAULT_FLUX_ROOT = process.env.ORANGE5_FLUX_ROOT
  || resolve(ORANGE5_ROOT, '06-ORANGELLM', 'memory', 'ae-cobra', 'flux');
const DEFAULT_DB_PATH = process.env.ORANGE5_COMMITMENT_ATOMS_DB
  || resolve(ORANGE5_ROOT, '06-ORANGELLM', 'memory', 'commitment-atoms.db');
const DEFAULT_RECEIPTS_DIR = process.env.ORANGE5_COMMITMENT_RECEIPTS_DIR
  || resolve(ORANGE5_ROOT, '10-RECEIPTS', 'orange5-build');

// ──────────────────────────────────────────────────────────────────────────────
// Lazy-load AtomSmasher modules. The store imports better-sqlite3 at module
// top-level; if the native binding isn't built in this workspace, that import
// throws. We catch it and degrade healthz/read/write to honest stubs instead of
// crashing the registry — same posture as postgres.mjs vs the pg client.
// ──────────────────────────────────────────────────────────────────────────────

let _storeMod = null;
let _persistMod = null;
let _loadError = null;

async function getStore() {
  if (_storeMod) return _storeMod;
  if (_loadError) return null;
  try {
    _storeMod = await import('../../12-ATOMSMASHER/commitment-atoms/store.mjs');
    return _storeMod;
  } catch (err) {
    _loadError = String(err?.message || err);
    return null;
  }
}

async function getPersist() {
  if (_persistMod) return _persistMod;
  if (_loadError) return null;
  try {
    _persistMod = await import('../../12-ATOMSMASHER/commitment-atoms/persist.mjs');
    return _persistMod;
  } catch (err) {
    _loadError = String(err?.message || err);
    return null;
  }
}

function loadFailure(reason = 'atomsmasher_unavailable') {
  return {
    ok: false,
    reason,
    detail: _loadError || 'commitment-atoms backing modules not loadable (better-sqlite3 likely missing)',
    spec: SPEC,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────────────────────────

/**
 * read(params)
 *   { op: 'get', atom_id }                                  -> single atom or null
 *   { op: 'list', kind?, status?, since?, limit? }          -> array of atoms
 * Default op is 'get' when atom_id present, else 'list'.
 *
 * All reads go through the SQLite index for speed; canonical record is Flux.
 * No approval gate — memory-family reads are Sovereign-safe.
 */
async function read(params = {}) {
  const op = params.op
    || (typeof params.atom_id === 'string' && params.atom_id.length > 0 ? 'get' : 'list');

  const dbPath = params.dbPath || DEFAULT_DB_PATH;

  const store = await getStore();
  if (!store) return loadFailure();

  // SQLite file absence is not fatal — listAtoms on an empty index returns [],
  // and getAtom returns null. But if the parent directory doesn't even exist
  // we surface that honestly so the caller knows the store hasn't been
  // initialized yet.
  if (!existsSync(dbPath)) {
    if (op === 'get') {
      return { ok: true, op, atom: null, detail: 'index not yet initialized', spec: SPEC };
    }
    if (op === 'list') {
      return { ok: true, op, atoms: [], detail: 'index not yet initialized', spec: SPEC };
    }
  }

  try {
    if (op === 'get') {
      const atomId = String(params.atom_id || '');
      if (!atomId) {
        return { ok: false, reason: 'atom_id_required', spec: SPEC };
      }
      const atom = store.getAtom(atomId, { dbPath });
      return { ok: true, op, atom };
    }

    if (op === 'list') {
      const opts = { dbPath };
      if (typeof params.kind === 'string') opts.kind = params.kind;
      if (typeof params.status === 'string') opts.status = params.status;
      if (typeof params.since === 'string') opts.since = params.since;
      if (Number.isInteger(params.limit)) opts.limit = params.limit;
      const atoms = store.listAtoms(opts);
      return { ok: true, op, atoms, count: atoms.length };
    }

    return { ok: false, reason: 'unknown_read_op', op, spec: SPEC };
  } catch (err) {
    return { ok: false, reason: 'atoms_read_failed', detail: String(err?.message || err), spec: SPEC };
  }
}

/**
 * write(params)
 *   { op: 'create', kind, body, actor, preconditions?, supersedes?, evidence?,
 *     expires_at?, prevHash?, ts?, emitReceipt?, fluxRoot?, dbPath?, receiptsDir? }
 *     -> persist.persist() — encoder gate + Flux append + SQLite mirror + receipt
 *
 *   { op: 'revoke', atom_id, superseded_by?, fluxRoot?, dbPath? }
 *     -> store.revokeAtom() — flips status to 'superseded' (if replacement named)
 *        or 'revoked' (otherwise) and emits a commitment-revocation Flux event.
 *
 * No Hermes lease — memory-family writes do not cross out of the Sovereign
 * substrate. The encoder's anti-fluff rules and validation ARE the gate.
 */
async function write(params = {}) {
  const op = String(params.op || '').toLowerCase();

  if (op === 'create') {
    const persistMod = await getPersist();
    if (!persistMod) return loadFailure();

    // Required-field surface — match encoder contract so a caller bug becomes
    // a clean refusal instead of a thrown exception bubbling up to the
    // registry. The encoder will throw on its own gates inside persist();
    // those throws are caught and surfaced as ok:false with stage='encode'.
    if (!params.kind) return { ok: false, reason: 'kind_required', spec: SPEC };
    if (!params.body || typeof params.body !== 'object') {
      return { ok: false, reason: 'body_required', detail: 'body must be a non-null object', spec: SPEC };
    }
    if (!params.actor) return { ok: false, reason: 'actor_required', spec: SPEC };

    const persistParams = {
      kind: params.kind,
      body: params.body,
      actor: params.actor,
    };
    if (Array.isArray(params.preconditions)) persistParams.preconditions = params.preconditions;
    if (Array.isArray(params.supersedes))    persistParams.supersedes    = params.supersedes;
    if (Array.isArray(params.evidence))      persistParams.evidence      = params.evidence;
    if (params.expires_at !== undefined)     persistParams.expires_at    = params.expires_at;
    if (typeof params.prevHash === 'string') persistParams.prevHash      = params.prevHash;
    if (Number.isFinite(params.ts))          persistParams.ts            = params.ts;

    const opts = {
      fluxRoot:    params.fluxRoot    || DEFAULT_FLUX_ROOT,
      dbPath:      params.dbPath      || DEFAULT_DB_PATH,
      receiptsDir: params.receiptsDir || DEFAULT_RECEIPTS_DIR,
      emitReceipt: params.emitReceipt !== false,
    };

    let result;
    try {
      result = persistMod.persist(persistParams, opts);
    } catch (err) {
      // persist() catches its own errors and returns shaped objects; a throw
      // here means something synchronous outside encoder/store/receipt blew
      // up (e.g. fileURLToPath edge case). Surface honestly.
      return { ok: false, reason: 'atoms_create_threw', detail: String(err?.message || err), spec: SPEC };
    }

    if (!result.ok) {
      return {
        ok: false,
        reason: 'atoms_create_failed',
        stage: result.stage,
        detail: result.error,
        errors: result.errors,
        atom_id: result.atom_id || null,
        flux_record_hash: result.flux_record_hash || null,
        spec: SPEC,
      };
    }

    return {
      ok: true,
      op,
      atom_id: result.atom_id,
      atom: result.atom,
      duplicate: result.duplicate === true,
      receipt: {
        mount: 'atoms',
        action: 'commitment.create',
        atom_id: result.atom_id,
        flux_record_hash: result.flux_record_hash,
        receipt_path: result.receipt_path,
        duplicate: result.duplicate === true,
        timestamp: new Date().toISOString(),
      },
    };
  }

  if (op === 'revoke') {
    const store = await getStore();
    if (!store) return loadFailure();

    const atomId = String(params.atom_id || '');
    if (!atomId) return { ok: false, reason: 'atom_id_required', spec: SPEC };

    const supersededBy = params.superseded_by != null
      ? String(params.superseded_by)
      : null;

    const fluxRoot = params.fluxRoot || DEFAULT_FLUX_ROOT;
    const dbPath   = params.dbPath   || DEFAULT_DB_PATH;

    let result;
    try {
      result = store.revokeAtom(atomId, supersededBy, { fluxRoot, dbPath });
    } catch (err) {
      return { ok: false, reason: 'atoms_revoke_threw', detail: String(err?.message || err), spec: SPEC };
    }

    if (!result.ok) {
      return {
        ok: false,
        reason: 'atoms_revoke_failed',
        detail: result.error,
        spec: SPEC,
      };
    }

    return {
      ok: true,
      op,
      atom_id: atomId,
      status: result.status || result.already,
      already: result.already || null,
      receipt: {
        mount: 'atoms',
        action: 'commitment.revoke',
        atom_id: atomId,
        from_status: result.already || 'active',
        to_status: result.status || result.already,
        superseded_by: supersededBy,
        flux_record_hash: result.flux_record_hash || null,
        timestamp: new Date().toISOString(),
      },
    };
  }

  return {
    ok: false,
    reason: 'write_op_required',
    detail: "op must be 'create' or 'revoke'",
    spec: SPEC,
  };
}

/**
 * healthz()
 *   Touches the SQLite index via listAtoms({limit:1}). Honest stubs when:
 *     - better-sqlite3 (and therefore the store module) is not loadable
 *     - the index file does not yet exist (uninitialized substrate)
 *     - listAtoms throws (corrupt DB / permission error)
 *   Never throws.
 */
async function healthz() {
  const store = await getStore();
  if (!store) {
    return {
      ok: false,
      status: 'atomsmasher_unavailable',
      detail: _loadError || 'commitment-atoms store not loadable (better-sqlite3 likely missing)',
      spec: SPEC,
    };
  }

  if (!existsSync(DEFAULT_DB_PATH)) {
    return {
      ok: false,
      status: 'index_uninitialized',
      detail: `commitment-atoms.db not present at ${DEFAULT_DB_PATH}; first createAtom() will create it`,
      db_path: DEFAULT_DB_PATH,
      spec: SPEC,
    };
  }

  try {
    const atoms = store.listAtoms({ dbPath: DEFAULT_DB_PATH, limit: 1 });
    return {
      ok: true,
      status: 'ready',
      detail: `commitment-atoms index reachable; sample size ${atoms.length}`,
      db_path: DEFAULT_DB_PATH,
      flux_root: DEFAULT_FLUX_ROOT,
      spec: SPEC,
    };
  } catch (err) {
    return {
      ok: false,
      status: 'index_unreachable',
      detail: String(err?.message || err),
      db_path: DEFAULT_DB_PATH,
      spec: SPEC,
    };
  }
}

// Exposed for tests — not part of the adapter contract.
export const __internals = Object.freeze({
  DEFAULT_FLUX_ROOT,
  DEFAULT_DB_PATH,
  DEFAULT_RECEIPTS_DIR,
  getStore,
  getPersist,
});

export const atomsAdapter = Object.freeze({ read, write, healthz });
export default atomsAdapter;
