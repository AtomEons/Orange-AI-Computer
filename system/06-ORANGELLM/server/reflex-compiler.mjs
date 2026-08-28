import { createHash } from 'node:crypto';
import { classifyPromotedReflex } from '../../03-BACKEND/reflex-registry.mjs';

const SCHEMA = 'orange.report.v1';

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function latestUserText(messages = []) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'user') continue;
    if (typeof message.content === 'string') return message.content;
    if (Array.isArray(message.content)) {
      return message.content.map((part) => part?.text || '').join(' ');
    }
    return JSON.stringify(message.content ?? '');
  }
  return '';
}

function estimateTokens(value) {
  return Math.max(1, Math.ceil(Buffer.byteLength(String(value), 'utf8') / 2.5));
}

function report(orderId, { status = 'needs_action', confidence = 1, findings, blockers = [], nextAction }) {
  return {
    schema: SCHEMA,
    orderId,
    status,
    confidence,
    actionsTaken: [],
    evidence: [],
    findings,
    blockers,
    nextAction,
    receiptPath: null,
  };
}

export function classifyReflexIntent(messages = []) {
  const text = latestUserText(messages).trim();
  if (!text) return null;

  const promoted = classifyPromotedReflex(text);
  if (promoted) return promoted;

  if (/\bhealth\b/i.test(text)
    && /\b(?:route|endpoint|check|probe|where|which)\b/i.test(text)
    && !/\b(?:edit|modify|patch|change|write|implement|build|delete|restart|reconnect|deploy|diagnos\w*|investigat\w*|analy[sz]\w*|fix)\b/i.test(text)) {
    return {
      id: 'health-route',
      status: 'needs_action',
      findings: ['deterministic route: GET /healthz'],
      blockers: [],
      nextAction: 'call GET /healthz and inspect its evidence before claiming system status',
    };
  }

  if (/\bmemory\b/i.test(text)
    && /\b(?:project|recall)\b/i.test(text)
    && /\b(?:route|endpoint|answer|which|where)\b/i.test(text)) {
    return {
      id: 'memory-recall-route',
      status: 'needs_action',
      findings: ['deterministic route: POST /v1/memory/recall'],
      blockers: [],
      nextAction: 'call POST /v1/memory/recall with the project recall query',
    };
  }

  if (/\b(?:image|screenshot|visual|document)\b/i.test(text)
    && /\b(?:inspect|inspection|route|organ|analy[sz]e|look)\b/i.test(text)) {
    return {
      id: 'visual-route',
      status: 'needs_action',
      findings: ['deterministic route: AE Eyes'],
      blockers: [],
      nextAction: 'provide the visual artifact to AE Eyes for governed analysis',
    };
  }

  if (/\bCodexa\b/i.test(text)
    && /\b(?:down|offline|unreachable|unavailable)\b/i.test(text)
    && /\b(?:fallback|next action|state|honest|what)\b/i.test(text)) {
    return {
      id: 'codexa-offline-policy',
      status: 'blocked',
      findings: ['deterministic fallback: N150 control only; no local answer model'],
      blockers: ['Codexa unavailable under the requested scenario'],
      nextAction: 'continue deterministic N150 Bun control and queue model-dependent work until Codexa reconnects',
    };
  }

  if (/\b(?:edit|write|modify|patch|change|mutation)\b/i.test(text)
    && /\b(?:receipt|proof|evidence|execut|claim)\b/i.test(text)
    && /\b(?:plan|without|do not|don't|cannot|can not|before|policy|claim)\b/i.test(text)) {
    return {
      id: 'mutation-proof-boundary',
      status: 'needs_action',
      findings: ['mutation was not executed'],
      blockers: ['no governed mutation receipt supplied'],
      nextAction: 'execute through a governed Hermes lease and verify the resulting receipt',
    };
  }

  return null;
}

export function compileReflexCompletion({ messages = [], orderId, model = 'orange-auto' } = {}) {
  const decision = classifyReflexIntent(messages);
  if (!decision || typeof orderId !== 'string' || !orderId) return null;
  const compiledReport = report(orderId, decision);
  const promptText = latestUserText(messages);
  const content = JSON.stringify(compiledReport);
  return {
    decision,
    report: compiledReport,
    envelope: {
      id: `chatcmpl-reflex-${sha256(`${orderId}:${decision.id}`).slice(0, 16)}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 0,
        completion_tokens: estimateTokens(content),
        total_tokens: estimateTokens(content),
      },
      ae_reflex: {
        schema: 'orange.reflex-decision.v1',
        intent: decision.id,
        compiler: 'bun-reflex-compiler',
        model_calls_avoided: 1,
        broad_hydrations_avoided: 1,
        estimated_prompt_tokens_avoided: estimateTokens(promptText),
      },
      ae_execution_tier: 'reflex',
      ae_effective_model: 'bun-reflex-compiler',
      ae_effective_host: 'n150',
      ae_effective_node: 'n150',
      ae_requested_tier: 'auto',
      ae_requested_model: model,
      ae_requested_host: 'n150+codexa',
      ae_requested_node: 'n150+codexa',
      ae_route_mode: 'deterministic_reflex',
      ae_inference_optimization: {
        schema: 'orange.inference-optimization.v1',
        mode: 'deterministic_reflex',
        model_calls_avoided: 1,
        cache_ratio: 1,
      },
    },
  };
}

export const __reflexCompilerInternals = Object.freeze({ latestUserText, estimateTokens });
