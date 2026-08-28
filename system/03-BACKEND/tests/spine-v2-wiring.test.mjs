// spine-v2-wiring.test.mjs — the v2 organs INSIDE the hot path.
//
// The organs were tested standalone (48 assertions). This proves they are
// actually wired into runOrder, that advisory mode is non-breaking, that strict
// mode really halts, and that the two MoE attribution fields land on receipts.
//
// Run: bun 03-BACKEND/tests/spine-v2-wiring.test.mjs

import { runOrder } from '../orange5-spine.mjs';

const ADVERSARIAL_PASS = Object.freeze({
  completed: true, preExecution: true, refuted: false,
  status: 'completed', reason: 'test refuter found no surviving objection',
});

let pass = 0, fail = 0;
function t(n, f) { try { f(); console.log(`  PASS  ${n}`); pass++; } catch (e) { console.log(`  FAIL  ${n}\n        ${e.message}`); fail++; } }
function assert(c, m) { if (!c) throw new Error(m); }

const exec = () => ({ ok: true, summary: 'executed', output: null });
const lease = a => ({ id: 't', allowed: [a], forbidden: [], requires_approval: false });

console.log('\nSpine v2 wiring — organs in the hot path\n');

// ── TOPOLOGY IN THE PLAN ─────────────────────────────────────────────────
t('topology reaches the plan — a claim demands a refute-pass', () => {
  const r = runOrder({ action: 'verify.discrimination', intent: 'confirm separation' },
    { dryRun: true, receiptChain: [], executor: exec, lease: lease('verify.discrimination') });
  assert(r.plan.topology === 'adversarial_pair', `topology ${r.plan.topology}`);
  assert(r.plan.adversarial_required === true, 'must require adversarial');
  assert(r.plan.required_gates.includes('epistemic'), 'must require epistemic gate');
});

t('mechanical work stays SOLO — cheap work is not taxed', () => {
  const r = runOrder({ action: 'read.status' },
    { dryRun: true, receiptChain: [], executor: exec, lease: lease('read.status') });
  assert(r.plan.topology === 'solo', `topology ${r.plan.topology}`);
  assert(r.plan.adversarial_required === false, 'no refute-pass for a status read');
});

// ── ADVISORY MODE IS NON-BREAKING ────────────────────────────────────────
t('ADVISORY (explicit): a weak diagnostic claim completes but is scored and annotated', () => {
  const chain = [];
  const r = runOrder(
    { action: 'verify.x', intent: 'prove it', evidence: { n: 5, coverage: 1.0, rateBounds: { FPR: { bound: 0.10, n: 5 } } } },
    { receiptChain: chain, executor: () => ({ ok: true, summary: 'PERFECT discrimination proven', output: null }), lease: lease('verify.x'), epistemicMode: 'advisory', adversarialEvidence: ADVERSARIAL_PASS }
  );
  assert(r.status === 'ok', `advisory must not halt, got ${r.status}`);
  assert(r.epistemic && r.epistemic.passed === false, 'gate should have found blocks');
  assert(Number.isFinite(r.receipt.epistemic_score), 'score must be recorded on the receipt');
  assert(r.receipt.epistemic_score < 0.8, `score ${r.receipt.epistemic_score} should be penalised`);
  assert(r.notes.some(n => /epistemic SAMPLE_POWER/.test(n)), 'must annotate the failure in notes');
});

t('TOPOLOGY DEFAULT: a weak claim is strict and HALTED', () => {
  const chain = [];
  let executed = false;
  const r = runOrder(
    { action: 'verify.x', intent: 'prove it', evidence: { n: 5, coverage: 1.0, rateBounds: { FPR: { bound: 0.10, n: 5 } } } },
    { receiptChain: chain, executor: () => { executed = true; return { ok: true, summary: 'PERFECT discrimination proven', output: null }; }, lease: lease('verify.x'), adversarialEvidence: ADVERSARIAL_PASS }
  );
  assert(r.status === 'halted', `claim topology must halt weak evidence, got ${r.status}`);
  assert(executed === false, 'strict weak claim must halt before executor entry');
  assert(r.receipt.executed === false, 'receipt must record no execution');
  assert(r.topology.gates.includes('epistemic'), 'topology must require epistemic enforcement');
  assert(r.receipt.epistemic_blocks.includes('SAMPLE_POWER'), 'receipt must name the evidence failure');
});

// ── STRICT MODE REALLY HALTS ─────────────────────────────────────────────
t('STRICT: the same weak claim is HALTED before entering the chain', () => {
  const chain = [];
  let executed = false;
  const r = runOrder(
    { action: 'verify.x', intent: 'prove it', evidence: { n: 5, coverage: 1.0, rateBounds: { FPR: { bound: 0.10, n: 5 } } } },
    { receiptChain: chain, executor: () => { executed = true; return { ok: true, summary: 'PERFECT discrimination proven', output: null }; },
      lease: lease('verify.x'), epistemicMode: 'strict', adversarialEvidence: ADVERSARIAL_PASS }
  );
  assert(r.status === 'halted', `strict must halt, got ${r.status}`);
  assert(/epistemic preflight halted/.test(r.report.summary), `summary: ${r.report.summary}`);
  assert(executed === false, 'strict evidence rejection must occur before executor entry');
  assert(r.receipt.executed === false, 'receipt must record no execution');
  assert(r.receipt != null, 'a halt is still a receipt — the refusal is recorded');
});

t('STRICT: a well-evidenced claim passes cleanly', () => {
  const r = runOrder(
    { action: 'verify.x', intent: 'measure separation',
      evidence: { n: 200, coverage: 0.95, rateBounds: { FPR: { bound: 0.10, n: 200 } }, classesSceneMatched: true, primaryCI: [0.82, 0.91] } },
    { receiptChain: [], executor: () => ({ ok: true, summary: 'results are consistent with separation', output: null }),
      lease: lease('verify.x'), epistemicMode: 'strict', adversarialEvidence: ADVERSARIAL_PASS }
  );
  assert(r.status === 'ok', `should pass, got ${r.status}: ${r.report?.summary}`);
  assert(r.receipt.epistemic_score >= 0.9, `score ${r.receipt.epistemic_score}`);
});

// ── MoE ATTRIBUTION — the two fields that make the chain a training set ──
t('expert_id + claim_shape land on the receipt', () => {
  const r = runOrder({ action: 'verify.x', intent: 'prove it', evidence: { n: 8 } },
    { receiptChain: [], executor: () => ({ ok: true, summary: 'PERFECT result', output: null }),
      lease: lease('verify.x'), expertId: 'opus', adversarialEvidence: ADVERSARIAL_PASS });
  assert(r.receipt.expert_id === 'opus', `expert_id ${r.receipt.expert_id}`);
  assert(r.receipt.claim_shape === 'absolute|tiny', `claim_shape ${r.receipt.claim_shape}`);
  assert(r.receipt.sample_n === 8, `sample_n ${r.receipt.sample_n}`);
});

t('trajectory fields land when supplied', () => {
  const r = runOrder({ action: 'fix.x', intent: 'correct it', supersedes: [7], evidence_refs: ['dossier.json'] },
    { receiptChain: [], executor: exec, lease: lease('fix.x'), campaignId: 'camp-1', parentReceipt: 6 });
  assert(r.receipt.campaign_id === 'camp-1', 'campaign_id');
  assert(r.receipt.parent_receipt === 6, 'parent_receipt');
  assert(JSON.stringify(r.receipt.supersedes) === '[7]', 'supersedes');
  assert(JSON.stringify(r.receipt.evidence_refs) === '["dossier.json"]', 'evidence_refs');
});

// ── BACKWARD COMPATIBILITY — the load-bearing guarantee ──────────────────
t('a bare order writes a receipt with NO v2 noise — old shape preserved', () => {
  const r = runOrder({ action: 'read.status' }, { receiptChain: [], executor: exec, lease: lease('read.status') });
  assert(r.receipt.campaign_id === undefined, 'no campaign_id when not supplied');
  assert(r.receipt.parent_receipt === undefined, 'no parent_receipt when not supplied');
  assert(r.receipt.supersedes === undefined, 'no supersedes when not supplied');
  assert(r.receipt.expert_id === undefined, 'no expert_id when not supplied');
  // claim_shape and epistemic_score ARE always written — they are the training signal
  assert(typeof r.receipt.claim_shape === 'string', 'claim_shape is always written');
});

t('seeded replay is still byte-identical through the new path', () => {
  const mk = () => runOrder({ action: 'verify.x', intent: 'measure', evidence: { n: 50 } },
    { receiptChain: [], seed: 'fixed-seed', executor: () => ({ ok: true, summary: 'measured', output: null }), lease: lease('verify.x'), adversarialEvidence: ADVERSARIAL_PASS });
  const a = mk(), b = mk();
  assert(a.receipt.hash === b.receipt.hash, `determinism broken: ${a.receipt.hash} vs ${b.receipt.hash}`);
});

t('prev_hash chaining survives the added fields', () => {
  const chain = [];
  const o = { action: 'verify.x', intent: 'measure', evidence: { n: 50 } };
  const opt = { receiptChain: chain, executor: exec, lease: lease('verify.x'), expertId: 'opus', adversarialEvidence: ADVERSARIAL_PASS };
  const r1 = runOrder(o, opt), r2 = runOrder(o, opt);
  assert(r2.receipt.prev_hash === r1.receipt.hash, 'chain must still link');
  assert(r1.receipt.expert_id === 'opus' && r2.receipt.expert_id === 'opus', 'attribution on both');
});

// ── DEGRADATION — an organ failing must never crash the crossing ─────────
t('a broken organ degrades to an honest note, never a crash', () => {
  const r = runOrder({ action: 'verify.x', intent: 'measure', evidence: null },
    { receiptChain: [], executor: exec, lease: lease('verify.x'), adversarialEvidence: ADVERSARIAL_PASS });
  assert(r.status === 'ok', `must still complete, got ${r.status}`);
  assert(r.receipt != null, 'receipt must still be written');
});

console.log(`\nSummary: ${pass} pass / ${fail} fail of ${pass + fail}\n`);
if (fail > 0) process.exit(1);
