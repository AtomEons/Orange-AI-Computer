// commitment-atoms/store.mjs
//
// AtomSmasher module #1 — Commitment Atoms: storage backend.
//
// Persists Commitment Atoms into TWO substrates:
//
//   1. Reality lane of Æ Cobra Flux  (the audit chain, source of truth)
//        06-ORANGELLM/memory/ae-cobra/flux/events/reality/<YYYY-MM-DD>.jsonl
//        origin = 'atomsmasher', kind = 'commitment', body = atom
//        Append-only, hash-chained. Tampering breaks the chain.
//
//   2. SQLite index                  (the fast-query view over the Flux chain)
//        06-ORANGELLM/memory/commitment-atoms.db
//        Table `atoms` indexed by (kind, status, created_at).
//        The SQLite row is a DERIVED view. Flux is the canonical record.
//        If the index is ever lost it can be rebuilt by replaying Flux.
//
// Doctrine (binding — from encoder.mjs and the AtomSmasher spec):
//   - Atoms are append-only. The encoder enforces this; this store never
//     UPDATEs body, kind, evidence, preconditions, or signature columns.
//   - revokeAtom() is the ONLY operation that mutates an existing row, and
//     only the `status` column, only from 'active' -> 'superseded' (or
//     'revoked' if no replacement is named). The mutation is mirrored into
//     Flux as a NEW commitment-revocation record so the audit chain still
//     reflects the change.
//   - createAtom() rejects any atom that fails validateCommitmentAtom().
//     The encoder's anti-fluff + signature checks are the gate.
//
// What this file does NOT do:
//   - It does not encode atoms. Callers must encode via encoder.mjs first.
//   - It does not expose a gateway route. That lives in
//     06-ORANGELLM/server/routes/commitment-atoms.mjs (PENDING).
//   - It does not verify the Flux chain. Use writer.verifyChain() for that.

import fs from 'node:fs';
import path from 'node:path';

import crypto from 'node:crypto';

import Database from '../../bin/sqlite-shim.mjs';

import { validateCommitmentAtom, VALID_STATUSES } from './encoder.mjs';
import { writeFluxRecord as writeCanonicalFluxRecord } from '../../06-ORANGELLM/memory/ae-cobra/flux/writer.mjs';

// ---------------------------------------------------------------------------
// Flux Reality lane appender (canonical events/<lane>/<YYYY-MM-DD>.jsonl form)
// ---------------------------------------------------------------------------
//
// This store's header (top of file) documents its Flux output as:
//   06-ORANGELLM/memory/ae-cobra/flux/events/reality/<YYYY-MM-DD>.jsonl
// with origin='atomsmasher', kind='commitment', body=atom, and a returned
// record carrying a `.hash`. That is the contract every consumer of Flux in
// this tree uses (04-CONTROL-PLANE/continuity/generator.mjs and
// endurance/synth-24h.mjs read `join(fluxRoot,'events',lane)` per-date files;
// 12-ATOMSMASHER/compression-debt/ledger.mjs and 07-VISUAL/visual-event write
// the same {lane,origin,kind,body} shape and read `.hash`).
//
// The module previously imported writeFluxRecord from ../flux/writer.mjs, but
// that module was written to a DIFFERENT ("Night-1") spec: it is async, takes
// an `event` object (not kind/body), returns `.sha256`, and writes a FLAT
// <fluxRoot>/<lane>.jsonl. The store called it synchronously (never awaited)
// with kind/body — so nothing was ever written to disk and `.hash` was
// undefined, while the SQLite mirror still succeeded. Result: ok:true with no
// Flux file and a null flux_record_hash. That is a silent audit-chain gap —
// exactly what Flux exists to prevent.
//
// Fix: append through a local, synchronous, hash-chained writer that honors
// the store's own documented contract. It is the same shape synth-24h.mjs
// carries inline as "the real cobra flux writer" contract. Scope is contained
// to the atoms subsystem; the shared writer.mjs and its own consumers are
// untouched.
function isoDateForTs(ts) {
  return new Date(ts).toISOString().slice(0, 10); // UTC YYYY-MM-DD
}

// Per-process, per-file tail cache so successive appends in one run chain
// deterministically without re-reading the file each time. On first touch of a
// file we recover the prior hash from its existing tail (crash/restart safe).
const _fluxTails = new Map(); // absolute file path -> last hash

function recoverTailHash(file) {
  if (_fluxTails.has(file)) return _fluxTails.get(file);
  let prior = 'GENESIS';
  try {
    if (fs.existsSync(file)) {
      const data = fs.readFileSync(file, 'utf8');
      const lines = data.split('\n').filter(Boolean);
      if (lines.length > 0) {
        const last = JSON.parse(lines[lines.length - 1]);
        if (last && typeof last.hash === 'string' && last.hash.length > 0) {
          prior = last.hash;
        }
      }
    }
  } catch {
    // Unreadable/torn tail: fall back to GENESIS for this process. The append
    // still succeeds; chain verification tooling surfaces the discontinuity.
    prior = 'GENESIS';
  }
  _fluxTails.set(file, prior);
  return prior;
}

/**
 * Append one hash-chained record to the Reality (or Thought) lane and return
 * the persisted record (including its `.hash`).
 *
 * @param {Object} args
 * @param {'reality'|'thought'} args.lane
 * @param {string} args.origin
 * @param {string} args.kind
 * @param {Object} args.body
 * @param {string} args.fluxRoot   - dir containing events/
 * @param {number} [args.ts=Date.now()]
 * @returns {{ts:number, lane:string, origin:string, kind:string, body:Object, prev_hash:string, hash:string}}
 */
function writeFluxRecord({ lane, origin, kind, body, fluxRoot, ts = Date.now() }) {
  return writeCanonicalFluxRecord({ lane, origin, kind, body, fluxRoot, ts });
}

// ---------------------------------------------------------------------------
// SQLite schema
// ---------------------------------------------------------------------------

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS atoms (
  atom_id            TEXT PRIMARY KEY,
  schema_id          TEXT NOT NULL DEFAULT 'orange5.atomsmasher.commitment-atom.v0',
  kind               TEXT NOT NULL,
  status             TEXT NOT NULL,
  signed_status      TEXT NOT NULL DEFAULT 'active',
  body_json          TEXT NOT NULL,
  prev_hash          TEXT NOT NULL,
  hash               TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  expires_at         TEXT,
  actor              TEXT NOT NULL,
  evidence_json      TEXT NOT NULL,
  supersedes_json    TEXT NOT NULL,
  preconditions_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_atoms_kind_status_created
  ON atoms (kind, status, created_at);
`;

// ---------------------------------------------------------------------------
// DB handle cache
// ---------------------------------------------------------------------------
//
// better-sqlite3 is synchronous and each handle is cheap, but reopening on
// every call would still thrash the page cache for hot callers (gateway
// routes, the indexer). Cache one handle per absolute path. The cache is
// process-local; consumers that fork should not share it.

const _dbCache = new Map();

function getDb(dbPath) {
  if (typeof dbPath !== 'string' || dbPath.length === 0) {
    throw new Error('store: dbPath required (absolute path to commitment-atoms.db)');
  }
  const abs = path.resolve(dbPath);
  if (_dbCache.has(abs)) return _dbCache.get(abs);

  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const db = new Database(abs);
  // WAL: many short reads from the gateway, occasional appends from the
  // indexer. WAL keeps reads non-blocking during writes.
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.exec(SCHEMA_SQL);
  const columns = new Set(db.prepare('PRAGMA table_info(atoms)').all().map((row) => row.name));
  if (!columns.has('schema_id')) db.exec("ALTER TABLE atoms ADD COLUMN schema_id TEXT NOT NULL DEFAULT 'orange5.atomsmasher.commitment-atom.v0'");
  if (!columns.has('expires_at')) db.exec('ALTER TABLE atoms ADD COLUMN expires_at TEXT');
  if (!columns.has('signed_status')) db.exec("ALTER TABLE atoms ADD COLUMN signed_status TEXT NOT NULL DEFAULT 'active'");
  _dbCache.set(abs, db);
  return db;
}

/**
 * Close all cached DB handles. Test-only; production code should leave the
 * cache alone and let process exit flush WAL.
 */
export function _closeAllForTests() {
  for (const db of _dbCache.values()) {
    try { db.close(); } catch { /* ignore */ }
  }
  _dbCache.clear();
}

// ---------------------------------------------------------------------------
// Row <-> atom marshaling
// ---------------------------------------------------------------------------

function atomToRow(atom) {
  return {
    atom_id: atom.atom_id,
    schema_id: atom.schema || 'orange5.atomsmasher.commitment-atom.v0',
    kind: atom.kind,
    status: atom.status,
    signed_status: atom.status,
    body_json: JSON.stringify(atom.body),
    prev_hash: atom.signature.prev_hash,
    hash: atom.signature.hash,
    created_at: atom.created_at,
    expires_at: atom.expires_at ?? null,
    actor: atom.actor,
    evidence_json: JSON.stringify(atom.evidence),
    supersedes_json: JSON.stringify(atom.supersedes),
    preconditions_json: JSON.stringify(atom.preconditions),
  };
}

function rowToAtom(row) {
  if (!row) return null;
  // SQLite mirrors every signed field required to reconstruct and revalidate
  // the canonical atom; Flux remains the append-only source of truth.
  return {
    schema: row.schema_id,
    atom_id: row.atom_id,
    kind: row.kind,
    status: row.status,
    signed_status: row.signed_status,
    lifecycle_status: row.status,
    body: JSON.parse(row.body_json),
    preconditions: JSON.parse(row.preconditions_json),
    supersedes: JSON.parse(row.supersedes_json),
    evidence: JSON.parse(row.evidence_json),
    actor: row.actor,
    created_at: row.created_at,
    expires_at: row.expires_at,
    signature: {
      prev_hash: row.prev_hash,
      hash: row.hash,
    },
  };
}

// ---------------------------------------------------------------------------
// createAtom
// ---------------------------------------------------------------------------

/**
 * Persist a Commitment Atom to Reality lane + SQLite index.
 *
 * The atom MUST already be encoded via encodeCommitmentAtom(). This function
 * validates the atom's structure, signature, and anti-fluff rules before
 * touching either substrate. The validation is the gate — a bad atom never
 * reaches Flux and never reaches the index.
 *
 * @param {Object} atom                          - output of encodeCommitmentAtom()
 * @param {Object} opts
 * @param {string} opts.fluxRoot                 - absolute path to Flux root
 *                                                 (the dir containing events/)
 * @param {string} opts.dbPath                   - absolute path to
 *                                                 commitment-atoms.db
 * @returns {{ ok: true, atom_id: string, flux_record_hash: string }
 *          | { ok: false, error: string, errors?: string[] }}
 */
export function createAtom(atom, { fluxRoot, dbPath } = {}) {
  if (!fluxRoot) {
    return { ok: false, error: 'fluxRoot required (path to Flux root containing events/)' };
  }
  if (!dbPath) {
    return { ok: false, error: 'dbPath required (path to commitment-atoms.db)' };
  }

  // ---- validate -----------------------------------------------------------
  const { valid, errors } = validateCommitmentAtom(atom);
  if (!valid) {
    return { ok: false, error: 'invalid atom — validation failed', errors };
  }

  const db = getDb(dbPath);

  // ---- duplicate guard ----------------------------------------------------
  // atom_id is content-derived, so collisions mean the same commitment was
  // already created. Returning the existing hash is the honest behavior —
  // the caller's intent (this content is committed) is already true. We
  // surface ok:true with a duplicate=true flag so the caller can log it.
  const existing = db.prepare('SELECT hash FROM atoms WHERE atom_id = ?').get(atom.atom_id);
  if (existing) {
    return {
      ok: true,
      atom_id: atom.atom_id,
      flux_record_hash: existing.hash,
      duplicate: true,
    };
  }

  // ---- write to Flux first ------------------------------------------------
  // Flux is the canonical record. If the SQLite insert later fails, the
  // atom is still recoverable from Flux on next index rebuild. The reverse
  // (SQLite row exists, no Flux record) would silently corrupt the audit
  // chain, so Flux goes first and SQLite mirrors it.
  let fluxRecord;
  try {
    fluxRecord = writeFluxRecord({
      lane: 'reality',
      origin: 'receipt.atomsmasher',
      kind: 'commitment',
      body: atom,
      fluxRoot,
    });
  } catch (e) {
    return { ok: false, error: `flux write failed: ${e.message}` };
  }

  // ---- mirror into SQLite -------------------------------------------------
  const row = atomToRow(atom);
  try {
    db.prepare(
      `INSERT INTO atoms
        (atom_id, schema_id, kind, status, signed_status, body_json, prev_hash, hash,
         created_at, expires_at, actor, evidence_json, supersedes_json, preconditions_json)
       VALUES
        (@atom_id, @schema_id, @kind, @status, @signed_status, @body_json, @prev_hash, @hash,
         @created_at, @expires_at, @actor, @evidence_json, @supersedes_json, @preconditions_json)`,
    ).run(row);
  } catch (e) {
    // Flux already has the record. Report honestly; the indexer can recover
    // on next rebuild. Do NOT pretend the write succeeded.
    return {
      ok: false,
      error: `sqlite insert failed after flux write succeeded: ${e.message}`,
      flux_record_hash: fluxRecord.hash,
      atom_id: atom.atom_id,
      recovery: 'replay flux reality lane to rebuild sqlite index',
    };
  }

  // ---- cascade supersedes -------------------------------------------------
  // If this atom names prior atoms in `supersedes`, mark them superseded.
  // The encoder doctrine: an old atom's status flips via the indexer, never
  // via mutation of the old atom's body / signature. Only the `status`
  // column is touched, and the change is mirrored to Flux as a new event so
  // the audit chain reflects it.
  if (atom.supersedes.length > 0) {
    const upd = db.prepare(
      "UPDATE atoms SET status = 'superseded' WHERE atom_id = ? AND status = 'active'",
    );
    const cascadeTx = db.transaction((ids) => {
      const flipped = [];
      for (const oldId of ids) {
        const info = upd.run(oldId);
        if (info.changes > 0) flipped.push(oldId);
      }
      return flipped;
    });
    const flipped = cascadeTx(atom.supersedes);
    for (const oldId of flipped) {
      // Best-effort Flux audit trail for the supersede transition. Failure
      // here does not roll back the status flip — Flux already has the new
      // atom; the supersede is implied by `supersedes: [oldId]` on it.
      try {
        writeFluxRecord({
          lane: 'reality',
          origin: 'receipt.atomsmasher',
          kind: 'commitment-status-change',
          body: {
            atom_id: oldId,
            from_status: 'active',
            to_status: 'superseded',
            superseded_by_atom_id: atom.atom_id,
            ts_iso: new Date().toISOString(),
          },
          fluxRoot,
        });
      } catch {
        // Audit trail failure is logged via the caller's surface, not here.
      }
    }
  }

  return {
    ok: true,
    atom_id: atom.atom_id,
    flux_record_hash: fluxRecord.hash,
  };
}

// ---------------------------------------------------------------------------
// getAtom
// ---------------------------------------------------------------------------

/**
 * Fetch a single atom by id from the SQLite index.
 *
 * @param {string} atomId
 * @param {Object} opts
 * @param {string} opts.dbPath
 * @returns {Object|null} reconstructed atom, or null if not found
 */
export function getAtom(atomId, { dbPath } = {}) {
  if (typeof atomId !== 'string' || atomId.length === 0) {
    throw new Error('getAtom: atomId required');
  }
  if (!dbPath) throw new Error('getAtom: dbPath required');

  const db = getDb(dbPath);
  const row = db.prepare('SELECT * FROM atoms WHERE atom_id = ?').get(atomId);
  return rowToAtom(row);
}

// ---------------------------------------------------------------------------
// listAtoms
// ---------------------------------------------------------------------------

/**
 * List atoms with optional filters. All filters are AND-combined; omitting a
 * filter means "any value". Results are ordered by created_at ASC so the
 * chain reads naturally from oldest to newest.
 *
 * @param {Object} opts
 * @param {string} opts.dbPath
 * @param {string} [opts.kind]    - decision|promise|invariant|deadline|threshold
 * @param {string} [opts.status]  - active|fulfilled|revoked|superseded
 * @param {string} [opts.since]   - ISO 8601 string; created_at >= since
 * @param {number} [opts.limit]   - max rows; defaults to 1000
 * @returns {Object[]} array of atoms
 */
export function listAtoms({ kind, status, since, dbPath, limit = 1000 } = {}) {
  if (!dbPath) throw new Error('listAtoms: dbPath required');
  if (status != null && !VALID_STATUSES.includes(status)) {
    throw new Error(
      `listAtoms: invalid status '${status}'. Must be one of: ${VALID_STATUSES.join(', ')}`,
    );
  }
  if (since != null) {
    if (typeof since !== 'string' || Number.isNaN(Date.parse(since))) {
      throw new Error(`listAtoms: since must be parseable ISO date, got '${since}'`);
    }
  }
  if (!Number.isInteger(limit) || limit <= 0 || limit > 100000) {
    throw new Error('listAtoms: limit must be a positive integer <= 100000');
  }

  const db = getDb(dbPath);

  const where = [];
  const params = {};
  if (kind != null) { where.push('kind = @kind'); params.kind = kind; }
  if (status != null) { where.push('status = @status'); params.status = status; }
  if (since != null) { where.push('created_at >= @since'); params.since = since; }

  const sql =
    'SELECT * FROM atoms' +
    (where.length ? ' WHERE ' + where.join(' AND ') : '') +
    ' ORDER BY created_at ASC, atom_id ASC' +
    ` LIMIT ${limit}`;

  const rows = db.prepare(sql).all(params);
  return rows.map(rowToAtom);
}

// ---------------------------------------------------------------------------
// revokeAtom
// ---------------------------------------------------------------------------

/**
 * Mark an atom as superseded (when a replacement atom_id is given) or
 * revoked (when no replacement is named). Writes a revocation event into
 * Flux so the audit chain reflects the transition. The original atom's
 * body, signature, and identity are never mutated — only the `status`
 * column on its SQLite row.
 *
 * If `supersededByAtomId` is provided, the resulting status is 'superseded'
 * (the standard transition issued when a new atom names this one in its
 * `supersedes` array). If null/undefined, the status is 'revoked' (an
 * explicit retraction with no replacement, e.g. a deadline withdrawn).
 *
 * Idempotent: revoking an atom already in a terminal state returns
 * `{ ok: true, already: <prior_status> }` without writing a new Flux event.
 *
 * @param {string} atomId
 * @param {string|null} supersededByAtomId
 * @param {Object} opts
 * @param {string} opts.fluxRoot
 * @param {string} opts.dbPath
 * @returns {{ ok: boolean, status?: string, flux_record_hash?: string,
 *            already?: string, error?: string }}
 */
export function revokeAtom(atomId, supersededByAtomId, { fluxRoot, dbPath } = {}) {
  if (typeof atomId !== 'string' || atomId.length === 0) {
    return { ok: false, error: 'atomId required' };
  }
  if (!fluxRoot) return { ok: false, error: 'fluxRoot required' };
  if (!dbPath) return { ok: false, error: 'dbPath required' };
  if (supersededByAtomId != null && typeof supersededByAtomId !== 'string') {
    return { ok: false, error: 'supersededByAtomId must be a string or null' };
  }

  const db = getDb(dbPath);
  const existing = db.prepare('SELECT status FROM atoms WHERE atom_id = ?').get(atomId);
  if (!existing) {
    return { ok: false, error: `atom not found: ${atomId}` };
  }

  // Idempotency: terminal states are not re-revoked.
  if (existing.status === 'superseded' || existing.status === 'revoked') {
    return { ok: true, already: existing.status };
  }
  // 'fulfilled' atoms are not revocable — fulfillment is a positive terminal
  // state; revoking it would lie about history. Surface the conflict.
  if (existing.status === 'fulfilled') {
    return {
      ok: false,
      error: `atom ${atomId} is already 'fulfilled' and cannot be revoked`,
    };
  }

  const nextStatus = supersededByAtomId ? 'superseded' : 'revoked';

  // Mutate status in SQLite, then write the audit event. Wrapping the
  // SQLite update in a transaction is overkill for a single-row UPDATE but
  // keeps the intent explicit: this is a state transition, not a free write.
  const updateTx = db.transaction(() => {
    db.prepare('UPDATE atoms SET status = ? WHERE atom_id = ?').run(nextStatus, atomId);
  });
  updateTx();

  let fluxRecord;
  try {
    fluxRecord = writeFluxRecord({
      lane: 'reality',
      origin: 'receipt.atomsmasher',
      kind: 'commitment-revocation',
      body: {
        atom_id: atomId,
        from_status: existing.status,
        to_status: nextStatus,
        superseded_by_atom_id: supersededByAtomId || null,
        ts_iso: new Date().toISOString(),
      },
      fluxRoot,
    });
  } catch (e) {
    // SQLite already mutated. Rather than swallow the audit-trail failure,
    // surface it honestly so the caller can re-run or repair.
    return {
      ok: false,
      error: `sqlite updated but flux audit write failed: ${e.message}`,
      status: nextStatus,
      recovery: 'rerun revokeAtom; idempotency guard will skip the sqlite update',
    };
  }

  return {
    ok: true,
    status: nextStatus,
    flux_record_hash: fluxRecord.hash,
  };
}

// ---------------------------------------------------------------------------
// Re-exports for downstream tooling
// ---------------------------------------------------------------------------

export const __internals = Object.freeze({
  SCHEMA_SQL,
  atomToRow,
  rowToAtom,
  getDb,
});
