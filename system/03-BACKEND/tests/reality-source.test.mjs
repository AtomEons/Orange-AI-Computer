// reality-source.test.mjs
//
// The whole module exists to guarantee ONE thing: a caller cannot claim an
// outcome — the observer runs the thing and records what it saw. Tests are
// written around that invariant. If any of them fails, the guarantee is gone
// and the Reality lane stops being un-gameable.
//
// Run: bun 03-BACKEND/tests/reality-source.test.mjs

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  observeTestRun, observeGitState, observeFileState, observeOperatorDecision,
  ledgerShape, REALITY_ORIGINS, REALITY_SCHEMA,
} from '../reality-source.mjs';

let pass = 0, fail = 0;
function t(n, f) { try { f(); console.log(`  PASS  ${n}`); pass++; } catch (e) { console.log(`  FAIL  ${n}\n        ${e.message}`); fail++; } }
function assert(c, m) { if (!c) throw new Error(m); }

const fluxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reality-src-'));
console.log('\nreality-source — the Reality-lane producer\n  (temp ledger:', fluxRoot + ')\n');

// ── STRUCTURAL: lane cannot be passed as a parameter ────────────────────────
t('STRUCTURAL: no observer accepts a lane argument', () => {
  // The point of origin-typed lanes is that "which lane" is not the caller's
  // choice. If any observer takes a lane parameter, the guarantee is gone.
  for (const fn of [observeTestRun, observeGitState, observeFileState, observeOperatorDecision]) {
    const src = fn.toString();
    assert(!/\blane\s*:/.test(src.split('{')[0]),
      `${fn.name} appears to take a lane parameter — that breaks the origin-typing guarantee`);
  }
});

t('STRUCTURAL: no observer accepts an outcome argument', () => {
  // observeTestRun takes a COMMAND. It must NEVER take {passed, exitCode, ...}.
  const sig = observeTestRun.toString().split('{')[0];
  for (const forbidden of ['passed', 'exitCode', 'exit_code', 'success', 'ok']) {
    assert(!new RegExp(`\\b${forbidden}\\s*:`).test(sig),
      `observeTestRun signature exposes '${forbidden}' — callers must not be able to declare outcomes`);
  }
});

// ── observeTestRun — the machine-truth observer ─────────────────────────────
t('observeTestRun runs the command and records the real exit code (pass path)', () => {
  const r = observeTestRun({ fluxRoot, command: ['bun', '-e', 'process.exit(0)'], timeoutMs: 15_000, label: 'green case' });
  assert(r.exitCode === 0, `expected exit 0, got ${r.exitCode}`);
  assert(r.passed === true, 'passed must be true');
  assert(r.record.lane === 'reality', 'must land in Reality');
  assert(r.record.body.self_verified === true, 'must be self-verified');
  assert(r.record.kind === 'observation:test-pass', `kind: ${r.record.kind}`);
});

t('observeTestRun records failure honestly (fail path)', () => {
  const r = observeTestRun({ fluxRoot, command: ['bun', '-e', 'process.exit(2)'], timeoutMs: 15_000, label: 'red case' });
  assert(r.exitCode === 2, `expected exit 2, got ${r.exitCode}`);
  assert(r.passed === false, 'passed must be false');
  assert(r.record.kind === 'observation:test-fail', `kind: ${r.record.kind}`);
  assert(r.record.body.overall_ok === false && r.record.body.is_mistake === true,
    'must carry failure signals so recall-engine counts it as a mistake');
});

t('observeTestRun captures stdout hash so a later tamper is provable', () => {
  const r = observeTestRun({ fluxRoot, command: ['bun', '-e', 'console.log("hello reality")'], timeoutMs: 15_000 });
  assert(typeof r.record.body.stdout_sha256 === 'string' && r.record.body.stdout_sha256.length === 64,
    'stdout must be hashed');
});

// ── observeFileState — did the thing actually land? ─────────────────────────
t('observeFileState reports missing files as observation:file-missing, present as file-present', () => {
  const missing = observeFileState({ fluxRoot, cwd: os.tmpdir(), paths: ['definitely-not-there-abc.xyz'] });
  assert(missing.record.kind === 'observation:file-missing', 'missing must be flagged');
  assert(missing.record.body.overall_ok === false, 'missing must fail');

  const tmp = path.join(fluxRoot, 'here.txt');
  fs.writeFileSync(tmp, 'x');
  const present = observeFileState({ fluxRoot, paths: [tmp] });
  assert(present.record.kind === 'observation:file-present', 'present must be flagged');
  assert(typeof present.observed[0].sha256 === 'string' && present.observed[0].sha256.length === 64, 'must hash file bytes');
});

t('observeFileState rejects a non-array paths argument', () => {
  let threw = false;
  try { observeFileState({ fluxRoot, paths: null }); } catch { threw = true; }
  assert(threw, 'must reject invalid input');
});

// ── observeGitState — observed, never asserted ──────────────────────────────
t('observeGitState reports "unavailable" honestly for a non-repo (no false claim)', () => {
  const r = observeGitState({ fluxRoot, repo: os.tmpdir() });
  assert(r.record === null, 'must NOT write Reality for a non-observation');
  assert(r.head === null, 'must not fabricate a head');
  assert(typeof r.note === 'string' && /unavailable|not a repo/i.test(r.note), 'must state why');
});

// ── observeOperatorDecision — the honest self-verified:false line ───────────
t('observeOperatorDecision stamps self_verified:false — the one honest exception', () => {
  const r = observeOperatorDecision({ fluxRoot, verbatim: 'ship it', decision: 'go' });
  assert(r.lane === 'reality', 'still Reality per spec');
  assert(r.body.self_verified === false,
    'MUST be false — the module cannot verify operator statements. Removing this stamp reopens the un-gameable hole this module exists to close.');
  assert(typeof r.body.verbatim_sha256 === 'string' && r.body.verbatim_sha256.length === 64,
    'verbatim must be hashed so an altered later claim is provable');
});

t('observeOperatorDecision rejects empty verbatim', () => {
  let threw = false;
  try { observeOperatorDecision({ fluxRoot, verbatim: '' }); } catch { threw = true; }
  assert(threw, 'must reject empty operator input');
});

// ── ledgerShape — reports counts honestly ───────────────────────────────────
t('ledgerShape reports the two-lane balance and the canCalibrate flag', () => {
  const shape = ledgerShape({ fluxRoot });
  assert(shape.reality > 0, 'we have written Reality above; must be > 0');
  assert(shape.selfVerifiedReality > 0, 'and self-verified ones');
  assert(typeof shape.note === 'string' && shape.note.length > 0, 'must carry a plain-language note');
});

t('ledgerShape returns empty on missing root without throwing', () => {
  const shape = ledgerShape({ fluxRoot: path.join(fluxRoot, 'does-not-exist') });
  assert(shape.reality === 0 && shape.thought === 0, 'empty is empty');
  assert(/empty|Run an observer|insufficient/i.test(shape.note), 'must state why');
});

// ── SCHEMA CONSTANTS — public surface stability ─────────────────────────────
t('REALITY_ORIGINS is a closed set — new observers must register', () => {
  const values = Object.values(REALITY_ORIGINS);
  // The 5 registered origins: TEST, BUILD, GIT, FILE, OPERATOR. New observers
  // must extend this set explicitly; writeReality refuses unregistered origins.
  assert(values.length === 5, `expected 5 origins, got ${values.length}`);
  assert(new Set(values).size === values.length, 'origins must be unique');
});

t('every Reality record carries the schema id', () => {
  const r = observeFileState({ fluxRoot, paths: [path.join(fluxRoot, 'here.txt')] });
  assert(r.record.body.schema === REALITY_SCHEMA, 'schema tag is how downstream identifies the shape');
});

console.log(`\nSummary: ${pass} pass / ${fail} fail of ${pass + fail}\n`);
fs.rmSync(fluxRoot, { recursive: true, force: true });
if (fail > 0) process.exit(1);
