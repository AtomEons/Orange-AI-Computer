import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveOrangeBrainUrl } from './brain-endpoint.mjs';
import { planSwarm } from '../08-HERMES/product-integration/scripts/swarmgate.mjs';
import { inspectSwarm } from '../08-HERMES/product-integration/scripts/swarm-sentinel.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RESEARCH_EVIDENCE_ROOT = path.join(ROOT, '10-RECEIPTS', 'orange5-build', 'research-evidence');

export const SWARM_READ_ONLY_ACTIONS = Object.freeze({
  'plan.swarm': Object.freeze({
    run: planSwarm,
    module: '08-HERMES/product-integration/scripts/swarmgate.mjs',
    exportName: 'planSwarm',
  }),
  'inspect.swarm': Object.freeze({
    run: inspectSwarm,
    module: '08-HERMES/product-integration/scripts/swarm-sentinel.mjs',
    exportName: 'inspectSwarm',
  }),
});

export function operationalEndpoints(env = process.env) {
  const orangeBrainUrl = resolveOrangeBrainUrl(env);
  return {
  ollama: { url: 'http://127.0.0.1:11434/api/tags' },
  navigator_kernel: { url: `${orangeBrainUrl}/v1/models` },
  orangebrain: { url: `${orangeBrainUrl}/healthz` },
  cobra: { url: 'http://127.0.0.1:7419/healthz' },
  hermes: { url: 'http://127.0.0.1:7430/healthz' },
  ae_eyes: { url: 'http://127.0.0.1:7440/health' },
  atomsmasher: { url: 'http://127.0.0.1:8901/health' },
  ae_phase: { url: `${env.ORANGE5_AE_PHASE_URL || 'http://127.0.0.1:8907'}/health` },
  };
}

export const OPERATIONAL_ENDPOINTS = Object.freeze(operationalEndpoints());

const TARGET_ALIASES = Object.freeze({
  brain: 'orangebrain',
  memory: 'cobra',
  eyes: 'ae_eyes',
  aeyes: 'ae_eyes',
  skinny: 'navigator_kernel',
  navigator: 'navigator_kernel',
  rail: 'ae_phase',
  codexa: 'ae_phase',
  phase: 'ae_phase',
});

function normalizeTarget(value) {
  const target = String(value || 'all').trim().toLowerCase().replace(/[ -]+/g, '_');
  return TARGET_ALIASES[target] || target;
}

async function observe(name, endpoint, fetchImpl, timeoutMs) {
  const observedAt = new Date().toISOString();
  try {
    const response = await fetchImpl(endpoint.url, { signal: AbortSignal.timeout(timeoutMs) });
    const body = await response.json().catch(() => null);
    const semantics = response.ok
      ? evaluateOperationalSemantics(name, body)
      : { ok: false, reasons: [`http status ${response.status}`] };
    return {
      name,
      url: endpoint.url,
      ok: response.ok && semantics.ok,
      transportOk: response.ok,
      semanticOk: semantics.ok,
      semanticReasons: semantics.reasons,
      httpStatus: response.status,
      observedAt,
      body,
    };
  } catch (error) {
    return {
      name,
      url: endpoint.url,
      ok: false,
      httpStatus: 0,
      observedAt,
      error: String(error?.message || error),
    };
  }
}

export function evaluateOperationalSemantics(name, body) {
  const reasons = [];
  const require = (condition, reason) => { if (!condition) reasons.push(reason); };
  if (!body || typeof body !== 'object') return { ok: false, reasons: ['response body is not a JSON object'] };

  switch (name) {
    case 'ollama': {
      const models = Array.isArray(body.models) ? body.models.map((item) => item?.name || item?.model) : [];
      require(models.includes('nomic-embed-text:latest') || models.includes('nomic-embed-text'), 'required local embedding model is missing');
      break;
    }
    case 'navigator_kernel': {
      const navigator = Array.isArray(body.data) ? body.data.find((item) => item?.id === 'orange-navigator') : null;
      require(navigator != null, 'orange-navigator model card is missing');
      require(navigator?.ae_state === 'warm', `orange-navigator is ${navigator?.ae_state || 'unknown'}, not warm`);
      break;
    }
    case 'orangebrain':
      require(body.status === 'ok', `gateway status is ${body.status || 'missing'}`);
      require(body.boundary === 'frontier_isolation_active', 'frontier isolation is not active');
      require(body.primary?.live === true, 'primary model endpoint is not live');
      require(body.primary?.warm === true, 'primary model is not warm');
      break;
    case 'cobra':
      require(body.status === 'ok', `Cobra status is ${body.status || 'missing'}`);
      require(body.upstream?.processor?.live === true, 'Cobra processor is not live');
      require(body.upstream?.flux_writer?.live === true, 'Cobra Flux writer is not live');
      require(Number(body.lanes?.total || 0) > 0, 'Cobra contains no memory lanes');
      break;
    case 'hermes':
      require(body.ok === true, 'Hermes envelope is not ok');
      require(body.data?.status === 'alive', `Hermes status is ${body.data?.status || 'missing'}`);
      require(body.data?.gates === 8, `Hermes loaded ${body.data?.gates ?? 'unknown'} gates, expected 8`);
      require(body.data?.misfit?.enabled === true, 'Hermes Misfit middleware is disabled');
      require(body.data?.misfit?.load_error == null, `Hermes Misfit load error: ${body.data?.misfit?.load_error}`);
      break;
    case 'ae_eyes':
      require(body.ok === true, 'AE Eyes envelope is not ok');
      require(body.resident_worker?.state === 'ready', `AE Eyes worker is ${body.resident_worker?.state || 'missing'}`);
      require(Number(body.resident_worker?.failures || 0) === 0, `AE Eyes worker has ${body.resident_worker?.failures} failures`);
      require(typeof body.backend === 'string' && body.backend.length > 0, 'AE Eyes backend is missing');
      break;
    case 'atomsmasher':
      require(body.ok === true, 'AtomSmasher envelope is not ok');
      require(body.service === 'atomsmasher2', `unexpected AtomSmasher service ${body.service || 'missing'}`);
      require(Number(body.counts?.features || 0) >= 620, `AtomSmasher feature inventory is ${body.counts?.features ?? 0}, expected at least 620`);
      break;
    case 'ae_phase':
      require(body.ok === true, 'AE Phase envelope is not ok');
      require(body.status === 'AE_PHASE_FABRIC_ACTIVE', `AE Phase status is ${body.status || 'missing'}`);
      require(body.authenticated === true, 'AE Phase authentication is not active');
      require(Number(body.connectedPeers || 0) > 0, 'AE Phase has no connected compute peer');
      require(body.backpressured !== true, 'AE Phase is backpressured');
      break;
    default:
      require(body.status === 'ok' || body.ok === true, 'generic endpoint did not declare ok');
  }
  return { ok: reasons.length === 0, reasons };
}

export function isDeterministicOperationalAction(action) {
  return action === 'read.status'
    || action === 'read.health'
    || action === 'analyze.agent'
    || action === 'synthesize.delegation'
    || Object.prototype.hasOwnProperty.call(SWARM_READ_ONLY_ACTIONS, action);
}

function validReceipt(receipt) {
  return Boolean(
    receipt
    && typeof receipt.receipt_id === 'string'
    && receipt.receipt_id.length > 0
    && typeof receipt.hash === 'string'
    && /^[a-f0-9]{64}$/i.test(receipt.hash),
  );
}

function synthesizeDelegation(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TypeError('synthesize.delegation requires an object payload');
  }
  const children = Array.isArray(payload.childEvidence) ? payload.childEvidence : [];
  if (children.length === 0) throw new Error('synthesize.delegation requires childEvidence');

  const incomplete = children.filter((child) => {
    const status = String(child?.status || '').toLowerCase();
    return !['ok', 'completed', 'ready'].includes(status)
      || !validReceipt(child?.receipt)
      || (Array.isArray(child?.blockers) && child.blockers.length > 0);
  });
  if (incomplete.length > 0) {
    return {
      ok: false,
      status: 'needs_action',
      summary: `Delegation synthesis halted: ${incomplete.length}/${children.length} child reports are incomplete or unreceipted`,
      lane: 'reflex',
      model: null,
      host: 'n150',
      output: {
        status: 'needs_action',
        evidence: [],
        blockers: incomplete.map((child) => `${child?.agent || 'unknown'}: incomplete, blocked, or missing a valid receipt`),
        nextAction: 'repair child reports before synthesis',
      },
      evidence: {
        source: 'receipt_backed_deterministic_synthesis',
        execution: 'cognitive_report_requires_action',
        mutationPerformed: false,
      },
    };
  }

  const evidence = [...new Set(children.flatMap((child) => Array.isArray(child.evidence) ? child.evidence : []))].slice(0, 12);
  const findings = children.map((child) => ({
    agent: child.agent || 'specialist',
    summary: child.summary || child.nextAction || 'completed',
    receipt: child.receipt,
  }));
  return {
    ok: true,
    status: 'completed',
    summary: `Deterministically synthesized ${children.length} completed, receipt-backed specialist report${children.length === 1 ? '' : 's'}`,
    lane: 'reflex',
    model: null,
    host: 'n150',
    output: {
      status: 'completed',
      findings,
      evidence,
      blockers: [],
      nextAction: 'delegation complete',
    },
    evidence: {
      source: 'receipt_backed_deterministic_synthesis',
      execution: 'cognitive_report_completed',
      mutationPerformed: false,
      childReceipts: children.map((child) => child.receipt),
      parentExecutionHash: payload.parentOrder?.governedExecution?.resultHash || null,
      parentReceiptSha256: payload.parentOrder?.governedExecution?.receiptSha256 || null,
    },
  };
}

function analyzeGovernedExecution(order) {
  const governed = order?.payload?.parentOrder?.governedExecution;
  if (!governed) return null;
  const resultHash = String(governed.resultHash || '');
  const receiptSha256 = String(governed.receiptSha256 || '');
  if (!/^[a-f0-9]{64}$/i.test(resultHash) || !/^[a-f0-9]{64}$/i.test(receiptSha256)) {
    return {
      ok: false,
      status: 'needs_action',
      summary: 'Governed source analysis refused invalid execution provenance',
      lane: 'reflex',
      model: null,
      host: 'n150',
      output: { status: 'needs_action', evidence: [], blockers: ['invalid governed execution hashes'], nextAction: 'repair source execution receipt' },
      evidence: { source: 'governed_execution_reflex', execution: 'cognitive_report_requires_action', mutationPerformed: false },
    };
  }
  const suppliedEvidence = Array.isArray(order.evidence) ? order.evidence.map(String).slice(0, 12) : [];
  const excerpt = String(governed.excerpt || '').trim();
  return {
    ok: true,
    status: 'completed',
    summary: `Verified governed ${governed.action || 'source'} execution for ${order?.payload?.agent || 'specialist'}`,
    lane: 'reflex',
    model: null,
    host: 'n150',
    output: {
      status: 'completed',
      confidence: 1,
      actionsTaken: [],
      evidence: suppliedEvidence,
      findings: [
        `governed action ${governed.action || 'unknown'} completed with result ${resultHash.slice(0, 16)}`,
        ...(excerpt ? [excerpt] : []),
      ],
      blockers: [],
      nextAction: 'return verified source finding to parent delegation',
    },
    evidence: {
      source: 'governed_execution_reflex',
      execution: 'cognitive_report_completed',
      mutationPerformed: false,
      resultHash,
      receiptSha256,
    },
  };
}

function researchFailure(message) {
  return {
    ok: false,
    status: 'needs_action',
    summary: 'Governed research analysis refused invalid source evidence',
    lane: 'reflex',
    model: null,
    host: 'n150',
    output: {
      status: 'needs_action',
      evidence: [],
      blockers: [message],
      nextAction: 'repair the research evidence artifact before delegation',
    },
    evidence: {
      source: 'governed_research_evidence_reflex',
      execution: 'cognitive_report_requires_action',
      mutationPerformed: false,
    },
  };
}

function analyzeResearchEvidence(order, options = {}) {
  const supplied = order?.payload?.researchEvidence;
  if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied)) return null;
  const expectedSha = String(supplied.sha256 || '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expectedSha)) return researchFailure('research artifact SHA-256 is missing or invalid');

  const evidenceRoot = path.resolve(options.researchEvidenceRoot || RESEARCH_EVIDENCE_ROOT);
  const artifactPath = path.resolve(String(supplied.artifactPath || ''));
  if (!(artifactPath === evidenceRoot || artifactPath.startsWith(`${evidenceRoot}${path.sep}`))) {
    return researchFailure('research artifact is outside the governed evidence root');
  }
  if (!fs.existsSync(artifactPath)) return researchFailure('research artifact is missing');

  let artifact;
  try { artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8')); }
  catch { return researchFailure('research artifact is not valid JSON'); }
  const { sha256: recordedSha, ...payload } = artifact || {};
  const actualSha = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  if (String(recordedSha || '').toLowerCase() !== expectedSha || actualSha !== expectedSha) {
    return researchFailure('research artifact hash does not match supplied evidence');
  }

  const artifactSources = Array.isArray(payload.sources) ? payload.sources : [];
  const suppliedSources = Array.isArray(supplied.sources) ? supplied.sources : [];
  const sourceCount = Number(supplied.sourceCount || 0);
  if (sourceCount < 1 || artifactSources.length !== sourceCount || suppliedSources.length < 1) {
    return researchFailure('research source count is empty or inconsistent');
  }
  const artifactUrls = new Set(artifactSources.map((source) => source?.url).filter(Boolean));
  if (suppliedSources.some((source) => !source?.url || !artifactUrls.has(source.url))) {
    return researchFailure('supplied research sources do not match the governed artifact');
  }

  const suppliedRefs = Array.isArray(order.evidence) ? order.evidence.map(String).slice(0, 12) : [];
  return {
    ok: true,
    status: 'completed',
    summary: `Verified ${sourceCount} governed research sources for ${order?.payload?.agent || 'specialist'}`,
    lane: 'reflex',
    model: null,
    host: 'n150',
    output: {
      status: 'completed',
      confidence: 1,
      actionsTaken: ['verified research artifact hash, source count, and source membership'],
      evidence: suppliedRefs,
      findings: suppliedSources.slice(0, 6).map((source) => ({
        provider: source.provider || null,
        title: source.title || null,
        url: source.url,
        lifecycle: source.lifecycle || 'BENCHMARK_REQUIRED',
      })),
      blockers: [],
      nextAction: 'return verified research evidence to parent delegation',
    },
    evidence: {
      source: 'governed_research_evidence_reflex',
      execution: 'cognitive_report_completed',
      mutationPerformed: false,
      artifactPath,
      artifactSha256: actualSha,
      sourceCount,
    },
  };
}

export async function executeOperationalAction(order, options = {}) {
  if (!isDeterministicOperationalAction(order?.action)) return null;

  if (order.action === 'analyze.agent') {
    return analyzeGovernedExecution(order) || analyzeResearchEvidence(order, options);
  }
  if (order.action === 'synthesize.delegation') {
    return synthesizeDelegation(order.payload);
  }

  const swarmAction = SWARM_READ_ONLY_ACTIONS[order.action];
  if (swarmAction) {
    if (!order.payload || typeof order.payload !== 'object' || Array.isArray(order.payload)) {
      throw new TypeError(`${order.action} requires an object payload`);
    }
    const output = swarmAction.run(order.payload);
    return {
      ok: true,
      status: 'completed',
      summary: `${swarmAction.exportName} completed with ${output.status}`,
      lane: 'reflex',
      model: null,
      host: 'n150',
      output,
      evidence: {
        source: 'canonical_module',
        module: swarmAction.module,
        export: swarmAction.exportName,
        execution: 'read_only',
        mutationPerformed: false,
      },
    };
  }

  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = options.timeoutMs ?? 8_000;
  const endpoints = options.endpoints || operationalEndpoints(options.env || process.env);
  const target = normalizeTarget(order?.payload?.target);
  const selected = target === 'all'
    ? Object.entries(endpoints)
    : Object.entries(endpoints).filter(([name]) => name === target);

  if (selected.length === 0) {
    return {
      ok: false,
      status: 'needs_action',
      summary: `No deterministic status target is registered for ${target}`,
      lane: 'reflex',
      model: null,
      host: 'n150',
      output: { target, registeredTargets: Object.keys(endpoints) },
      evidence: { observed: false, reason: 'unknown_target' },
    };
  }

  const observations = await Promise.all(
    selected.map(([name, endpoint]) => observe(name, endpoint, fetchImpl, timeoutMs)),
  );
  const allGreen = observations.every((entry) => entry.ok);
  const green = observations.filter((entry) => entry.ok).length;

  return {
    ok: allGreen,
    status: allGreen ? 'ok' : 'error',
    summary: `Observed ${green}/${observations.length} ${target === 'all' ? 'OrangeFive organs' : target} healthy`,
    lane: 'reflex',
    model: null,
    host: 'n150',
    output: {
      schema: 'orange.operational-status.v1',
      target,
      green,
      total: observations.length,
      observations,
    },
    evidence: {
      source: 'direct_http_and_semantic_observation',
      endpoints: observations.map(({ name, url, httpStatus, observedAt, ok, transportOk, semanticOk, semanticReasons }) => ({ name, url, httpStatus, observedAt, ok, transportOk, semanticOk, semanticReasons })),
    },
  };
}

export function classifyModelExecution(order, gatewayResult) {
  const action = String(order?.action || '');
  const cognitive = /^(query|ask|explain|analyze|plan|synthesize)\./.test(action);
  const modelStatus = gatewayResult?.output?.status;
  const hasCognitiveOutput = gatewayResult?.ok === true
    && gatewayResult.output != null
    && (typeof gatewayResult.output !== 'string' || gatewayResult.output.trim().length > 0);

  // For cognitive orders the governed report is the artifact. Requiring a
  // filesystem executor here falsely turns successful analysis into
  // needs_action. Mutating actions still fall through to the strict rule.
  if (cognitive && hasCognitiveOutput) {
    const completed = ['ok', 'completed', 'ready'].includes(String(modelStatus || '').toLowerCase());
    return {
      ...gatewayResult,
      ok: completed,
      status: completed ? 'completed' : (modelStatus || 'needs_action'),
      evidence: {
        ...(gatewayResult?.evidence || {}),
        execution: completed ? 'cognitive_report_completed' : 'cognitive_report_requires_action',
        modelStatus: modelStatus ?? null,
      },
    };
  }

  return {
    ...gatewayResult,
    ok: false,
    status: 'needs_action',
    summary: `OrangeBrain produced guidance for ${action}; no deterministic executor completed the action`,
    evidence: {
      ...(gatewayResult?.evidence || {}),
      execution: 'not_performed',
      modelStatus: modelStatus ?? null,
    },
  };
}
