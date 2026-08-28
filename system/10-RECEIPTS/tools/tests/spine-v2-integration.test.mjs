// spine-v2-integration.test.mjs - the four organs against a deterministic,
// legacy-compatible chain. Live operator history is audited separately so the
// source verifier never borrows untracked machine state.
//
// Run: bun 10-RECEIPTS/tools/tests/spine-v2-integration.test.mjs

import { buildTrajectory, liveClaims, supersededClaims, campaignHealth, chainIntegrity } from '../trajectory.mjs';
import { epistemicPrior, chainSelfAudit, claimShape } from '../../../06-ORANGELLM/memory/ae-cobra/epistemic-prior.mjs';
import { pickTopology, adversarialBrief, TOPOLOGIES } from '../../../06-ORANGELLM/topology-router.mjs';
import { counterfactualReplay, leakageCorrection, sceneConfoundCorrection } from '../counterfactual-replay.mjs';
import { evaluateEpistemicGates } from '../../../08-HERMES/src/loom-epistemic.mjs';

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log(`  [PASS] ${name}`); pass++; }
  catch (e) { console.log(`  [FAIL] ${name}\n         ${e.message}`); fail++; }
}
function assert(c, m) { if (!c) throw new Error(m); }

console.log('\nSpine v2 organs - deterministic chain integration\n');

function buildFixtureChain(count = 220) {
  const out = [];
  for (let seq = 0; seq < count; seq++) {
    const row = {
      seq,
      action: seq % 9 === 0 ? 'verify.claim' : 'read.status',
      summary: seq % 9 === 0 ? 'results are consistent with verified operation' : `fixture receipt ${seq}`,
      hash: `fixture-hash-${seq}`,
      epistemic_score: 0.8,
    };
    if (seq > 0) row.prev_hash = out[seq - 1].hash;
    if (seq >= 20) row.campaign_id = 'fixture-campaign';
    out.push(row);
  }
  return out;
}

const chain = buildFixtureChain();
console.log(`  (deterministic fixture chain: ${chain.length} receipts)\n`);

// ── TRAJECTORY ──────────────────────────────────────────────────────
t('trajectory builds from the deterministic chain', () => {
  const traj = buildTrajectory(chain);
  assert(traj.size === chain.length, `size ${traj.size} != ${chain.length}`);
  assert(traj.campaigns.size >= 1, 'expected at least one campaign bucket');
});

t('backward compatible — pre-field receipts read as unassigned, nothing throws', () => {
  const traj = buildTrajectory(chain);
  const live = liveClaims(traj);
  assert(live.length > 0, 'expected live claims');
  // legacy receipts have no campaign_id and must land in _unassigned without error
  assert(traj.campaigns.has('_unassigned'), 'legacy receipts should bucket to _unassigned');
});

t('chain integrity holds on deterministic data', () => {
  const r = chainIntegrity(chain);
  assert(r.broken === 0, `chain has ${r.broken} broken links: ${JSON.stringify(r.breaks)}`);
  assert(r.links_checked > 200, `expected >200 links checked, got ${r.links_checked}`);
});

t('supersession derives forward-only and never rewrites the victim', () => {
  const synthetic = [
    { seq: 0, action: 'a.claim', summary: 'perfect discrimination', hash: 'h0' },
    { seq: 1, action: 'a.correct', summary: 'was a scene confound', supersedes: [0], prev_hash: 'h0', hash: 'h1' },
  ];
  const traj = buildTrajectory(synthetic);
  assert(traj.nodes.get(0).superseded_by === 1, 'seq 0 should be superseded by 1');
  assert(traj.nodes.get(1).superseded_by === null, 'seq 1 should be live');
  // the victim's own bytes are untouched
  assert(traj.nodes.get(0).hash === 'h0', 'victim hash must not change');
  assert(traj.nodes.get(0).summary === 'perfect discrimination', 'victim summary must not change');
  const live = liveClaims(traj);
  assert(live.length === 1 && live[0].seq === 1, 'only the correction should be live');
});

t('campaignHealth reports supersession rate', () => {
  const synthetic = [
    { seq: 0, campaign_id: 'c1', summary: 'claim a', epistemic_score: 0.5 },
    { seq: 1, campaign_id: 'c1', summary: 'claim b', epistemic_score: 0.9 },
    { seq: 2, campaign_id: 'c1', summary: 'correction', supersedes: [0], epistemic_score: 1.0 },
  ];
  const h = campaignHealth(buildTrajectory(synthetic), 'c1');
  assert(h.receipts === 3, `receipts ${h.receipts}`);
  assert(h.superseded === 1, `superseded ${h.superseded}`);
  assert(Math.abs(h.supersession_rate - 1 / 3) < 1e-9, `rate ${h.supersession_rate}`);
  assert(Math.abs(h.mean_epistemic_score - 0.8) < 1e-9, `mean ${h.mean_epistemic_score}`);
});

// ── EPISTEMIC PRIOR ─────────────────────────────────────────────────
t('claimShape fingerprints strength and sample band', () => {
  assert(claimShape('this PROVES it', { n: 5 }).strength === 'absolute', 'absolute');
  assert(claimShape('this PROVES it', { n: 5 }).sampleBand === 'tiny', 'tiny');
  assert(claimShape('results are consistent with', { n: 500 }).strength === 'hedged', 'hedged');
  assert(claimShape('results are consistent with', { n: 500 }).sampleBand === 'large', 'large');
});

t('cold-start guard flags absolute-at-tiny even with no matching history', () => {
  const p = epistemicPrior({
    summary: 'This PROVES the substrate discriminates perfectly',
    meta: { n: 7, action: 'test.claim' },
    chain: [{ seq: 0, action: 'x.y', summary: 'unrelated hedged note' }],
  });
  assert(p.verdict === 'HIGH_RISK_SHAPE', `verdict ${p.verdict}`);
  assert(p.penalty > 0, 'expected a penalty');
});

t('learns the shape from its OWN documented history', () => {
  // three absolute/tiny claims, two of which were overturned
  const hist = [
    { seq: 0, action: 'r.claim', summary: 'PERFECT discrimination achieved', sample_n: 8 },
    { seq: 1, action: 'r.claim', summary: 'PROVEN separation of classes', sample_n: 10 },
    { seq: 2, action: 'r.claim', summary: 'CONCLUSIVELY demonstrated', sample_n: 7 },
    { seq: 3, action: 'r.fix', summary: 'was a confound', supersedes: [0] },
    { seq: 4, action: 'r.fix', summary: 'leakage found', supersedes: [1] },
  ];
  const p = epistemicPrior({ summary: 'PERFECT results again', meta: { n: 9, action: 'r.claim' }, chain: hist });
  assert(p.observed.total >= 3, `total ${p.observed.total}`);
  assert(p.observed.superseded >= 2, `superseded ${p.observed.superseded}`);
  assert(p.verdict === 'HIGH_RISK_SHAPE', `verdict ${p.verdict}`);
  assert(/overturned/.test(p.advice || ''), 'advice should cite the history');
  assert(p.examples.length > 0, 'should cite concrete prior examples');
});

t('hedged large-sample claims are not penalised', () => {
  const p = epistemicPrior({
    summary: 'results are consistent with category separation',
    meta: { n: 400, action: 'r.claim' }, chain,
  });
  assert(p.penalty === 0 || p.verdict !== 'HIGH_RISK_SHAPE', `should not be high risk, got ${p.verdict}`);
});

t('chainSelfAudit profiles the deterministic chain by claim shape', () => {
  const a = chainSelfAudit({ chain });
  assert(a.chainSize === chain.length, 'size mismatch');
  assert(Array.isArray(a.byShape) && a.byShape.length > 0, 'expected shape rows');
});

// ── TOPOLOGY ROUTER ─────────────────────────────────────────────────
t('mechanical work routes SOLO — cheap work stays cheap', () => {
  const r = pickTopology({ action: 'read.status', payload: {} });
  assert(r.topology === TOPOLOGIES.SOLO, `got ${r.topology}`);
  assert(r.adversarialRequired === false, 'no refute-pass for a status read');
});

t('a factual claim routes ADVERSARIAL — the core rule', () => {
  const r = pickTopology({ action: 'verify.discrimination', intent: 'confirm the substrate discriminates' });
  assert(r.topology === TOPOLOGIES.ADVERSARIAL_PAIR, `got ${r.topology}`);
  assert(r.adversarialRequired === true, 'claims must survive a refute-pass');
  assert(r.gates.includes('epistemic'), 'epistemic gate required');
});

t('irreversible work demands adversarial + human final stop', () => {
  const r = pickTopology({ action: 'deploy.release', intent: 'ship to production' });
  assert(r.adversarialRequired === true, 'adversarial required');
  assert(r.gates.includes('human_final_stop'), 'human stop required');
});

t('broad claim surface routes FANOUT_VERIFY', () => {
  const r = pickTopology({ action: 'audit.campaign', intent: 'measure across all banks and verify every finding' });
  assert(r.topology === TOPOLOGIES.FANOUT_VERIFY, `got ${r.topology}`);
  assert(r.minAgents >= 3, 'fan-out needs agents');
});

t('open design space routes PANEL', () => {
  const r = pickTopology({ action: 'design.architecture', intent: 'explore approaches for the new lane' });
  assert(r.topology === TOPOLOGIES.PANEL, `got ${r.topology}`);
});

t('adversarial brief actively falsifies without inventing objections', () => {
  const b = adversarialBrief({ action: 'x' }, { summary: 'perfect discrimination' });
  assert(/falsify/i.test(b.instruction), 'must instruct active falsification');
  assert(/concrete contradiction/i.test(b.instruction), 'must require a concrete defeater');
  assert(/Do not invent/i.test(b.instruction), 'must reject performative objections');
  assert(b.attackVectors.length >= 3, 'needs a bounded universal attack surface');
});

// ── COUNTERFACTUAL REPLAY ───────────────────────────────────────────
t('replay finds LIVE claims that die under a correction', () => {
  const hist = [
    { seq: 10, action: 'law.tournament', summary: 'PERFECT discrimination TPR=100%' },
    { seq: 11, action: 'read.status', summary: 'chain ok' },
  ];
  const r = counterfactualReplay({ chain: hist, corrections: [leakageCorrection()] });
  assert(r.liveButFalsified.length === 1, `expected 1 live-but-falsified, got ${r.liveButFalsified.length}`);
  assert(r.liveButFalsified[0].seq === 10, 'seq 10 should be falsified');
  assert(/do not survive/.test(r.verdict), `verdict: ${r.verdict}`);
});

t('replay leaves already-corrected history alone', () => {
  const hist = [
    { seq: 10, action: 'law.tournament', summary: 'PERFECT discrimination TPR=100%' },
    { seq: 11, action: 'law.correct', summary: 'nested rerun shows 0.60', supersedes: [10] },
  ];
  const r = counterfactualReplay({ chain: hist, corrections: [leakageCorrection()] });
  assert(r.liveButFalsified.length === 0, 'the correction already landed; nothing live should be falsified');
});

t('replay NEVER mutates history', () => {
  const before = JSON.stringify(chain);
  const r = counterfactualReplay({ chain, corrections: [leakageCorrection(), sceneConfoundCorrection()] });
  assert(JSON.stringify(chain) === before, 'chain was mutated — unacceptable');
  assert(r.historyMutated === false, 'must report no mutation');
});

t('replay runs on the deterministic chain end to end', () => {
  const r = counterfactualReplay({ chain, fromSeq: 100, corrections: [leakageCorrection(), sceneConfoundCorrection()] });
  assert(r.shadow.length > 0, 'expected shadow receipts');
  assert(typeof r.verdict === 'string', 'expected a verdict');
});

// ── FULL CROSSING ───────────────────────────────────────────────────
t('end-to-end: a bad claim is stopped by topology + epistemic together', () => {
  const order = { action: 'verify.discrimination', intent: 'prove perfect separation' };
  const topo = pickTopology(order);
  assert(topo.adversarialRequired, 'topology must demand a refute-pass');

  const gate = evaluateEpistemicGates(
    { statement: 'PERFECT discrimination proven' },
    { n: 8, coverage: 1.0, rateBounds: { FPR: { bound: 0.10, n: 8 } }, classesSceneMatched: false },
    {}
  );
  assert(!gate.passed, 'epistemic gate must block');
  assert(gate.epistemicScore < 0.6, `score should be low, got ${gate.epistemicScore}`);

  const prior = epistemicPrior({ summary: 'PERFECT discrimination proven', meta: { n: 8 }, chain });
  assert(prior.verdict === 'HIGH_RISK_SHAPE', 'prior must flag the shape');
});

console.log(`\n  ${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
