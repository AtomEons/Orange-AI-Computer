// Orange5 Spine — the nervous system that composes the seven organs into ONE
// order->report flow. Free local-first PM-tool OS. Bun only. Mom's Law: honest,
// tested, no fake-green, no model in the critical path.
//
// FLOW:  intent -> govern -> route -> recall context -> LOOM gate -> execute
//        -> report -> receipt (hash-chained)   ;  compression runs OFF the hot path.
//
// Composes (import-only, never rewrites):
//   route    06-ORANGELLM/router-least-action.mjs   pickLane(order, systemState)
//   recall   06-ORANGELLM/memory/ae-cobra/recall-engine.mjs   recallMistakes(...)
//   gate     08-HERMES/src/loom-fastpath.mjs        evaluateGates(action, lease, ctx)
//   sieve    12-ATOMSMASHER/full-scope/sieve.mjs     sieveOrder(order)   [async, deferred]
//
// Innovations baked in (design fixes from the 2026-07-04 review):
//   - dry-run:        opts.dryRun -> returns a plan, writes NOTHING
//   - deterministic:  opts.seed   -> all ids derive from seed; same seed => identical receipt
//   - real governor:  Flowstate as a CALLED runtime (shouldThrottle), not baked into a model
//   - async sieve:    compression is deferred off the hot path (never blocks the return)

import { createHash } from 'node:crypto';
import { pickLane } from '../06-ORANGELLM/router-least-action.mjs';
import { sieveOrder } from '../12-ATOMSMASHER/full-scope/sieve.mjs';
import { evaluateGates } from '../08-HERMES/src/loom-fastpath.mjs';
import { projectState, recallMistakes } from '../06-ORANGELLM/memory/ae-cobra/recall-engine.mjs';

// ── v2 organs ─────────────────────────────────────────────────────────────
// Added 2026-07-25. The spine had a PROCEDURAL conscience and no epistemic one:
// across AEyes-1 seq 141-173, three conclusions were wrong while passing every
// gate. Each was caught by an external auditor relayed by hand, days later.
// These organs internalize that loop. All are additive and degrade via safe().
import { evaluateEpistemicGates } from '../08-HERMES/src/loom-epistemic.mjs';
import { pickTopology } from '../06-ORANGELLM/topology-router.mjs';
import { epistemicPrior, claimShape } from '../06-ORANGELLM/memory/ae-cobra/epistemic-prior.mjs';

export const SPINE_SCHEMA_ID = 'orange5.spine.order-flow.v1';
const GENESIS = createHash('sha256').update('orange5-spine-genesis').digest('hex');

function sha256(s) { return createHash('sha256').update(String(s)).digest('hex'); }

// --- deterministic id: seeded -> reproducible; unseeded -> unique per run ---
function makeIdFactory(seed, startCounter = 0) {
  let counter = startCounter;
  return function id(prefix, ...parts) {
    counter += 1;
    if (seed != null) return prefix + sha256(parts.join('|') + '|' + seed + '|' + counter).slice(0, 16);
    return prefix + sha256(parts.join('|') + '|' + Date.now() + '|' + Math.random() + '|' + counter).slice(0, 16);
  };
}
function seededNow(seed, counter) {
  // deterministic clock when seeded (2025-01-01 base + 1ms/step), else wall clock
  return seed != null ? 1735689600000 + counter : Date.now();
}

// --- Governor: Flowstate as a CALLED runtime. Pure, testable backpressure. ---
export function shouldThrottle(state = {}, config = {}) {
  const openCurrents = state.openCurrents ?? 0;
  const spawnRate = state.spawnRate ?? 0;
  const maxConcurrent = config.maxConcurrent ?? 16;
  const maxSpawnRate = config.maxSpawnRate ?? 64;
  if (openCurrents >= maxConcurrent) return { throttle: true, reason: `open currents ${openCurrents} >= max ${maxConcurrent}` };
  if (spawnRate >= maxSpawnRate) return { throttle: true, reason: `spawn rate ${spawnRate} >= max ${maxSpawnRate}` };
  return { throttle: false, reason: 'under pressure ceiling' };
}

function validateOrder(order) {
  if (!order || typeof order !== 'object') throw new Error('spine: order must be an object');
  if (typeof order.action !== 'string' || !order.action.trim()) throw new Error('spine: order.action must be a non-empty string');
  return true;
}

// safe organ call — one failing organ degrades to an honest note, never crashes the flow
function safe(label, fn, fallback) {
  try { return { ok: true, value: fn() }; }
  catch (e) { return { ok: false, value: fallback, note: `${label} unavailable: ${e?.message || e}` }; }
}

function compressionEvidence(result) {
  if (!result || result.ok !== true) return { consulted: true, ok: false, lossless: false };
  const debt = result.debt || {};
  return {
    consulted: true,
    ok: true,
    schema: result.schema,
    form: result.crossing?.form ?? null,
    lossless: result.crossing?.lossless === true && debt.roundtrip_ok === true,
    raw_bytes: debt.raw_bytes ?? null,
    compressed_bytes: debt.compressed_bytes ?? null,
    savings_bytes: debt.savings_bytes ?? null,
    ratio: debt.ratio ?? null,
    regression: debt.regression_flag === true,
    fluff_verdict: result.frame?.fluff_verdict ?? null,
    workset_id: result.frame?.workset?.workset_id ?? null,
    workset_kept: result.frame?.workset?.kept ?? null,
    least_action_tier: result.frame?.route?.chosen_tier ?? null,
    raw_sha256: result.crossing?.raw_sha256 ?? null,
  };
}

function adversarialReceiptEvidence(result) {
  if (!result || typeof result !== 'object') return null;
  return {
    completed: result.completed === true,
    pre_execution: result.preExecution === true,
    refuted: result.refuted !== false,
    status: result.status ?? null,
    reason: result.reason ?? null,
    blockers: Array.isArray(result.blockers) ? result.blockers.map(String).slice(0, 5) : [],
    model: result.model ?? null,
    lane: result.lane ?? null,
    host: result.host ?? null,
  };
}

function epistemicReceiptEvidence(result) {
  if (!result || typeof result !== 'object') return null;
  return {
    passed: result.passed === true,
    score: Number.isFinite(result.epistemicScore) ? result.epistemicScore : null,
    blocks: Array.isArray(result.blocks) ? result.blocks.map((item) => item?.check || String(item)).slice(0, 10) : [],
    warns: Array.isArray(result.warns) ? result.warns.map((item) => item?.check || String(item)).slice(0, 10) : [],
  };
}

/**
 * runOrder(order, opts) — execute the full order->report flow.
 * @param opts.dryRun    bool     return a plan, write nothing
 * @param opts.seed      any      deterministic replay: same seed+order => identical receipt
 * @param opts.executor  fn(order,ctx)->result   required for execution; absence is receipted as not performed
 * @param opts.routerFn   fn(order,state)->decision optional test/integration router override
 * @param opts.topologyFn fn(order,ctx)->topology optional test/integration topology override
 * @param opts.sieveFn    fn(order)->result optional test/integration AtomSmasher override
 * @param opts.epistemicFn fn(claim,evidence,ctx)->result optional test/integration epistemic override
 * @param opts.recallFn fn(query)->mistakes optional test/integration recall override
 * @param opts.projectStateFn fn(query)->state optional test/integration project recall override
 * @param opts.lease     object   Hermes lease presented for the LOOM gate
 * @param opts.systemState object routing signals (warm lanes, budget, ...)
 * @param opts.flowState  object  {openCurrents, spawnRate} for the governor
 * @param opts.flowConfig object  {maxConcurrent, maxSpawnRate}
 * @param opts.fluxRoot   string  AE Cobra ledger root for recall
 * @param opts.receiptChain array in-memory hash chain (for tests / injection)
 * @param opts.adversarialEvidence object completed pre-execution refuter result for claim-bearing work
 * Returns { status, report, receipt, plan, lane, gate, mistakes, compressionDone }.
 */
export function runOrder(order, opts = {}) {
  validateOrder(order);
  const seed = opts.seed ?? null;
  const id = makeIdFactory(seed);
  const notes = [];

  // 1. GOVERN — real backpressure before we commit work
  const gov = shouldThrottle(opts.flowState, opts.flowConfig);
  if (gov.throttle && !opts.dryRun) {
    return {
      status: 'deferred',
      reason: gov.reason,
      report: { schema: SPINE_SCHEMA_ID, action: order.action, status: 'deferred', summary: `deferred by governor: ${gov.reason}` },
      receipt: null, plan: null, lane: null, gate: null, mistakes: [], compressionDone: Promise.resolve(null),
    };
  }

  // 2. ROUTE — least-action lane
  const routerFn = typeof opts.routerFn === 'function' ? opts.routerFn : pickLane;
  const routed = safe('router', () => routerFn(order, opts.systemState || {}), { lane: null, model: null, scorecard: [], rationale: 'router unavailable' });
  if (!routed.ok) notes.push(routed.note);
  const decision = routed.value || {};
  const lane = decision.lane ?? null;
  const chosenRoute = Array.isArray(decision.scorecard)
    ? decision.scorecard.find((candidate) => candidate?.lane === lane)
    : null;
  const routeEligible = routed.ok
    && typeof lane === 'string'
    && lane.length > 0
    && (chosenRoute == null || chosenRoute.eligible === true);

  // 2b. TOPOLOGY — the SHAPE of thought this order needs, not just the model.
  //     pickLane answers "which expert"; this answers "how many, arranged how".
  //     Core rule: anything asserting a fact about the world earns a refute-pass.
  const topologyFn = typeof opts.topologyFn === 'function' ? opts.topologyFn : pickTopology;
  const topoRes = safe('topology', () => topologyFn(order, { risk: decision.risk }), null);
  if (!topoRes.ok) notes.push(topoRes.note);
  const topology = topoRes.value;
  const topologyReady = topoRes.ok
    && topology != null
    && typeof topology.topology === 'string'
    && Array.isArray(topology.gates);

  // 3. RECALL — surface prior mistakes for this action class (context, before acting)
  const recallFn = typeof opts.recallFn === 'function' ? opts.recallFn : recallMistakes;
  const recalled = safe('recall', () => recallFn({ fluxRoot: opts.fluxRoot, kind: order.action, limit: 5 }), []);
  if (!recalled.ok) notes.push(recalled.note);
  const mistakes = Array.isArray(recalled.value) ? recalled.value : (recalled.value?.mistakes ?? []);
  const projectName = order.targetProject || order.payload?.targetProject || 'OrangeFive';
  const projectStateFn = typeof opts.projectStateFn === 'function' ? opts.projectStateFn : projectState;
  const projectRes = safe('project-recall', () => projectStateFn({
    fluxRoot: opts.fluxRoot,
    project: projectName,
    maxPer: 5,
  }), { ok: false, project: projectName, found: false, reality: [], thought: [], open_threads: [], conflicts: [] });
  if (!projectRes.ok) notes.push(projectRes.note);
  const project = projectRes.value;

  // 3b. EPISTEMIC PRIOR — recall by CLAIM SHAPE, not action-name string match.
  //     Answers the question that actually matters: "claims that looked like this
  //     one — how did they end?" Learned from this chain's own supersession record.
  const priorRes = safe('epistemic-prior', () => epistemicPrior({
    summary: order.intent ?? order.action,
    meta: { action: order.action, n: order.evidence?.n ?? order.payload?.n },
    chain: opts.receiptChain || [],
  }), null);
  if (!priorRes.ok) notes.push(priorRes.note);
  const prior = priorRes.value;
  if (prior?.advice) notes.push(`epistemic-prior: ${prior.advice}`);

  // AtomSmasher is a mandatory pre-execution crossing, not post-hoc telemetry.
  // Only its deterministic summary enters reports and receipts.
  const sieveFn = typeof opts.sieveFn === 'function' ? opts.sieveFn : sieveOrder;
  const compressed = safe('sieve', () => sieveFn(order), null);
  if (!compressed.ok) notes.push(compressed.note);
  const compression = compressionEvidence(compressed.value);
  const compressionReady = compressed.ok && compression.ok && compression.lossless;
  const adversarialRequired = topology?.adversarialRequired === true;
  const adversarialEvidence = opts.adversarialEvidence ?? null;
  const adversarialReady = !adversarialRequired || (
    adversarialEvidence?.completed === true
    && adversarialEvidence?.preExecution === true
    && adversarialEvidence?.refuted === false
  );
  const memory = {
    consulted: true,
    ok: recalled.ok && projectRes.ok,
    source: 'ae-cobra-flux',
    mode: 'pre-action',
    matches: mistakes.length,
    project: projectName,
    project_found: project?.found === true,
    project_records: (project?.reality?.length || 0) + (project?.thought?.length || 0),
  };
  const memoryReady = recalled.ok && projectRes.ok;

  // 4. GATE the CROSSING — the spine speaks order.v1/report.v1; LOOM validates
  //    the full envelope (order + provisional report + receipt path + lease +
  //    Human-Final-Stop + no-fake-green) as authorization BEFORE we execute.
  const orderV1 = {
    schema: 'orange.order.v1', id: id('ord_', order.action), ts: seededNow(seed, 0),
    action: order.action, intent: order.intent ?? order.action,
    payload: order.payload ?? {}, status: order.status ?? 'ok',
  };
  const lease = opts.lease ?? {
    id: 'spine-default',
    allowed: Array.isArray(order.allowedActions) && order.allowedActions.length
      ? order.allowedActions
      : [order.action],
    forbidden: Array.isArray(order.forbiddenActions) ? order.forbiddenActions : [],
    expires_at: null,
    requires_approval: order.requiresApproval === true
      || order.requiresHumanApproval === true
      || ['high', 'destructive', 'irreversible'].includes(String(order.riskLevel ?? '').toLowerCase()),
  };
  const receiptPath = opts.receiptPath ?? `10-RECEIPTS/orange5-build/${orderV1.id}.json`;
  const provisionalReport = { schema: 'orange.report.v1', action: order.action, status: order.status ?? 'ok', summary: 'pending' };
  const crossing = {
    order: orderV1, report: provisionalReport, receipt_path: receiptPath, lease,
    status: order.status ?? 'ok',
    has_human_approval: opts.hasHumanApproval ?? false,
    has_openai_gateway: opts.hasOpenaiGateway, // undefined => LOOM default true
    has_mcp_default: opts.hasMcpDefault,        // undefined => LOOM default true
  };
  const gateFn = typeof opts.gateFn === 'function' ? opts.gateFn : evaluateGates;
  const gated = safe('loom', () => gateFn({ type: order.action }, lease, crossing), {
    passed: false,
    first_fail: { gate: 'loom_runtime', reason: 'gate engine unavailable' },
    degraded: true,
  });
  if (!gated.ok) notes.push(gated.note);
  const gate = gated.value || { passed: true };
  const gatePassed = gate.passed !== false;

  // Strict claim topologies must prove the proposed claim/evidence envelope
  // before any executor can act. The post-output epistemic gate below remains
  // necessary because an executor may produce a stronger or different claim.
  const epistemicMode = opts.epistemicMode
    ?? (topology?.gates?.includes('epistemic') ? 'strict' : 'advisory');
  const epistemicFn = typeof opts.epistemicFn === 'function' ? opts.epistemicFn : evaluateEpistemicGates;
  const preEpistemicRequired = epistemicMode === 'strict';
  const preEpistemicRes = preEpistemicRequired
    ? safe('loom-epistemic-preflight', () => epistemicFn({
        statement: order.intent ?? order.action,
        summary: order.intent ?? order.action,
        supersedes: order.supersedes ?? [],
      }, order.evidence ?? {}, { relatedPriorClaims: opts.relatedPriorClaims ?? [] }), null)
    : { ok: true, value: null };
  if (!preEpistemicRes.ok) notes.push(preEpistemicRes.note);
  const preEpistemic = preEpistemicRes.value;
  const preEpistemicReady = !preEpistemicRequired
    || (preEpistemicRes.ok && preEpistemic != null && preEpistemic.passed === true);

  // --- plan (what we WOULD do) ---
  // `gates_pass` is the public, whole-crossing verdict.  Keep the procedural
  // LOOM result separately so a dry-run can never advertise a green crossing
  // that execution would immediately halt on topology, memory, adversarial,
  // routing, compression, or epistemic readiness.
  const crossingReady = gatePassed
    && routeEligible
    && topologyReady
    && memoryReady
    && compressionReady
    && adversarialReady
    && preEpistemicReady;
  const readinessFail = !gatePassed ? (gate.first_fail ?? { gate: 'procedural', reason: 'LOOM gate failed' })
    : !routeEligible ? { gate: 'routing', reason: decision.rationale || routed.note || 'no eligible execution lane' }
    : !topologyReady ? { gate: 'topology', reason: topoRes.note || 'topology runtime unavailable' }
    : !memoryReady ? { gate: 'memory', reason: recalled.note || projectRes.note || 'pre-action recall unavailable' }
    : !compressionReady ? { gate: 'compression', reason: compressed.note || 'lossless compression proof unavailable' }
    : !adversarialReady ? { gate: 'adversarial', reason: adversarialEvidence?.reason || 'required pre-execution refuter pass is unavailable' }
    : !preEpistemicReady ? { gate: 'epistemic', reason: preEpistemicRes.note || preEpistemic?.first_fail?.reason || 'proposed evidence does not support the claim' }
    : null;
  const plan = {
    lane, model: decision.model ?? null, eligible: routeEligible,
    complexity: decision.complexity ?? null, risk: decision.risk ?? null,
    gates_pass: crossingReady,
    procedural_gates_pass: gatePassed,
    gate_first_fail: readinessFail,
    would_recall: mistakes.length, would_execute: crossingReady,
    estimated_bytes: JSON.stringify(order).length,
    mediation: { memory, compression },
    // v2
    topology: topology?.topology ?? null,
    topology_ready: topologyReady,
    memory_ready: memoryReady,
    epistemic_preflight_required: preEpistemicRequired,
    epistemic_preflight_ready: preEpistemicReady,
    adversarial_required: topology?.adversarialRequired ?? false,
    adversarial_ready: adversarialReady,
    adversarial_evidence: adversarialReceiptEvidence(adversarialEvidence),
    min_agents: topology?.minAgents ?? 1,
    required_gates: topology?.gates ?? ['procedural'],
    epistemic_prior: prior ? { verdict: prior.verdict, penalty: prior.penalty, shape: prior.shapeKey } : null,
  };

  // 4b. DRY-RUN — return the plan, write nothing
  if (opts.dryRun) {
    return { status: 'planned', plan, order: orderV1, report: null, receipt: null, lane, gate, mistakes, project, topology, prior, mediation: plan.mediation, compressionDone: Promise.resolve(compressed.value), notes };
  }

  // 4c. HALT when the router cannot identify an eligible execution lane. The
  // hard capability/risk/latency floor is an execution boundary, not advice.
  if (!routeEligible) {
    const routeReason = decision.rationale || routed.note || 'no eligible lane';
    const report = {
      schema: 'orange.report.v1', action: order.action, status: 'needs_action',
      summary: `routing halted: ${routeReason}`,
      lane: null, route_eligible: false, mediation: { memory, compression },
    };
    const receipt = writeReceipt(order, report, { id, seed, chain: opts.receiptChain, executed: false, opts, topology, prior, mediation: report.mediation });
    return { status: 'needs_action', report, receipt, plan, order: orderV1, lane: null, gate, mistakes, topology, prior, mediation: report.mediation, compressionDone: Promise.resolve(compressed.value), notes };
  }

  // 4d. HALT when the mandatory AtomSmasher crossing cannot prove a lossless
  // roundtrip. Compression telemetry is not enough; exact reconstruction is
  // the authorization condition for continuing with the compressed workset.
  if (!compressionReady) {
    const compressionReason = compressed.note || 'lossless compression crossing unavailable';
    const report = {
      schema: 'orange.report.v1', action: order.action, status: 'needs_action',
      summary: `compression halted: ${compressionReason}`,
      lane, compression_ready: false, mediation: { memory, compression },
    };
    const receipt = writeReceipt(order, report, { id, seed, chain: opts.receiptChain, executed: false, opts, topology, prior, mediation: report.mediation });
    return { status: 'needs_action', report, receipt, plan, order: orderV1, lane, gate, mistakes, topology, prior, mediation: report.mediation, compressionDone: Promise.resolve(compressed.value), notes };
  }

  // 4e. HALT on hard gate failure — never execute past a real block (Human Final Stop, fake-green, schema)
  if (!gatePassed) {
    const report = {
      schema: 'orange.report.v1', action: order.action, status: 'halted',
      summary: `LOOM gate halted: ${gate.first_fail?.reason || gate.first_fail || 'gate failed'}`,
      lane, gate_first_fail: gate.first_fail ?? null, mediation: { memory, compression },
    };
    const receipt = writeReceipt(order, report, { id, seed, chain: opts.receiptChain, executed: false, opts, topology, prior, mediation: report.mediation });
    return { status: 'halted', report, receipt, plan, order: orderV1, lane, gate, mistakes, topology, prior, mediation: report.mediation, compressionDone: Promise.resolve(compressed.value), notes };
  }

  // Thought-shape selection and memory recall are mandatory control organs.
  // If either runtime faults, executing anyway would silently discard policy
  // or project history while still producing a plausible-looking receipt.
  if (!topologyReady) {
    const report = {
      schema: 'orange.report.v1', action: order.action, status: 'needs_action',
      summary: `topology halted: ${topoRes.note || 'topology runtime unavailable'}`,
      lane, topology_ready: false, mediation: { memory, compression },
    };
    const receipt = writeReceipt(order, report, { id, seed, chain: opts.receiptChain, executed: false, opts, topology, prior, mediation: report.mediation });
    return { status: 'needs_action', report, receipt, plan, order: orderV1, lane, gate, mistakes, topology, prior, mediation: report.mediation, compressionDone: Promise.resolve(compressed.value), notes };
  }

  if (!memoryReady) {
    const report = {
      schema: 'orange.report.v1', action: order.action, status: 'needs_action',
      summary: `memory halted: ${recalled.note || projectRes.note || 'pre-action recall unavailable'}`,
      lane, memory_ready: false, mediation: { memory, compression },
    };
    const receipt = writeReceipt(order, report, { id, seed, chain: opts.receiptChain, executed: false, opts, topology, prior, mediation: report.mediation });
    return { status: 'needs_action', report, receipt, plan, order: orderV1, lane, gate, mistakes, topology, prior, mediation: report.mediation, compressionDone: Promise.resolve(compressed.value), notes };
  }

  // Claim-bearing work requires a separate clean-context refuter pass before
  // execution. Topology metadata alone is never evidence that review occurred.
  if (!adversarialReady) {
    const reason = adversarialEvidence?.reason || 'required pre-execution refuter pass is unavailable';
    const report = {
      schema: 'orange.report.v1', action: order.action, status: 'halted',
      summary: `adversarial gate halted: ${reason}`,
      lane, adversarial_required: true, adversarial_ready: false,
      adversarial: adversarialEvidence, mediation: { memory, compression },
    };
    const receipt = writeReceipt(order, report, { id, seed, chain: opts.receiptChain, executed: false, opts, topology, prior, mediation: report.mediation });
    return { status: 'halted', report, receipt, plan, order: orderV1, lane, gate, mistakes, topology, prior, mediation: report.mediation, compressionDone: Promise.resolve(compressed.value), notes };
  }

  if (!preEpistemicReady) {
    const reason = preEpistemicRes.note
      || preEpistemic?.first_fail?.reason
      || 'proposed evidence does not support the claim';
    const report = {
      schema: 'orange.report.v1', action: order.action, status: 'halted',
      summary: `epistemic preflight halted: ${reason}`,
      lane, epistemic_preflight_ready: false,
      epistemic_first_fail: preEpistemic?.first_fail ?? null,
      mediation: { memory, compression },
    };
    const receipt = writeReceipt(order, report, { id, seed, chain: opts.receiptChain, executed: false, opts, topology, prior, epistemic: preEpistemic, preEpistemic, mediation: report.mediation });
    return { status: 'halted', report, receipt, plan, order: orderV1, lane, gate, mistakes, topology, prior, epistemic: preEpistemic, mediation: report.mediation, compressionDone: Promise.resolve(compressed.value), notes };
  }

  // 5. EXECUTE — injected executor only. A missing executor is an honest
  // unavailability result, never a simulated successful action.
  const executor = typeof opts.executor === 'function' ? opts.executor : unavailableExecutor;
  const execResult = safe('executor', () => executor(order, { lane, decision, mistakes, project, memory, compression, adversarial: adversarialEvidence }), { ok: false, output: null });
  if (!execResult.ok) notes.push(execResult.note);
  const executionPerformed = execResult.ok
    && execResult.value?.ok !== false
    && execResult.value?.executed !== false
    && execResult.value?.evidence?.execution !== 'not_performed';

  // 6. REPORT — orange.report.v1
  const report = {
    schema: 'orange.report.v1', action: order.action,
    status: execResult.value?.status ?? (execResult.value?.ok === false ? 'error' : 'ok'),
    summary: execResult.value?.summary ?? `executed ${order.action} via ${lane}`,
    lane: execResult.value?.lane ?? lane,
    model: execResult.value && Object.prototype.hasOwnProperty.call(execResult.value, 'model')
      ? execResult.value.model
      : (decision.model ?? null),
    host: execResult.value && Object.prototype.hasOwnProperty.call(execResult.value, 'host')
      ? execResult.value.host
      : null,
    output: execResult.value?.output ?? null,
    mistakes_surfaced: mistakes.length,
    memory_context: execResult.value?.evidence?.memoryContext ?? null,
    adversarial_review: adversarialReceiptEvidence(adversarialEvidence),
    mediation: { memory, compression },
  };

  // 6b. EPISTEMIC GATE — the claim does not exist until the executor produces it,
  //     so this gate sits AFTER execute and BEFORE the receipt. LOOM asked "did you
  //     follow the process?"; this asks "does the evidence support the claim?"
  //
  //     Mode is deliberate. The score is ALWAYS recorded so the aux-loss signal
  //     accumulates from the first receipt onward. Claim-bearing topologies are
  //     strict by default; advisory mode must be selected explicitly for a
  //     diagnostic run and cannot be mistaken for proof.
  const evidence = order.evidence ?? execResult.value?.evidence ?? {};
  const claim = {
    statement: report.summary,
    summary: order.intent ?? order.action,
    supersedes: order.supersedes ?? [],
  };
  const epiRes = safe('loom-epistemic', () => epistemicFn(claim, evidence, {
    relatedPriorClaims: opts.relatedPriorClaims ?? [],
  }), null);
  if (!epiRes.ok) notes.push(epiRes.note);
  const epistemic = epiRes.value;

  if (epistemicMode === 'strict' && (!epiRes.ok || !epistemic)) {
    const halted = {
      schema: 'orange.report.v1', action: order.action, status: 'halted',
      summary: `epistemic gate halted: ${epiRes.note || 'epistemic runtime unavailable'}`,
      lane, epistemic_ready: false, mediation: { memory, compression },
    };
    const receipt = writeReceipt(order, halted, { id, seed, chain: opts.receiptChain, executed: executionPerformed, opts, topology, prior, epistemic, preEpistemic, mediation: halted.mediation });
    return { status: 'halted', report: halted, receipt, plan, lane, gate, mistakes, topology, prior, epistemic, mediation: halted.mediation, compressionDone: Promise.resolve(compressed.value), notes };
  }

  if (epistemic && !epistemic.passed) {
    for (const b of epistemic.blocks) notes.push(`epistemic ${b.check}: ${b.detail}`);
    if (epistemicMode === 'strict') {
      const halted = {
        schema: 'orange.report.v1', action: order.action, status: 'halted',
        summary: `epistemic gate halted: ${epistemic.first_fail?.reason || 'evidence does not support the claim'}`,
        lane, epistemic_first_fail: epistemic.first_fail ?? null, mediation: { memory, compression },
      };
      const receipt = writeReceipt(order, halted, { id, seed, chain: opts.receiptChain, executed: executionPerformed, opts, topology, prior, epistemic, preEpistemic, mediation: halted.mediation });
      return { status: 'halted', report: halted, receipt, plan, lane, gate, mistakes, topology, prior, epistemic, mediation: halted.mediation, compressionDone: Promise.resolve(compressed.value), notes };
    }
  }
  report.epistemic_score = epistemic?.epistemicScore ?? null;

  // 7. RECEIPT — hash-chained, deterministic under seed (the crossing)
  const receipt = writeReceipt(order, report, { id, seed, chain: opts.receiptChain, executed: executionPerformed, opts, topology, prior, epistemic, preEpistemic, mediation: report.mediation });

  // 8. COMPRESSION — OFF the hot path. Deferred; never blocks the return.
  const compressionDone = Promise.resolve(compressed.ok ? compressed.value : { ok: false, note: compressed.note });

  return { status: report.status, report, receipt, plan, lane, gate, mistakes, topology, prior, epistemic, mediation: report.mediation, compressionDone, notes };
}

// A library caller that omits an executor has planned and governed work, but
// has not performed it. This result is deliberately receipted for diagnosis.
function unavailableExecutor(order, ctx) {
  return {
    ok: false,
    executed: false,
    status: 'needs_action',
    summary: `No executor completed ${order.action}`,
    output: { echoed: order.payload ?? null, lane: ctx.lane },
    evidence: { execution: 'not_performed', reason: 'executor_not_supplied' },
  };
}

// hash-chained receipt writer. Chain is an injectable array (in-memory by default).
//
// v2 fields are OMITTED when absent rather than written as null, so a receipt with
// no trajectory or expert context hashes exactly as it did before v2. Existing
// receipts and existing tests are unaffected; new context is purely additive.
//
// The two fields that matter most are expert_id and claim_shape. They cost nothing
// to write and they turn the chain into the MoE gate's training set: every later
// `supersedes` marks a labeled example of which expert was wrong on which shape.
function writeReceipt(order, report, { id, seed, chain, executed, opts = {}, topology = null, prior = null, epistemic = null, preEpistemic = null, mediation = null } = {}) {
  const arr = chain || (writeReceipt._default ||= []);
  const seq = arr.length;
  const prev_hash = seq === 0 ? GENESIS : arr[seq - 1].hash;
  const receipt_id = id('rcpt_', order.action, seq);
  const ts = seededNow(seed, seq);

  const body = { schema: SPINE_SCHEMA_ID, seq, receipt_id, ts, action: order.action, status: report.status, summary: report.summary, lane: report.lane, executed };

  // ── trajectory: makes the chain a walkable tree instead of a flat log ──
  if (opts.campaignId != null) body.campaign_id = opts.campaignId;
  if (opts.parentReceipt != null) body.parent_receipt = opts.parentReceipt;
  if (Array.isArray(order.supersedes) && order.supersedes.length) body.supersedes = order.supersedes;
  if (Array.isArray(order.evidence_refs) && order.evidence_refs.length) body.evidence_refs = order.evidence_refs;

  // ── MoE aux-loss attribution: two fields, zero cost, whole training signal ──
  const expertId = opts.expertId ?? order.expert_id ?? null;
  if (expertId != null) body.expert_id = expertId;
  const shape = safe('claim-shape', () => claimShape(order.intent ?? report.summary, {
    action: order.action, n: order.evidence?.n ?? order.payload?.n,
  }), null).value;
  if (shape) body.claim_shape = `${shape.strength}|${shape.sampleBand}`;

  // ── epistemic health of this specific claim ──
  if (epistemic && Number.isFinite(epistemic.epistemicScore)) {
    body.epistemic_score = epistemic.epistemicScore;
    if (epistemic.blocks?.length) body.epistemic_blocks = epistemic.blocks.map(b => b.check);
    if (epistemic.warns?.length) body.epistemic_warns = epistemic.warns.map(w => w.check);
  }
  if (prior?.verdict && prior.verdict !== 'NO_PRIOR') body.prior_verdict = prior.verdict;
  if (topology?.topology) body.topology = topology.topology;
  if (topology?.adversarialRequired === true) {
    body.adversarial_review = adversarialReceiptEvidence(opts.adversarialEvidence)
      ?? { completed: false, pre_execution: false, refuted: true, status: 'missing', reason: 'adversarial evidence unavailable', blockers: [], model: null, lane: null, host: null };
  }
  const preflightEvidence = epistemicReceiptEvidence(preEpistemic);
  if (preflightEvidence) body.epistemic_preflight = preflightEvidence;
  if (Number.isFinite(order.evidence?.n)) body.sample_n = order.evidence.n;
  if (mediation) body.mediation = mediation;

  const hash = sha256(prev_hash + '|' + JSON.stringify(body));
  const entry = { ...body, prev_hash, hash };
  arr.push(entry);
  return entry;
}

export const __spineInternals = Object.freeze({ makeIdFactory, seededNow, writeReceipt, unavailableExecutor, compressionEvidence, adversarialReceiptEvidence, epistemicReceiptEvidence, GENESIS });
