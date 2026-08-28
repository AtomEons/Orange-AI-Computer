// clr/tests/bridge.test.mjs — node:test suite for the CLR phase-router bridge.
// Run with: node --test tests/bridge.test.mjs  (from clr/ directory)
//       or: node --test C:/AtomEons/Orange5/06-ORANGELLM/memory/ae-cobra/clr/tests/bridge.test.mjs
// Requires Node 20+ (node:test is stable from v20).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verify, DEFAULT_POLICY } from '../bridge.mjs';

// --- Fixtures ----------------------------------------------------------------

function turn(overrides = {}) {
  return {
    lane: 'reality',
    event_type: 'observation',
    summary: 'npm test green: 7/7',
    entities: ['npm', 'test'],
    files: ['package.json'],
    commands: ['npm test'],
    risk: 'low',
    next_action: 'commit',
    confidence: 0.8,
    ...overrides,
  };
}

function fiveOf(t) {
  return [t, t, t, t, t].map(x => ({ ...x }));
}

const REALITY_CTX = {
  reality_events: [
    { files: ['package.json', 'src/index.mjs'], commands: ['npm test'], entities: ['npm'] },
  ],
  hermes_receipts: [
    { kind: 'test', path: 'receipts/npm-test-7of7.json', ok: true },
  ],
};

// --- Arg-shape contract ------------------------------------------------------

test('rejects null/undefined turn', () => {
  assert.throws(() => verify(null), /turn is required/);
  assert.throws(() => verify(undefined), /turn is required/);
});

test('rejects non-object opts', () => {
  assert.throws(() => verify(turn(), null), /opts must be an object/);
  // arrays are objects in JS; we accept them gracefully (no force/policy lookup hits).
  // Strings/numbers are rejected.
  assert.throws(() => verify(turn(), 'k1'), /opts must be an object/);
  assert.throws(() => verify(turn(), 42), /opts must be an object/);
});

// --- Risk-level extraction ---------------------------------------------------

test('explicit opts.risk_level wins over turn.risk', () => {
  const r = verify(turn({ risk: 'low' }), { risk_level: 'high', force: 'k1' });
  assert.equal(r.risk_level, 'high');
});

test('candidates bundle event.risk_level wins over turn.risk', () => {
  const r = verify(
    { candidates: fiveOf(turn({ risk: 'low' })), event: { risk_level: 'production' } },
    {},
  );
  assert.equal(r.risk_level, 'production');
  assert.equal(r.phase, 'k5');
});

test('falls back to turn.risk for single-turn input', () => {
  const r = verify(turn({ risk: 'medium' }), {});
  assert.equal(r.risk_level, 'medium');
  assert.equal(r.phase, 'k1'); // default policy maps medium -> k1
});

test('unknown risk_level surfaces a gap but still routes', () => {
  const r = verify(turn(), { risk_level: 'catastrophic' });
  assert.equal(r.risk_level, 'catastrophic');
  assert.ok(r.gap, 'expected gap to be reported for unknown risk_level');
  assert.match(r.gap, /unknown risk_level/);
});

// --- Phase selection ---------------------------------------------------------

test('default policy: low -> K=1', () => {
  const r = verify(turn({ risk: 'low' }), {});
  assert.equal(r.phase, 'k1');
  assert.equal(r.k, 1);
  assert.equal(r.routed_by, 'risk_level');
});

test('default policy: medium -> K=1', () => {
  const r = verify(turn(), { risk_level: 'medium' });
  assert.equal(r.phase, 'k1');
});

test('default policy: high -> K=5 (refuses without candidates)', () => {
  const r = verify(turn({ risk: 'high' }), {});
  assert.equal(r.phase, 'k5');
  assert.equal(r.accepted, false);
  assert.ok(r.gap, 'expected gap when K=5 selected without candidates');
  assert.match(r.gap, /candidates/);
});

test('default policy: destructive -> K=5', () => {
  const r = verify(
    { candidates: fiveOf(turn()), event: { risk_level: 'destructive' } },
    {},
  );
  assert.equal(r.phase, 'k5');
  assert.equal(r.k, 5);
});

test('default policy: production -> K=5', () => {
  const r = verify(
    { candidates: fiveOf(turn()), event: { risk_level: 'production' } },
    {},
  );
  assert.equal(r.phase, 'k5');
});

test('opts.force overrides risk-based routing', () => {
  const r = verify(turn({ risk: 'high' }), { force: 'k1' });
  assert.equal(r.phase, 'k1');
  assert.equal(r.routed_by, 'force');
});

test('opts.policy overrides default mapping', () => {
  const r = verify(turn({ risk: 'low' }), {
    policy: { low: 'k5' },
    // We must supply candidates because we just promoted low to K=5.
  });
  assert.equal(r.phase, 'k5');
  // No candidates supplied -> bridge refuses (no silent fall-back).
  assert.equal(r.accepted, false);
  assert.ok(r.gap);
});

test('opts.config.default_phase used when policy lookup misses', () => {
  // Force a risk_level not in policy override map by clearing policy.
  // We can do that by spying through opts.policy only listing one key — the
  // bridge merges with DEFAULT_POLICY, so we instead force an unknown level.
  const r = verify(turn(), {
    risk_level: 'novel-band',
    config: { default_phase: 'k1' },
  });
  // unknown band -> default policy lookup misses -> config default applies.
  assert.equal(r.phase, 'k1');
  assert.equal(r.routed_by, 'default');
  assert.ok(r.gap);
});

// --- K=1 delegation ----------------------------------------------------------

test('K=1 clean turn accepted', () => {
  const r = verify(turn(), { force: 'k1' });
  assert.equal(r.phase, 'k1');
  assert.equal(r.k, 1);
  assert.ok(r.accepted, `expected accepted, score=${r.score}, reasons=${r.reasons.join('|')}`);
  assert.ok(r.score >= 0.5);
  assert.equal(typeof r.score, 'number');
  assert.ok(Array.isArray(r.reasons));
});

test('K=1 fake-green word rejected', () => {
  const r = verify(turn({ summary: 'fake_green: all systems go' }), { force: 'k1' });
  assert.equal(r.accepted, false);
  assert.ok(r.reasons.some(x => /fake-green/.test(x)));
});

test('K=1 respects custom threshold', () => {
  const r = verify(turn(), { force: 'k1', threshold: 0.99 });
  // clean turn scores 1.0 from verifier-k1 (no penalties), so still accepted.
  assert.equal(r.threshold, 0.99);
});

test('K=1 path accepts a candidates bundle by picking candidates[0]', () => {
  const r = verify(
    { candidates: fiveOf(turn()), event: { risk_level: 'low' } },
    { force: 'k1' },
  );
  assert.equal(r.phase, 'k1');
  assert.ok(r.accepted);
});

// --- K=5 delegation ----------------------------------------------------------

test('K=5 happy path: 5 clean candidates accepted', () => {
  const r = verify(
    { candidates: fiveOf(turn()), event: { risk_level: 'high' } },
    { context: REALITY_CTX },
  );
  assert.equal(r.phase, 'k5');
  assert.equal(r.k, 5);
  assert.equal(r.scores.length, 5);
  assert.ok(r.accepted, `expected accepted, median=${r.median}`);
  assert.ok(r.median >= 0.5);
  assert.ok(Array.isArray(r.per_candidate));
  assert.equal(r.per_candidate.length, 5);
});

test('K=5 refuses without candidates bundle (no silent fall-back)', () => {
  const r = verify(turn({ risk: 'high' }), {});
  assert.equal(r.phase, 'k5');
  assert.equal(r.accepted, false);
  assert.match(r.gap, /candidates/);
});

test('K=5 refuses when candidates.length !== 5', () => {
  const r = verify(
    { candidates: [turn(), turn(), turn()], event: { risk_level: 'high' } },
    {},
  );
  assert.equal(r.phase, 'k5');
  assert.equal(r.accepted, false);
  assert.match(r.gap, /candidates\.length=3/);
});

test('K=5 contradicts a failed Hermes receipt', () => {
  const bad = turn({ summary: 'tests passed green', files: ['receipts/npm-test-fail.json'] });
  const ctx = {
    reality_events: REALITY_CTX.reality_events,
    hermes_receipts: [{ kind: 'test', path: 'receipts/npm-test-fail.json', ok: false }],
  };
  const r = verify(
    { candidates: fiveOf(bad), event: { risk_level: 'high' } },
    { context: ctx },
  );
  // Median candidate should be penalized for the success-vs-fail contradiction.
  assert.ok(r.median < 1.0);
  const sawContradiction = r.per_candidate.some(p =>
    p.reasons.some(x => /contradicts failed Hermes receipt/.test(x)),
  );
  assert.ok(sawContradiction, 'expected contradiction reason to surface');
});

test('K=5 respects custom threshold for accepted flag', () => {
  const r = verify(
    { candidates: fiveOf(turn()), event: { risk_level: 'high' } },
    { threshold: 0.95, context: REALITY_CTX },
  );
  assert.equal(r.threshold, 0.95);
  // Clean turns score 1.0 across dims, so still accepted at 0.95.
  assert.ok(r.accepted);
});

// --- Doctrine surface --------------------------------------------------------

test('DEFAULT_POLICY exposes the canonical mapping', () => {
  assert.equal(DEFAULT_POLICY.low, 'k1');
  assert.equal(DEFAULT_POLICY.medium, 'k1');
  assert.equal(DEFAULT_POLICY.high, 'k5');
  assert.equal(DEFAULT_POLICY.destructive, 'k5');
  assert.equal(DEFAULT_POLICY.production, 'k5');
});

test('default export is verify', async () => {
  const mod = await import('../bridge.mjs');
  assert.equal(mod.default, mod.verify);
});

// --- Shape contract ----------------------------------------------------------

test('return shape includes all canonical fields for K=1', () => {
  const r = verify(turn(), { force: 'k1' });
  for (const f of ['phase', 'accepted', 'score', 'reasons', 'k', 'threshold', 'risk_level', 'routed_by']) {
    assert.ok(Object.prototype.hasOwnProperty.call(r, f), `missing field ${f}`);
  }
});

test('return shape includes all canonical fields for K=5', () => {
  const r = verify(
    { candidates: fiveOf(turn()), event: { risk_level: 'high' } },
    { context: REALITY_CTX },
  );
  for (const f of ['phase', 'accepted', 'scores', 'median', 'reasons', 'k', 'threshold', 'risk_level', 'routed_by', 'per_candidate']) {
    assert.ok(Object.prototype.hasOwnProperty.call(r, f), `missing field ${f}`);
  }
});
