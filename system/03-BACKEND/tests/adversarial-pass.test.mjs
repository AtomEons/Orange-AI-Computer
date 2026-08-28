import { buildAdversarialPacket, normalizeAdversarialReport, runGatewayAdversarialPass } from '../adversarial-pass.mjs';
import { adversarialBrief } from '../../06-ORANGELLM/topology-router.mjs';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const ok = (value, message) => { if (!value) throw new Error(message); };

test('valid clean report is accepted', () => {
  const result = normalizeAdversarialReport({ schema: 'orange.report.v1', status: 'completed', summary: 'No surviving objection', evidence: ['REFUTED=false'], blockers: [] });
  ok(result.completed && !result.refuted && result.preExecution, 'clean report must pass');
});

test('blockers refute even a completed report', () => {
  const result = normalizeAdversarialReport({ schema: 'orange.report.v1', status: 'completed', summary: 'Concern found', evidence: ['REFUTED=false'], blockers: ['missing evidence'] });
  ok(result.completed && result.refuted, 'blocker must refute');
});

test('explicit true marker refutes', () => {
  const result = normalizeAdversarialReport({ schema: 'orange.report.v1', status: 'blocked', evidence: ['REFUTED=true'], blockers: ['counterexample'] });
  ok(result.completed && result.refuted, 'true marker must refute');
});

test('ambiguous markerless report fails closed', () => {
  const result = normalizeAdversarialReport({ schema: 'orange.report.v1', status: 'completed', actionsTaken: ['Reviewed claim'], blockers: [] });
  ok(!result.completed && result.refuted && /verification action/.test(result.reason), 'ambiguous markerless report must fail closed');
});

test('standard verified report passes without a marker', () => {
  const result = normalizeAdversarialReport({ schema: 'orange.report.v1', status: 'completed', actionsTaken: ['Verified claim against supplied evidence'], blockers: [] });
  ok(result.completed && !result.refuted, 'positive standard verification must pass');
});

test('standard blocked report refutes without a marker', () => {
  const result = normalizeAdversarialReport({ schema: 'orange.report.v1', status: 'blocked', actionsTaken: ['Checked claim'], blockers: ['concrete contradiction'] });
  ok(result.completed && result.refuted, 'standard blocker must refute');
});

test('multiple markers fail closed', () => {
  const result = normalizeAdversarialReport({ schema: 'orange.report.v1', status: 'completed', evidence: ['REFUTED=false', 'REFUTED=true'], blockers: [] });
  ok(!result.completed && result.refuted, 'ambiguous markers must fail closed');
});

test('contradictory prose cannot override a false marker', () => {
  const result = normalizeAdversarialReport({ schema: 'orange.report.v1', status: 'completed', evidence: ['REFUTED=false'], actionsTaken: ['Refuted claim: unsupported'], blockers: [] });
  ok(result.completed && result.refuted, 'semantic contradiction must fail closed');
});

test('misplaced REFUTED=false blocker is normalized without hiding real blockers', () => {
  const repaired = normalizeAdversarialReport({
    schema: 'orange.report.v1', status: 'needs_action', evidence: ['REFUTED=false'],
    blockers: ['REFUTED=false'], actionsTaken: [],
  });
  ok(repaired.completed && !repaired.refuted, 'misplaced false marker must not become a contradiction');
  ok(repaired.status === 'completed' && repaired.protocolNormalized, 'wire repair must be explicit');

  const real = normalizeAdversarialReport({
    schema: 'orange.report.v1', status: 'needs_action', evidence: ['REFUTED=false'],
    blockers: ['REFUTED=false', 'source hash does not match'], actionsTaken: [],
  });
  ok(real.refuted && real.blockers.length === 1, 'substantive blocker must remain fail-closed');
});

test('attack vectors are claim-relevant', () => {
  const logical = adversarialBrief({ action: 'verify.claim', intent: 'prove arithmetic identity' }, { summary: '2 + 2 equals 4' });
  ok(logical.attackVectors.some((item) => /arithmetic step/.test(item)), 'logical claim needs derivation attack');
  ok(!logical.attackVectors.some((item) => /sample large/.test(item)), 'logical claim must not inherit empirical sample attack');
  const empirical = adversarialBrief({ action: 'verify.benchmark', intent: 'measure accuracy', evidence: { n: 20 } }, { summary: 'accuracy measured' });
  ok(empirical.attackVectors.some((item) => /sample large/.test(item)), 'empirical claim needs sample attack');
});

const plannedSwarmResult = {
  ok: true,
  status: 'completed',
  summary: 'planSwarm completed with PLANNED',
  output: { schema: 'orange5.swarmgate-plan.v1', status: 'PLANNED', executionWaves: [] },
  evidence: { execution: 'read_only', mutationPerformed: false },
};

test('truthful PLANNED evidence is scoped to plan production', () => {
  const packet = buildAdversarialPacket({ action: 'plan.swarm' }, plannedSwarmResult);
  ok(packet.claimSemantics.planningOnly === true, 'canonical read-only plan must receive planning semantics');
  ok(packet.claimSemantics.executionClaimed === false, 'planning claim must explicitly disclaim task execution');
  ok(/no planned task execution is claimed/i.test(packet.claim), 'claim must not imply completed execution');
  ok(packet.order.action === 'plan.swarm', 'packet must identify the planning-only order');
  ok(packet.primaryResult.output === plannedSwarmResult.output, 'packet must supply the canonical primary result');
  ok(packet.primaryResult.evidence.mutationPerformed === false, 'packet must supply non-mutation provenance');
});

test('PLANNED cannot excuse missing evidence for actual execution', () => {
  const executionPacket = buildAdversarialPacket({ action: 'execute.swarm' }, plannedSwarmResult);
  ok(executionPacket.claimSemantics.planningOnly === false, 'execution action must not receive planning semantics');

  const mutatedPlanPacket = buildAdversarialPacket(
    { action: 'plan.swarm' },
    { ...plannedSwarmResult, evidence: { execution: 'executor', mutationPerformed: true } },
  );
  ok(mutatedPlanPacket.claimSemantics.planningOnly === false, 'mutating result must not receive planning semantics');
});

test('empty model evidence falls back to attributable order evidence', () => {
  const packet = buildAdversarialPacket(
    {
      action: 'analyze.agent',
      evidence: [
        'receipt:hermes-profile-deployment:sha256=abc',
        'receipt:hermes-preflight:required=17/18',
      ],
    },
    {
      status: 'completed',
      output: { schema: 'orange.report.v1', status: 'completed', evidence: [] },
      evidence: [],
    },
  );
  ok(Array.isArray(packet.evidence) && packet.evidence.length === 2, 'empty model evidence must not erase order evidence');
  ok(packet.evidence[0].startsWith('receipt:'), 'fallback evidence must remain attributable');
});

test('gateway refuter accepts a truthful planning-only PLANNED artifact', async () => {
  const originalFetch = globalThis.fetch;
  let systemPrompt = '';
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(init.body);
    systemPrompt = request.messages[0].content;
    const packet = JSON.parse(request.messages[1].content);
    ok(packet.claimSemantics.planningOnly === true, 'gateway must receive planning semantics');
    return Response.json({
      choices: [{ message: { content: JSON.stringify({
        schema: 'orange.report.v1', status: 'completed',
        actionsTaken: ['Verified canonical planning artifact'],
        evidence: ['REFUTED=false'], blockers: [],
      }) } }],
    });
  };
  try {
    const result = await runGatewayAdversarialPass({
      url: 'http://127.0.0.1:1337', order: { action: 'plan.swarm' }, primaryResult: plannedSwarmResult,
    });
    ok(result.completed && !result.refuted, 'truthful PLANNED artifact must pass the refuter');
    ok(/never applies to execution or mutation claims/i.test(systemPrompt), 'prompt must preserve strict execution evidence');
  } finally { globalThis.fetch = originalFetch; }
});

test('malformed output fails closed', () => {
  const result = normalizeAdversarialReport({ status: 'completed' });
  ok(!result.completed && result.refuted, 'malformed report must fail closed');
});

test('transport failure fails closed', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('no', { status: 503 });
  try {
    const result = await runGatewayAdversarialPass({ url: 'http://127.0.0.1:1', order: { action: 'verify.x' }, primaryResult: { summary: 'claim' } });
    ok(!result.completed && result.refuted && /503/.test(result.reason), 'transport failure must fail closed');
  } finally { globalThis.fetch = originalFetch; }
});

test('default refuter stays on the qualified Navigator lane', async () => {
  const originalFetch = globalThis.fetch;
  const previous = process.env.ORANGE5_REFUTER_MODEL;
  delete process.env.ORANGE5_REFUTER_MODEL;
  let requestedModel = null;
  globalThis.fetch = async (_url, init) => {
    requestedModel = JSON.parse(init.body).model;
    return Response.json({ model: 'orange-navigator:hot-v1', choices: [{ message: { content: JSON.stringify({ schema: 'orange.report.v1', status: 'completed', actionsTaken: ['Verified supplied claim'], evidence: ['REFUTED=false'], blockers: [] }) } }] });
  };
  try {
    const result = await runGatewayAdversarialPass({ url: 'http://127.0.0.1:1337', order: { action: 'verify.x' }, primaryResult: { summary: 'claim' } });
    ok(requestedModel === 'orange-navigator', `unexpected default model ${requestedModel}`);
    ok(result.completed && !result.refuted, 'qualified Navigator response must pass');
  } finally {
    globalThis.fetch = originalFetch;
    if (previous == null) delete process.env.ORANGE5_REFUTER_MODEL;
    else process.env.ORANGE5_REFUTER_MODEL = previous;
  }
});

test('schema-repaired refuter gets one bounded protocol retry', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls += 1;
    const request = JSON.parse(init.body);
    if (calls === 1) {
      return Response.json({
        ae_report_repair_applied: true,
        choices: [{ message: { content: JSON.stringify({
          schema: 'orange.report.v1', status: 'needs_action', confidence: 0.5,
          actionsTaken: [], evidence: ['REFUTED=true'], findings: [],
          blockers: ['model draft required deterministic orange.report.v1 schema repair'],
          nextAction: 'continue through the governed operational path', receiptPath: null,
        }) } }],
      });
    }
    ok(/PROTOCOL REPAIR/.test(request.messages[0].content), 'second attempt must use the strict protocol repair prompt');
    return Response.json({ choices: [{ message: { content: JSON.stringify({
      schema: 'orange.report.v1', status: 'completed', confidence: 0.9,
      actionsTaken: ['Verified supplied claim'], evidence: ['REFUTED=false'],
      findings: [], blockers: [], nextAction: 'continue', receiptPath: null,
    }) } }] });
  };
  try {
    const result = await runGatewayAdversarialPass({
      url: 'http://127.0.0.1:1337', order: { action: 'verify.x' }, primaryResult: { summary: 'claim', evidence: ['proof'] },
    });
    ok(calls === 2, `expected exactly two attempts, got ${calls}`);
    ok(result.completed && !result.refuted, 'valid repaired protocol response must pass');
    ok(result.protocolAttempts === 2, 'receipt metadata must expose the bounded retry');
  } finally { globalThis.fetch = originalFetch; }
});

let pass = 0;
for (const entry of tests) {
  try { await entry.fn(); pass += 1; console.log(`PASS ${entry.name}`); }
  catch (error) { console.error(`FAIL ${entry.name}: ${error.message}`); }
}
console.log(`Summary: ${pass} pass / ${tests.length - pass} fail of ${tests.length}`);
if (pass !== tests.length) process.exit(1);
