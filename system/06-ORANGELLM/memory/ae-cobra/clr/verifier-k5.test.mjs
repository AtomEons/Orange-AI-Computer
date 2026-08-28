// clr/verifier-k5.test.mjs — node:test suite for CLR-K5 verifier.
// Run with: node --test verifier-k5.test.mjs
// Requires Node 20+ (node:test is stable from v20).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  verifyCandidatesK5,
  scoreCandidate,
} from './verifier-k5.mjs';

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

function mixed(arr) {
  if (arr.length !== 5) throw new Error('mixed() needs 5');
  return arr.map(x => ({ ...x }));
}

const REALITY_CTX = {
  reality_events: [
    { files: ['package.json', 'src/index.mjs'], commands: ['npm test'], entities: ['npm'] },
    { files: ['README.md'], commands: ['git status'], entities: [] },
  ],
  hermes_receipts: [
    { kind: 'test', path: 'receipts/npm-test-7of7.json', ok: true },
  ],
};

// --- Arg-shape contract ------------------------------------------------------

test('rejects non-array candidates', () => {
  assert.throws(() => verifyCandidatesK5(null), /must be an array/);
  assert.throws(() => verifyCandidatesK5({}), /must be an array/);
});

test('rejects wrong K', () => {
  assert.throws(() => verifyCandidatesK5([turn()]), /exactly 5 candidates/);
  assert.throws(() => verifyCandidatesK5(new Array(4).fill(turn())), /exactly 5 candidates/);
  assert.throws(() => verifyCandidatesK5(new Array(6).fill(turn())), /exactly 5 candidates/);
});

test('returns canonical shape', () => {
  const r = verifyCandidatesK5(fiveOf(turn()));
  assert.equal(typeof r, 'object');
  assert.ok(Array.isArray(r.scores));
  assert.equal(r.scores.length, 5);
  assert.equal(typeof r.median, 'number');
  assert.equal(typeof r.accepted, 'boolean');
  assert.ok(Array.isArray(r.reasons));
  assert.equal(r.reasons.length, 5);
  assert.equal(r.k, 5);
  assert.equal(r.threshold, 0.5);
  assert.equal(r.per_candidate.length, 5);
});

// --- Happy path --------------------------------------------------------------

test('5 clean candidates all accept; median above threshold', () => {
  const r = verifyCandidatesK5(fiveOf(turn()));
  assert.ok(r.accepted, `expected accepted, median=${r.median}`);
  assert.ok(r.median >= 0.5);
  for (const s of r.scores) assert.ok(s >= 0.5, `score ${s} below threshold`);
});

test('clean candidates with Reality context still pass', () => {
  const r = verifyCandidatesK5(fiveOf(turn()), { context: REALITY_CTX });
  assert.ok(r.accepted);
});

// --- Median 3-of-5 doctrine --------------------------------------------------

test('3 strong + 2 weak → accept (median > threshold)', () => {
  const strong = turn();
  const weak = turn({
    summary: 'maybe this might work, probably should_work, seems to be ok',
    next_action: 'I hope this helps, in summary kind of done',
    risk: 'high',
    files: [],
    commands: [],
  });
  const r = verifyCandidatesK5(mixed([strong, strong, strong, weak, weak]));
  assert.ok(r.accepted, `median=${r.median} scores=${r.scores}`);
  assert.ok(r.median >= 0.5);
});

test('2 strong + 3 weak → reject (median below threshold)', () => {
  const strong = turn();
  // Weak candidate must tank multiple dimensions, not just one.
  // - anti_fluff:        fake-green + 3+ fluff hits
  // - grounding:         high risk with no files/commands/entities
  // - risk_vs_content:   destructive language at low risk + error event w/ conf>0.9
  // - claim_verification:Reality lane referencing unknown files + contradicting failed receipt
  const weak = turn({
    lane: 'reality',
    event_type: 'receipt',
    summary: 'green_assumed, looks_ok, probably maybe perhaps it might',
    next_action: 'should_work fake_green kind of arguably, rm -rf cache',
    risk: 'high',
    files: [],
    commands: [],
    entities: [],
    confidence: 0.05,
  });
  const r = verifyCandidatesK5(
    mixed([strong, strong, weak, weak, weak]),
  );
  assert.equal(r.accepted, false, `expected reject, median=${r.median}, scores=${r.scores}`);
  assert.ok(r.median < 0.5);
});

test('exactly the median (index 2 after sort) decides', () => {
  // Construct 5 candidates whose individual scores will land at:
  // [low, low, mid, high, high]. The median is "mid".
  // We can verify behavior by checking that sorting matters, not insertion order.
  const strong = turn();
  const weak = turn({
    summary: 'probably maybe perhaps it might',
    next_action: 'kind of arguably',
    files: [],
    commands: [],
    risk: 'high',
  });
  const interleaved = verifyCandidatesK5(mixed([weak, strong, weak, strong, strong]));
  const ordered = verifyCandidatesK5(mixed([strong, strong, strong, weak, weak]));
  assert.equal(interleaved.median, ordered.median);
});

// --- Threshold override ------------------------------------------------------

test('custom threshold respected', () => {
  const t = turn();
  const r1 = verifyCandidatesK5(fiveOf(t), { threshold: 0.99 });
  // Clean turn scores < 1.0 only when fluff/grounding/etc penalties hit;
  // baseline clean turn here scores 1.0 across all dims. Median should be 1.0.
  assert.equal(r1.threshold, 0.99);
  assert.ok(r1.median >= 0.99);
  assert.ok(r1.accepted);

  const r2 = verifyCandidatesK5(fiveOf(t), { threshold: 0.0 });
  assert.equal(r2.threshold, 0.0);
  assert.ok(r2.accepted);
});

// --- Dimension: anti-fluff ---------------------------------------------------

test('fake-green word tanks anti_fluff dim', () => {
  const t = turn({ summary: 'green_assumed all the way home' });
  const r = scoreCandidate(t);
  assert.ok(r.dims.anti_fluff < 0.5, `anti_fluff=${r.dims.anti_fluff}`);
  assert.ok(r.reasons.some(x => x.includes('fake-green')));
});

test('three or more fluff hits reduce anti_fluff', () => {
  const t = turn({
    summary: 'this might maybe seems to perhaps',
    next_action: 'kind of arguably',
  });
  const r = scoreCandidate(t);
  assert.ok(r.dims.anti_fluff < 1.0);
});

// --- Dimension: grounding ----------------------------------------------------

test('high-risk turn with no anchors loses grounding', () => {
  const t = turn({ risk: 'high', files: [], commands: [], entities: [] });
  const r = scoreCandidate(t);
  assert.ok(r.dims.grounding < 0.5, `grounding=${r.dims.grounding}`);
});

test('decision with no anchors loses grounding', () => {
  const t = turn({
    event_type: 'decision', files: [], commands: [], entities: [],
  });
  const r = scoreCandidate(t);
  assert.ok(r.dims.grounding < 1.0);
});

// --- Dimension: risk-vs-content ---------------------------------------------

test('destructive language without high risk costs risk_vs_content', () => {
  const t = turn({
    summary: 'will run rm -rf on the cache folder',
    risk: 'low',
  });
  const r = scoreCandidate(t);
  assert.ok(r.dims.risk_vs_content < 1.0);
});

test('error event with confidence > 0.9 costs risk_vs_content', () => {
  const t = turn({ event_type: 'error', confidence: 0.99 });
  const r = scoreCandidate(t);
  assert.ok(r.dims.risk_vs_content < 1.0);
});

test('sub-floor confidence costs risk_vs_content', () => {
  const t = turn({ confidence: 0.1 });
  const r = scoreCandidate(t);
  assert.ok(r.dims.risk_vs_content < 1.0);
});

// --- Dimension: claim-verification against Reality ---------------------------

test('claim_verification is neutral 1.0 when no Reality corpus provided', () => {
  const t = turn({ files: ['totally-fake-file.txt'] });
  const r = scoreCandidate(t);
  assert.equal(r.dims.claim_verification, 1.0);
});

test('Reality-lane turn citing unknown files loses claim_verification', () => {
  const t = turn({
    lane: 'reality',
    files: ['ghost.txt', 'phantom.js'],
    commands: ['./never-run.sh'],
  });
  const r = scoreCandidate(t, REALITY_CTX);
  assert.ok(r.dims.claim_verification < 1.0,
    `claim_verification=${r.dims.claim_verification}`);
});

test('Reality-lane turn citing known files passes claim_verification', () => {
  const t = turn({
    lane: 'reality',
    files: ['package.json'],
    commands: ['npm test'],
  });
  const r = scoreCandidate(t, REALITY_CTX);
  assert.equal(r.dims.claim_verification, 1.0);
});

test('receipt event without Hermes path reference loses claim_verification', () => {
  const t = turn({
    event_type: 'receipt',
    lane: 'reality',
    files: ['package.json'], // known but not a receipt path
    commands: ['npm test'],
  });
  const r = scoreCandidate(t, REALITY_CTX);
  assert.ok(r.dims.claim_verification < 1.0);
});

test('receipt event referencing Hermes path passes claim_verification', () => {
  const t = turn({
    event_type: 'receipt',
    lane: 'reality',
    files: ['receipts/npm-test-7of7.json'],
    commands: ['npm test'],
  });
  const r = scoreCandidate(t, REALITY_CTX);
  assert.equal(r.dims.claim_verification, 1.0);
});

test('Reality "passed" claim contradicting failed Hermes receipt loses dim', () => {
  const failedCtx = {
    reality_events: [{ files: ['package.json'], commands: ['npm test'] }],
    hermes_receipts: [{ kind: 'test', path: 'receipts/r.json', ok: false }],
  };
  const t = turn({
    lane: 'reality',
    summary: 'npm test passed green',
    files: ['package.json'],
  });
  const r = scoreCandidate(t, failedCtx);
  assert.ok(r.dims.claim_verification < 1.0,
    `expected contradiction penalty, got ${r.dims.claim_verification}`);
});

// --- End-to-end --------------------------------------------------------------

test('per_candidate and scores agree element-wise', () => {
  const candidates = fiveOf(turn());
  candidates[2].summary = 'green_assumed kind of perhaps maybe';
  const r = verifyCandidatesK5(candidates);
  for (let i = 0; i < 5; i++) {
    assert.equal(r.scores[i], r.per_candidate[i].score);
    assert.deepEqual(r.reasons[i], r.per_candidate[i].reasons);
  }
});

test('median is the 3rd element of sorted scores', () => {
  // Hand-tune candidates so each one has a distinct score.
  const c0 = turn({ summary: 'green_assumed' }); // dim1 tanks
  const c1 = turn({ risk: 'high', files: [], commands: [], entities: [] }); // dim2 tanks
  const c2 = turn({ summary: 'will rm -rf root', risk: 'low' }); // dim3 tanks
  const c3 = turn(); // clean
  const c4 = turn(); // clean
  const r = verifyCandidatesK5([c0, c1, c2, c3, c4]);
  const sorted = [...r.scores].sort((a, b) => a - b);
  assert.equal(r.median, sorted[2]);
});

test('rejects non-object candidate', () => {
  const candidates = fiveOf(turn());
  candidates[0] = null;
  assert.throws(() => verifyCandidatesK5(candidates), /AgentTurn object/);
});

test('all scores within [0, 1]', () => {
  // Construct a worst-case candidate that triggers every penalty.
  const worst = turn({
    lane: 'reality',
    event_type: 'error',
    summary: 'green_assumed looks_ok probably should_work in summary maybe perhaps',
    next_action: 'rm -rf / on production main branch, kind of arguably',
    files: ['ghost.txt', 'phantom.js'],
    commands: ['./never.sh'],
    entities: [],
    risk: 'low',
    confidence: 0.99,
  });
  const r = verifyCandidatesK5(fiveOf(worst), { context: REALITY_CTX });
  for (const s of r.scores) {
    assert.ok(s >= 0 && s <= 1, `score ${s} out of [0,1]`);
  }
  assert.equal(r.accepted, false);
});
