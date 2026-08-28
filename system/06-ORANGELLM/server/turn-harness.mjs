import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runOrder } from '../../03-BACKEND/orange5-spine.mjs';
import { defaultProjectLockPath, injectProjectLock, readProjectLock } from '../../03-BACKEND/project-lock.mjs';
import { getCurrentAwareness, shouldScoutIntent } from '../../03-BACKEND/current-awareness.mjs';
import { enqueueLearningReceipt } from '../../03-BACKEND/learning-queue.mjs';
import { compileContextCrystal } from '../../03-BACKEND/context-crystal.mjs';
import { continuityPreflight, recordContinuityTurn, renderContinuityAir } from '../../03-BACKEND/project-continuum.mjs';
import { lessonFor } from '../../03-BACKEND/learning-loop.mjs';
import { compileChatOrder } from './auto-route.mjs';
import { compileGovernedChatEvidence } from './governed-chat-evidence.mjs';
import { memoryInjectMiddleware } from './middleware/memory-inject.mjs';
import { compileProblem, renderWorkObjectAir } from '../../03-BACKEND/problem-compiler.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_CHAIN = path.join(ROOT, '10-RECEIPTS', 'spine-chain.jsonl');
const RECEIPTS_ENABLED = process.env.ORANGE5_CHAT_RECEIPTS !== '0'
  && process.env.NODE_ENV !== 'test';
const DEFAULT_PROMPT_BUDGET_TOKENS = Math.max(1_200, Number(process.env.ORANGE5_PROMPT_BUDGET_TOKENS || 2_600));

let receiptQueue = Promise.resolve();

function internalRefuterTopology() {
  return {
    schema: 'orange5.topology.v1',
    topology: 'solo',
    reason: 'terminal independent refuter pass; another refuter would recurse indefinitely',
    adversarialRequired: false,
    minAgents: 1,
    gates: ['procedural'],
  };
}

function advisoryChatTopology() {
  return {
    schema: 'orange5.topology.v1',
    topology: 'solo',
    reason: 'non-mutating advisory chat; model observations remain unverified until governed evidence is supplied',
    adversarialRequired: false,
    minAgents: 1,
    gates: ['procedural'],
  };
}

function advisoryChatRouter(tier = 'light', model = null) {
  const lane = tier === 'light' ? 'reflex' : String(tier || 'reflex');
  return {
    lane,
    model,
    eligible: true,
    complexity: 'bounded_chat',
    risk: 'low',
    rationale: 'receipt bound to the model lane that completed the non-mutating chat turn',
    scorecard: [{ lane, model, eligible: true }],
  };
}

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

const SPINE_GENESIS = sha256('orange5-spine-genesis');

function latestUserText(messages = []) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'user') continue;
    if (typeof message.content === 'string') return message.content;
    return JSON.stringify(message.content ?? '');
  }
  return '';
}

function messageText(message) {
  if (typeof message?.content === 'string') return message.content;
  return JSON.stringify(message?.content ?? '');
}

function estimatePromptTokens(messages = []) {
  const bytes = messages.reduce((sum, message) => sum + Buffer.byteLength(messageText(message), 'utf8') + 12, 0);
  return Math.ceil(bytes / 2.5);
}

function truncateFrame(value, maxChars) {
  const text = String(value || '');
  if (text.length <= maxChars) return text;
  const marker = '\n[ORANGE_FRAME_TRUNCATED; full evidence remains source-addressable]\n';
  const tail = Math.min(180, Math.floor(maxChars * 0.12));
  const head = Math.max(1, maxChars - marker.length - tail);
  return `${text.slice(0, head)}${marker}${text.slice(-tail)}`;
}

function promptSourceIdentity(message, originalIndex) {
  const explicit = [
    message?.source_identity,
    message?.source,
    message?.source_path,
    message?.metadata?.source_identity,
    message?.metadata?.source,
    message?.metadata?.source_path,
    message?.name,
  ].find((value) => typeof value === 'string' && value.trim());
  if (explicit) return explicit.trim().slice(0, 240);

  const content = messageText(message);
  const marker = [
    'Return compact JSON only.',
    'ORANGE ACTIVE PROJECT LOCK',
    'AIR:PARTY-LINE.v1',
    'AIR:CONTEXT-CRYSTAL.v1',
    'AIR:PROJECT-CONTINUUM.v1',
    'AIR:FAILURE-MEMORY.v1',
    'AIR:CURRENT.v1',
    'AIR:MEMORY.v1',
    '[MEMORY:RECALLED',
  ].find((candidate) => content.includes(candidate));
  if (marker) return marker;
  return `${message?.role || 'unknown'}:message:${originalIndex}`;
}

function promptTransformAudit(message, originalIndex, sourceIdentity, afterContent, stage) {
  const beforeContent = messageText(message);
  return {
    original_index: originalIndex,
    role: message?.role || null,
    source_identity: sourceIdentity,
    stage,
    before_sha256: sha256(beforeContent),
    after_sha256: afterContent == null ? null : sha256(afterContent),
    before_chars: beforeContent.length,
    after_chars: afterContent == null ? 0 : afterContent.length,
  };
}

function systemFrameCap(content) {
  const text = String(content || '');
  if (text.includes('AIR:PARTY-LINE.v1')) return 1_600;
  if (text.includes('AIR:CONTEXT-CRYSTAL.v1')) return 2_400;
  if (text.includes('AIR:PROJECT-CONTINUUM.v1')) return 1_200;
  if (text.includes('AIR:FAILURE-MEMORY.v1')) return 900;
  if (text.includes('ORANGE ACTIVE PROJECT LOCK')) return 2_200;
  if (text.includes('AIR:CURRENT.v1')) return 1_500;
  if (text.includes('AIR:MEMORY.v1') || text.includes('[MEMORY:RECALLED')) return 1_500;
  return 1_800;
}

function systemFrameFloor(content, baseFloor) {
  const text = String(content || '');
  // The report grammar is executable protocol, not background context. If it
  // is crushed to the same floor as recalled prose, specialists emit malformed
  // packets that deterministic repair can only quarantine.
  if (/^Return compact JSON only\./.test(text)) return Math.max(baseFloor, 520);
  if (text.includes('AIR:PARTY-LINE.v1')) return Math.max(baseFloor, 480);
  if (text.includes('ORANGE ACTIVE PROJECT LOCK')) return Math.max(baseFloor, 180);
  if (text.includes('AIR:CONTEXT-CRYSTAL.v1')) return Math.max(baseFloor, 180);
  if (text.includes('AIR:PROJECT-CONTINUUM.v1')) return Math.max(baseFloor, 160);
  if (text.includes('AIR:FAILURE-MEMORY.v1')) return Math.max(baseFloor, 140);
  if (text.includes('AIR:CURRENT.v1')) return Math.max(baseFloor, 120);
  if (text.includes('AIR:MEMORY.v1') || text.includes('[MEMORY:RECALLED')) return Math.max(baseFloor, 120);
  return baseFloor;
}

export function fitMessagesToBudget(messages = [], {
  budgetTokens = DEFAULT_PROMPT_BUDGET_TOKENS,
  minSystemChars = 500,
  maxPasses = 8,
} = {}) {
  const original = structuredClone(Array.isArray(messages) ? messages : []);
  const beforeTokens = estimatePromptTokens(original);
  let truncatedFrames = 0;
  const truncationAudit = [];
  const droppedAudit = [];
  let fitted = original.map((message, originalIndex) => {
    const sourceIdentity = promptSourceIdentity(message, originalIndex);
    if (message?.role !== 'system' || typeof message.content !== 'string') {
      return { message, originalIndex, sourceIdentity };
    }
    const content = truncateFrame(message.content, systemFrameCap(message.content));
    if (content !== message.content) {
      truncatedFrames += 1;
      truncationAudit.push(promptTransformAudit(message, originalIndex, sourceIdentity, content, 'system_cap'));
    }
    return { message: { ...message, content }, originalIndex, sourceIdentity };
  });

  let droppedMessages = 0;
  while (estimatePromptTokens(fitted.map((item) => item.message)) > budgetTokens) {
    const latestUserIndex = fitted.findLastIndex((item) => item.message?.role === 'user');
    const removable = fitted.findIndex((item, index) => item.message?.role !== 'system' && index !== latestUserIndex);
    if (removable < 0) break;
    const [dropped] = fitted.splice(removable, 1);
    droppedAudit.push(promptTransformAudit(
      original[dropped.originalIndex],
      dropped.originalIndex,
      dropped.sourceIdentity,
      null,
      'history_drop',
    ));
    droppedMessages += 1;
  }

  let pass = 0;
  while (estimatePromptTokens(fitted.map((item) => item.message)) > budgetTokens && pass < maxPasses) {
    const systems = fitted
      .map((item, index) => ({
        item,
        index,
        size: item.message?.role === 'system' ? messageText(item.message).length : 0,
        floor: item.message?.role === 'system' ? systemFrameFloor(messageText(item.message), minSystemChars) : minSystemChars,
      }))
      .filter((item) => item.size > item.floor)
      .sort((a, b) => b.size - a.size);
    if (!systems.length) break;
    const target = systems[0];
    const beforeMessage = target.item.message;
    const content = truncateFrame(messageText(beforeMessage), Math.max(target.floor, Math.floor(target.size * 0.72)));
    fitted[target.index] = {
      ...target.item,
      message: { ...beforeMessage, content },
    };
    truncationAudit.push(promptTransformAudit(
      beforeMessage,
      target.item.originalIndex,
      target.item.sourceIdentity,
      content,
      `budget_pass_${pass + 1}`,
    ));
    truncatedFrames += 1;
    pass += 1;
  }

  const fittedMessages = fitted.map((item) => item.message);
  const afterTokens = estimatePromptTokens(fittedMessages);
  return {
    messages: fittedMessages,
    meta: {
      schema: 'orange.prompt-budget.v1',
      budget_tokens: budgetTokens,
      estimated_tokens_before: beforeTokens,
      estimated_tokens_after: afterTokens,
      dropped_messages: droppedMessages,
      truncated_frames: truncatedFrames,
      within_budget: afterTokens <= budgetTokens,
      transform_audit: {
        schema: 'orange.prompt-transform-audit.v1',
        dropped: droppedAudit,
        truncated: truncationAudit,
        reasoning_blocks_removed: 0,
        special_tokens_removed: 0,
      },
    },
  };
}

function systemFramePriority(message) {
  const content = String(message?.content || '');
  if (/^Return compact JSON only\./.test(content)) return 0;
  if (content.includes('ORANGE ACTIVE PROJECT LOCK')) return 1;
  if (content.includes('AIR:PARTY-LINE.v1')) return 2;
  if (content.includes('AIR:PROJECT-CONTINUUM.v1')) return 3;
  if (content.includes('AIR:FAILURE-MEMORY.v1')) return 4;
  if (content.includes('AIR:CURRENT.v1')) return 5;
  if (content.includes('AIR:MEMORY.v1') || content.includes('[MEMORY:RECALLED')) return 6;
  return 7;
}

function renderFailureAir(action, lesson) {
  const patterns = Array.isArray(lesson?.patterns) ? lesson.patterns.slice(0, 3) : [];
  return [
    'AIR:FAILURE-MEMORY.v1',
    `action=${action} prior_failures=${lesson?.count || 0}`,
    ...patterns.map((item) => `F:${item.failureClass} count=${item.count} repair=${JSON.stringify(item.repair || '')}`),
    `RECURRENCE_GUARD: ${lesson?.recommendedAction || 'inspect exact prior evidence before repeating the route'}`,
    ...(lesson?.mistakes || []).slice(0, 2).map((item) => `S:${item.hash || 'unknown'} ${String(item.summary || item.kind || '').replace(/\s+/g, ' ').slice(0, 180)}`),
  ].join('\n');
}

function injectFailureMemory(messages, action, deps = {}) {
  try {
    const lesson = (deps.failureRunner || lessonFor)(action);
    if (!lesson || Number(lesson.count || 0) < 1) {
      return { messages, meta: {
        active: false,
        action,
        count: 0,
        patterns: [],
        resolvedCount: Number(lesson?.resolved_count || 0),
        lastResolutionAt: lesson?.last_resolution_at || null,
        lastResolutionDisposition: lesson?.last_resolution_disposition || null,
        recommendedAction: null,
      } };
    }
    const nextMessages = structuredClone(messages);
    const continuumIndex = nextMessages.findIndex((message) => message?.role === 'system'
      && String(message.content || '').includes('AIR:PROJECT-CONTINUUM.v1'));
    const lockIndex = nextMessages.findIndex((message) => message?.role === 'system'
      && String(message.content || '').includes('ORANGE ACTIVE PROJECT LOCK'));
    const insertAt = continuumIndex >= 0 ? continuumIndex + 1 : (lockIndex >= 0 ? lockIndex + 1 : 0);
    nextMessages.splice(insertAt, 0, { role: 'system', content: renderFailureAir(action, lesson) });
    return {
      messages: nextMessages,
      meta: {
        active: true,
        action,
        count: Number(lesson.count || 0),
        patterns: Array.isArray(lesson.patterns) ? lesson.patterns : [],
        resolvedCount: Number(lesson.resolved_count || 0),
        lastResolutionAt: lesson.last_resolution_at || null,
        lastResolutionDisposition: lesson.last_resolution_disposition || null,
        recommendedAction: lesson.recommendedAction || null,
      },
    };
  } catch (error) {
    return { messages, meta: { active: false, action, count: 0, patterns: [], recommendedAction: null, error: error?.message || String(error) } };
  }
}

function injectContinuity(messages, userText, deps = {}) {
  try {
    const runner = deps.continuityRunner || continuityPreflight;
    const preflight = runner(userText);
    if (!preflight?.available || !Array.isArray(preflight.hits) || preflight.hits.length === 0) {
      return { messages, meta: preflight || { available: false, hits: [], reason: 'continuity unavailable' } };
    }
    const nextMessages = structuredClone(messages);
    const lockIndex = nextMessages.findIndex((message) => message?.role === 'system'
      && String(message.content || '').includes('ORANGE ACTIVE PROJECT LOCK'));
    const firstSystem = nextMessages.findIndex((message) => message?.role === 'system');
    const insertAt = lockIndex >= 0 ? lockIndex + 1 : (firstSystem >= 0 ? firstSystem + 1 : 0);
    nextMessages.splice(insertAt, 0, { role: 'system', content: renderContinuityAir(preflight) });
    return {
      messages: nextMessages,
      meta: preflight,
    };
  } catch (error) {
    return {
      messages,
      meta: { available: false, stale: true, hits: [], reason: error?.message || String(error), duplicate_sensitive: false, existing_lineage_found: false, training_lineage_found: false, training_paths: [] },
    };
  }
}

export function stabilizeLeadingSystemFrames(messages = []) {
  const input = structuredClone(Array.isArray(messages) ? messages : []);
  let count = 0;
  while (input[count]?.role === 'system') count += 1;
  if (count < 2) return input;
  const leading = input.slice(0, count).map((message, index) => ({ message, index }));
  leading.sort((a, b) => systemFramePriority(a.message) - systemFramePriority(b.message) || a.index - b.index);
  return [...leading.map((item) => item.message), ...input.slice(count)];
}

function executionRequested(text) {
  const value = String(text);
  if (/\b(?:change|create|delete|deploy|edit|execute|fix|implement|install|move|patch|publish|remove|rename|restart|run|ship|start|stop|update|write)\b/i.test(value)) {
    return true;
  }
  if (!/\bbuild\b/i.test(value)) return false;
  return !/\b(?:a|the|this|that|our|your)\s+build\b/i.test(value);
}

function injectProjectCrystal(messages, project, userText) {
  if (!project?.active || !project?.project?.root) {
    return { ...injectProjectLock(messages, project, { maxChars: 2_400 }), crystal: null };
  }
  try {
    const root = path.resolve(project.project.root);
    const lockContent = [
      'ORANGE ACTIVE PROJECT LOCK',
      'Orange active project authority.',
      `product=Orange release=OrangeFive project=${project.project.name || 'OrangeFive'}`,
      `root=${root}`,
      `goal=${project.goal || 'Follow the current operator order and governing sources.'}`,
      `lock_sha256=${project.sha256 || 'unknown'}`,
      'LAW: Live probes and fresh receipts outrank prose and recollection.',
      'LAW: Never claim file, tool, service, deployment, or mutation work without governed execution evidence.',
      'LAW: Keep project scope active. Do not pivot or rollback user work.',
    ].join('\n');
    const sources = [{
      id: 'orange-active-project-lock',
      pointer: `file://${defaultProjectLockPath().replaceAll('\\', '/')}`,
      content: lockContent,
      pinned: true,
      authority: 1,
    }];
    for (const doc of project.project.governingDocs || []) {
      const absolute = path.resolve(root, String(doc.path || ''));
      const insideRoot = absolute.toLowerCase() === root.toLowerCase()
        || absolute.toLowerCase().startsWith(`${root.toLowerCase()}${path.sep}`);
      if (!insideRoot || !fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) continue;
      const stat = fs.statSync(absolute);
      if (stat.size <= 0 || stat.size > 500_000) continue;
      sources.push({
        id: String(doc.path).replaceAll('\\', '/'),
        pointer: `file://${absolute.replaceAll('\\', '/')}`,
        content: fs.readFileSync(absolute, 'utf8'),
        authority: sources.length <= 4 ? 0.2 : 0,
      });
    }
    const crystal = compileContextCrystal({
      task: userText || 'OrangeFive active project scope and runtime authority',
      sources,
      budgetBytes: 2_200,
      requiredSourceIds: ['orange-active-project-lock'],
    });
    return {
      messages: [{ role: 'system', content: crystal.hot_context }, ...structuredClone(messages)],
      state: project,
      crystal,
      evidenceSources: sources,
    };
  } catch (error) {
    const fallback = injectProjectLock(messages, project, { maxChars: 2_400 });
    return { ...fallback, crystal: { error: error?.message || String(error) } };
  }
}

function loadChain(chainPath) {
  let raw;
  try {
    raw = fs.readFileSync(chainPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    const wrapped = new Error(`receipt chain read failed at ${chainPath}: ${error?.message || String(error)}`);
    wrapped.code = 'ORANGE_RECEIPT_CHAIN_READ_FAILED';
    wrapped.cause = error;
    throw wrapped;
  }

  const rows = [];
  for (const [index, line] of raw.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch (error) {
      const wrapped = new Error(`receipt chain parse failed at ${chainPath}:${index + 1}: ${error?.message || String(error)}`);
      wrapped.code = 'ORANGE_RECEIPT_CHAIN_PARSE_FAILED';
      wrapped.cause = error;
      throw wrapped;
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      const error = new Error(`receipt chain corruption at ${chainPath}:${index + 1}: entry must be an object`);
      error.code = 'ORANGE_RECEIPT_CHAIN_CORRUPT';
      throw error;
    }
    rows.push({ entry, lineNumber: index + 1 });
  }

  for (let index = 0; index < rows.length; index += 1) {
    const { entry, lineNumber } = rows[index];
    const expectedPrevHash = index === 0 ? SPINE_GENESIS : rows[index - 1].entry.hash;
    const { prev_hash: prevHash, hash, ...body } = entry;
    const expectedHash = sha256(`${expectedPrevHash}|${JSON.stringify(body)}`);
    let reason = null;
    if (entry.seq !== index) reason = `expected seq ${index}, received ${JSON.stringify(entry.seq)}`;
    else if (prevHash !== expectedPrevHash) reason = 'previous hash mismatch';
    else if (typeof hash !== 'string' || hash !== expectedHash) reason = 'content hash mismatch';
    if (reason) {
      const error = new Error(`receipt chain corruption at ${chainPath}:${lineNumber}: ${reason}`);
      error.code = 'ORANGE_RECEIPT_CHAIN_CORRUPT';
      throw error;
    }
  }
  return rows.map((row) => row.entry);
}

function persistNewReceipt(chainPath, beforeLength, chain) {
  if (chain.length <= beforeLength) return null;
  fs.mkdirSync(path.dirname(chainPath), { recursive: true });
  const entries = chain.slice(beforeLength);
  fs.appendFileSync(chainPath, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n', 'utf8');
  return entries.at(-1);
}

async function injectMemory(body) {
  if (process.env.ORANGE5_CHAT_MEMORY === '0' || process.env.NODE_ENV === 'test') {
    return { body: structuredClone(body), meta: { bytes: 0, sources: [], recallTags: [], notes: ['memory injection disabled'], compression: [] } };
  }
  const req = { method: 'POST', url: '/v1/chat/completions', body: structuredClone(body) };
  const middleware = memoryInjectMiddleware({
    enabled: true,
    recentMaxBytes: 1_000,
    deepMaxBytes: 2_200,
    recentTimeoutMs: 5_000,
    deepTimeoutMs: 12_000,
    log: (message) => {
      if (process.env.ORANGE5_CHAT_MEMORY_DEBUG === '1') console.warn(message);
    },
  });
  await new Promise((resolve) => middleware(req, { setHeader() {} }, resolve));
  return { body: req.body, meta: req._aeMemoryInjected || { bytes: 0, sources: [], recallTags: [], notes: [], compression: [] } };
}

function inheritedChildResearchEvidence(userText) {
  let order;
  try { order = JSON.parse(userText); } catch { return null; }
  if (!['analyze.agent', 'synthesize.delegation'].includes(order?.action)) return null;
  const evidence = order?.payload?.researchEvidence;
  const sources = Array.isArray(evidence?.sources) ? evidence.sources.filter((source) => source?.url) : [];
  if (!sources.length) return null;
  return { action: order.action, sourceCount: sources.length, sha256: evidence.sha256 || null };
}

async function injectAwareness(messages, userText, project, deps = {}) {
  const inherited = inheritedChildResearchEvidence(userText);
  if (inherited) {
    return {
      messages,
      meta: {
        triggered: false,
        sourceCount: 0,
        cacheHit: false,
        status: 'INHERITED_RESEARCH_EVIDENCE',
        inheritedSourceCount: inherited.sourceCount,
        inheritedEvidenceSha256: inherited.sha256,
        errors: [],
      },
    };
  }
  if (!shouldScoutIntent(userText)) {
    return { messages, meta: { triggered: false, sourceCount: 0, cacheHit: false, status: 'NOT_NEEDED', errors: [] } };
  }
  if ((process.env.ORANGE5_CURRENT_AWARENESS === '0' || process.env.NODE_ENV === 'test') && !deps.awarenessRunner) {
    return { messages, meta: { triggered: true, sourceCount: 0, cacheHit: false, status: 'DISABLED', errors: [] } };
  }
  const runner = deps.awarenessRunner || getCurrentAwareness;
  try {
    const awareness = await runner({ query: userText, project, budgetMs: 60_000, briefBytes: 1_400 });
    const frame = awareness.brief
      ? [{ role: 'system', content: awareness.brief }]
      : [];
    return {
      messages: [...frame, ...messages],
      meta: {
        triggered: true,
        sourceCount: awareness.sourceCount || 0,
        cacheHit: awareness.cacheHit === true,
        status: awareness.status || 'UNKNOWN',
        generatedAt: awareness.generatedAt || null,
        expiresAt: awareness.expiresAt || null,
        sha256: awareness.sha256 || null,
        registryPath: awareness.registryPath || null,
        evidenceArtifactPath: awareness.evidenceArtifactPath || null,
        opportunities: (awareness.opportunities || []).slice(0, 3).map((item) => ({ title: item.title, url: item.url, score: item.score, nextGate: item.nextGate })),
        compression: awareness.compression || null,
        errors: awareness.errors || [],
      },
    };
  } catch (error) {
    return { messages, meta: { triggered: true, sourceCount: 0, cacheHit: false, status: 'SCOUT_ERROR', errors: [error?.message || String(error)] } };
  }
}

export async function prepareChatTurn(body, orderId, deps = {}) {
  const userText = latestUserText(body?.messages);
  const action = compileChatOrder({ messages: body?.messages || [], ae_order_id: orderId }).action;
  const internalRefuter = deps.internalRefuter === true;
  const reflex = deps.reflex === true;
  const isolatedProof = internalRefuter;
  const project = readProjectLock();
  const workObject = compileProblem({
    intent: userText,
    targetProject: body?.ae_target_project || project?.project?.name || 'orange5',
  }, {
    project: body?.ae_target_project || project?.project?.name || 'orange5',
    authority: 'operator',
    owner: 'orangebrain',
  });
  // A deterministic reflex answer does not consume project, memory, or current-
  // awareness text. The project lock still governs and is recorded in the
  // receipt, but hydrating it into a model prompt would be pure wasted work.
  const locked = reflex || isolatedProof
    ? { messages: structuredClone(body?.messages || []) }
    : injectProjectCrystal(body?.messages || [], project, userText);
  const continuity = reflex || isolatedProof
    ? { messages: locked.messages, meta: { available: true, stale: false, hits: [], reason: isolatedProof ? 'isolated refuter uses the supplied claim packet only' : 'not needed for deterministic reflex', duplicate_sensitive: false, existing_lineage_found: false, training_lineage_found: false, training_paths: [] } }
    : injectContinuity(locked.messages, userText, deps);
  const failure = reflex || isolatedProof
    ? { messages: continuity.messages, meta: { active: false, action, count: 0, patterns: [], recommendedAction: null, reason: isolatedProof ? 'isolated refuter cannot inherit prior verdicts' : 'not needed for deterministic reflex' } }
    : injectFailureMemory(continuity.messages, action, deps);
  const awareness = reflex || isolatedProof
    ? { messages: failure.messages, meta: { triggered: false, sourceCount: 0, cacheHit: false, status: isolatedProof ? 'NOT_NEEDED_ISOLATED_PROOF' : 'NOT_NEEDED_REFLEX', errors: [] } }
    : await injectAwareness(failure.messages, userText, project, deps);
  const memory = reflex || isolatedProof
    ? { body: { ...structuredClone(body), messages: awareness.messages }, meta: { bytes: 0, sources: [], recallTags: [], notes: [isolatedProof ? 'isolated refuter: supplied evidence is the complete workset' : 'least-action reflex: memory hydration not required'], compression: [] } }
    : await injectMemory({ ...body, messages: awareness.messages });
  const injectedMemoryCount = Math.max(0, (memory.body?.messages?.length || 0) - awareness.messages.length);
  const governedEvidence = reflex || isolatedProof ? {
    schema: 'orange.governed-chat-evidence.v1', items: [], citations: [],
  } : compileGovernedChatEvidence({
    userText,
    projectSources: locked.evidenceSources || [],
    projectSelected: locked.crystal?.selected || [],
    memoryMessages: (memory.body?.messages || []).slice(0, injectedMemoryCount),
  });
  const order = {
    id: orderId,
    orderId,
    schema: 'orange.order.v1',
    action,
    intent: userText.slice(0, 512),
    targetProject: body?.ae_target_project || project?.project?.name || 'OrangeFive',
    payload: {
      message_sha256: sha256(userText),
      requested_model: body?.model || 'orange-auto',
      execution_requested: executionRequested(userText),
      message_count: Array.isArray(body?.messages) ? body.messages.length : 0,
      project_lock_active: project?.active === true,
      project_lock_sha256: project?.sha256 || null,
      project_root: project?.project?.root || null,
      current_awareness_triggered: awareness.meta.triggered,
      current_awareness_status: awareness.meta.status,
      current_awareness_sources: awareness.meta.sourceCount,
      current_awareness_sha256: awareness.meta.sha256 || null,
      internal_refuter: internalRefuter,
      deterministic_reflex: reflex,
      continuity_available: continuity.meta?.available === true,
      continuity_hits: continuity.meta?.hits?.length || 0,
      duplicate_sensitive: continuity.meta?.duplicate_sensitive === true,
      existing_lineage_found: continuity.meta?.existing_lineage_found === true,
      training_lineage_found: continuity.meta?.training_lineage_found === true,
      failure_memory_active: failure.meta?.active === true,
      prior_failure_count: failure.meta?.count || 0,
      prior_failure_classes: (failure.meta?.patterns || []).map((item) => item.failureClass),
      resolved_failure_count: failure.meta?.resolvedCount || 0,
      failure_last_resolution_at: failure.meta?.lastResolutionAt || null,
      governed_context_evidence_count: governedEvidence.items.length,
      governed_context_evidence_sha256: governedEvidence.items.length ? sha256(JSON.stringify(governedEvidence.items)) : null,
      work_object: workObject,
      work_object_air: renderWorkObjectAir(workObject),
      work_object_hash: workObject.compilationHash,
    },
  };
  const preflight = runOrder(order, {
    dryRun: true,
    lease: { id: 'orangebrain-chat-preflight', allowed: [action], forbidden: [], requires_approval: false },
    topologyFn: internalRefuter ? internalRefuterTopology : advisoryChatTopology,
  });
  return { order, workObject, userText, body: memory.body, memory: memory.meta, awareness: awareness.meta, continuity: continuity.meta, failure: failure.meta, project, projectCrystal: locked.crystal || null, governedEvidence, preflight };
}

export async function finalizeChatTurn({
  turn,
  completion,
  tier,
  model,
  host,
  requestedTier = tier,
  routeMode = 'specialist',
  requestedModel = model,
  requestedHost = host,
  requestedNode = requestedHost,
  effectiveNode = host,
}) {
  const choice = completion?.choices?.[0];
  const message = choice?.message || {};
  const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '');
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls.length : 0;
  const executionRequired = turn.order.payload.execution_requested === true;
  const completed = completion && !completion.error;

  const receiptTask = receiptQueue.then(() => {
    const chainPath = process.env.ORANGE5_CHAT_RECEIPT_PATH || DEFAULT_CHAIN;
    const chain = RECEIPTS_ENABLED ? loadChain(chainPath) : [];
    const beforeLength = chain.length;
    const governed = runOrder(turn.order, {
      receiptChain: chain,
      lease: { id: 'orangebrain-chat', allowed: [turn.order.action], forbidden: [], requires_approval: false },
      epistemicMode: 'advisory',
      routerFn: () => advisoryChatRouter(tier, model),
      topologyFn: turn.order.payload.internal_refuter === true ? internalRefuterTopology : advisoryChatTopology,
      executor: () => ({
        ok: completed,
        // A model/reflex may complete a cognitive report, but no external
        // mutation or tool action occurred in this chat-only executor.
        executed: false,
        status: completed ? 'completed' : 'needs_action',
          summary: completed
          ? `OrangeBrain completed a governed chat turn via ${tier}${requestedTier !== tier ? ` (requested ${requestedTier})` : ''}`
          : `OrangeBrain chat turn failed via ${tier}${requestedTier !== tier ? ` (requested ${requestedTier})` : ''}`,
        lane: tier,
        model: model || null,
        host: host || null,
        output: { response_sha256: sha256(content), finish_reason: choice?.finish_reason || null, tool_calls: toolCalls },
        evidence: {
          execution: completed ? 'cognitive_report_completed' : 'not_performed',
          memory_bytes: turn.memory.bytes || 0,
          memory_sources: turn.memory.sources || [],
          tool_evidence: toolCalls > 0,
          mutation_proven: executionRequired ? false : null,
          project_lock_active: turn.project?.active === true,
          project_lock_sha256: turn.project?.sha256 || null,
          project_root: turn.project?.project?.root || null,
          current_awareness_triggered: turn.awareness?.triggered === true,
          current_awareness_status: turn.awareness?.status || 'NOT_NEEDED',
          current_awareness_sources: turn.awareness?.sourceCount || 0,
           current_awareness_sha256: turn.awareness?.sha256 || null,
           continuity_available: turn.continuity?.available === true,
           continuity_hits: turn.continuity?.hits?.length || 0,
           existing_lineage_found: turn.continuity?.existing_lineage_found === true,
           training_lineage_found: turn.continuity?.training_lineage_found === true,
           failure_memory_active: turn.failure?.active === true,
           prior_failure_count: turn.failure?.count || 0,
           prior_failure_classes: (turn.failure?.patterns || []).map((item) => item.failureClass),
           failure_resolution_count: turn.failure?.resolvedCount || 0,
           failure_last_resolution_at: turn.failure?.lastResolutionAt || null,
           failure_recurrence_intervention: turn.context?.recurrence_guard || null,
           requested_tier: requestedTier,
           execution_tier: tier,
           route_mode: routeMode,
           requested_model: requestedModel || null,
           effective_model: model || null,
           requested_node: requestedNode || null,
           effective_node: effectiveNode || null,
        },
      }),
    });
    const receipt = RECEIPTS_ENABLED ? persistNewReceipt(chainPath, beforeLength, chain) : governed.receipt;
    return { governed, receipt, receiptPath: RECEIPTS_ENABLED ? chainPath : null };
  });
  receiptQueue = receiptTask.then(() => undefined, () => undefined);
  const result = await receiptTask;

  const reflexCrystallized = routeMode === 'deterministic_reflex';
  const internalRefuterProof = turn.order.payload.internal_refuter === true;
  const learningSkipReason = internalRefuterProof
    ? 'internal refuter proof is already bound to its parent turn; duplicate learning is suppressed'
    : (reflexCrystallized ? 'deterministic reflex is already crystallized; repeated learning would be duplicate waste' : null);
  let assistantReport = null;
  try { assistantReport = JSON.parse(content); } catch { /* native specialist text */ }
  const completionError = completion?.error && typeof completion.error === 'object' ? completion.error : null;
  let learning = {
    requested: false,
    queued: false,
    ingested: false,
    queueId: null,
    transport: null,
    memoryId: null,
    error: null,
    skippedReason: learningSkipReason,
  };
  if (RECEIPTS_ENABLED && process.env.ORANGE5_CHAT_LEARNING !== '0' && result.receipt && !reflexCrystallized && !internalRefuterProof) {
    learning.requested = true;
    try {
      const queued = enqueueLearningReceipt({
        ...result.receipt,
        action: turn.order.action,
        status: assistantReport?.status || result.governed?.report?.status || (completed ? 'completed' : 'needs_action'),
        summary: assistantReport?.nextAction || completionError?.message || result.governed?.report?.summary || `OrangeBrain ${completed ? 'completed' : 'failed'} chat turn`,
        targetProject: turn.order.targetProject,
        receiptPath: result.receiptPath,
        blockers: assistantReport?.blockers || (completionError ? [completionError.code, completionError.detail?.status, completionError.message].filter(Boolean) : null) || result.governed?.report?.blockers || [],
      }, { cobraUrl: process.env.AE_COBRA_BASE || 'http://127.0.0.1:7419' });
      learning = {
        requested: true,
        queued: true,
        ingested: queued.status === 'completed',
        queueId: queued.item_id,
        transport: queued.status === 'completed' ? queued.result?.transport || null : 'durable-sqlite-queue',
        memoryId: queued.status === 'completed' ? queued.result?.id || queued.result?.hash?.slice(0, 12) || null : null,
        error: queued.status === 'failed' ? queued.last_error : null,
        skippedReason: null,
      };
    } catch (error) {
      learning.error = error?.message || String(error);
    }
  }

  let continuityRecord = {
    recorded: false,
    reason: internalRefuterProof
      ? 'internal refuter proof is already represented by its parent turn; duplicate continuity is suppressed'
      : (RECEIPTS_ENABLED ? null : 'receipts disabled'),
  };
  if (RECEIPTS_ENABLED && !internalRefuterProof) {
    try {
      let assistantReportStatus = null;
      try { assistantReportStatus = JSON.parse(content)?.status || null; } catch { /* non-report specialist output */ }
      continuityRecord = recordContinuityTurn({
        orderId: turn.order.orderId,
        userText: turn.userText,
        assistantText: content,
        route: {
          requested_tier: requestedTier,
          execution_tier: tier,
          route_mode: routeMode,
          requested_model: requestedModel || null,
          effective_model: model || null,
          requested_node: requestedNode || null,
          effective_node: effectiveNode || null,
        },
        receipt: result.receipt ? { id: result.receipt.receipt_id, seq: result.receipt.seq, hash: result.receipt.hash, path: result.receiptPath } : null,
        status: assistantReportStatus || result.governed?.report?.status || (completed ? 'completed' : 'needs_action'),
      });
    } catch (error) {
      continuityRecord = { recorded: false, reason: error?.message || String(error) };
    }
  }

  return {
    schema: 'orange.chat-turn.v1',
    order_id: turn.order.orderId,
    action: turn.order.action,
    execution_requested: executionRequired,
    execution_performed: false,
    tool_calls: toolCalls,
    memory: {
      bytes: turn.memory.bytes || 0,
      sources: turn.memory.sources || [],
      recall_tags: turn.memory.recallTags || [],
      compression: Array.isArray(turn.memory.compression) ? turn.memory.compression.map((item) => ({
        workset_id: item.worksetId || null,
        raw_bytes: item.rawBytes || 0,
        hot_bytes: item.hotBytes || 0,
        saved_bytes: item.savedBytes || 0,
        input_items: item.inputItems || 0,
        kept_items: item.keptItems || 0,
        dropped_items: item.droppedItems || 0,
        warnings: item.warnings || [],
      })) : [],
    },
    prompt_budget: turn.context || null,
    project: turn.project?.active ? {
      name: turn.project.project?.name || null,
      root: turn.project.project?.root || null,
      goal: turn.project.goal || null,
      lock_sha256: turn.project.sha256 || null,
    } : null,
    project_context: turn.projectCrystal ? {
      schema: turn.projectCrystal.schema || null,
      crystal_id: turn.projectCrystal.crystal_id || null,
      proof: turn.projectCrystal.proof || null,
      metrics: turn.projectCrystal.metrics || null,
      error: turn.projectCrystal.error || null,
    } : null,
    governed_context_evidence: turn.governedEvidence || { schema: 'orange.governed-chat-evidence.v1', items: [], citations: [] },
    continuity: {
      available: turn.continuity?.available === true,
      stale: turn.continuity?.stale === true,
      duplicate_sensitive: turn.continuity?.duplicate_sensitive === true,
      existing_lineage_found: turn.continuity?.existing_lineage_found === true,
      training_lineage_found: turn.continuity?.training_lineage_found === true,
      training_paths: turn.continuity?.training_paths || [],
      source_paths: (turn.continuity?.hits || []).map((hit) => hit.path),
      reason: turn.continuity?.reason || null,
      turn_record: continuityRecord,
    },
    failure_memory: {
      active: turn.failure?.active === true,
      action: turn.failure?.action || turn.order.action,
      prior_failure_count: turn.failure?.count || 0,
      classes: (turn.failure?.patterns || []).map((item) => item.failureClass),
      resolved_count: turn.failure?.resolvedCount || 0,
      last_resolution_at: turn.failure?.lastResolutionAt || null,
      last_resolution_disposition: turn.failure?.lastResolutionDisposition || null,
      recurrence_guard: turn.failure?.recommendedAction || null,
      intervention: turn.context?.recurrence_guard || null,
      error: turn.failure?.error || null,
    },
    current_awareness: {
      triggered: turn.awareness?.triggered === true,
      status: turn.awareness?.status || 'NOT_NEEDED',
      source_count: turn.awareness?.sourceCount || 0,
      cache_hit: turn.awareness?.cacheHit === true,
      generated_at: turn.awareness?.generatedAt || null,
      expires_at: turn.awareness?.expiresAt || null,
      sha256: turn.awareness?.sha256 || null,
      opportunities: turn.awareness?.opportunities || [],
      compression: turn.awareness?.compression || null,
      errors: turn.awareness?.errors || [],
    },
    learning,
    governance: {
      status: result.governed?.status || null,
      report_status: result.governed?.report?.status || null,
      summary: result.governed?.report?.summary || null,
      topology: result.governed?.topology?.topology || null,
      adversarial_required: result.governed?.topology?.adversarialRequired === true,
      execution_performed: result.governed?.receipt?.executed === true,
    },
    compression: result.governed?.mediation?.compression || null,
    route: {
      lane: tier,
      requested_tier: requestedTier,
      execution_tier: tier,
      route_mode: routeMode,
      requested_model: requestedModel || null,
      effective_model: model || null,
      requested_host: requestedHost || null,
      effective_host: host || null,
      requested_node: requestedNode || null,
      effective_node: effectiveNode || null,
      model: model || null,
      host: host || null,
    },
    receipt: result.receipt ? { id: result.receipt.receipt_id, seq: result.receipt.seq, hash: result.receipt.hash, path: result.receiptPath } : null,
    claim_policy: executionRequired
      ? 'chat output is guidance until a governed tool or Hermes receipt proves mutation'
      : 'cognitive response receipted',
  };
}

export const __turnHarnessInternals = Object.freeze({ executionRequested, latestUserText, sha256, injectAwareness, injectContinuity, injectFailureMemory, injectProjectCrystal, estimatePromptTokens, truncateFrame, loadChain, SPINE_GENESIS, advisoryChatTopology, advisoryChatRouter });
