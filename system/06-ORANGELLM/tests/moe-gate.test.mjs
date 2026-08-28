// moe-gate.test.mjs — heterogeneous MoE gating.
//
// The expert roster below is modelled on the ensemble the operator ALREADY runs
// by hand. Failure profiles are seeded from what this project actually observed
// across the AEyes-1 campaign, not from vendor claims.
//
// Run: bun 06-ORANGELLM/tests/moe-gate.test.mjs

import { defineExpert, gate, failureCorrelation, calibrationFromChain, loadBalance, auxLoss, FAILURE_AXES } from '../moe-gate.mjs';

let pass = 0, fail = 0;
function t(n, f) { try { f(); console.log(`  [PASS] ${n}`); pass++; } catch (e) { console.log(`  [FAIL] ${n}\n         ${e.message}`); fail++; } }
function assert(c, m) { if (!c) throw new Error(m); }

console.log('\nMoE gate — heterogeneous expert routing\n');

// ── ROSTER ───────────────────────────────────────────────────────────────
// Failure profiles are observations from this project's own history.
const OPUS = defineExpert({
  id: 'opus', model: 'claude-opus-5',
  tools: ['bash', 'read', 'write', 'agent', 'workflow', 'vision'],
  costPerCall: 10, strengths: ['build', 'implement', 'verify'],
  failureProfile: {
    // observed at AEyes-1 seq 160/170 and in the L9-L11 leakage
    overclaims_on_small_n: 0.7,
    misses_selection_leakage: 0.8,
    misses_confounds: 0.7,
    sycophantic_to_operator: 0.5,
    premature_convergence: 0.6,
  },
});

const GPT_AUDITOR = defineExpert({
  id: 'gpt-auditor', model: 'gpt-architect',
  tools: ['reason'], costPerCall: 6, strengths: ['audit', 'review', 'verify'],
  failureProfile: {
    // caught every one of the above; different blind spots entirely
    overclaims_on_small_n: 0.1,
    misses_selection_leakage: 0.1,
    misses_confounds: 0.1,
    anchors_on_own_prior: 0.6,
    context_truncation: 0.5,
    tool_result_overtrust: 0.2,
  },
});

const KIMI = defineExpert({
  id: 'kimi', model: 'kimi-long-context',
  tools: ['read', 'reason'], contextWindow: 200000,
  costPerCall: 4, strengths: ['synthesize', 'corpus', 'survey'],
  failureProfile: {
    context_truncation: 0.1,
    overclaims_on_small_n: 0.3,
    misses_selection_leakage: 0.5,
    premature_convergence: 0.3,
    tool_result_overtrust: 0.6,
  },
});

// A near-twin of Opus: strong, but fails in the SAME places. The trap case.
const OPUS_TWIN = defineExpert({
  id: 'opus-twin', model: 'claude-opus-5-alt',
  tools: ['bash', 'read', 'write'], costPerCall: 10,
  failureProfile: {
    overclaims_on_small_n: 0.7,
    misses_selection_leakage: 0.8,
    misses_confounds: 0.7,
    sycophantic_to_operator: 0.5,
    premature_convergence: 0.6,
  },
});

const CHEAP = defineExpert({
  id: 'reflex', model: 'qwen3:0.6b', costPerCall: 1,
  strengths: ['read', 'status', 'format'],
  failureProfile: { overclaims_on_small_n: 0.4, context_truncation: 0.8, premature_convergence: 0.8 },
});

const ROSTER = [OPUS, GPT_AUDITOR, KIMI, OPUS_TWIN, CHEAP];

// ── FAILURE CORRELATION ──────────────────────────────────────────────────
t('twins are highly correlated — pairing them buys nothing', () => {
  const c = failureCorrelation(OPUS, OPUS_TWIN);
  assert(c > 0.9, `expected near-1 for twins, got ${c.toFixed(2)}`);
});

t('opus and the auditor are decorrelated — this is why the audit loop worked', () => {
  const c = failureCorrelation(OPUS, GPT_AUDITOR);
  assert(c < 0.4, `expected low correlation, got ${c.toFixed(2)}`);
});

t('decorrelation is symmetric', () => {
  const ab = failureCorrelation(OPUS, KIMI), ba = failureCorrelation(KIMI, OPUS);
  assert(Math.abs(ab - ba) < 1e-9, 'must be symmetric');
});

t('unknown failure profile is not rewarded', () => {
  const blank = defineExpert({ id: 'blank', model: 'x' });
  const c = failureCorrelation(OPUS, blank);
  assert(c === 0.5, `unknown should be 0.5 not 0, got ${c}`);
});

// ── THE CENTRAL CLAIM ────────────────────────────────────────────────────
t('CORE: gate picks the DECORRELATED peer, not the second-strongest twin', () => {
  const g = gate({ claimShape: 'absolute|tiny', order: { action: 'verify.discrimination' }, experts: ROSTER, chain: [], k: 2 });
  assert(g.selected.length === 2, `expected 2 experts, got ${g.selected.length}`);
  assert(g.selected.includes('opus-twin') === false,
    `gate chose the twin (${g.selected.join('+')}) — redundant competence catches nothing`);
  assert(g.pairCorrelation < 0.5, `pair correlation ${g.pairCorrelation?.toFixed(2)} too high — blind spots overlap`);
});

t('the chosen pair covers axes the anchor is blind to', () => {
  const g = gate({ claimShape: 'absolute|tiny', order: { action: 'verify.claim' }, experts: ROSTER, chain: [], k: 2 });
  const peerId = g.selected.find(id => id !== g.selected[0]);
  const peer = ROSTER.find(e => e.id === peerId);
  const anchor = ROSTER.find(e => e.id === g.selected[0]);
  // the peer must be materially better on at least one axis the anchor fails
  const covered = FAILURE_AXES.filter(ax => (anchor.failureProfile[ax] ?? 0) > 0.5 && (peer.failureProfile[ax] ?? 0) < 0.4);
  assert(covered.length > 0, `peer ${peerId} covers no axis the anchor ${anchor.id} is weak on`);
});

t('budget forces graceful degradation, honestly reported', () => {
  const g = gate({ claimShape: 'x', order: { action: 'verify.x' }, experts: ROSTER, chain: [], k: 2, budget: 10 });
  assert(g.k === 1 || g.estimatedCost <= 10, `budget breached: cost ${g.estimatedCost}`);
  if (g.k === 1) assert(g.degraded === true, 'degradation must be reported, not hidden');
});

t('combine weights are a normalized distribution', () => {
  const g = gate({ claimShape: 'x', order: { action: 'verify.x' }, experts: ROSTER, chain: [], k: 3 });
  const sum = g.combine.reduce((s, c) => s + c.weight, 0);
  assert(Math.abs(sum - 1) < 1e-9, `weights sum to ${sum}, must be 1`);
});

// ── AUX LOSS FROM THE CHAIN ──────────────────────────────────────────────
t('calibration is LEARNED from supersession, not declared', () => {
  const chain = [
    { seq: 1, expert_id: 'opus', claim_shape: 'absolute|tiny' },
    { seq: 2, expert_id: 'opus', claim_shape: 'absolute|tiny' },
    { seq: 3, expert_id: 'opus', claim_shape: 'absolute|tiny' },
    { seq: 4, expert_id: 'opus', claim_shape: 'absolute|tiny' },
    { seq: 5, expert_id: 'gpt-auditor', claim_shape: 'absolute|tiny', supersedes: [1, 2, 3] },
  ];
  const opus = calibrationFromChain(chain, 'opus', 'absolute|tiny');
  assert(opus.n === 4, `n=${opus.n}`);
  assert(opus.superseded === 3, `superseded=${opus.superseded}`);
  assert(opus.competence < 0.5, `competence ${opus.competence} should be below 0.5 after 3/4 overturned`);
  assert(opus.source === 'chain', 'must come from chain not declaration');
});

t('thin evidence shrinks toward 0.5 — 1-of-1 is not trusted', () => {
  const chain = [{ seq: 1, expert_id: 'kimi', claim_shape: 's' }];
  const c = calibrationFromChain(chain, 'kimi', 's');
  assert(c.n === 1 && Math.abs(c.competence - 0.55) < 0.01, `expected heavy shrinkage, got ${c.competence}`);
});

t('measured history overrides the declared prior in routing', () => {
  // opus is repeatedly overturned on this shape; kimi is clean
  const chain = [];
  for (let i = 1; i <= 10; i++) chain.push({ seq: i, expert_id: 'opus', claim_shape: 'absolute|tiny' });
  for (let i = 11; i <= 20; i++) chain.push({ seq: i, expert_id: 'kimi', claim_shape: 'absolute|tiny' });
  chain.push({ seq: 21, expert_id: 'gpt-auditor', claim_shape: 'absolute|tiny', supersedes: [1,2,3,4,5,6,7,8,9] });
  const g = gate({ claimShape: 'absolute|tiny', order: { action: 'verify.x' }, experts: [OPUS, KIMI], chain, k: 1 });
  assert(g.selected[0] === 'kimi', `chain shows opus wrong 9/10 on this shape; gate picked ${g.selected[0]}`);
});

// ── LOAD BALANCING ───────────────────────────────────────────────────────
t('detects collapse toward a monolith', () => {
  const chain = Array.from({ length: 20 }, (_, i) => ({ seq: i, expert_id: 'opus' }));
  const lb = loadBalance(chain, ROSTER, 20);
  assert(lb.balanced === false, 'must flag collapse');
  assert(lb.dominant.includes('opus'), 'must name the dominant expert');
  assert(/collapsing toward a monolith/.test(lb.warning), `warning: ${lb.warning}`);
});

t('detects starved experts — specialization needs traffic', () => {
  const chain = [
    ...Array.from({ length: 5 }, (_, i) => ({ seq: i, expert_id: 'opus' })),
    ...Array.from({ length: 5 }, (_, i) => ({ seq: i + 5, expert_id: 'kimi' })),
  ];
  const lb = loadBalance(chain, ROSTER, 20);
  assert(lb.collapsed.length > 0, 'must flag never-routed experts');
});

t('balanced traffic passes', () => {
  const chain = ROSTER.flatMap((e, i) => Array.from({ length: 4 }, (_, j) => ({ seq: i * 4 + j, expert_id: e.id })));
  const lb = loadBalance(chain, ROSTER, 20);
  assert(lb.balanced === true, `should be balanced: ${lb.warning}`);
});

// ── THE TRAINING SIGNAL ──────────────────────────────────────────────────
t('auxLoss surfaces per-expert-per-shape error from own history', () => {
  const chain = [
    { seq: 1, expert_id: 'opus', claim_shape: 'absolute|tiny' },
    { seq: 2, expert_id: 'opus', claim_shape: 'absolute|tiny' },
    { seq: 3, expert_id: 'opus', claim_shape: 'hedged|large' },
    { seq: 4, expert_id: 'gpt-auditor', claim_shape: 'strong|small', supersedes: [1, 2] },
  ];
  const l = auxLoss(chain, ROSTER);
  assert(l.labeledExamples === 4, `labeled=${l.labeledExamples}`);
  const worst = l.cells[0];
  assert(worst.expert === 'opus' && worst.shape === 'absolute|tiny', `worst cell: ${JSON.stringify(worst)}`);
  assert(worst.loss === 1, `opus absolute|tiny should be loss 1.0, got ${worst.loss}`);
});

t('unattributed chain says so plainly instead of faking a signal', () => {
  const l = auxLoss([{ seq: 1, action: 'x' }], ROSTER);
  assert(l.labeledExamples === 0, 'no attribution');
  assert(/no expert_id attribution yet/.test(l.note), `note: ${l.note}`);
  assert(/zero collection cost/.test(l.note), 'should state the signal is free once attributed');
});

// ── DEGENERATE CASES ─────────────────────────────────────────────────────
t('empty roster degrades honestly', () => {
  const g = gate({ experts: [], chain: [] });
  assert(g.selected.length === 0 && g.degraded === true, 'must report degraded');
});

t('single available expert reports why it could not pair', () => {
  const g = gate({ claimShape: 'x', order: { action: 'verify.x' }, experts: [OPUS], chain: [], k: 2 });
  assert(g.k === 1 && g.degraded === true, 'must degrade');
  assert(/no decorrelated peer/.test(g.reason), `reason: ${g.reason}`);
});

console.log(`\n  ${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
