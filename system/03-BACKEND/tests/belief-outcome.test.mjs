// belief-outcome.test.mjs
//
// The one property this module MUST have: it does not print a confident number
// when the evidence base doesn't support one. The independence correction
// caught our own live-ledger case (n=23 beliefs, 1 outcome) — these tests lock
// it so a future edit can't quietly regress to reporting 23/1 as 23 trials.
//
// Run: bun 03-BACKEND/tests/belief-outcome.test.mjs

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pairBeliefsWithOutcomes, calibration, expertCalibration, unverifiedClaims, wilson, VERDICT }
  from '../belief-outcome.mjs';
import { __loopInternals } from '../learning-loop.mjs';

const { appendFlux } = __loopInternals;

let pass = 0, fail = 0;
function t(n, f) { try { f(); console.log(`  PASS  ${n}`); pass++; } catch (e) { console.log(`  FAIL  ${n}\n        ${e.message}`); fail++; } }
function assert(c, m) { if (!c) throw new Error(m); }

const fluxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'belief-outcome-'));
console.log('\nbelief-outcome — the Schism ledger as calibration corpus\n  (temp ledger:', fluxRoot + ')\n');

// ── Helpers to author fixture events ────────────────────────────────────────
let seq = 0;
const T0 = Date.parse('2026-07-01T00:00:00Z');
function belief(offsetMs, action, ok, expert, summary) {
  seq++;
  appendFlux({
    fluxRoot, lane: 'thought', origin: `spine:${action}`,
    kind: (ok ? 'receipt' : 'mistake') + `:${action}`,
    ts: T0 + offsetMs,
    body: {
      action, status: ok ? 'ok' : 'error', summary: summary ?? `${action} claim ${seq}`,
      is_mistake: !ok, ...(ok ? {} : { overall_ok: false, severity: 'error' }),
      expert_id: expert ?? null,
    },
  });
}
function outcome(offsetMs, action, passed, selfVerified = true, summary) {
  seq++;
  appendFlux({
    fluxRoot, lane: 'reality', origin: 'terminal:test-run',
    kind: passed ? 'observation:test-pass' : 'observation:test-fail',
    ts: T0 + offsetMs,
    body: {
      schema: 'orange5.reality.observation.v1',
      self_verified: selfVerified,
      summary: summary ?? `${action} observation`,
      passed, exit_code: passed ? 0 : 2, commands: [action],
      ...(passed ? {} : { overall_ok: false, is_mistake: true }),
    },
  });
}
const NOW = T0 + 30 * 86_400_000;   // pin nowMs so time-based bounds are deterministic

// ── THE CORE INVARIANT: independence correction ─────────────────────────────
t('CORE: 23 beliefs graded by 1 outcome is NOT 23 trials — INSUFFICIENT_EVIDENCE', () => {
  const R = fs.mkdtempSync(path.join(os.tmpdir(), 'bo-independence-'));
  const oldRoot = fluxRoot;
  try {
    // Beliefs and outcome must share >= 2 topic tokens to pair (the live case
    // that inspired this test had 'verify' + 'visual' — two words is realistic).
    for (let i = 0; i < 23; i++) {
      appendFlux({ fluxRoot: R, lane: 'thought', origin: 'spine:verify.visual',
        kind: 'receipt:verify.visual', ts: T0 + i * 3600_000,
        body: { action: 'verify.visual', status: 'ok', summary: `stub verify.visual reflex smoke #${i}` } });
    }
    appendFlux({ fluxRoot: R, lane: 'reality', origin: 'terminal:test-run',
      kind: 'observation:test-fail', ts: T0 + 24 * 3600_000,
      body: { schema: 'x', self_verified: true, summary: 'verify.visual smoke exited 2 in 609ms',
        passed: false, exit_code: 2, overall_ok: false, is_mistake: true, commands: ['verify.visual'] } });

    const c = calibration({ fluxRoot: R, nowMs: T0 + 30 * 86_400_000 });
    assert(c.overall.n >= 20, `should resolve most beliefs, got ${c.overall.n}`);
    assert(c.overall.distinctOutcomes === 1, `expected 1 distinct outcome, got ${c.overall.distinctOutcomes}`);
    assert(c.overall.independent === false, 'reuse >> 1 must flag as non-independent');
    assert(c.overall.sufficient === false, 'sufficiency is by distinct evidence, not by belief count');
    assert(c.verdict.startsWith('INSUFFICIENT_EVIDENCE'), `verdict: ${c.verdict}`);
    assert(c.warnings.some(w => /OUTCOME_REUSE/.test(w)), 'must emit outcome-reuse warning');
  } finally { fs.rmSync(R, { recursive: true, force: true }); }
});

// ── PAIRING ─────────────────────────────────────────────────────────────────
t('pairs a belief to a later outcome that shares topic tokens', () => {
  belief(0, 'build.feature', true, 'opus', 'add dark mode toggle to settings');
  outcome(3600_000, 'build.feature', true, true, 'dark mode toggle settings shipped clean');
  const p = pairBeliefsWithOutcomes({ fluxRoot, nowMs: NOW });
  const found = p.pairs.find(x => x.class === 'build.feature');
  assert(found, 'must pair by shared topic tokens (dark, mode, toggle, settings)');
  assert(found.verdict === VERDICT.CONFIRMED, `expected CONFIRMED, got ${found.verdict}`);
  assert(found.shared_tokens.length >= 2, 'must record the tokens that justified the join');
});

t('unresolved when no outcome shares the topic', () => {
  belief(2 * 86_400_000, 'read.status', true, null, 'orphan claim with no matching outcome text');
  const p = pairBeliefsWithOutcomes({ fluxRoot, nowMs: NOW });
  const found = p.pairs.find(x => x.belief.text?.includes('orphan claim'));
  assert(found?.verdict === VERDICT.UNRESOLVED, 'no matching outcome = UNRESOLVED');
  assert(found.outcome === null, 'unresolved carries null outcome');
});

t('outcome must FOLLOW belief in time (no retro grading)', () => {
  // outcome at T0-2h, belief at T0-1h — pair must not form
  const R = fs.mkdtempSync(path.join(os.tmpdir(), 'bo-arrow-'));
  appendFlux({ fluxRoot: R, lane: 'reality', origin: 'terminal:test-run',
    kind: 'observation:test-pass', ts: T0 - 7200_000,
    body: { schema: 'x', self_verified: true, passed: true, exit_code: 0, summary: 'phantom outcome' } });
  appendFlux({ fluxRoot: R, lane: 'thought', origin: 'spine:phantom',
    kind: 'receipt:phantom', ts: T0 - 3600_000,
    body: { action: 'phantom', status: 'ok', summary: 'phantom belief' } });
  const p = pairBeliefsWithOutcomes({ fluxRoot: R, nowMs: NOW });
  const found = p.pairs.find(x => x.class === 'phantom');
  assert(found?.verdict === VERDICT.UNRESOLVED, 'time arrow must be enforced — outcome BEFORE belief cannot grade it');
  fs.rmSync(R, { recursive: true, force: true });
});

t('self_verified:false Reality is EXCLUDED by default (a model must not grade itself)', () => {
  const R = fs.mkdtempSync(path.join(os.tmpdir(), 'bo-selfverify-'));
  // Need >= 2 shared tokens (default minShared) for pairing to be possible at all,
  // so that the test can prove EXCLUSION vs INCLUSION cleanly.
  appendFlux({ fluxRoot: R, lane: 'thought', origin: 'spine:widget',
    kind: 'receipt:widget', ts: T0, body: { action: 'widget', status: 'ok', summary: 'widget alpha bravo claim' } });
  appendFlux({ fluxRoot: R, lane: 'reality', origin: 'operator:decision',
    kind: 'observation:operator-decision', ts: T0 + 3600_000,
    body: { schema: 'x', self_verified: false, passed: true, summary: 'operator said widget alpha bravo passed' } });
  const p = pairBeliefsWithOutcomes({ fluxRoot: R, nowMs: NOW });
  const found = p.pairs.find(x => x.class === 'widget');
  assert(found?.verdict === VERDICT.UNRESOLVED, 'unverified operator claim must NOT grade a belief by default');
  const pIn = pairBeliefsWithOutcomes({ fluxRoot: R, nowMs: NOW, includeUnverified: true });
  assert(pIn.pairs.find(x => x.class === 'widget')?.verdict !== VERDICT.UNRESOLVED,
    'includeUnverified:true opts back in — explicit');
  fs.rmSync(R, { recursive: true, force: true });
});

// ── HONESTY: report blockers instead of fabricating rates ───────────────────
t('empty Reality lane → NOT_YET_MEASURABLE (never a fabricated rate)', () => {
  const R = fs.mkdtempSync(path.join(os.tmpdir(), 'bo-empty-reality-'));
  appendFlux({ fluxRoot: R, lane: 'thought', origin: 'spine:x',
    kind: 'receipt:x', ts: T0, body: { action: 'x', status: 'ok', summary: 'lonely claim' } });
  const c = calibration({ fluxRoot: R, nowMs: NOW });
  assert(c.verdict.startsWith('NOT_YET_MEASURABLE'), `verdict: ${c.verdict}`);
  assert(c.blocked === 'REALITY_LANE_EMPTY', 'must state the reason it cannot be measured');
  fs.rmSync(R, { recursive: true, force: true });
});

t('stale pairing (large lag) is FLAGGED, not silently accepted', () => {
  const R = fs.mkdtempSync(path.join(os.tmpdir(), 'bo-stale-'));
  appendFlux({ fluxRoot: R, lane: 'thought', origin: 'spine:legacy',
    kind: 'receipt:legacy', ts: T0, body: { action: 'legacy', status: 'ok', summary: 'legacy claim about widget' } });
  appendFlux({ fluxRoot: R, lane: 'reality', origin: 'terminal:test-run',
    kind: 'observation:test-fail', ts: T0 + 10 * 86_400_000,   // 10 days later
    body: { schema: 'x', self_verified: true, passed: false, exit_code: 2, overall_ok: false, is_mistake: true, summary: 'legacy widget broke' } });
  const c = calibration({ fluxRoot: R, staleLagMs: 2 * 86_400_000, nowMs: T0 + 30 * 86_400_000 });
  assert(c.overall.stale === true, 'median lag > threshold must flag stale');
  assert(c.warnings.some(w => /STALE_PAIRING/.test(w)), 'must warn');
  fs.rmSync(R, { recursive: true, force: true });
});

// ── EXPERT CALIBRATION — the MoE routing signal ─────────────────────────────
t('expertCalibration routes on Wilson lower bound over DISTINCT observations', () => {
  const R = fs.mkdtempSync(path.join(os.tmpdir(), 'bo-experts-'));
  // Expert A: 40 beliefs echoing the same claim, 1 outcome confirms → must NOT beat...
  for (let i = 0; i < 40; i++) {
    appendFlux({ fluxRoot: R, lane: 'thought', origin: 'spine:echo',
      kind: 'receipt:echo', ts: T0 + i * 3600_000,
      body: { action: 'echo', status: 'ok', summary: `echo alpha bravo #${i}`, expert_id: 'A' } });
  }
  appendFlux({ fluxRoot: R, lane: 'reality', origin: 'terminal:test-run',
    kind: 'observation:test-pass', ts: T0 + 40 * 3600_000,
    body: { schema: 'x', self_verified: true, passed: true, exit_code: 0, summary: 'echo alpha bravo passed' } });

  // Expert B: 8 distinct beliefs, each paired to its own outcome, 7 confirmed
  for (let i = 0; i < 8; i++) {
    appendFlux({ fluxRoot: R, lane: 'thought', origin: 'spine:vary',
      kind: 'receipt:vary', ts: T0 + (100 + i * 5) * 3600_000,
      body: { action: 'vary', status: 'ok', summary: `vary widget${i} config${i} rev${i}`, expert_id: 'B' } });
    appendFlux({ fluxRoot: R, lane: 'reality', origin: 'terminal:test-run',
      kind: i === 7 ? 'observation:test-fail' : 'observation:test-pass',
      ts: T0 + (101 + i * 5) * 3600_000,
      body: { schema: 'x', self_verified: true, passed: i !== 7, exit_code: i === 7 ? 2 : 0,
        summary: `vary widget${i} config${i} rev${i} outcome`,
        ...(i === 7 ? { overall_ok: false, is_mistake: true } : {}) } });
  }

  const e = expertCalibration({ fluxRoot: R, minSample: 8, nowMs: T0 + 300 * 3600_000 });
  const A = e.experts.find(x => x.expert_id === 'A');
  const B = e.experts.find(x => x.expert_id === 'B');
  assert(A && B, 'both experts must appear');
  assert(A.outcomeReuse > 5, `A must show high reuse, got ${A.outcomeReuse}`);
  assert(A.sufficient === false, 'A has 1 distinct outcome — cannot be routable');
  assert(A.routingScore === null, 'insufficient expert must have null routingScore');
  assert(B.sufficient === true, 'B has 8 distinct outcomes — routable');
  assert(B.routingScore !== null && B.routingScore > 0, 'B has real evidence');
  assert(e.experts[0].expert_id === 'B', 'router must prefer B — 40 echoes cannot outrank 8 checks');
  fs.rmSync(R, { recursive: true, force: true });
});

// ── UNVERIFIED CLAIMS ───────────────────────────────────────────────────────
t('unverifiedClaims returns beliefs never met by an outcome', () => {
  const R = fs.mkdtempSync(path.join(os.tmpdir(), 'bo-unverified-'));
  for (let i = 0; i < 5; i++) {
    appendFlux({ fluxRoot: R, lane: 'thought', origin: 'spine:orphan',
      kind: 'receipt:orphan', ts: T0 + i * 3600_000,
      body: { action: 'orphan', status: 'ok', summary: `orphan claim gamma delta ${i}` } });
  }
  const u = unverifiedClaims({ fluxRoot: R, nowMs: NOW });
  assert(u.count === 5, `expected 5 open claims, got ${u.count}`);
  assert(u.claims.every(c => c.class === 'orphan'), 'all must be orphan class');
});

// ── WILSON MATH ─────────────────────────────────────────────────────────────
t('wilson interval bounds are correct at n=0, small n, large n', () => {
  const zero = wilson(0, 0);
  assert(zero.p === null && zero.n === 0, 'n=0 → null p');

  const three = wilson(3, 3);
  assert(three.p === 1, 'p̂ = 1 for 3/3');
  assert(three.lo < 0.5, 'but the lower bound is well below 1 (correct)');

  const big = wilson(80, 100);
  assert(Math.abs(big.p - 0.8) < 1e-9, 'point estimate is 0.8');
  assert(big.lo > 0.7 && big.hi < 0.87, 'interval tightens with n');
});

console.log(`\nSummary: ${pass} pass / ${fail} fail of ${pass + fail}\n`);
fs.rmSync(fluxRoot, { recursive: true, force: true });
if (fail > 0) process.exit(1);
