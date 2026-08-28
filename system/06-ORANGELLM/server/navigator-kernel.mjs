import { createHash } from 'node:crypto';

const SOURCE_REFS = Object.freeze([
  '06-ORANGELLM/server/orange-system.mjs#ORANGE_NAVIGATOR_COMPACT_CONVERSATION_SYSTEM',
  '03-BACKEND/ae-phase-fabric.mjs',
  '04-CONTROL-PLANE/party-line/ledger.mjs',
  '06-ORANGELLM/memory/ae-cobra',
]);

const EXECUTION_OR_DESIGN = /\b(?:build|change|edit|write|patch|implement|install|deploy|restart|run|execute|fix|debug|research|browse|search|compare|recommend|design|invent|brainstorm|improve|optimi[sz]e|upgrade|refactor|delete|remove|create)\b/i;
const LIVE_STATUS = /\b(?:is|are)\s+(?:it|they|phase|codexa|orange|orangebrain|navigator|hermes)\s+(?:live|running|healthy|reachable|connected|up|down|offline)\b|\b(?:health|status|uptime|latency|reachable|unreachable|connected|disconnected|online|offline|right now|currently running)\b/i;
const OPEN_ENDED = /\b(?:what should|how should|could we|would it|why not|best way|better way)\b/i;

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function latestUserText(messages = []) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'user') continue;
    if (typeof message.content === 'string') return message.content;
    if (Array.isArray(message.content)) return message.content.map((part) => part?.text || '').join(' ');
    return JSON.stringify(message.content ?? '');
  }
  return '';
}

function estimateTokens(value) {
  return Math.max(1, Math.ceil(Buffer.byteLength(String(value), 'utf8') / 2.5));
}

function conceptsFor(text) {
  return {
    memory: /\b(?:project memory|memory|remember|preserv\w+\s+(?:the\s+)?project|transcript|artifact)\b/i.test(text),
    transport: /\b(?:AE Phase|cross-computer transport|heavy model work|send\w*\s+.*\s+Codexa|Codexa\s+compute|model lease)\b/i.test(text),
    authority: /\b(?:source truth|hot context|working (?:state|context)|source pointer|raw ledger|authority)\b/i.test(text),
    partyLine: /\bParty Line\b/i.test(text),
    topology: /\b(?:N150|Codexa|control plane|compute node|where\s+.*\s+(?:model|compute))\b/i.test(text),
  };
}

function renderAnswer(concepts) {
  if (concepts.memory && concepts.transport && concepts.authority) {
    return [
      'Orange preserves complete transcripts, artifacts, receipts, and AE Cobra raw-ledger records on disk as source truth; hot context is only a task-specific workbench of current commitments, constraints, decisions, and hydratable source pointers.',
      'The N150 keeps Bun control lightweight, while OrangeBrain and Navigator send heavy model and tool leases to Codexa through authenticated AE Phase, Orange\'s only active cross-computer transport.',
      'Party Line records shared continuity on disk, but it is neither transport nor source truth unless an event links governed evidence.',
    ].join(' ');
  }

  const sentences = [];
  if (concepts.memory || concepts.authority) {
    sentences.push('Orange keeps complete transcripts, artifacts, receipts, and AE Cobra raw-ledger records on disk as source truth, while hot context remains a small task-specific workbench with hydratable source pointers.');
  }
  if (concepts.transport || concepts.topology) {
    sentences.push('The N150 runs the Bun control plane, and OrangeBrain sends heavy model or tool leases to Codexa through authenticated AE Phase, the only active cross-computer transport.');
  }
  if (concepts.partyLine) {
    sentences.push('Party Line is a disk-backed continuity stream, not a transport or source truth unless its event links governed evidence.');
  }
  return sentences.join(' ');
}

export function classifyNavigatorKernelQuery(messages = []) {
  const text = latestUserText(messages).trim();
  if (!text || text.length > 1_200) return null;
  if (EXECUTION_OR_DESIGN.test(text) || LIVE_STATUS.test(text) || OPEN_ENDED.test(text)) return null;
  if (!/\b(?:explain|describe|distinguish|name|what|how|where|tell me|define)\b/i.test(text)) return null;

  const concepts = conceptsFor(text);
  const conceptCount = Object.values(concepts).filter(Boolean).length;
  const directAuthorityQuestion = concepts.authority && /\b(?:source truth|hot context)\b/i.test(text);
  if (conceptCount < 2 && !directAuthorityQuestion) return null;

  const answer = renderAnswer(concepts);
  if (!answer) return null;
  return {
    id: 'orange-system-truth',
    concepts: Object.entries(concepts).filter(([, present]) => present).map(([name]) => name),
    answer,
    sourceRefs: [...SOURCE_REFS],
  };
}

export function compileNavigatorKernelCompletion({ messages = [], orderId, model = 'orange-auto' } = {}) {
  const decision = classifyNavigatorKernelQuery(messages);
  if (!decision || typeof orderId !== 'string' || !orderId) return null;
  const prompt = latestUserText(messages);
  const content = decision.answer;
  const promptTokens = estimateTokens(prompt);
  const completionTokens = estimateTokens(content);
  return {
    decision,
    envelope: {
      id: `chatcmpl-navkernel-${sha256(`${orderId}:${decision.id}:${prompt}`).slice(0, 16)}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: 'bun-navigator-kernel',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
      ae_navigator_kernel: {
        schema: 'orange.navigator-kernel.v1',
        intent: decision.id,
        compiler: 'bun-navigator-kernel',
        concepts: decision.concepts,
        source_refs: decision.sourceRefs,
        authority: 'governed_architecture_law_not_live_health',
        query_sha256: sha256(prompt),
        answer_sha256: sha256(content),
        model_calls_avoided: 1,
      },
      ae_execution_tier: 'navigator_kernel',
      ae_effective_model: 'bun-navigator-kernel',
      ae_effective_host: 'n150',
      ae_effective_node: 'n150',
      ae_requested_tier: 'auto',
      ae_requested_model: model,
      ae_requested_host: 'n150+codexa',
      ae_requested_node: 'n150+codexa',
      ae_route_mode: 'navigator_kernel',
      ae_inference_optimization: {
        schema: 'orange.inference-optimization.v1',
        mode: 'source_backed_navigator_kernel',
        model_calls_avoided: 1,
        broad_hydrations_avoided: 1,
      },
    },
  };
}

export const __navigatorKernelInternals = Object.freeze({ latestUserText, estimateTokens, conceptsFor, renderAnswer });
