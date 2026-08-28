// Orange5 Spine — standalone Bun test harness.
// Proves the seven organs compose into one order->report flow, and that the
// four innovations hold: dry-run writes nothing, seeded replay is byte-identical,
// the governor defers under pressure, a hard gate halts execution, and the
// compression sieve runs OFF the hot path.
//
// Run:  bun 03-BACKEND/tests/orange5-spine.test.mjs

import { runOrder, shouldThrottle, __spineInternals } from '../orange5-spine.mjs';

const TESTS = [];
const test = (name, fn) => TESTS.push({ name, fn });
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m || 'not equal'}: ${a} !== ${b}`); };
const ok = (c, m) => { if (!c) throw new Error(m || 'expected truthy'); };

const ORDER = { action: 'build.feature', status: 'ok', payload: { text: 'ship the spine' } };
const EXECUTOR = () => ({ ok: true, executed: true, summary: 'test executor completed the action', output: { proven: true } });
const ADVERSARIAL_PASS = Object.freeze({
  completed: true, preExecution: true, refuted: false,
  status: 'completed', reason: 'test refuter found no surviving objection',
});

test('happy_path_composes_end_to_end_with_real_organs', () => {
  const chain = [];
  const r = runOrder(ORDER, { receiptChain: chain, executor: EXECUTOR, adversarialEvidence: ADVERSARIAL_PASS });
  eq(r.status, 'ok', 'status');
  ok(r.report && r.report.summary, 'has report');
  ok(r.receipt && r.receipt.hash, 'has hashed receipt');
  ok(r.lane, 'routed to a lane');
  eq(chain.length, 1, 'one receipt written');
  ok(r.report.mediation?.memory?.consulted, 'report proves pre-action memory consultation');
  ok(r.report.mediation?.compression?.consulted, 'report proves compression consultation');
  ok(r.report.mediation?.compression?.lossless, 'compression is lossless');
  ok(r.receipt.mediation?.compression?.raw_sha256, 'receipt carries compression identity');
  return `ok (lane=${r.lane}, receipt=${r.receipt.receipt_id.slice(0, 12)})`;
});

test('dry_run_returns_plan_and_writes_nothing', () => {
  const chain = [];
  const r = runOrder(ORDER, { dryRun: true, receiptChain: chain });
  eq(r.status, 'planned', 'status planned');
  ok(r.plan, 'has plan');
  ok('would_execute' in r.plan, 'plan has would_execute');
  eq(r.receipt, null, 'no receipt in dry-run');
  eq(chain.length, 0, 'chain untouched');
  return `ok (plan lane=${r.plan.lane}, wrote 0 receipts)`;
});

test('seeded_replay_is_byte_identical', () => {
  const a = [], b = [];
  const r1 = runOrder(ORDER, { seed: 'replay-seed-42', receiptChain: a, executor: EXECUTOR, adversarialEvidence: ADVERSARIAL_PASS });
  const r2 = runOrder(ORDER, { seed: 'replay-seed-42', receiptChain: b, executor: EXECUTOR, adversarialEvidence: ADVERSARIAL_PASS });
  eq(r1.receipt.receipt_id, r2.receipt.receipt_id, 'receipt id');
  eq(r1.receipt.hash, r2.receipt.hash, 'receipt hash');
  eq(r1.receipt.ts, r2.receipt.ts, 'deterministic ts');
  eq(JSON.stringify(r1.receipt), JSON.stringify(r2.receipt), 'full receipt bytes');
  return `ok (both => ${r1.receipt.hash.slice(0, 16)})`;
});

test('different_seeds_differ', () => {
  const r1 = runOrder(ORDER, { seed: 'A', receiptChain: [], executor: EXECUTOR, adversarialEvidence: ADVERSARIAL_PASS });
  const r2 = runOrder(ORDER, { seed: 'B', receiptChain: [], executor: EXECUTOR, adversarialEvidence: ADVERSARIAL_PASS });
  ok(r1.receipt.receipt_id !== r2.receipt.receipt_id, 'different seeds => different ids');
  return 'ok';
});

test('governor_defers_under_pressure', () => {
  const chain = [];
  const r = runOrder(ORDER, { flowState: { openCurrents: 99 }, flowConfig: { maxConcurrent: 16 }, receiptChain: chain });
  eq(r.status, 'deferred', 'status deferred');
  eq(chain.length, 0, 'no work committed when throttled');
  ok(/governor/.test(r.report.summary), 'report says governor');
  return `ok (${r.reason})`;
});

test('shouldThrottle_is_a_pure_backpressure_fn', () => {
  eq(shouldThrottle({ openCurrents: 5 }, { maxConcurrent: 16 }).throttle, false, 'under ceiling');
  eq(shouldThrottle({ openCurrents: 16 }, { maxConcurrent: 16 }).throttle, true, 'at ceiling');
  eq(shouldThrottle({ spawnRate: 100 }, { maxSpawnRate: 64 }).throttle, true, 'spawn ceiling');
  return 'ok';
});

test('hard_gate_failure_halts_execution', () => {
  const chain = [];
  let executed = false;
  const r = runOrder(ORDER, {
    gateFn: () => ({ passed: false, first_fail: { reason: 'forbidden action' } }),
    executor: () => { executed = true; return { ok: true }; },
    receiptChain: chain,
  });
  eq(r.status, 'halted', 'status halted');
  eq(executed, false, 'executor NEVER ran past the gate');
  eq(chain.length, 1, 'halt still receipted (honest audit)');
  eq(chain[0].executed, false, 'receipt records not-executed');
  return `ok (halted: ${r.report.summary})`;
});

test('gate_engine_fault_fails_closed_and_never_executes', () => {
  const chain = [];
  let executed = false;
  const r = runOrder(ORDER, {
    gateFn: () => { throw new Error('simulated LOOM engine fault'); },
    executor: () => { executed = true; return { ok: true, executed: true }; },
    receiptChain: chain,
  });
  eq(r.status, 'halted', 'gate engine fault must halt');
  eq(executed, false, 'executor never runs when authorization is unavailable');
  eq(chain.length, 1, 'authorization failure is receipted');
  eq(chain[0].executed, false, 'receipt records no execution');
  ok(/gate engine unavailable/.test(r.report.summary), 'halt names unavailable gate engine');
  ok(r.notes.some((note) => /simulated LOOM engine fault/.test(note)), 'underlying fault remains diagnosable');
  return 'ok';
});

test('no_eligible_route_halts_before_execution', () => {
  const chain = [];
  let executed = false;
  const r = runOrder({ ...ORDER, latencyBudgetMs: 1 }, {
    executor: () => { executed = true; return { ok: true, executed: true }; },
    receiptChain: chain,
  });
  eq(r.status, 'needs_action', 'impossible route needs action');
  eq(r.lane, null, 'no lane is invented');
  eq(r.plan.eligible, false, 'plan exposes route ineligibility');
  eq(r.plan.would_execute, false, 'plan refuses to promise execution');
  eq(executed, false, 'executor never runs without an eligible lane');
  eq(chain[0].executed, false, 'receipt records no execution');
  ok(/no_eligible_lane/.test(r.report.summary), 'report preserves router rationale');
  return 'ok';
});

test('router_engine_fault_halts_before_execution', () => {
  const chain = [];
  let executed = false;
  const r = runOrder(ORDER, {
    routerFn: () => { throw new Error('simulated router fault'); },
    executor: () => { executed = true; return { ok: true, executed: true }; },
    receiptChain: chain,
  });
  eq(r.status, 'needs_action', 'router fault needs action');
  eq(r.lane, null, 'fault cannot invent a lane');
  eq(executed, false, 'executor never runs after router fault');
  eq(chain[0].executed, false, 'fault receipt records no execution');
  ok(r.notes.some((note) => /simulated router fault/.test(note)), 'router fault remains diagnosable');
  return 'ok';
});

test('topology_engine_fault_halts_before_execution', () => {
  const chain = [];
  let executed = false;
  const r = runOrder(ORDER, {
    topologyFn: () => { throw new Error('simulated topology fault'); },
    executor: () => { executed = true; return { ok: true, executed: true }; },
    receiptChain: chain,
  });
  eq(r.status, 'needs_action', 'topology fault needs action');
  eq(r.plan.topology_ready, false, 'plan exposes topology failure');
  eq(executed, false, 'executor never runs after topology fault');
  eq(chain[0].executed, false, 'fault receipt records no execution');
  ok(r.notes.some((note) => /simulated topology fault/.test(note)), 'topology fault remains diagnosable');
  return 'ok';
});

test('memory_engine_fault_halts_before_execution', () => {
  const chain = [];
  let executed = false;
  const r = runOrder(ORDER, {
    recallFn: () => { throw new Error('simulated memory fault'); },
    adversarialEvidence: ADVERSARIAL_PASS,
    executor: () => { executed = true; return { ok: true, executed: true }; },
    receiptChain: chain,
  });
  eq(r.status, 'needs_action', 'memory fault needs action');
  eq(r.plan.memory_ready, false, 'plan exposes memory failure');
  eq(executed, false, 'executor never runs after memory fault');
  eq(chain[0].executed, false, 'fault receipt records no execution');
  ok(r.notes.some((note) => /simulated memory fault/.test(note)), 'memory fault remains diagnosable');
  return 'ok';
});

test('atomsmasher_fault_halts_before_execution', () => {
  const chain = [];
  let executed = false;
  const r = runOrder(ORDER, {
    sieveFn: () => { throw new Error('simulated AtomSmasher fault'); },
    executor: () => { executed = true; return { ok: true, executed: true }; },
    receiptChain: chain,
  });
  eq(r.status, 'needs_action', 'sieve fault needs action');
  eq(r.plan.would_execute, false, 'plan refuses execution without compression proof');
  eq(executed, false, 'executor never runs after sieve fault');
  eq(chain[0].executed, false, 'fault receipt records no execution');
  eq(r.mediation.compression.lossless, false, 'mediation exposes missing lossless proof');
  ok(r.notes.some((note) => /simulated AtomSmasher fault/.test(note)), 'sieve fault remains diagnosable');
  return 'ok';
});

test('non_lossless_atomsmasher_result_halts_before_execution', () => {
  const chain = [];
  let executed = false;
  const r = runOrder(ORDER, {
    sieveFn: () => ({ ok: true, schema: 'test', crossing: { lossless: false }, debt: { roundtrip_ok: false } }),
    executor: () => { executed = true; return { ok: true, executed: true }; },
    receiptChain: chain,
  });
  eq(r.status, 'needs_action', 'non-lossless crossing needs action');
  eq(executed, false, 'executor never runs after non-lossless crossing');
  eq(chain[0].executed, false, 'non-lossless receipt records no execution');
  return 'ok';
});

test('real_false_green_guard_blocks_fake_green_status', () => {
  // uses the REAL LOOM gate (no injection) — proves the honesty gate is wired
  const chain = [];
  let executed = false;
  const r = runOrder({ action: 'ship.it', status: 'probably ok', payload: {} }, {
    executor: () => { executed = true; return { ok: true }; }, receiptChain: chain,
  });
  eq(r.status, 'halted', 'fake-green status must halt');
  eq(executed, false, 'never executes on fake-green');
  ok(/false_green|fake.?green/i.test(r.report.summary), 'report names the fake-green gate');
  return `ok (real guard halted: ${r.report.summary})`;
});

test('sieve_runs_before_execution_and_is_receipted', async () => {
  const r = runOrder(ORDER, { receiptChain: [], executor: EXECUTOR, adversarialEvidence: ADVERSARIAL_PASS });
  const c = await r.compressionDone;
  ok(c?.ok, 'compression completed');
  ok(r.mediation?.compression?.lossless, 'mediation proves byte-exact roundtrip');
  ok(r.receipt?.mediation?.compression?.consulted, 'receipt proves sieve crossing');
  return `ok (lossless=${r.mediation.compression.lossless}, saved=${r.mediation.compression.savings_bytes})`;
});

test('executor_receives_memory_and_compression_mediation', () => {
  let context = null;
  runOrder(ORDER, {
    receiptChain: [],
    adversarialEvidence: ADVERSARIAL_PASS,
    executor: (_order, ctx) => { context = ctx; return { ok: true, summary: 'executed' }; },
  });
  ok(context?.memory?.consulted, 'executor receives memory evidence');
  ok(context?.compression?.consulted, 'executor receives compression evidence');
  ok(context?.compression?.raw_sha256, 'executor receives exact crossing identity');
  return 'ok';
});

test('invalid_order_is_rejected_cleanly', () => {
  let threw = false;
  try { runOrder({ payload: {} }); } catch { threw = true; }
  ok(threw, 'order without action must throw');
  return 'ok';
});

test('claim_without_adversarial_evidence_halts_before_execution', () => {
  let executed = false;
  const r = runOrder({ action: 'verify.claim', intent: 'prove the claim', evidence: { n: 200 } }, {
    receiptChain: [],
    executor: () => { executed = true; return { ok: true }; },
  });
  eq(r.status, 'halted', 'missing refuter must halt');
  eq(executed, false, 'executor never runs without refuter proof');
  eq(r.plan.adversarial_ready, false, 'plan exposes missing refuter proof');
  eq(r.receipt.executed, false, 'receipt records no execution');
  return 'ok';
});

test('refuted_claim_halts_before_execution', () => {
  let executed = false;
  const r = runOrder({ action: 'verify.claim', intent: 'prove the claim', evidence: { n: 200 } }, {
    receiptChain: [],
    adversarialEvidence: { ...ADVERSARIAL_PASS, refuted: true, reason: 'counterexample survives' },
    executor: () => { executed = true; return { ok: true }; },
  });
  eq(r.status, 'halted', 'refuted claim must halt');
  eq(executed, false, 'executor never runs after refutation');
  ok(/counterexample survives/.test(r.report.summary), 'report preserves refutation reason');
  return 'ok';
});

test('successful claim receipt proves both pre-execution reviews', () => {
  const r = runOrder({ action: 'verify.claim', intent: 'measure separation',
    evidence: { n: 200, coverage: 0.95, rateBounds: { FPR: { bound: 0.10, n: 200 } }, classesSceneMatched: true, primaryCI: [0.82, 0.91] } }, {
    receiptChain: [], adversarialEvidence: ADVERSARIAL_PASS,
    executor: () => ({ ok: true, executed: true, summary: 'results are consistent with separation' }),
  });
  eq(r.status, 'ok', 'well-evidenced claim completes');
  eq(r.receipt.adversarial_review.completed, true, 'receipt proves refuter completion');
  eq(r.receipt.adversarial_review.pre_execution, true, 'receipt proves review timing');
  eq(r.receipt.adversarial_review.refuted, false, 'receipt records surviving claim');
  eq(r.receipt.epistemic_preflight.passed, true, 'receipt proves epistemic preflight');
  ok(Number.isFinite(r.receipt.epistemic_preflight.score), 'preflight score is hash-chained');
  eq(r.report.adversarial_review.completed, true, 'operator report exposes review evidence');
  return 'ok';
});

test('missing adversarial evidence is hash-chained as missing', () => {
  const r = runOrder({ action: 'verify.claim', intent: 'prove it', evidence: { n: 200 } }, { receiptChain: [] });
  eq(r.status, 'halted', 'claim halts');
  eq(r.receipt.adversarial_review.completed, false, 'receipt records missing pass');
  eq(r.receipt.adversarial_review.status, 'missing', 'missing state is explicit');
  return 'ok';
});

test('strict_epistemic_engine_fault_cannot_complete_claim', () => {
  const chain = [];
  let executed = false;
  const r = runOrder({ action: 'verify.claim', intent: 'prove the claim', evidence: { n: 200 } }, {
    receiptChain: chain,
    adversarialEvidence: ADVERSARIAL_PASS,
    epistemicFn: () => { throw new Error('simulated epistemic fault'); },
    executor: () => { executed = true; return { ok: true, executed: true, summary: 'claim output' }; },
  });
  eq(r.status, 'halted', 'strict epistemic fault must halt completion');
  eq(executed, false, 'executor never runs when strict epistemic preflight is unavailable');
  eq(r.receipt.executed, false, 'receipt records no execution');
  ok(/simulated epistemic fault/.test(r.report.summary), 'report preserves epistemic fault');
  ok(r.notes.some((note) => /simulated epistemic fault/.test(note)), 'fault remains diagnosable');
  return 'ok';
});

test('executor_needs_action_cannot_be_promoted_to_ok', () => {
  const chain = [];
  const r = runOrder({ action: 'build.feature', payload: {} }, {
    executor: () => ({ ok: false, status: 'needs_action', summary: 'no deterministic executor completed the action' }),
    receiptChain: chain,
  });
  eq(r.status, 'needs_action', 'top-level status preserves executor truth');
  eq(r.report.status, 'needs_action', 'report status preserves executor truth');
  eq(chain.length, 1, 'non-completion is still receipted');
  eq(chain[0].executed, false, 'non-completion is never recorded as executed');
  return 'ok';
});

test('missing_executor_is_receipted_as_not_performed', () => {
  const chain = [];
  const r = runOrder({ action: 'build.feature', payload: {} }, { receiptChain: chain });
  eq(r.status, 'needs_action', 'missing executor needs action');
  eq(r.report.status, 'needs_action', 'report preserves missing executor truth');
  eq(chain[0].executed, false, 'receipt records no execution');
  ok(/No executor completed/.test(r.report.summary), 'summary names missing execution');
  return 'ok';
});

test('deterministic_executor_does_not_inherit_a_model_it_never_used', () => {
  const r = runOrder({ action: 'read.status', payload: {} }, {
    executor: () => ({ ok: true, status: 'ok', summary: 'direct observation', model: null, host: 'n150' }),
    receiptChain: [],
  });
  eq(r.report.model, null, 'deterministic execution model provenance');
  eq(r.report.host, 'n150', 'deterministic execution host provenance');
  return 'ok';
});

test('receipt_chain_links_prev_hash', () => {
  const chain = [];
  runOrder(ORDER, { seed: 's', receiptChain: chain, executor: EXECUTOR, adversarialEvidence: ADVERSARIAL_PASS });
  runOrder({ action: 'test.run', status: 'ok' }, { seed: 's', receiptChain: chain, executor: EXECUTOR });
  eq(chain.length, 2, 'two entries');
  eq(chain[1].prev_hash, chain[0].hash, 'chain links');
  eq(chain[0].prev_hash, __spineInternals.GENESIS, 'genesis anchor');
  return 'ok (hash-chained)';
});

// ---- runner ----
console.log('Orange5 Spine — order-flow composition test');
console.log('Bun ' + (process.versions?.bun || 'unknown'));
console.log('');
let pass = 0, fail = 0;
for (const t of TESTS) {
  const t0 = Date.now();
  try {
    const note = await t.fn();
    pass++;
    console.log(`  PASS  ${t.name.padEnd(48)} ${(Date.now() - t0).toString().padStart(4)}ms  ${note || ''}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL  ${t.name.padEnd(48)} ${(Date.now() - t0).toString().padStart(4)}ms  ${e.message}`);
  }
}
console.log('');
console.log(`Summary: ${pass} pass / ${fail} fail of ${TESTS.length}`);
if (fail > 0) process.exit(1);
