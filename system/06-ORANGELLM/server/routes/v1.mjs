// OpenAI-compatible /v1/* route handlers
// PR-03: chat-completions proxies to Smart Skinny at :8797 via upstream.mjs.

import { randomUUID } from "node:crypto";
import { UPSTREAM, coalesceSystemMessages, proxyChatCompletions, probeUpstreamBudgeted } from "../upstream.mjs";
import { compileCompletionEnvelope, explicitEvidenceFromMessages, isOperationalReportDraft, orderIdFromMessages, ORANGE_REPORT_SCHEMA, prepareOperationalRequest, validateExplicitEvidencePacket, validateOrangeReport } from "../../contracts/orange-report.mjs";
import { isAutoModel, resolveAutoRoute } from "../auto-route.mjs";
import { AE_EYES_TARGET, proxyAeEyesChat } from "../ae-eyes-route.mjs";
import { compactNavigatorConversationMessages, compactNoEvidenceNavigatorMessages, injectOrangeSystem } from "../orange-system.mjs";
import { compileReflexCompletion } from "../reflex-compiler.mjs";
import { compileNavigatorKernelCompletion } from "../navigator-kernel.mjs";
import { capabilityRepairInstruction, classifyCapabilityCovenant, enforceCapabilityFailure, specialistPolicyFor, validateCapabilityOutput } from "../capability-covenant.mjs";
import { finalizeChatTurn, fitMessagesToBudget, prepareChatTurn, stabilizeLeadingSystemFrames } from "../turn-harness.mjs";
import { loadState as loadFlowState } from "../../../05-FLOW/src/store.mjs";
import { enforceContinuityReport } from "../../../03-BACKEND/project-continuum.mjs";
import {
  appendPartyLineEvent,
  completionText,
  hydratePartyLine,
} from "../../../04-CONTROL-PLANE/party-line/ledger.mjs";
import { BuildRunStore } from "../../../04-CONTROL-PLANE/build-runs/store.mjs";
import {
  prepareGovernedModelToolRequest,
  runGovernedModelToolLoop,
  shouldUseGovernedModelTools,
} from "../model-tool-bridge.mjs";

const EXPLICIT_MODEL_ALIASES = Object.freeze({
  'orangellm-light': 'light',
  'orange-light': 'light',
  'orange-navigator': 'navigator',
  // Logical role tag used by Hermes. The Misfit system contract supplies the
  // dissent behavior; the live Navigator supplies the inference body until a
  // separately baked and promoted Misfit adapter exists.
  'ae-misfit:v0': 'navigator',
  'orange-misfit': 'navigator',
  'orange-code': 'code',
  'orangellm-code': 'code',
  'orangellm-heavy': 'heavy',
  'orangellm-fatty': 'heavy',
});

export function resolveRequestedModelRoute(model, upstream = UPSTREAM) {
  if (isAutoModel(model)) return { valid: true, mode: 'auto', tier: null, requestedModel: model || 'orange-auto' };

  const requestedModel = String(model || '').trim();
  const aliasTier = EXPLICIT_MODEL_ALIASES[requestedModel.toLowerCase()];
  if (aliasTier) return { valid: true, mode: 'explicit', tier: aliasTier, requestedModel };

  for (const tier of ['light', 'navigator', 'code', 'heavy']) {
    const installedModel = String(upstream?.[tier]?.model || '').trim();
    if (installedModel && requestedModel === installedModel) {
      return { valid: true, mode: 'explicit', tier, requestedModel };
    }
  }

  return {
    valid: false,
    mode: 'invalid',
    tier: null,
    requestedModel,
    supportedModels: [
      'orange-auto',
      ...Object.keys(EXPLICIT_MODEL_ALIASES),
      ...['light', 'navigator', 'code', 'heavy'].map((tier) => upstream?.[tier]?.model).filter(Boolean),
    ],
  };
}

function latestUserText(messages = []) {
  const message = [...messages].reverse().find((item) => item?.role === 'user');
  if (typeof message?.content === 'string') return message.content;
  if (Array.isArray(message?.content)) return message.content.map((part) => part?.text || '').join('\n');
  return '';
}

function injectPartyLineContext(messages, context) {
  if (!context) return messages;
  const frame = {
    role: 'system',
    content: `AIR:PARTY-LINE.v1
Use [party:<id>] records as bounded operational context and cite their ids when they support an answer. Do not reject a record merely because it came through Party Line. A conversation-unverified record is continuity only; an operational-record may describe observed state; mutations and green claims still require linked receipts or direct proof.
${context}`,
  };
  const firstNonSystem = messages.findIndex((message) => message?.role !== 'system');
  if (firstNonSystem < 0) return [...messages, frame];
  return [...messages.slice(0, firstNonSystem), frame, ...messages.slice(firstNonSystem)];
}

function injectCompactPartyLineContext(messages, context) {
  if (!context) return messages;
  const frame = {
    role: 'system',
    content: `AIR:PARTY-ANCHOR.v2
kind=conversation-continuity
authority=unverified-unless-linked-receipt
not_transport=true
not_source_truth_without_governed_evidence=true
active_cross_computer_transport=AE Phase
${String(context).slice(0, 220)}`,
  };
  const firstNonSystem = messages.findIndex((message) => message?.role !== 'system');
  if (firstNonSystem < 0) return [...messages, frame];
  return [...messages.slice(0, firstNonSystem), frame, ...messages.slice(firstNonSystem)];
}

function compactPartyLineAnchor(hydration, limit = 2, compact = false) {
  const selected = Array.isArray(hydration?.selected) ? hydration.selected.slice(0, limit) : [];
  if (!selected.length) return '';
  return selected.map((event) => {
    const authority = event.eventType === 'message' ? 'conversation-unverified' : 'operational-record';
    const boundedDetail = !compact && authority === 'operational-record' && event.body
      ? ` detail=${String(event.body).replace(/\s+/g, ' ').slice(0, 240)}`
      : '';
    return `[party:${event.id}] authority=${authority} type=${event.eventType} :: ${String(event.summary || '').slice(0, compact ? 120 : 240)}${boundedDetail}`;
  }).join('\n');
}

async function appendChatPartyLine(event, options = {}) {
  try {
    return await appendPartyLineEvent(event, options);
  } catch (error) {
    return { error: error.message };
  }
}

function buildRunLink(context, write = null, warning = null) {
  return {
    schema: 'atomic-orange.build-run-link.v1',
    runId: write?.run?.runId || context?.run?.runId || null,
    status: write?.run?.status || context?.run?.status || null,
    stage: write?.run?.stage || context?.run?.stage || null,
    warning,
  };
}

async function settleBuildRunFailure(context, runtime, error, patch = {}) {
  if (!context?.run?.runId) return { write: null, warning: null };
  const message = String(error?.message || error || 'chat turn failed').slice(0, 4_000);
  try {
    const repository = new BuildRunStore(runtime.buildRunFilePath);
    const previous = repository.get(context.run.runId) || context.run;
    const write = await repository.update(context.run.runId, {
      ...patch,
      stage: 'settle',
      status: 'failed',
      blockers: [...new Set([...previous.blockers, message])].slice(-128),
      nextAction: 'Repair the report compilation boundary and retry the turn.',
    }, 'turn_failed');
    return { write, warning: null };
  } catch (settlementError) {
    return { write: null, warning: settlementError.message };
  }
}

export function applyFailureRecurrenceGuard(messages = [], failure = {}) {
  const classes = new Set((failure?.patterns || []).map((item) => item.failureClass));
  if (failure?.active !== true || !classes.has('context_pressure')) {
    return { messages, meta: { applied: false, reason: 'no prior context-pressure failure', dropped_frames: [] } };
  }
  const dropped = [];
  const guarded = messages.filter((message) => {
    if (message?.role !== 'system') return true;
    const content = String(message.content || '');
    if (content.includes('AIR:CURRENT.v1')) { dropped.push('current-awareness'); return false; }
    if (content.includes('AIR:MEMORY.v1') || content.includes('[MEMORY:RECALLED')) { dropped.push('recalled-memory'); return false; }
    return true;
  });
  return {
    messages: guarded,
    meta: {
      applied: true,
      reason: 'prior context-pressure failure; preserve authority, exact lineage, failure lesson, contract, and current request only',
      dropped_frames: dropped,
      recurrence_guard: failure.recommendedAction || null,
    },
  };
}

export function reconcileReportWithRuntimeRoute(envelope, route = {}) {
  if (route.succeeded !== true) return { repaired: false, removed: [] };
  const choice = envelope?.choices?.[0];
  if (!choice?.message || typeof choice.message.content !== 'string') return { repaired: false, removed: [] };
  let report;
  try { report = JSON.parse(choice.message.content); } catch { return { repaired: false, removed: [] }; }
  if (report?.schema !== ORANGE_REPORT_SCHEMA) return { repaired: false, removed: [] };

  const model = String(route.model || '').toLowerCase();
  const tier = String(route.tier || '').toLowerCase();
  const node = String(route.node || route.host || '').toLowerCase();
  const routeTerms = [model, tier, tier === 'navigator' ? 'navigator' : '', node.includes('codexa') ? 'codexa' : '']
    .filter((item) => item.length >= 4);
  const failureClaim = /\b(?:unreachable|not reachable|offline|unavailable|connectivity issue|cannot connect|failed to connect)\b/i;
  const contradictsRoute = (value) => {
    const text = String(value || '');
    const lower = text.toLowerCase();
    return failureClaim.test(text) && routeTerms.some((term) => lower.includes(term));
  };
  const findings = Array.isArray(report.findings) ? report.findings : [];
  const blockers = Array.isArray(report.blockers) ? report.blockers : [];
  const removed = [...findings, ...blockers].filter(contradictsRoute);
  if (!removed.length) return { repaired: false, removed: [] };

  const routeFinding = `runtime route observed: ${tier || 'specialist'} via ${route.node || route.host || 'configured node'} returned HTTP 200`;
  report.findings = [routeFinding, ...findings.filter((item) => !contradictsRoute(item))].slice(0, 3);
  report.blockers = blockers.filter((item) => !contradictsRoute(item));
  validateOrangeReport(report, report.orderId);
  choice.message.content = JSON.stringify(report);
  envelope.ae_route_truth_repair = {
    schema: 'orange.route-truth-repair.v1',
    repaired: true,
    tier: route.tier || null,
    model: route.model || null,
    node: route.node || route.host || null,
    removed_claims: removed,
  };
  return { repaired: true, removed };
}

export async function handleV1Models() {
  // List what OrangeLLM can serve. Reflex = Smart Skinny. Heavy = pending PR-04.
  // BUDGETED + CONCURRENT: this endpoint is the heartbeat every consumer polls
  // (Atomic Orange included). It shares /healthz's mDNS hang risk — a stalled
  // CODEXA.local lookup would hold the listing open forever and read as death.
  const [navigatorProbe, codeProbe, heavyProbe] = await Promise.all([
    probeUpstreamBudgeted("navigator"),
    probeUpstreamBudgeted("code"),
    probeUpstreamBudgeted("heavy"),
  ]);
  return {
    object: "list",
    data: [
      {
        id: "orange-auto",
        object: "model",
        created: 1785360000,
        owned_by: "atomeons",
        permission: [],
        root: "orange-auto",
        parent: "orange5.orangebrain.least-action-lane.v1",
        ae_lane: "deterministic-auto",
        ae_host: "n150+codexa",
        ae_state: navigatorProbe.live ? "ready" : "degraded",
      },
      {
        id: "orange-navigator",
        object: "model",
        created: 1785276000,
        owned_by: "atomeons",
        permission: [],
        root: "orange-navigator",
        parent: UPSTREAM.navigator.model,
        ae_lane: "navigator",
        ae_host: UPSTREAM.navigator.host,
        ae_state: navigatorProbe.model_loaded ? "warm" : (navigatorProbe.live ? "available" : "unreachable"),
        ae_upstream: navigatorProbe,
      },
      {
        id: "orangellm-heavy",
        object: "model",
        created: 1735000000,
        owned_by: "atomeons",
        permission: [],
        root: "orangellm-heavy",
        parent: UPSTREAM.heavy.model,
        ae_lane: "heavy",
        ae_host: UPSTREAM.heavy.host,
        ae_state: modelResidencyState(heavyProbe),
        ae_capability_mode: heavyProbe.capability_mode || null,
        ae_upstream: heavyProbe,
      },
      {
        id: "orange-code",
        object: "model",
        created: 1785360000,
        owned_by: "atomeons",
        permission: [],
        root: "orange-code",
        parent: UPSTREAM.code.model,
        ae_lane: "local-code",
        ae_host: UPSTREAM.code.host,
        ae_state: modelResidencyState(codeProbe),
        ae_capability_mode: codeProbe.capability_mode || null,
        ae_upstream: codeProbe,
      },
    ],
  };
}

export async function handleV1ChatCompletions(body, runtime = {}) {
  const requestStarted = performance.now();
  if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
    return {
      _ae_http_status: 400,
      error: {
        message: "messages array required",
        type: "invalid_request_error",
        code: "messages_required",
      },
    };
  }

  const responseMode = body.ae_response_mode ?? null;
  if (responseMode && !['conversation', 'report'].includes(responseMode)) {
    return {
      _ae_http_status: 400,
      error: { message: `unsupported ae_response_mode: ${responseMode}`, type: 'invalid_request_error', code: 'unsupported_response_mode' },
    };
  }
  if (responseMode === 'conversation' && body.ae_response_contract) {
    return {
      _ae_http_status: 400,
      error: { message: 'conversation mode cannot request an operational report contract', type: 'invalid_request_error', code: 'response_mode_contract_conflict' },
    };
  }

  const requestedModelRoute = resolveRequestedModelRoute(body.model);
  if (!requestedModelRoute.valid) {
    return {
      _ae_http_status: 400,
      error: {
        message: `unknown Orange model: ${requestedModelRoute.requestedModel}`,
        type: 'invalid_request_error',
        code: 'unknown_orange_model',
        supported_models: [...new Set(requestedModelRoute.supportedModels)],
      },
    };
  }

  // Machine clients retain the strict Orange report contract by default.
  // Atomic Orange explicitly requests the human conversation surface; its
  // prose still passes through the same routing, memory, learning, and receipt
  // finalizer below.
  const responseContract = body.ae_response_contract
    ?? (isAutoModel(body.model) && responseMode !== 'conversation' ? ORANGE_REPORT_SCHEMA : null);
  // Standard OpenAI-compatible clients do not know Orange-only request fields.
  // An explicit model without a report contract is therefore a human chat
  // surface by default; machine callers retain orange.report.v1 through
  // orange-auto or an explicit contract.
  const effectiveResponseMode = responseMode
    ?? (responseContract === ORANGE_REPORT_SCHEMA ? 'report' : 'conversation');
  if (responseContract && responseContract !== ORANGE_REPORT_SCHEMA) {
    return {
      _ae_http_status: 400,
      error: { message: `unsupported ae_response_contract: ${responseContract}`, type: "invalid_request_error", code: "unsupported_response_contract" },
    };
  }
  const identity = resolveOperationalOrderIdentity(body);
  const orderId = identity.orderId;
  const callerSuppliedEvidence = explicitEvidenceFromMessages(body.messages);
  const requestedEvidencePolicy = body.ae_evidence_policy ?? null;
  const allowedEvidencePolicies = new Set(['none', 'preserve_exact', 'derive']);
  if (requestedEvidencePolicy && responseContract !== ORANGE_REPORT_SCHEMA) {
    return {
      _ae_http_status: 400,
      error: { message: 'ae_evidence_policy requires ae_response_contract=orange.report.v1', type: 'invalid_request_error', code: 'evidence_policy_requires_report_contract' },
    };
  }
  if (requestedEvidencePolicy && !allowedEvidencePolicies.has(requestedEvidencePolicy)) {
    return {
      _ae_http_status: 400,
      error: { message: `unsupported ae_evidence_policy: ${requestedEvidencePolicy}`, type: 'invalid_request_error', code: 'unsupported_evidence_policy' },
    };
  }
  if (requestedEvidencePolicy === 'derive' && !isDerivedEvidenceCaller(body, orderId)) {
    return {
      _ae_http_status: 403,
      error: { message: 'derive evidence policy is reserved for the internal refuter protocol', type: 'invalid_request_error', code: 'derive_policy_forbidden' },
    };
  }
  if (callerSuppliedEvidence.length > 0 && requestedEvidencePolicy === 'none') {
    return {
      _ae_http_status: 400,
      error: { message: 'explicit evidence cannot disable preservation', type: 'invalid_request_error', code: 'evidence_policy_downgrade_forbidden' },
    };
  }
  if (callerSuppliedEvidence.length === 0 && requestedEvidencePolicy === 'preserve_exact') {
    return {
      _ae_http_status: 400,
      error: { message: 'preserve_exact requires explicit evidence', type: 'invalid_request_error', code: 'preserve_exact_requires_evidence' },
    };
  }
  const internalRefuter = requestedEvidencePolicy === 'derive' && isDerivedEvidenceCaller(body, orderId);
  const initialEvidencePolicy = requestedEvidencePolicy ?? (callerSuppliedEvidence.length ? 'preserve_exact' : 'none');
  if (initialEvidencePolicy === 'preserve_exact') {
    const packet = validateExplicitEvidencePacket(callerSuppliedEvidence);
    if (!packet.valid) {
      return {
        _ae_http_status: 413,
        error: { message: `${packet.reason}; hydrate larger evidence through governed source pointers`, type: 'invalid_request_error', code: 'evidence_packet_budget_exceeded' },
      };
    }
  }
  const partyLineConfig = body.ae_party_line && typeof body.ae_party_line === 'object'
    ? body.ae_party_line
    : {};
  // A refuter receives one closed claim/evidence packet. Hydrating or writing
  // Party Line here creates recursive context, latency, and verdict leakage.
  const partyLineEnabled = !internalRefuter && partyLineConfig.enabled !== false;
  const partyLineProject = String(partyLineConfig.projectId || body.ae_project_id || 'orange5').slice(0, 256);
  const partyLineQuery = latestUserText(body.messages);
  let buildRunContext = null;
  let buildRunWarning = null;
  if (typeof body.ae_thread_id === 'string' && body.ae_thread_id.trim()) {
    try {
      const repository = new BuildRunStore(runtime.buildRunFilePath);
      buildRunContext = await repository.ensureForThread({
        threadId: body.ae_thread_id.trim(),
        goal: partyLineQuery,
        projectRoot: typeof body.ae_project_root === 'string' ? body.ae_project_root : '',
        workspaceRoots: Array.isArray(body.ae_workspace_roots) ? body.ae_workspace_roots : [],
        mode: body.ae_build_mode || 'plan',
      });
    } catch (error) {
      buildRunWarning = error.message;
    }
  }
  const {
    ae_response_contract: _contract,
    ae_response_mode: _responseMode,
    ae_order_id: _orderId,
    ae_evidence_policy: _evidencePolicy,
    ae_party_line: _partyLine,
    ae_project_id: _projectId,
    ae_thread_id: _threadId,
    ae_project_root: _projectRoot,
    ae_workspace_roots: _workspaceRoots,
    ae_build_mode: _buildMode,
    ae_tools_enabled: _toolsEnabled,
    ...baseBody
  } = body;
  const reportReflex = responseContract === ORANGE_REPORT_SCHEMA
    && initialEvidencePolicy === 'none'
    && isAutoModel(baseBody.model)
    ? compileReflexCompletion({ messages: baseBody.messages, orderId, model: baseBody.model || 'orange-auto' })
    : null;
  const navigatorKernel = !reportReflex
    && responseContract == null
    && effectiveResponseMode === 'conversation'
    && initialEvidencePolicy === 'none'
    && isAutoModel(baseBody.model)
    ? compileNavigatorKernelCompletion({ messages: baseBody.messages, orderId, model: baseBody.model || 'orange-auto' })
    : null;
  const reflex = reportReflex || navigatorKernel;
  const harnessStarted = performance.now();
  const turn = await prepareChatTurn(baseBody, orderId, { internalRefuter, reflex: Boolean(reflex) });
  let partyLineHydration = null;
  if (partyLineEnabled && !reflex) {
    partyLineHydration = await hydratePartyLine({
      query: partyLineQuery,
      projectId: partyLineProject,
      limit: Number(partyLineConfig.limit || 6),
      filePath: runtime.partyLineFilePath,
    });
    if (partyLineHydration.context) {
      turn.body.messages = injectPartyLineContext(turn.body.messages, partyLineHydration.context);
    }
  }
  const inboundPartyLine = partyLineEnabled
    ? await appendChatPartyLine({
        projectId: partyLineProject,
        topic: String(partyLineConfig.topic || 'chat'),
        actor: { id: 'operator', kind: 'operator', displayName: 'Operator' },
        eventType: 'message',
        summary: partyLineQuery.slice(0, 300) || 'Operator chat turn',
        body: partyLineQuery,
        correlationId: orderId,
        detail: buildRunContext?.run?.runId ? { runId: buildRunContext.run.runId } : null,
        tags: ['chat', effectiveResponseMode],
        importance: 0.7,
      }, { filePath: runtime.partyLineFilePath })
    : null;
  const harnessMs = performance.now() - harnessStarted;
  const governedContextEvidence = !reflex
    && responseContract === ORANGE_REPORT_SCHEMA
    && requestedEvidencePolicy == null
    && callerSuppliedEvidence.length === 0
    && turn.order.action === 'query.chat'
    && turn.order.payload.execution_requested !== true
    ? turn.governedEvidence.items
    : [];
  const suppliedEvidence = callerSuppliedEvidence.length ? callerSuppliedEvidence : governedContextEvidence;
  const evidenceOrigin = callerSuppliedEvidence.length
    ? 'caller'
    : (governedContextEvidence.length ? 'governed_context' : 'none');
  const evidencePolicy = requestedEvidencePolicy ?? (suppliedEvidence.length ? 'preserve_exact' : 'none');
  if (evidencePolicy === 'preserve_exact') {
    const packet = validateExplicitEvidencePacket(suppliedEvidence);
    if (!packet.valid) {
      return {
        _ae_http_status: 500,
        error: { message: `governed evidence compiler produced an invalid packet: ${packet.reason}`, type: 'server_error', code: 'governed_evidence_packet_invalid' },
      };
    }
  }
  const hydratedBody = { ...baseBody, messages: turn.body.messages };
  const preparedBody = responseContract === ORANGE_REPORT_SCHEMA
    ? prepareOperationalRequest(hydratedBody, orderId, { suppliedEvidence, evidencePolicy })
    : hydratedBody;
  const { ae_compiler_order_id: _compilerOrderId, ...cleanBody } = preparedBody;
  const budgetStarted = performance.now();
  if (reflex) {
    const measured = fitMessagesToBudget(turn.body.messages);
    cleanBody.messages = turn.body.messages;
    turn.context = {
      ...measured.meta,
      estimated_tokens_after: 0,
      model_input_tokens: 0,
      tokens_avoided: measured.meta.estimated_tokens_before,
      mode: reflex.envelope?.ae_route_mode || 'deterministic_reflex',
    };
  } else {
    // Preserve the compiler contract prepared above. Internal refuters get a
    // closed claim packet plus that contract, not product doctrine that can
    // leak control markers into semantic blockers.
    const contractMessages = responseContract === ORANGE_REPORT_SCHEMA
      ? cleanBody.messages
      : turn.body.messages;
    const stableMessages = stabilizeLeadingSystemFrames(contractMessages);
    cleanBody.messages = internalRefuter
      ? stableMessages
      : injectOrangeSystem(stableMessages, { responseMode: effectiveResponseMode });
    const budgeted = fitMessagesToBudget(cleanBody.messages);
    cleanBody.messages = budgeted.messages;
    turn.context = budgeted.meta;
  }
  const budgetMs = performance.now() - budgetStarted;

  // orange-auto is the hot deterministic conductor. It chooses a lane before
  // any model fires. Explicit model ids remain bounded specialist leases.
  const routeStarted = performance.now();
  let autoRoute = null;
  let tier;
  if (reflex) {
    tier = reflex.envelope?.ae_execution_tier || 'reflex';
  } else if (requestedModelRoute.mode === 'auto') {
    // FLOW is the live work-pressure field, not a second brain. Feed its
    // current snapshot into the deterministic conductor so active work,
    // contention, and lane warmth affect the route before any model fires.
    autoRoute = resolveAutoRoute({ ...cleanBody, ae_order_id: orderId }, loadFlowState());
    tier = autoRoute.tier;
    cleanBody.model = "orange-auto";
  } else {
    tier = requestedModelRoute.tier;
  }
  if (!reflex) {
    // Codexa specialists are throughput-limited by prompt prefill, not output
    // generation. Give them the smallest source-addressed workbench that can
    // preserve the current order; full project truth remains hydratable through
    // Continuum and Context Crystal pointers instead of being replayed inline.
    const recurrence = applyFailureRecurrenceGuard(cleanBody.messages, turn.failure);
    cleanBody.messages = recurrence.messages;
    const compactNoEvidenceNavigator = tier === 'navigator'
      && responseContract === ORANGE_REPORT_SCHEMA
      && evidencePolicy === 'none';
    const compactNavigatorConversation = tier === 'navigator'
      && effectiveResponseMode === 'conversation'
      && responseContract == null;
    const specialistMessages = compactNoEvidenceNavigator
      ? coalesceSystemMessages(compactNoEvidenceNavigatorMessages(recurrence.messages))
      : (compactNavigatorConversation
          ? coalesceSystemMessages(compactNavigatorConversationMessages(recurrence.messages))
          : recurrence.messages);
    const tierBudget = tier === 'heavy'
      ? 700
      : (tier === 'code' ? 1_000 : (tier === 'navigator' ? ((compactNoEvidenceNavigator || compactNavigatorConversation) ? 256 : 900) : 1_400));
    const partyAnchor = compactPartyLineAnchor(partyLineHydration, compactNavigatorConversation ? 1 : 2, compactNavigatorConversation);
    const unanchoredMessages = partyAnchor
      ? specialistMessages.filter((message) => !(message?.role === 'system' && String(message.content || '').includes('AIR:PARTY-LINE.v1')))
      : specialistMessages;
    const partyAnchorTokens = partyAnchor
      ? Math.ceil((Buffer.byteLength(partyAnchor, 'utf8') + 520) / 2.5)
      : 0;
    const specialistFit = fitMessagesToBudget(unanchoredMessages, {
      budgetTokens: Math.max(256, tierBudget - partyAnchorTokens),
      minSystemChars: tier === 'heavy' ? 80 : (compactNoEvidenceNavigator ? 96 : 180),
      maxPasses: 32,
    });
    cleanBody.messages = partyAnchor
      ? (compactNavigatorConversation
          ? injectCompactPartyLineContext(specialistFit.messages, partyAnchor)
          : injectPartyLineContext(specialistFit.messages, partyAnchor))
      : specialistFit.messages;
    turn.context = {
      ...specialistFit.meta,
      initial_estimated_tokens: turn.context?.estimated_tokens_after ?? turn.context?.estimated_tokens_before ?? null,
      capability_tier: tier,
      mode: 'source_addressed_specialist_workbench',
      conversation_compacted: compactNavigatorConversation,
      recurrence_guard: recurrence.meta,
    };
  }
  const routeMs = performance.now() - routeStarted;
  const routeTarget = reflex
    ? {
        model: reflex.envelope?.ae_effective_model || 'bun-reflex-compiler',
        host: reflex.envelope?.ae_effective_host || 'n150',
        node: reflex.envelope?.ae_effective_node || 'n150',
      }
    : (tier === 'visual' ? AE_EYES_TARGET : UPSTREAM[tier]);
  const capabilityCovenant = classifyCapabilityCovenant({ messages: body.messages, tier, autoRoute });
  const upstreamBody = reflex || tier === "light" ? cleanBody : {
    ...cleanBody,
    model: routeTarget.model,
    ae_specialist_policy: specialistPolicyFor(capabilityCovenant, tier),
  };
  const modelToolLoopEnabled = shouldUseGovernedModelTools({
    responseMode: effectiveResponseMode,
    reflex: Boolean(reflex),
    tier,
    body: { ...upstreamBody, ae_tools_enabled: body.ae_tools_enabled },
  });
  const inferenceBody = modelToolLoopEnabled
    ? prepareGovernedModelToolRequest(upstreamBody)
    : upstreamBody;
  const modelProxy = runtime.proxyChatCompletions || proxyChatCompletions;
  const bufferedInitialChunks = [];
  const inferenceStarted = performance.now();
  let result = reflex
    ? { status: 200, body: reflex.envelope }
    : (tier === 'visual'
        ? await proxyAeEyesChat(inferenceBody)
        : await modelProxy(inferenceBody, tier, {
            onChunk: modelToolLoopEnabled
              ? (chunk) => bufferedInitialChunks.push(structuredClone(chunk))
              : (effectiveResponseMode === 'conversation' ? runtime.onStreamChunk : null),
          }));
  if (modelToolLoopEnabled) {
    result = await runGovernedModelToolLoop({
      initialResult: result,
      requestBody: inferenceBody,
      orderId,
      executeBrainMcp: runtime.executeBrainMcp,
      invokeModel: (synthesisBody) => modelProxy(synthesisBody, tier, {
        onChunk: effectiveResponseMode === 'conversation' ? runtime.onStreamChunk : null,
      }),
    });
    if (result.body?.ae_tool_loop?.calls?.length === 0 && result.streamed === true) {
      if (typeof runtime.onStreamChunk === 'function') {
        for (const chunk of bufferedInitialChunks) await runtime.onStreamChunk(chunk);
      } else {
        result.streamed = false;
      }
    }
  }
  const inferenceMs = performance.now() - inferenceStarted;
  if (autoRoute && result.body && typeof result.body === "object") {
    result.body.ae_auto_route = {
      schema: autoRoute.decision.schema,
      decision_id: autoRoute.decision.decision_id,
      lane: autoRoute.decision.lane,
      tier,
      model: routeTarget?.model || null,
      capability: autoRoute.decision.capability || null,
      rationale: autoRoute.decision.rationale,
      flow: autoRoute.decision.field,
    };
  }
  const compileStarted = performance.now();
  if (responseContract === ORANGE_REPORT_SCHEMA && result.status === 200) {
    try {
      compileCompletionEnvelope(result.body, orderId, { suppliedEvidence, evidencePolicy, requestMessages: body.messages });
      reconcileReportWithRuntimeRoute(result.body, {
        succeeded: true,
        tier,
        model: result.body?.ae_effective_model || routeTarget?.model || cleanBody.model || null,
        host: result.body?.ae_effective_host || routeTarget?.host || null,
        node: result.body?.ae_effective_node || routeTarget?.node || routeTarget?.host || null,
      });
      result.body.ae_order_identity_source = identity.source;
      result.body.ae_evidence_origin = evidenceOrigin;
      if (evidenceOrigin === 'governed_context') {
        result.body.ae_evidence_authority = 'governed_context_preserved_exact';
        result.body.ae_governed_context_evidence = turn.governedEvidence;
      }
    } catch (error) {
      const settlement = await settleBuildRunFailure(buildRunContext, runtime, error, { order: turn.order });
      return {
        _ae_http_status: 502,
        error: { message: error.message, type: "upstream_error", code: "report_contract_compile_failed" },
        ae_build_run: buildRunLink(buildRunContext, settlement.write, settlement.warning || buildRunWarning),
      };
    }
  } else if (result.status === 200 && isOperationalReportDraft(result.body?.choices?.[0]?.message?.content)) {
    try {
      compileCompletionEnvelope(result.body, orderId, { suppliedEvidence: [], evidencePolicy: 'none', requestMessages: body.messages });
      result.body.ae_implicit_report_sanitized = true;
      result.body.ae_order_identity_source = identity.source;
    } catch (error) {
      const settlement = await settleBuildRunFailure(buildRunContext, runtime, error, { order: turn.order });
      return {
        _ae_http_status: 502,
        error: { message: error.message, type: "upstream_error", code: "implicit_report_sanitize_failed" },
        ae_build_run: buildRunLink(buildRunContext, settlement.write, settlement.warning || buildRunWarning),
      };
    }
  }
  const compileMs = performance.now() - compileStarted;
  if (responseContract === ORANGE_REPORT_SCHEMA && result.status === 200 && !reflex) {
    let verdict = validateCapabilityOutput(result.body, capabilityCovenant, {
      requestedTier: result.body?.ae_requested_tier || tier,
      executionTier: result.body?.ae_execution_tier || tier,
      routeMode: result.body?.ae_route_mode || 'specialist',
    });
    if (!verdict.valid && (tier === 'heavy' || tier === 'code') && verdict.executionTier === verdict.minimumTier) {
      const repairBody = {
        ...upstreamBody,
        messages: [...(upstreamBody.messages || []), { role: 'user', content: capabilityRepairInstruction(verdict) }],
      };
      const repaired = await modelProxy(repairBody, tier);
      if (repaired.status === 200) {
        const routeMetadata = result.body?.ae_auto_route || null;
        compileCompletionEnvelope(repaired.body, orderId, { suppliedEvidence, evidencePolicy, requestMessages: body.messages });
        const repairedVerdict = validateCapabilityOutput(repaired.body, capabilityCovenant, {
          requestedTier: repaired.body?.ae_requested_tier || tier,
          executionTier: repaired.body?.ae_execution_tier || tier,
          routeMode: repaired.body?.ae_route_mode || 'specialist',
        });
        repaired.body.ae_capability_repair = { attempted: true, first_verdict: verdict, final_verdict: repairedVerdict };
        if (routeMetadata) repaired.body.ae_auto_route = routeMetadata;
        result.body = repaired.body;
        result.status = repaired.status;
        verdict = repairedVerdict;
      }
    }
    if (!verdict.valid) enforceCapabilityFailure(result.body, verdict);
    else result.body.ae_capability_covenant = { ...verdict, enforced: true };
  }
  if (responseContract === ORANGE_REPORT_SCHEMA && result.status === 200) {
    enforceContinuityReport(result.body, turn.continuity);
  }
  if (!result.body || typeof result.body !== "object") result.body = {};
  const finalizeStarted = performance.now();
  const turnReceipt = await finalizeChatTurn({
    turn,
    completion: result.body,
    tier: result.body?.ae_execution_tier || tier,
    model: result.body?.ae_effective_model || routeTarget?.model || cleanBody.model || null,
    host: result.body?.ae_effective_host || result.body?.ae_host || routeTarget?.host || null,
    requestedTier: result.body?.ae_requested_tier || tier,
    routeMode: result.body?.ae_route_mode || 'specialist',
    requestedModel: result.body?.ae_requested_model || routeTarget?.model || cleanBody.model || null,
    requestedHost: result.body?.ae_requested_host || routeTarget?.host || null,
    requestedNode: result.body?.ae_requested_node || routeTarget?.node || routeTarget?.host || null,
    effectiveNode: result.body?.ae_effective_node || routeTarget?.node || routeTarget?.host || null,
  });
  const finalizeMs = performance.now() - finalizeStarted;
  result.body.ae_turn = turnReceipt;
  result.body.ae_order_id = orderId;
  result.body.ae_response_mode = effectiveResponseMode;
  if (result.streamed === true) result.body._ae_live_streamed = true;
  const toolExecutionTruth = result.body.ae_tool_loop?.execution_truth || null;
  const toolReceiptPaths = result.body.ae_tool_loop?.receipt_paths || [];
  result.body.ae_execution_performed = toolExecutionTruth?.execution_performed === true;
  result.body.ae_receipt_authority = toolReceiptPaths.length > 0
    ? (turnReceipt.receipt ? "orangefive-runtime+brain-mcp-hermes" : "brain-mcp-hermes")
    : (turnReceipt.receipt ? "orangefive-runtime" : "disabled");
  let buildRunWrite = null;
  if (buildRunContext?.run?.runId) {
    try {
      const repository = new BuildRunStore(runtime.buildRunFilePath);
      const previous = repository.get(buildRunContext.run.runId) || buildRunContext.run;
      const receiptRecord = turnReceipt.receipt
        ? { id: turnReceipt.receipt.id, seq: turnReceipt.receipt.seq, hash: turnReceipt.receipt.hash, path: turnReceipt.receipt.path }
        : null;
      const receipts = receiptRecord
        ? [...previous.receipts.filter((item) => item?.id !== receiptRecord.id), receiptRecord]
        : previous.receipts;
      buildRunWrite = await repository.update(buildRunContext.run.runId, {
        stage: 'settle',
        status: result.status === 200 ? 'completed' : 'failed',
        order: turn.order,
        route: turnReceipt.route,
        modelLane: {
          tier: result.body?.ae_execution_tier || tier,
          model: result.body?.ae_effective_model || routeTarget?.model || cleanBody.model || null,
          node: result.body?.ae_effective_node || routeTarget?.node || routeTarget?.host || null,
        },
        evidence: turn.governedEvidence?.items || previous.evidence,
        receipts,
        blockers: result.status === 200 ? [] : [result.body?.error?.message || `HTTP ${result.status}`],
        nextAction: result.status === 200 ? null : 'Inspect the failed turn receipt and repair the exact boundary.',
      }, 'turn_settled');
    } catch (error) {
      buildRunWarning = error.message;
    }
  }
  result.body.ae_build_run = buildRunLink(buildRunContext, buildRunWrite, buildRunWarning);
  const outboundText = completionText(result.body);
  const outboundPartyLine = partyLineEnabled && result.status === 200
    ? await appendChatPartyLine({
        projectId: partyLineProject,
        topic: String(partyLineConfig.topic || 'chat'),
        actor: {
          id: result.body?.ae_effective_model || routeTarget?.model || cleanBody.model || 'orange-auto',
          kind: 'model',
          displayName: result.body?.ae_effective_model || routeTarget?.model || cleanBody.model || 'Orange',
          model: result.body?.ae_effective_model || routeTarget?.model || cleanBody.model || null,
          node: result.body?.ae_effective_node || routeTarget?.node || routeTarget?.host || null,
        },
        eventType: responseContract === ORANGE_REPORT_SCHEMA ? 'report' : 'message',
        status: result.body?.choices?.[0]?.finish_reason || 'completed',
        summary: outboundText.slice(0, 300) || `Orange ${responseContract === ORANGE_REPORT_SCHEMA ? 'report' : 'reply'}`,
        body: outboundText,
        detail: {
          tier: result.body?.ae_execution_tier || tier,
          routeMode: result.body?.ae_route_mode || 'specialist',
          orderId,
          runId: buildRunWrite?.run?.runId || buildRunContext?.run?.runId || null,
        },
        sourceRefs: turnReceipt.receipt?.path
          ? [{ uri: turnReceipt.receipt.path, hash: turnReceipt.receipt.hash, label: 'chat turn receipt' }]
          : [],
        correlationId: orderId,
        tags: ['chat', effectiveResponseMode],
        importance: responseContract === ORANGE_REPORT_SCHEMA ? 0.85 : 0.65,
      }, { filePath: runtime.partyLineFilePath })
    : null;
  result.body.ae_party_line = {
    schema: 'orange.party-line.turn.v1',
    enabled: partyLineEnabled,
    projectId: partyLineProject,
    inboundEventId: inboundPartyLine?.event?.id || null,
    outboundEventId: outboundPartyLine?.event?.id || null,
    hydratedEventIds: partyLineHydration?.selected?.map((event) => event.id) || [],
    hydrationCursor: partyLineHydration?.cursor ?? null,
    warning: inboundPartyLine?.error || outboundPartyLine?.error || null,
  };
  result.body.ae_stage_timings_ms = {
    schema: 'orange.chat-stage-timings.v1',
    harness: Number(harnessMs.toFixed(2)),
    prompt_budget: Number(budgetMs.toFixed(2)),
    route: Number(routeMs.toFixed(2)),
    inference: Number(inferenceMs.toFixed(2)),
    compile: Number(compileMs.toFixed(2)),
    finalize: Number(finalizeMs.toFixed(2)),
    total: Number((performance.now() - requestStarted).toFixed(2)),
  };
  // Pass-through status so server can use it
  result.body._ae_http_status = result.status;
  return result.body;
}

export function modelResidencyState(probe = {}) {
  return probe.model_loaded === true ? "warm" : (probe.live === true ? "available" : "unreachable");
}

export function resolveOperationalOrderIdentity(body = {}, uuid = randomUUID) {
  if (typeof body.ae_order_id === "string" && body.ae_order_id.trim()) {
    return { orderId: body.ae_order_id.trim(), source: "explicit_request" };
  }
  const userOrderId = orderIdFromMessages(body.messages);
  if (userOrderId) return { orderId: userOrderId, source: "user_order" };
  return { orderId: `gw-order-${uuid()}`, source: "gateway_minted" };
}

export function isDerivedEvidenceCaller(body = {}, orderId = '') {
  if (!String(orderId).endsWith(':refuter')) return false;
  for (let index = (body.messages ?? []).length - 1; index >= 0; index -= 1) {
    const message = body.messages[index];
    if (message?.role !== 'user' || typeof message.content !== 'string') continue;
    try { return JSON.parse(message.content)?.role === 'falsifier'; }
    catch { return false; }
  }
  return false;
}
