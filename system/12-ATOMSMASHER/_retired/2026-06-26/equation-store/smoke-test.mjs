// equation-store/smoke-test.mjs
//
// End-to-end smoke for the EquationStore.
//
// Asserts:
//   1.  encodeEquation builds a content-addressed, signed equation
//   2.  equation_id is deterministic over slots (ts excluded except as it
//       changes created_at, which IS part of the slot set — so we test
//       both: same draft+ts -> same id; same draft+different ts ->
//       different id; signature.hash is derived from id + prev_hash)
//   3.  validateEquation catches tampering with body, statement, params,
//       prev_hash, or signature.hash
//   4.  seedEquations on a fresh store writes the four canonical equations
//       and produces a valid chain; re-seeding the same store is idempotent
//   5.  The four canonical equations are present by name with the expected
//       kinds (FOUNDER_SALARY_PER_INSTALL_CENTS=numeric, GATE_0_LBCE=structural,
//       GUARDRAILS_COUNT=count with count=27, MOMS_LAW=meta)
//   6.  verifyChain returns ok on a healthy store
//   7.  addEquation honors the operator gate — sovereign mismatch is rejected
//   8.  addEquation rejects a chain mismatch (stale prev_hash)
//   9.  Supersedes cascade: minting a successor flips the prior to
//       'superseded' and getByName resolves to the new one
//  10.  retireEquation flips active -> retired and is idempotent on terminal
//  11.  Duplicate add (same equation_id) returns ok with duplicate=true
//  12.  Filesystem persistence: opening the store from a fresh module
//       reload (simulated via _resetCacheForTests) re-reads the JSONL and
//       reconstructs the same head + chain
//
// No test framework. Exits non-zero on failure.
// Run:  node 12-ATOMSMASHER/equation-store/smoke-test.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  encodeEquation,
  addEquation,
  retireEquation,
  getEquation,
  getByName,
  listEquations,
  verifyChain,
  getHead,
  seedEquations,
  loadSeedEquations,
  EQUATION_SCHEMA_ID,
  VALID_KINDS,
  GENESIS_HASH,
  _resetCacheForTests,
  __internals,
} from './store.mjs';

let failed = 0;
function check(label, cond, detail) {
  if (cond) {
    console.log(`  ok   ${label}`);
  } else {
    console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`);
    failed++;
  }
}

function mkStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eqstore-'));
  return dir;
}

function rmStore(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// 1. encodeEquation builds a signed, content-addressed equation
// ---------------------------------------------------------------------------
console.log('1. encodeEquation builds a signed equation');
const draftA = {
  name: 'TEST_SAMPLE_NUMERIC',
  kind: 'numeric',
  statement: 'Sample numeric equation used by the smoke test fixture.',
  lhs: 'X',
  op: '=',
  rhs: 42,
  enforces: ['drift-audit'],
  sovereign: 'atom-mccree',
  actor: 'atom-mccree',
  ts: 1_700_000_000_000,
};
const eqA = encodeEquation(draftA);
check('schema is equation.v0', eqA.schema === EQUATION_SCHEMA_ID);
check('equation_id is 64-char hex', /^[a-f0-9]{64}$/.test(eqA.equation_id));
check('signature.hash is 64-char hex', /^[a-f0-9]{64}$/.test(eqA.signature.hash));
check('signature.prev_hash is GENESIS by default', eqA.signature.prev_hash === GENESIS_HASH);
check('status defaults to active', eqA.status === 'active');

// ---------------------------------------------------------------------------
// 2. Determinism and signature derivation
// ---------------------------------------------------------------------------
console.log('2. determinism and signature derivation');
const eqAagain = encodeEquation(draftA);
check('same draft+ts -> same equation_id', eqA.equation_id === eqAagain.equation_id);
check('same draft+ts -> same hash', eqA.signature.hash === eqAagain.signature.hash);

const eqDifferentTs = encodeEquation({ ...draftA, ts: 1_700_000_001_000 });
check(
  'different ts -> different equation_id (created_at IS part of id slots)',
  eqDifferentTs.equation_id !== eqA.equation_id,
);

const eqDifferentPrev = encodeEquation({ ...draftA, prevHash: 'a'.repeat(64) });
check(
  'different prevHash -> different equation_id',
  eqDifferentPrev.equation_id !== eqA.equation_id,
);
check(
  'signature.hash === sha256(equation_id + ":" + prev_hash)',
  eqA.signature.hash === __internals.sha256(eqA.equation_id + ':' + eqA.signature.prev_hash),
);

// ---------------------------------------------------------------------------
// 3. Tamper detection
// ---------------------------------------------------------------------------
console.log('3. tamper detection');
function tamper(eq, mut) {
  const copy = JSON.parse(JSON.stringify(eq));
  mut(copy);
  return copy;
}
const v0 = __internals.validateEquation(eqA);
check('clean equation validates', v0.valid, JSON.stringify(v0.errors));

const tamperedStatement = tamper(eqA, (e) => {
  e.statement = e.statement + ' (sneakily edited)';
});
const v1 = __internals.validateEquation(tamperedStatement);
check('mutating statement breaks equation_id integrity', !v1.valid);
check(
  'tamper error names equation_id integrity',
  v1.errors.some((e) => e.includes('equation_id integrity')),
);

const tamperedHash = tamper(eqA, (e) => {
  e.signature.hash = 'b'.repeat(64);
});
const v2 = __internals.validateEquation(tamperedHash);
check('mutating signature.hash breaks signature integrity', !v2.valid);
check(
  'tamper error names signature.hash integrity',
  v2.errors.some((e) => e.includes('signature.hash integrity')),
);

const tamperedEnforces = tamper(eqA, (e) => {
  e.enforces.push('extra-tag');
});
const v3 = __internals.validateEquation(tamperedEnforces);
check('mutating enforces breaks equation_id integrity', !v3.valid);

// ---------------------------------------------------------------------------
// 4. Seed canonical equations
// ---------------------------------------------------------------------------
console.log('4. seed canonical equations into a fresh store');
const storeDir = mkStore();
const seedRes = seedEquations({ storeDir, ts: 1_700_000_000_000 });
check('seed returns ok', seedRes.ok === true, JSON.stringify(seedRes));
check('seed wrote 4 equations', seedRes.seeded === 4, JSON.stringify(seedRes));

const reSeed = seedEquations({ storeDir });
check('re-seed is idempotent', reSeed.ok === true && reSeed.already_seeded === true);

// JSONL file actually exists on disk
const jsonlAbs = path.join(storeDir, 'equations.jsonl');
check('JSONL file exists', fs.existsSync(jsonlAbs));
const lineCount = fs
  .readFileSync(jsonlAbs, 'utf8')
  .split('\n')
  .filter((l) => l.trim().length > 0).length;
check('JSONL has 4 lines after seed', lineCount === 4, `got ${lineCount}`);

// ---------------------------------------------------------------------------
// 5. Canonical four are present with expected kinds
// ---------------------------------------------------------------------------
console.log('5. canonical four are present');
const founders = getByName('FOUNDER_SALARY_PER_INSTALL_CENTS', { storeDir });
check('FOUNDER_SALARY_PER_INSTALL_CENTS present', !!founders);
check('founders is numeric', founders && founders.kind === 'numeric');
check(
  "founders rhs references env var",
  founders && typeof founders.rhs === 'string' && founders.rhs.includes('FOUNDER_SALARY_PER_INSTALL_CENTS'),
);
check(
  'founders enforces payout/dividend/drift-audit',
  founders &&
    ['payout', 'dividend', 'drift-audit'].every((t) => founders.enforces.includes(t)),
);

const gate0 = getByName('GATE_0_LBCE', { storeDir });
check('GATE_0_LBCE present', !!gate0);
check('gate0 is structural', gate0 && gate0.kind === 'structural');
check(
  'gate0 params name LatticeIntegrityGate',
  gate0 && gate0.params && gate0.params.gate_class === 'LatticeIntegrityGate',
);

const guardrails = getByName('GUARDRAILS_COUNT', { storeDir });
check('GUARDRAILS_COUNT present', !!guardrails);
check('guardrails is count', guardrails && guardrails.kind === 'count');
check('guardrails count === 27', guardrails && guardrails.count === 27);

const moms = getByName('MOMS_LAW', { storeDir });
check("MOMS_LAW present", !!moms);
check('moms is meta', moms && moms.kind === 'meta');
check(
  'moms enforces all-rules',
  moms && moms.enforces.includes('all-rules'),
);

// listEquations returns four active
const allActive = listEquations({ storeDir, status: 'active' });
check('listEquations(active) returns 4', allActive.length === 4, `got ${allActive.length}`);

// All four kinds are represented
const kinds = new Set(allActive.map((e) => e.kind));
check(
  'all four canonical kinds represented (numeric, structural, count, meta)',
  ['numeric', 'structural', 'count', 'meta'].every((k) => kinds.has(k)),
  [...kinds].join(','),
);

// ---------------------------------------------------------------------------
// 6. verifyChain on the seeded store
// ---------------------------------------------------------------------------
console.log('6. verifyChain on healthy store');
const chainRes = verifyChain({ storeDir });
check('verifyChain ok', chainRes.ok === true, JSON.stringify(chainRes));
check('chain length === 4', chainRes.length === 4);
check('head matches getHead()', chainRes.head === getHead({ storeDir }));

// ---------------------------------------------------------------------------
// 7. Operator gate
// ---------------------------------------------------------------------------
console.log('7. operator gate rejects sovereign mismatch');
const head = getHead({ storeDir });
const strangerDraft = {
  name: 'INJECTED_BY_STRANGER',
  kind: 'numeric',
  statement: 'An equation a stranger tried to inject without operator authority.',
  lhs: 'Y',
  op: '=',
  rhs: 0,
  enforces: ['nothing'],
  sovereign: 'someone-else',
  actor: 'someone-else',
  prevHash: head,
  ts: 1_700_000_100_000,
};
const strangerEq = encodeEquation(strangerDraft);
const rejected = addEquation(strangerEq, { storeDir, operator: 'atom-mccree' });
check('stranger equation rejected by operator gate', rejected.ok === false);
check(
  'rejection error mentions operator gate',
  typeof rejected.error === 'string' && rejected.error.includes('operator gate'),
  rejected.error,
);

// Confirm the JSONL was not appended
const lineCountAfterReject = fs
  .readFileSync(jsonlAbs, 'utf8')
  .split('\n')
  .filter((l) => l.trim().length > 0).length;
check('JSONL still 4 lines after rejected write', lineCountAfterReject === 4);

// ---------------------------------------------------------------------------
// 8. Chain-mismatch rejection
// ---------------------------------------------------------------------------
console.log('8. chain mismatch rejected');
const staleDraft = {
  name: 'TEST_STALE_CHAIN',
  kind: 'numeric',
  statement: 'An equation built off a stale chain head should be rejected.',
  lhs: 'Z',
  op: '=',
  rhs: 1,
  enforces: ['test'],
  sovereign: 'atom-mccree',
  actor: 'atom-mccree',
  prevHash: 'c'.repeat(64), // not the current head
  ts: 1_700_000_200_000,
};
const staleEq = encodeEquation(staleDraft);
const staleRes = addEquation(staleEq, { storeDir, operator: 'atom-mccree' });
check('stale-chain equation rejected', staleRes.ok === false);
check(
  'rejection mentions chain mismatch',
  typeof staleRes.error === 'string' && staleRes.error.includes('chain mismatch'),
);

// ---------------------------------------------------------------------------
// 9. Supersedes cascade
// ---------------------------------------------------------------------------
console.log('9. supersedes cascade');
const oldFounders = getByName('FOUNDER_SALARY_PER_INSTALL_CENTS', { storeDir });
check('founders is currently active before supersede', oldFounders.status === 'active');

const successorDraft = {
  name: 'FOUNDER_SALARY_PER_INSTALL_CENTS',
  kind: 'numeric',
  statement:
    'Founder salary per install (revised). Same env var, refined params describing the new audit trail location.',
  lhs: 'FOUNDER_SALARY_PER_INSTALL_CENTS',
  op: '=',
  rhs: '${env:ATOMEONS_FOUNDER_SALARY_PER_INSTALL_CENTS}',
  value_expr: '${env:ATOMEONS_FOUNDER_SALARY_PER_INSTALL_CENTS}',
  params: {
    currency: 'USD',
    scale: 'cents',
    source: 'env',
    env_var: 'ATOMEONS_FOUNDER_SALARY_PER_INSTALL_CENTS',
    audit_trail: 'flux:reality',
  },
  enforces: ['payout', 'dividend', 'drift-audit', 'audit-trail'],
  supersedes: [oldFounders.equation_id],
  sovereign: 'atom-mccree',
  actor: 'atom-mccree',
  prevHash: getHead({ storeDir }),
  ts: 1_700_000_300_000,
};
const successorEq = encodeEquation(successorDraft);
const successorRes = addEquation(successorEq, { storeDir, operator: 'atom-mccree' });
check('successor added ok', successorRes.ok === true, JSON.stringify(successorRes));
check(
  'cascade reports old founders id was flipped',
  Array.isArray(successorRes.cascaded_supersedes) &&
    successorRes.cascaded_supersedes.includes(oldFounders.equation_id),
);

const oldFoundersAfter = getEquation(oldFounders.equation_id, { storeDir });
check('old founders status flipped to superseded', oldFoundersAfter.status === 'superseded');

const newFounders = getByName('FOUNDER_SALARY_PER_INSTALL_CENTS', { storeDir });
check('getByName resolves to successor', newFounders.equation_id === successorEq.equation_id);
check(
  'successor adds audit-trail to enforces',
  newFounders.enforces.includes('audit-trail'),
);

// Chain still verifies after the cascade
const chainAfter = verifyChain({ storeDir });
check('chain still verifies after cascade', chainAfter.ok === true, JSON.stringify(chainAfter));

// ---------------------------------------------------------------------------
// 10. retireEquation
// ---------------------------------------------------------------------------
console.log('10. retireEquation flips active -> retired');
const moms2 = getByName('MOMS_LAW', { storeDir });
check('moms was active before retire', moms2.status === 'active');
const retireRes = retireEquation(moms2.equation_id, { storeDir, actor: 'atom-mccree' });
check('retire returns ok', retireRes.ok === true, JSON.stringify(retireRes));
check('retire status is retired', retireRes.status === 'retired');

const momsAfter = getEquation(moms2.equation_id, { storeDir });
check('moms status is now retired', momsAfter.status === 'retired');
check(
  'getByName(MOMS_LAW) returns null after retire (no active under that name)',
  getByName('MOMS_LAW', { storeDir }) === null,
);

const retireAgain = retireEquation(moms2.equation_id, { storeDir });
check('re-retire is idempotent', retireAgain.ok === true && retireAgain.already === 'retired');

// Restore moms for downstream tests of the seeded set, by minting a fresh one
// — this exercises the "supersede a retired with a new active under same name"
// path (which the store allows: name resolution just follows the most recent
// active row, and a retired equation does NOT block a same-name successor).
const momsRestored = encodeEquation({
  name: 'MOMS_LAW',
  kind: 'meta',
  statement:
    "Mom's Law restored after smoke-test retire — full effort every time, overrides on conflict.",
  params: { origin: "Atom McCree's mother", restored: true },
  enforces: ['all-rules', 'release-steward'],
  sovereign: 'atom-mccree',
  actor: 'atom-mccree',
  prevHash: getHead({ storeDir }),
  ts: 1_700_000_400_000,
});
const restoreRes = addEquation(momsRestored, { storeDir, operator: 'atom-mccree' });
check('restored moms added ok', restoreRes.ok === true);

// ---------------------------------------------------------------------------
// 11. Duplicate add
// ---------------------------------------------------------------------------
console.log('11. duplicate add is idempotent');
const dupRes = addEquation(momsRestored, { storeDir, operator: 'atom-mccree' });
check('duplicate add returns ok', dupRes.ok === true);
check('duplicate add flagged as duplicate', dupRes.duplicate === true);

// ---------------------------------------------------------------------------
// 12. File persistence (clear cache, reopen)
// ---------------------------------------------------------------------------
console.log('12. file persistence across cache reset');
const headBefore = getHead({ storeDir });
const chainLenBefore = verifyChain({ storeDir }).length;
_resetCacheForTests();
const headAfter = getHead({ storeDir });
const chainAfter2 = verifyChain({ storeDir });
check('head survives cache reset', headBefore === headAfter, `${headBefore} vs ${headAfter}`);
check('chain length survives cache reset', chainAfter2.length === chainLenBefore);
check('chain still ok after cache reset', chainAfter2.ok === true);

// ---------------------------------------------------------------------------
// 13. loadSeedEquations sanity (the seed file itself is well-formed)
// ---------------------------------------------------------------------------
console.log('13. equations.json seed file is well-formed');
const seeds = loadSeedEquations();
check('seeds is an array of length 4', Array.isArray(seeds) && seeds.length === 4);
for (const draft of seeds) {
  check(
    `seed '${draft.name || '?'}' has kind in VALID_KINDS`,
    VALID_KINDS.includes(draft.kind),
  );
  check(
    `seed '${draft.name || '?'}' has non-empty statement`,
    typeof draft.statement === 'string' && draft.statement.length >= 8,
  );
  check(
    `seed '${draft.name || '?'}' has sovereign='atom-mccree'`,
    draft.sovereign === 'atom-mccree',
  );
}

// ---------------------------------------------------------------------------
// Cleanup + summary
// ---------------------------------------------------------------------------
rmStore(storeDir);

console.log('');
if (failed === 0) {
  console.log('PASS — AtomSmasher EquationStore end-to-end smoke green');
  console.log(
    `  canonical seeds: FOUNDER_SALARY_PER_INSTALL_CENTS, GATE_0_LBCE, GUARDRAILS_COUNT=27, MOMS_LAW`,
  );
  process.exit(0);
} else {
  console.log(`FAIL — ${failed} check(s) failed`);
  process.exit(1);
}
