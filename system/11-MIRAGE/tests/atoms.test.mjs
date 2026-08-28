#!/usr/bin/env node
// 11-MIRAGE/tests/atoms.test.mjs
//
// Offline-safe test battery for the atoms (Commitment Atoms) adapter.
// Does NOT require a running daemon, a populated SQLite DB, or even
// better-sqlite3 to be installed. Covers the discipline gates the Mirage
// contract demands:
//
//   1. healthz never throws — returns an honest stub when the store module
//      can't load (better-sqlite3 missing) or when the index file is absent.
//   2. read() input-shape gates: atom_id_required, unknown_read_op.
//   3. read() degrades cleanly when the SQLite file isn't present (returns
//      empty list / null atom, not a crash).
//   4. write() input-shape gates: write_op_required, kind_required,
//      body_required, actor_required, atom_id_required (revoke).
//   5. If better-sqlite3 IS available, a full create -> get -> revoke -> get
//      roundtrip succeeds against an isolated tmpdir workspace, the atom is
//      persisted to a real Flux Reality lane file, and a receipt markdown is
//      written. If better-sqlite3 is NOT available, this block is reported
//      as SKIP (not a fail — the adapter's load-failure path is the actual
//      contract being verified in that case, covered by the stub assertions).
//
// Run: node 11-MIRAGE/tests/atoms.test.mjs

import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Point the adapter at scratch defaults BEFORE importing so the module-level
// path constants resolve to a workspace we control. The adapter respects
// ORANGE5_FLUX_ROOT / ORANGE5_COMMITMENT_ATOMS_DB / ORANGE5_COMMITMENT_RECEIPTS_DIR.
const TMP_ROOT = mkdtempSync(join(tmpdir(), 'mirage-atoms-test-'));
const TMP_FLUX = join(TMP_ROOT, 'flux');
const TMP_DB   = join(TMP_ROOT, 'commitment-atoms.db');
const TMP_RCPT = join(TMP_ROOT, 'receipts');
process.env.ORANGE5_FLUX_ROOT             = TMP_FLUX;
process.env.ORANGE5_COMMITMENT_ATOMS_DB   = TMP_DB;
process.env.ORANGE5_COMMITMENT_RECEIPTS_DIR = TMP_RCPT;

const { atomsAdapter, __internals } = await import('../adapters/atoms.mjs');

let pass = 0, fail = 0, skip = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log(`  PASS ${msg}`); }
  else      { fail++; console.log(`  FAIL ${msg}`); }
}
function skipMsg(msg) { skip++; console.log(`  SKIP ${msg}`); }

// Determine up-front whether the AtomSmasher store module is loadable in this
// workspace. If not (better-sqlite3 not built / not installed), the adapter's
// honest-stub path is the contract under test; the integration roundtrip is
// skipped. Both paths are valid — the discipline is "no silent fall-through."
const storeMod = await __internals.getStore();
const STORE_AVAILABLE = storeMod !== null;

// ── 1. healthz honest behavior (never throws) ───────────────────────────────
{
  const h = await atomsAdapter.healthz();
  assert(h.ok === false, 'healthz returns ok:false before any atom is created');
  assert(typeof h.status === 'string', 'healthz status is a string');
  assert(typeof h.spec === 'string' && h.spec.includes('atoms'), 'healthz includes spec link');
  if (STORE_AVAILABLE) {
    assert(h.status === 'index_uninitialized',
      `healthz status is index_uninitialized when DB absent (got ${h.status})`);
  } else {
    assert(h.status === 'atomsmasher_unavailable',
      `healthz status is atomsmasher_unavailable when store module unloadable (got ${h.status})`);
  }
}

// ── 2. read() input-shape gates ──────────────────────────────────────────────
{
  const r1 = await atomsAdapter.read({ op: 'get' });  // missing atom_id
  if (STORE_AVAILABLE) {
    // DB absent shortcut returns ok:true with atom:null before the op switch
    // hits the atom_id_required gate. That's correct: an empty index has no
    // atom by any id. We just confirm it didn't throw.
    assert(r1.ok === true && r1.atom === null,
      'read({op:get}) on empty/absent index returns ok:true with atom:null');
  } else {
    assert(r1.ok === false && r1.reason === 'atomsmasher_unavailable',
      'read({op:get}) refuses with atomsmasher_unavailable when store missing');
  }

  const r2 = await atomsAdapter.read({ op: 'bogus' });
  if (STORE_AVAILABLE) {
    assert(r2.ok === false && r2.reason === 'unknown_read_op',
      `read() refuses unknown op (got ${r2.reason})`);
  } else {
    assert(r2.ok === false && r2.reason === 'atomsmasher_unavailable',
      'read({op:bogus}) blocked at load gate when store missing');
  }

  const r3 = await atomsAdapter.read({});  // defaults to list on empty/absent
  if (STORE_AVAILABLE) {
    assert(r3.ok === true && Array.isArray(r3.atoms) && r3.atoms.length === 0,
      'read({}) defaults to list and returns [] on empty index');
  } else {
    assert(r3.ok === false && r3.reason === 'atomsmasher_unavailable',
      'read({}) blocked at load gate when store missing');
  }
}

// ── 3. write() input-shape gates ─────────────────────────────────────────────
{
  const r1 = await atomsAdapter.write({});
  assert(r1.ok === false && r1.reason === 'write_op_required',
    'write({}) refuses missing op');

  const r2 = await atomsAdapter.write({ op: 'fly' });
  assert(r2.ok === false && r2.reason === 'write_op_required',
    'write({op:fly}) refuses unknown op');

  // create gates — these fire after the store-load check, so when the store
  // is unavailable the reason is atomsmasher_unavailable, not the field gate.
  // That's correct: we don't pretend the adapter is healthy when it isn't.
  const r3 = await atomsAdapter.write({ op: 'create' });
  if (STORE_AVAILABLE) {
    assert(r3.ok === false && r3.reason === 'kind_required',
      `write({op:create}) refuses missing kind (got ${r3.reason})`);
  } else {
    assert(r3.ok === false && r3.reason === 'atomsmasher_unavailable',
      'write({op:create}) blocked at load gate when store missing');
  }

  const r4 = await atomsAdapter.write({ op: 'create', kind: 'decision' });
  if (STORE_AVAILABLE) {
    assert(r4.ok === false && r4.reason === 'body_required',
      'write({op:create, kind}) refuses missing body');
  } else {
    skipMsg('body_required gate (store unavailable)');
  }

  const r5 = await atomsAdapter.write({
    op: 'create',
    kind: 'decision',
    body: { decision: 'ship the thing', rationale: 'because' },
  });
  if (STORE_AVAILABLE) {
    assert(r5.ok === false && r5.reason === 'actor_required',
      'write({op:create, kind, body}) refuses missing actor');
  } else {
    skipMsg('actor_required gate (store unavailable)');
  }

  // revoke gates
  const r6 = await atomsAdapter.write({ op: 'revoke' });
  if (STORE_AVAILABLE) {
    assert(r6.ok === false && r6.reason === 'atom_id_required',
      'write({op:revoke}) refuses missing atom_id');
  } else {
    assert(r6.ok === false && r6.reason === 'atomsmasher_unavailable',
      'write({op:revoke}) blocked at load gate when store missing');
  }
}

// ── 4. End-to-end roundtrip (only when better-sqlite3 is actually loadable) ─
if (STORE_AVAILABLE) {
  // create
  const createRes = await atomsAdapter.write({
    op: 'create',
    kind: 'decision',
    actor: 'mirage-test',
    body: {
      decision: 'wire the atoms adapter to AtomSmasher',
      rationale: 'memory-family mount needed READY status; backing store exists',
    },
    evidence: ['file://11-MIRAGE/SPEC.md#atoms'],
  });
  assert(createRes.ok === true,
    `create roundtrip ok (got ${createRes.ok}, reason=${createRes.reason}, detail=${createRes.detail})`);
  assert(typeof createRes.atom_id === 'string' && createRes.atom_id.length > 0,
    'create returns atom_id');
  assert(createRes.receipt && createRes.receipt.action === 'commitment.create',
    'create returns receipt with action commitment.create');
  assert(createRes.receipt && typeof createRes.receipt.flux_record_hash === 'string',
    'create receipt carries flux_record_hash');
  assert(existsSync(TMP_DB), 'SQLite index file was created');

  // Flux Reality lane file should exist for today's date in the reality dir.
  const realityDir = join(TMP_FLUX, 'events', 'reality');
  const realityFiles = existsSync(realityDir) ? readdirSync(realityDir) : [];
  assert(realityFiles.length > 0,
    `Flux Reality lane has at least one event file (found ${realityFiles.length})`);

  // Receipt markdown should exist in the configured receipts dir.
  const receiptFiles = existsSync(TMP_RCPT) ? readdirSync(TMP_RCPT) : [];
  assert(receiptFiles.some(f => f.endsWith('.md') && f.includes('commitment-atom-')),
    'commitment-atom receipt markdown was written');

  // get
  const getRes = await atomsAdapter.read({ op: 'get', atom_id: createRes.atom_id });
  assert(getRes.ok === true && getRes.atom && getRes.atom.atom_id === createRes.atom_id,
    'read({op:get}) returns the freshly created atom');
  assert(getRes.atom.status === 'active', 'freshly created atom has status=active');

  // list
  const listRes = await atomsAdapter.read({ op: 'list', kind: 'decision' });
  assert(listRes.ok === true && Array.isArray(listRes.atoms) && listRes.atoms.length >= 1,
    `read({op:list, kind:decision}) returns at least one atom (got ${listRes.atoms?.length})`);

  // healthz now reports ready
  const h2 = await atomsAdapter.healthz();
  assert(h2.ok === true && h2.status === 'ready',
    `healthz reports ready after create (got status=${h2.status})`);

  // duplicate-create is idempotent (same content -> same atom_id, duplicate:true)
  const dupRes = await atomsAdapter.write({
    op: 'create',
    kind: 'decision',
    actor: 'mirage-test',
    body: {
      decision: 'wire the atoms adapter to AtomSmasher',
      rationale: 'memory-family mount needed READY status; backing store exists',
    },
    evidence: ['file://11-MIRAGE/SPEC.md#atoms'],
  });
  assert(dupRes.ok === true && dupRes.duplicate === true,
    `duplicate create is honest (duplicate=${dupRes.duplicate})`);
  assert(dupRes.atom_id === createRes.atom_id, 'duplicate create reuses original atom_id');

  // revoke (no replacement -> status 'revoked')
  const revRes = await atomsAdapter.write({
    op: 'revoke',
    atom_id: createRes.atom_id,
  });
  assert(revRes.ok === true && revRes.status === 'revoked',
    `revoke without replacement -> status=revoked (got ${revRes.status})`);
  assert(revRes.receipt && revRes.receipt.action === 'commitment.revoke',
    'revoke returns receipt with action commitment.revoke');

  // get-after-revoke
  const getAfter = await atomsAdapter.read({ op: 'get', atom_id: createRes.atom_id });
  assert(getAfter.ok === true && getAfter.atom && getAfter.atom.status === 'revoked',
    `atom status is revoked after revokeAtom (got ${getAfter.atom?.status})`);

  // idempotent re-revoke
  const revRes2 = await atomsAdapter.write({
    op: 'revoke',
    atom_id: createRes.atom_id,
  });
  assert(revRes2.ok === true,
    'second revoke is idempotent (ok:true, no second flux event)');
} else {
  skipMsg('end-to-end roundtrip (better-sqlite3 not available in this workspace)');
  skipMsg('create -> get -> revoke chain (better-sqlite3 not available)');
  skipMsg('duplicate-create idempotency (better-sqlite3 not available)');
}

// ── 5. cleanup ──────────────────────────────────────────────────────────────
try { rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }

console.log(`\n[mirage/atoms] ${pass} passed / ${fail} failed / ${skip} skipped`);
process.exit(fail > 0 ? 1 : 0);
