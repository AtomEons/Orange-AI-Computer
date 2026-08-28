// registry.test.mjs
//
// The whole reason the registry was rewritten: the hand-typed status table was
// wrong about 9 of 12 modules. Tests here guarantee that the new
// derived-from-disk registry cannot go back to lying — it reads real files,
// and it names its own conflict with the theory doc when the doc overclaims.
//
// Run: bun 12-ATOMSMASHER/modules/tests/registry.test.mjs

import { probeModule, listModules, registrySummary, MODULES, IMPLS, STATUS } from '../index.mjs';

let pass = 0, fail = 0;
function t(n, f) { try { f(); console.log(`  PASS  ${n}`); pass++; } catch (e) { console.log(`  FAIL  ${n}\n        ${e.message}`); fail++; } }
function assert(c, m) { if (!c) throw new Error(m); }

console.log('\nAtomSmasher 2 registry — status derived from disk, never hand-typed\n');

// ── CODE_PRESENT — modules with real files and matching contract exports ────
t('compression-debt is CODE_PRESENT (ledger.mjs is a real ~700-line API)', () => {
  const p = probeModule('compression-debt');
  assert(p.status === STATUS.CODE_PRESENT, `expected CODE_PRESENT, got ${p.status}`);
  assert(p.contractExportsFound.includes('recordDebt'), 'must find recordDebt');
  assert(p.contractExportsFound.includes('payDebt'), 'must find payDebt');
  assert(p.lines > 100, 'ledger has substantial size');
});

t('anti-fluff-gate is CODE_PRESENT and IMPLS carries the in-process function', () => {
  const p = probeModule('anti-fluff-gate');
  assert(p.status === STATUS.CODE_PRESENT, `expected CODE_PRESENT, got ${p.status}`);
  assert(typeof IMPLS['anti-fluff-gate'] === 'function', 'IMPLS must expose the actual function for in-process callers');
});

// ── ABSENT — the modules the theory doc overclaims ──────────────────────────
t('saved-work-certs is ABSENT — the theory doc §6.9 overclaims a live encoder', () => {
  const p = probeModule('saved-work-certs');
  assert(p.status === STATUS.ABSENT, `expected ABSENT, got ${p.status}`);
});

t('canon-pressure is ABSENT — theory doc §6.10 overclaims 56/56 smoke tests', () => {
  const p = probeModule('canon-pressure');
  assert(p.status === STATUS.ABSENT, `expected ABSENT, got ${p.status}`);
});

t('pathwave-compressor is ABSENT — theory doc §6.11 overclaims a live compressor', () => {
  const p = probeModule('pathwave-compressor');
  assert(p.status === STATUS.ABSENT, `expected ABSENT, got ${p.status}`);
});

// ── registrySummary — the reader-facing gap report ──────────────────────────
t('registrySummary names the exact modules missing from disk', () => {
  const s = registrySummary();
  for (const id of ['saved-work-certs', 'canon-pressure', 'pathwave-compressor']) {
    assert(s.absentIds.includes(id), `${id} must appear in absentIds`);
  }
  assert(s.absent === s.absentIds.length, 'counts must match');
});

t('registrySummary surfaces the doc conflict rather than hiding it', () => {
  const s = registrySummary();
  assert(typeof s.docConflict === 'string', 'must state the conflict when absent > 0');
  assert(/ATOMSMASHER_2_OPERATIONAL_THEORY/.test(s.docConflict),
    'must name the specific doc that overclaims');
  assert(/does not exist|No code exists|overstates/i.test(s.docConflict),
    'must plainly state that code does not exist');
});

t('registrySummary is honest about its own limits — never emits OPERATIONAL as a status', () => {
  const s = registrySummary();
  assert(/does NOT prove the module runs/.test(s.boundary),
    'boundary must state the honest limit of static inspection');
  // The word "OPERATIONAL" appears in the boundary disclaimer (that's the point:
  // saying we do NOT emit it). Check no module actually CARRIES it as a status.
  const mods = listModules();
  assert(mods.every(m => m.status !== 'OPERATIONAL'),
    'no module may carry OPERATIONAL — that status is proof-gated and this registry does not run code');
});

// ── The Proxy — backward compatibility with legacy readers ──────────────────
t('MODULES[id] reflects disk (backward compat via Proxy)', () => {
  const cd = MODULES['compression-debt'];
  assert(cd?.status === STATUS.CODE_PRESENT, `MODULES proxy must probe disk; got ${cd?.status}`);
  const sw = MODULES['saved-work-certs'];
  assert(sw?.status === STATUS.ABSENT, 'and it must report ABSENT honestly');
});

t('MODULES enumerates ONLY registered ids (no invented keys)', () => {
  const keys = Object.keys(MODULES).sort();
  const listed = listModules().map(m => m.id).sort();
  assert(JSON.stringify(keys) === JSON.stringify(listed), 'Proxy ownKeys must match listModules()');
});

t('MODULES["nonsense"] returns undefined, does not crash', () => {
  assert(MODULES['definitely-not-a-module'] === undefined, 'unknown id must be undefined');
});

// ── listModules — the primary status surface ────────────────────────────────
t('listModules returns exactly the registered set with derived statuses', () => {
  const mods = listModules();
  assert(mods.length === 12, `expected 12 modules, got ${mods.length}`);
  assert(mods.every(m => typeof m.status === 'string' && Object.values(STATUS).includes(m.status)),
    'every module must carry a valid STATUS value');
});

// ── the untested list is populated when appropriate ─────────────────────────
t('untested surfaces present-but-untested modules (drives next work)', () => {
  const s = registrySummary();
  assert(Array.isArray(s.untested), 'untested is an array');
  // (we do not assert length — that would couple this test to disk state.
  //  The invariant is that it exists and is populated from disk state.)
});

console.log(`\nSummary: ${pass} pass / ${fail} fail of ${pass + fail}\n`);
if (fail > 0) process.exit(1);
