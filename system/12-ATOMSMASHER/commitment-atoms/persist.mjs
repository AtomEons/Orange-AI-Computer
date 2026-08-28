// commitment-atoms/persist.mjs
//
// AtomSmasher module #1 — Commitment Atoms: persist layer.
//
// Sibling to encoder.mjs + store.mjs + decoder.mjs. This file is the SINGLE
// public entry point for "I have a thing I want to commit; do the whole chain
// and give me back the atom plus an auditable receipt."
//
// What persist() does, in order:
//
//   1. Resolves the prevHash for the new atom by reading the most recent atom
//      from the SQLite index. The atom signature chain (per-atom causal chain)
//      is independent of the Flux lane chain (audit chain), so we resolve it
//      here on the encoder's behalf. Callers may override by passing prevHash
//      explicitly (test fixtures, replay tooling).
//
//   2. Calls encoder.encodeCommitmentAtom() with all caller-provided fields.
//      The encoder's anti-fluff + signature rules are the gate; a forbidden
//      word, a missing evidence pointer, or a malformed kind throws here and
//      nothing else runs.
//
//   3. Calls store.createAtom() to write to Æ Cobra Flux Reality lane FIRST
//      (canonical record), then mirror to SQLite (fast index). The store
//      handles the supersedes cascade and Flux audit events for status flips.
//
//   4. Writes a markdown receipt to 10-RECEIPTS/orange5-build/ on the
//      project's standard receipt schema (orange5.receipt.v0). Receipt
//      filename is derived from the local date and the atom_id prefix; if
//      that file already exists (idempotent re-persist of the same atom) the
//      receipt is left untouched and the existing path is reported.
//
//   5. Returns { ok, atom, atom_id, flux_record_hash, receipt_path,
//                 duplicate?, errors? }.
//
// Doctrine (binding):
//   - Atoms are append-only. persist() never mutates an existing atom; if the
//     content-derived atom_id already exists in the store, persist() returns
//     ok:true with duplicate:true and reuses the existing flux_record_hash
//     and (if present) the prior receipt path.
//   - The receipt is a derived artifact, not the canonical record. The
//     canonical record is the Flux JSONL entry. If the receipt write fails,
//     persist() does NOT pretend success — it surfaces the receipt error and
//     hands back the atom + flux hash so the operator can re-issue the
//     receipt without re-minting the atom.
//   - prevHash resolution is best-effort over the SQLite index. If the index
//     is empty or unreachable, prevHash defaults to 'GENESIS'. This matches
//     the encoder's contract; a caller wanting strict chain continuity should
//     pass prevHash explicitly.
//
// What this file does NOT do:
//   - It does not bypass anti-fluff. The encoder gate runs first.
//   - It does not expose a gateway route. That lives in
//     06-ORANGELLM/server/routes/atomsmasher.mjs.
//   - It does not run a chain verifier. Use flux/writer.verifyChain() or
//     decoder.traverseChain() for that — both already exist.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from '../../bin/sqlite-shim.mjs';

import { encodeCommitmentAtom } from './encoder.mjs';
import { createAtom } from './store.mjs';

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

// Orange5 tree absolute roots, resolved relative to THIS file so the persist
// layer works regardless of process.cwd(). fileURLToPath is the cross-platform
// way to get a real filesystem path out of a file:// URL — on Windows the
// raw URL.pathname carries a leading slash that would break path.resolve.
//
// Callers should pass these explicitly via opts; defaults are the canonical
// production paths and are used only when the caller omits the opt. Tests
// MUST override (the smoke-test pattern uses os.tmpdir() workspaces; see
// commitment-atoms/smoke-test.mjs).

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// <orange5>/12-ATOMSMASHER/commitment-atoms/persist.mjs
//   -> <orange5>/06-ORANGELLM/memory/ae-cobra/flux
const DEFAULT_FLUX_ROOT = path.resolve(
  __dirname,
  '..',
  '..',
  '06-ORANGELLM',
  'memory',
  'ae-cobra',
  'flux',
);

const DEFAULT_DB_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  '06-ORANGELLM',
  'memory',
  'commitment-atoms.db',
);

const DEFAULT_RECEIPTS_DIR = path.resolve(
  __dirname,
  '..',
  '..',
  '10-RECEIPTS',
  'orange5-build',
);

// ---------------------------------------------------------------------------
// prevHash resolution
// ---------------------------------------------------------------------------

/**
 * Read the signature.hash of the most recently created atom from the SQLite
 * index. Used as the prevHash for the next atom's per-atom causal chain.
 *
 * Returns 'GENESIS' if the index file does not exist, the table is empty, or
 * the database cannot be opened — none of those are fatal; the encoder
 * accepts 'GENESIS' as the chain head.
 *
 * This function opens its OWN read-only-ish handle and closes it immediately
 * so it never collides with the store's cached writable handle. better-sqlite3
 * handles concurrent handles on the same DB file under WAL just fine.
 *
 * @param {string} dbPath - absolute path to commitment-atoms.db
 * @returns {string} 64-char sha256 hex, or 'GENESIS'
 */
export function resolveHeadPrevHash(dbPath) {
  if (typeof dbPath !== 'string' || dbPath.length === 0) return 'GENESIS';
  if (!fs.existsSync(dbPath)) return 'GENESIS';
  let db;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    // ORDER BY created_at then hash so two atoms with the same millisecond
    // timestamp still produce a deterministic head. Hash sort is arbitrary
    // but stable.
    const row = db
      .prepare(
        'SELECT hash FROM atoms ORDER BY created_at DESC, hash DESC LIMIT 1',
      )
      .get();
    return row && typeof row.hash === 'string' && /^[a-f0-9]{64}$/.test(row.hash)
      ? row.hash
      : 'GENESIS';
  } catch {
    return 'GENESIS';
  } finally {
    if (db) { try { db.close(); } catch { /* ignore */ } }
  }
}

// ---------------------------------------------------------------------------
// Receipt rendering
// ---------------------------------------------------------------------------

function isoDateLocal(d = new Date()) {
  // Local YYYY-MM-DD (the receipt filenames already in 10-RECEIPTS/orange5-build/
  // use local-date prefixes, not UTC). pad helper inline to stay dep-free.
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function isoOffsetLocal(d = new Date()) {
  // e.g. 2026-06-24T18:30:00-04:00
  const pad = (n) => String(n).padStart(2, '0');
  const tz = -d.getTimezoneOffset();
  const sign = tz >= 0 ? '+' : '-';
  const abs = Math.abs(tz);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

/**
 * Build the receipt markdown body. Pure — no I/O.
 *
 * @param {Object} params
 * @param {Object} params.atom            - the validated atom
 * @param {string} params.fluxRecordHash  - hash of the Flux record carrying the atom
 * @param {boolean} params.duplicate      - true when atom_id already existed
 * @param {string} params.actor           - the actor recorded on the atom
 * @returns {string} markdown
 */
function renderReceipt({ atom, fluxRecordHash, duplicate, actor }) {
  const generatedAt = isoOffsetLocal(new Date());
  const evidenceLines = atom.evidence.length
    ? atom.evidence.map((e) => `- ${e}`).join('\n')
    : '_(none — kind does not require evidence)_';
  const supersedesLines = atom.supersedes.length
    ? atom.supersedes.map((id) => `- \`${id}\``).join('\n')
    : '_(none — head of chain)_';
  const preconditionsLines = atom.preconditions.length
    ? atom.preconditions.map((id) => `- \`${id}\``).join('\n')
    : '_(none)_';

  const statusBlurb = duplicate
    ? 'COMMITMENT_ATOM_DUPLICATE_REUSED'
    : 'COMMITMENT_ATOM_PERSISTED';
  const confidenceBlurb = duplicate
    ? 'HIGH — content-derived atom_id matched a row already in the SQLite index; ' +
      'no second Flux write was issued and the existing flux_record_hash is reused.'
    : 'HIGH — atom validated, Flux Reality lane appended, SQLite mirrored.';

  // Body JSON is rendered for human review; the canonical record is the Flux
  // line, not this markdown.
  const bodyPretty = JSON.stringify(atom.body, null, 2);

  return [
    `# Receipt — Commitment Atom persisted (${atom.kind})`,
    '',
    `- **Receipt ID:** \`${isoDateLocal()}-commitment-atom-${atom.atom_id.slice(0, 12)}\``,
    `- **generated_at:** ${generatedAt}`,
    `- **schema:** \`orange5.receipt.v0\``,
    `- **actor:** ${actor}`,
    `- **status:** \`${statusBlurb}\``,
    `- **confidence:** ${confidenceBlurb}`,
    '',
    '---',
    '',
    '## Atom',
    '',
    `- **atom_id:** \`${atom.atom_id}\``,
    `- **kind:** \`${atom.kind}\``,
    `- **status:** \`${atom.status}\``,
    `- **created_at:** ${atom.created_at}`,
    `- **expires_at:** ${atom.expires_at == null ? '_(no expiry)_' : `\`${atom.expires_at}\``}`,
    `- **signature.prev_hash:** \`${atom.signature.prev_hash}\``,
    `- **signature.hash:** \`${atom.signature.hash}\``,
    `- **flux_record_hash:** \`${fluxRecordHash}\``,
    '',
    '### Body',
    '',
    '```json',
    bodyPretty,
    '```',
    '',
    '### Evidence',
    '',
    evidenceLines,
    '',
    '### Supersedes',
    '',
    supersedesLines,
    '',
    '### Preconditions',
    '',
    preconditionsLines,
    '',
    '---',
    '',
    '## Notes',
    '',
    duplicate
      ? '- The content-derived `atom_id` already existed in the store. No new Flux record was written; the original `flux_record_hash` is reproduced here so the audit trail still points at the canonical record.'
      : '- Flux Reality lane is the canonical record. This markdown is a derived, human-readable surface. Anti-fluff + signature integrity were enforced by the encoder before any write.',
    '- The SQLite index is rebuildable from the Flux JSONL by replay; the index is never the source of truth.',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// persist
// ---------------------------------------------------------------------------

/**
 * Encode an atom, write it to Flux + SQLite, and emit a 10-RECEIPTS markdown.
 * The single entry point for "commit this and prove it."
 *
 * @param {Object} params
 * @param {'decision'|'promise'|'invariant'|'deadline'|'threshold'} params.kind
 * @param {Object} params.body
 * @param {string} params.actor                    - required by encoder
 * @param {string[]} [params.preconditions]
 * @param {string[]} [params.supersedes]
 * @param {string[]} [params.evidence]
 * @param {string|null} [params.expires_at]
 * @param {string} [params.prevHash]               - override; defaults to head of chain
 * @param {number} [params.ts]                     - encoder test override
 *
 * @param {Object} [opts]
 * @param {string} [opts.fluxRoot]                 - override Flux root
 * @param {string} [opts.dbPath]                   - override SQLite index path
 * @param {string} [opts.receiptsDir]              - override receipts dir
 * @param {boolean} [opts.emitReceipt=true]        - set false to skip receipt
 *
 * @returns {{
 *   ok: boolean,
 *   atom?: Object,
 *   atom_id?: string,
 *   flux_record_hash?: string,
 *   receipt_path?: string|null,
 *   duplicate?: boolean,
 *   error?: string,
 *   errors?: string[],
 *   stage?: 'encode'|'store'|'receipt',
 * }}
 */
export function persist(params = {}, opts = {}) {
  const {
    kind,
    body,
    actor,
    preconditions = [],
    supersedes = [],
    evidence = [],
    expires_at = null,
    prevHash: prevHashOverride,
    ts,
  } = params;

  const fluxRoot = opts.fluxRoot || DEFAULT_FLUX_ROOT;
  const dbPath = opts.dbPath || DEFAULT_DB_PATH;
  const receiptsDir = opts.receiptsDir || DEFAULT_RECEIPTS_DIR;
  const emitReceipt = opts.emitReceipt !== false;

  // ---- stage 1: encode ----------------------------------------------------
  // prevHash resolution is best-effort. The encoder will throw if the result
  // is somehow not a string; we keep this defensive but plain.
  let prevHash;
  if (typeof prevHashOverride === 'string' && prevHashOverride.length > 0) {
    prevHash = prevHashOverride;
  } else {
    prevHash = resolveHeadPrevHash(dbPath);
  }

  let atom;
  try {
    atom = encodeCommitmentAtom({
      kind,
      body,
      preconditions,
      supersedes,
      evidence,
      actor,
      expires_at,
      prevHash,
      ts,
    });
  } catch (e) {
    return {
      ok: false,
      error: `encode failed: ${e.message}`,
      stage: 'encode',
    };
  }

  // ---- stage 2: store (Flux + SQLite) -------------------------------------
  const storeResult = createAtom(atom, { fluxRoot, dbPath });
  if (!storeResult.ok) {
    return {
      ok: false,
      error: storeResult.error,
      errors: storeResult.errors,
      stage: 'store',
      // If Flux did write but SQLite failed, surface what we know so the
      // operator can recover without re-minting.
      atom,
      atom_id: storeResult.atom_id || atom.atom_id,
      flux_record_hash: storeResult.flux_record_hash,
    };
  }

  const duplicate = storeResult.duplicate === true;

  // ---- stage 3: receipt ---------------------------------------------------
  let receiptPath = null;
  if (emitReceipt) {
    const filename =
      `${isoDateLocal()}-commitment-atom-${atom.atom_id.slice(0, 12)}.md`;
    receiptPath = path.join(receiptsDir, filename);

    if (duplicate && fs.existsSync(receiptPath)) {
      // Idempotent re-persist of the same content: leave the existing
      // receipt untouched. The atom_id and flux_record_hash already match.
    } else {
      try {
        fs.mkdirSync(receiptsDir, { recursive: true });
        const md = renderReceipt({
          atom,
          fluxRecordHash: storeResult.flux_record_hash,
          duplicate,
          actor,
        });
        // Use a write-then-rename pattern? Overkill for a markdown receipt.
        // Direct write is fine; receipts are append-style artifacts that don't
        // participate in the audit chain.
        fs.writeFileSync(receiptPath, md, 'utf8');
      } catch (e) {
        // Atom is already persisted in Flux + SQLite. Be honest: the receipt
        // failed, the commitment did not.
        return {
          ok: false,
          error: `receipt write failed (atom IS persisted): ${e.message}`,
          stage: 'receipt',
          atom,
          atom_id: atom.atom_id,
          flux_record_hash: storeResult.flux_record_hash,
          duplicate,
          receipt_path: null,
          recovery: 'rerun persist() with same body; duplicate guard will reuse atom and retry receipt',
        };
      }
    }
  }

  return {
    ok: true,
    atom,
    atom_id: atom.atom_id,
    flux_record_hash: storeResult.flux_record_hash,
    receipt_path: receiptPath,
    duplicate,
  };
}

// ---------------------------------------------------------------------------
// Re-exports for downstream tooling / smoke tests
// ---------------------------------------------------------------------------

export const __internals = Object.freeze({
  DEFAULT_FLUX_ROOT,
  DEFAULT_DB_PATH,
  DEFAULT_RECEIPTS_DIR,
  renderReceipt,
  isoDateLocal,
  isoOffsetLocal,
});
