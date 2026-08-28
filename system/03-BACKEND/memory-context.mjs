import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

export function buildMemoryContext(preflight = {}) {
  const candidates = Array.isArray(preflight.mistakes) ? preflight.mistakes : [];
  const relevance = selectRelevantMistakes(candidates, preflight.order || preflight.query || null);
  const mistakes = relevance.injected.slice(0, 5);
  const records = mistakes.map((item) => {
    const rawSummary = item.summary || item.body?.summary || '';
    const summary = compactText(rawSummary, 360);
    const sourcePointer = compactSourcePointer(item, rawSummary);
    return {
      id: item.id || item.receipt_id || item.hash?.slice?.(0, 12) || null,
      lane: item.lane || null,
      kind: item.kind || null,
      summary,
      action: compactText(item.action || item.body?.action, 160) || null,
      receiptId: item.receipt_id || item.body?.receipt_id || null,
      sourceFile: sourcePointer?.path || null,
      sourcePointer,
      decisionReason: extractField(summary, 'decision_reason'),
      debtType: extractField(summary, 'debt_type'),
    };
  });
  const prior = preflight.prior && preflight.prior.verdict !== 'NO_PRIOR'
    ? {
        verdict: preflight.prior.verdict,
        advice: preflight.prior.advice || null,
        penalty: preflight.prior.penalty ?? null,
      }
    : null;
  const project = compactProject(preflight.project);
  return {
    schema: 'orange.memory-context.v1',
    law: 'Use prior evidence to avoid repeated failures. Do not claim the current task is complete because a prior task completed.',
    mistakeCount: records.length,
    suppressedMistakeCount: relevance.suppressed.length,
    mistakes: records,
    project,
    epistemicPrior: prior,
    retrieval: {
      sourceOfTruth: 'ae-cobra-flux',
      sqliteProjection: 'graph-weaver-derived',
      fullBodiesInjected: false,
      hydrateFromSourcePointers: true,
      candidatesConsidered: candidates.length,
      relevantMatches: relevance.injected.length,
      suppressedMatches: relevance.suppressed.length,
      suppressionReasons: countReasons(relevance.suppressed),
    },
  };
}

export function memoryContextEvidence(context) {
  const evidence = {
    schema: context.schema,
    mistakeCount: context.mistakeCount,
    suppressedMistakeCount: context.suppressedMistakeCount || 0,
    sourceIds: context.mistakes.map((item) => item.id || item.receiptId).filter(Boolean),
    project: context.project?.name || null,
    projectRecords: context.project?.records?.length || 0,
    priorVerdict: context.epistemicPrior?.verdict || null,
  };
  if (context.project?.conflicts?.length) evidence.conflictCount = context.project.conflicts.length;
  if (context.project?.openDebtCount) evidence.openDebtCount = context.project.openDebtCount;
  if (context.project?.decisions?.length) evidence.decisionReasons = context.project.decisions.length;
  const citations = collectSourcePointers(context);
  if (citations.length) evidence.sourceCitationCount = citations.length;
  return evidence;
}

export function selectRelevantMistakes(items = [], query = null) {
  if (!query || typeof query !== 'object') return { injected: [...items], suppressed: [] };
  const action = normalizeAction(query.action || query.kind);
  const intent = compactText(query.intent || query.payload?.intent || query.payload?.text, 2_000);
  const targetProject = normalizeProject(query.targetProject || query.target_project || query.payload?.targetProject);
  const failureClass = normalizeFailureClass(query.failureClass || query.failure_class || query.payload?.failureClass);
  const hasContext = Boolean(intent || targetProject || failureClass);
  if (!action || !hasContext) return { injected: [...items], suppressed: [] };

  const injected = [];
  const suppressed = [];
  for (const item of items) {
    const verdict = mistakeRelevance(item, { action, intent, targetProject, failureClass });
    if (verdict.relevant) injected.push({ ...item, relevance: verdict });
    else suppressed.push({ item, reason: verdict.reason });
  }
  return { injected, suppressed };
}

function mistakeRelevance(item = {}, query) {
  const observedAction = normalizeAction(
    item.action || item.body?.action || extractAction(item.kind) || extractAction(item.origin)
      || (item.entities || []).map(extractAction).find(Boolean) || extractField(item.summary, 'action'),
  );
  const actionExact = observedAction === query.action;
  const actionFamilyMatch = !actionExact && actionFamily(observedAction) === actionFamily(query.action);
  if (!actionExact && !actionFamilyMatch) return { relevant: false, score: 0, reason: 'action_mismatch' };

  const observedProject = normalizeProject(
    item.targetProject || item.target_project || item.body?.targetProject || item.body?.target_project
      || extractField(item.summary, 'target_project'),
  );
  if (query.targetProject && observedProject && query.targetProject !== observedProject) {
    return { relevant: false, score: 0, reason: 'project_mismatch' };
  }
  const projectMatch = Boolean(query.targetProject && observedProject === query.targetProject);

  const intentTokens = tokenSet(query.intent);
  const surfaceTokens = tokenSet([
    item.summary, item.body?.summary, item.next_action, item.body?.next_action,
    ...(Array.isArray(item.entities) ? item.entities : []),
  ].filter(Boolean).join(' '));
  const sharedIntentTerms = [...intentTokens].filter((token) => surfaceTokens.has(token));
  const intentMatch = sharedIntentTerms.length > 0;

  const observedFailure = normalizeFailureClass(
    item.failureClass || item.failure_class || item.body?.failureClass || item.body?.failure_class
      || extractField(item.summary, 'failure_class'),
  );
  if (query.failureClass && observedFailure && query.failureClass !== observedFailure) {
    return { relevant: false, score: 0, reason: 'failure_class_mismatch' };
  }
  const failureClassMatch = Boolean(query.failureClass && observedFailure === query.failureClass);
  const supportingSignals = Number(projectMatch) + Number(intentMatch) + Number(failureClassMatch);
  const intentRequiredButMissing = Boolean(query.intent && !intentMatch && !failureClassMatch);
  const requiredSignals = actionExact ? 1 : 2;
  if (intentRequiredButMissing || supportingSignals < requiredSignals) {
    return {
      relevant: false,
      score: actionExact ? 0.45 : 0.25,
      reason: 'insufficient_context_overlap',
      sharedIntentTerms,
    };
  }
  return {
    relevant: true,
    score: Math.min(1, (actionExact ? 0.45 : 0.25) + (projectMatch ? 0.2 : 0)
      + (intentMatch ? 0.25 : 0) + (failureClassMatch ? 0.25 : 0)),
    actionExact,
    projectMatch,
    failureClassMatch,
    sharedIntentTerms,
  };
}

function countReasons(suppressed) {
  const counts = {};
  for (const row of suppressed) counts[row.reason] = (counts[row.reason] || 0) + 1;
  return counts;
}

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'before', 'by', 'do', 'for', 'from', 'in', 'is',
  'it', 'of', 'on', 'or', 'the', 'this', 'to', 'with', 'without', 'work', 'task', 'question',
  'answer', 'current', 'new', 'please', 'orange', 'orangefive',
]);

function tokenSet(value) {
  const tokens = String(value || '').toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) || [];
  return new Set(tokens.map(stemToken).filter((token) => token && !STOP_WORDS.has(token)));
}

function stemToken(token) {
  if (token.length > 6 && token.endsWith('ing')) return token.slice(0, -3);
  if (token.length > 5 && token.endsWith('ed')) return token.slice(0, -2);
  if (token.length > 5 && token.endsWith('s')) return token.slice(0, -1);
  return token;
}

function extractAction(value) {
  const text = String(value || '');
  return text.match(/(?:^|[:;\s])([a-z][a-z0-9_-]*\.[a-z0-9_.-]+)/i)?.[1] || null;
}

function normalizeAction(value) { return String(value || '').trim().toLowerCase(); }
function actionFamily(value) { return normalizeAction(value).split(/[.:/]/)[0] || ''; }
function normalizeProject(value) { return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, ''); }
function normalizeFailureClass(value) { return String(value || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, ''); }

export function buildModelMemoryBrief(context = {}, { includeMistake = true } = {}) {
  const actionableMistake = includeMistake && Array.isArray(context.mistakes)
    ? context.mistakes.find((item) => !/OrangeBrain unreachable|operation timed out|transport timeout/i.test(item.summary || ''))
    : null;
  const latestMistake = actionableMistake?.summary || null;
  const projectRecords = Array.isArray(context.project?.records)
    ? context.project.records.slice(0, 3).map((item) => item.summary).filter(Boolean)
    : [];
  const conflicts = Array.isArray(context.project?.conflicts)
    ? context.project.conflicts.slice(0, 3).map((item) => ({
        id: item.id, summary: item.summary, sourceFile: item.sourceFile,
      }))
    : [];
  const decisions = Array.isArray(context.project?.decisions)
    ? context.project.decisions.slice(0, 3)
    : [];
  const sourcePointers = collectSourcePointers(context).slice(0, 8);
  return {
    schema: 'orange.memory-brief.v1',
    law: 'Use recalled evidence to avoid repeated failure; never infer current completion from prior completion.',
    latestMistake,
    project: context.project?.name || null,
    projectRecords,
    conflicts,
    openDebtCount: context.project?.openDebtCount || 0,
    decisions,
    sourcePointers,
    priorVerdict: context.epistemicPrior?.verdict || null,
  };
}

function compactProject(project) {
  if (!project || project.ok === false) return null;
  const rows = [...(project.reality || []), ...(project.thought || [])]
    .sort((a, b) => (b.ts || 0) - (a.ts || 0))
    .slice(0, 8)
    .map((item) => {
      const rawSummary = item.summary || '';
      const summary = compactText(rawSummary, 360);
      const sourcePointer = compactSourcePointer(item, rawSummary);
      return {
      id: item.receipt_id || null,
      ts: item.ts || null,
      lane: item.lane || null,
      summary,
      nextAction: compactText(item.next_action, 240) || null,
      risk: item.risk || null,
      sourceFile: sourcePointer?.path || null,
      sourcePointer,
      decisionReason: extractField(rawSummary, 'decision_reason'),
      action: extractField(rawSummary, 'action'),
      outcome: extractField(rawSummary, 'outcome'),
      debtId: extractField(rawSummary, 'debt_id'),
      debtType: extractField(rawSummary, 'debt_type'),
      debtStatus: extractField(rawSummary, 'debt_status'),
      };
    });
  const conflicts = (project.conflicts || []).slice(0, 3).map((item) => ({
    id: item.receipt_id || null,
    summary: compactText(item.summary, 360),
    nextAction: compactText(item.next_action, 240) || null,
    sourceFile: compactSourcePointer(item, item.summary)?.path || null,
    sourcePointer: compactSourcePointer(item, item.summary),
  }));
  const decisions = rows
    .filter((item) => item.decisionReason)
    .slice(0, 3)
    .map((item) => ({ id: item.id, reason: item.decisionReason, sourcePointer: item.sourcePointer }));
  const sourcePointers = rows
    .filter((item) => item.sourcePointer)
    .slice(0, 8)
    .map((item) => ({ ...item.sourcePointer, receiptId: item.id }));
  const latestOutcomeByAction = new Map();
  const debtStates = new Map();
  for (const item of rows) {
    if (item.action && ['success', 'guarded_stop'].includes(item.outcome) && !latestOutcomeByAction.has(item.action)) {
      latestOutcomeByAction.set(item.action, item);
    }
    const debtKey = item.debtId && item.debtId !== 'none'
      ? item.debtId
      : (item.debtType && item.debtType !== 'none' ? `${item.debtType}:${item.action || 'unknown'}:${item.id || item.ts}` : null);
    if (debtKey && !debtStates.has(debtKey)) debtStates.set(debtKey, item);
  }
  const openDebtCount = [...debtStates.values()].filter((item) => {
    if (item.debtStatus === 'resolved') return false;
    if (item.debtType !== 'execution_failure' || !item.action) return true;
    const resolution = latestOutcomeByAction.get(item.action);
    return !resolution || Number(resolution.ts) <= Number(item.ts);
  }).length;
  return {
    name: project.project || null,
    found: project.found === true,
    latestIsHypothesis: project.latest_is_hypothesis === true,
    records: rows,
    openThreads: (project.open_threads || []).slice(0, 3).map((item) => ({
      summary: compactText(item.summary, 300), nextAction: compactText(item.next_action, 220) || null,
    })),
    conflictCount: project.conflicts?.length || 0,
    conflicts,
    openDebtCount,
    decisions,
    sourcePointers,
  };
}

function compactText(value, max) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function extractField(value, field) {
  const match = new RegExp(`(?:^|;)\\s*${field}=([^;]+)`, 'i').exec(String(value || ''));
  return match ? compactText(match[1], 300) : null;
}

function compactSourcePointer(item = {}, summary = '') {
  const direct = item.sourcePointer || item.source_pointer || item.sourcePointers?.[0]
    || item.source_pointers?.[0] || item.body?.sourcePointers?.[0] || item.body?.source_pointers?.[0] || {};
  const path = compactText(direct.path || direct.source_path || extractField(summary, 'source_path') || item.files?.[0] || item.body?.files?.[0], 600);
  if (!path) return null;
  const sha256 = compactText(direct.sha256 || direct.hash || extractField(summary, 'source_sha256'), 128) || null;
  const offsetValue = direct.offset ?? numericField(summary, 'source_offset');
  const lineValue = direct.line ?? numericField(summary, 'source_line');
  const endLineValue = direct.end_line ?? direct.endLine ?? numericField(summary, 'source_end_line');
  return {
    kind: compactText(direct.kind || 'receipt', 80),
    path,
    sha256,
    offset: offsetValue != null && Number.isFinite(Number(offsetValue)) ? Number(offsetValue) : null,
    line: lineValue != null && Number.isFinite(Number(lineValue)) ? Number(lineValue) : null,
    endLine: endLineValue != null && Number.isFinite(Number(endLineValue)) ? Number(endLineValue) : null,
  };
}

function numericField(value, field) {
  const parsed = Number(extractField(value, field));
  return Number.isFinite(parsed) ? parsed : null;
}

function collectSourcePointers(context = {}) {
  const values = [
    ...(Array.isArray(context.mistakes) ? context.mistakes.map((item) => item.sourcePointer) : []),
    ...(Array.isArray(context.project?.sourcePointers) ? context.project.sourcePointers : []),
  ].filter(Boolean);
  const seen = new Set();
  return values.filter((pointer) => {
    const key = `${pointer.path}|${pointer.sha256 || ''}|${pointer.offset ?? ''}|${pointer.line ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export const SOURCE_BACKED_WORKBENCH_SCHEMA = 'orange5.source-backed-workbench.v1';

const WORKBENCH_WEIGHTS = Object.freeze({
  lexical: 0.22,
  semantic: 0.22,
  project: 0.16,
  authority: 0.18,
  recency: 0.12,
  contradiction: 0.10,
});

const AUTHORITY_SCORES = Object.freeze({
  'live-probe': 1,
  receipt: 0.9,
  test: 0.8,
  source: 0.7,
  'immutable-source': 0.7,
  transcript: 0.55,
  memory: 0.45,
});

function workbenchHash(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function score01(value, fallback = 0) {
  const score = Number(value);
  return Number.isFinite(score) ? Math.min(1, Math.max(0, score)) : fallback;
}

function rounded(value) {
  return Number(Number(value || 0).toFixed(4));
}

function sourceFileHash(filePath) {
  const hash = createHash('sha256');
  const handle = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    let offset = 0;
    let bytesRead;
    while ((bytesRead = fs.readSync(handle, buffer, 0, buffer.length, offset)) > 0) {
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
  } finally {
    fs.closeSync(handle);
  }
  return hash.digest('hex');
}

function normalizeWorkbenchSource(value = {}) {
  const sourcePath = compactText(value.path || value.source_path || value.sourcePath, 2_048);
  const sha256 = compactText(value.sha256 || value.hash, 128).toLowerCase();
  if (!sourcePath || !/^[a-f0-9]{64}$/.test(sha256)) return { ok: false, reason: 'source_pointer_incomplete' };
  if (value.authorized !== true) return { ok: false, reason: 'source_not_authorized' };
  const resolvedPath = path.resolve(sourcePath);
  let stat;
  try {
    stat = fs.statSync(resolvedPath);
    if (!stat.isFile() || sourceFileHash(resolvedPath) !== sha256) {
      return { ok: false, reason: 'source_hash_unverified' };
    }
  } catch {
    return { ok: false, reason: 'source_hash_unverified' };
  }
  const offset = value.offset === null || value.offset === undefined ? null : Number(value.offset);
  const byteCount = value.bytes === null || value.bytes === undefined ? null : Number(value.bytes);
  if ((offset !== null && (!Number.isSafeInteger(offset) || offset < 0))
    || (byteCount !== null && (!Number.isSafeInteger(byteCount) || byteCount < 0))
    || (offset !== null && offset > stat.size)
    || (offset !== null && byteCount !== null && offset + byteCount > stat.size)) {
    return { ok: false, reason: 'source_pointer_invalid_range' };
  }
  const optionalHashes = {
    event_sha256: compactText(value.event_sha256, 128).toLowerCase() || null,
    text_sha256: compactText(value.text_sha256, 128).toLowerCase() || null,
    authority_hash: compactText(value.authority_hash || value.authorityHash, 128).toLowerCase() || null,
    retention_hash: compactText(value.retention_hash || value.retentionHash, 128).toLowerCase() || null,
  };
  if (Object.values(optionalHashes).some((hash) => hash !== null && !/^[a-f0-9]{64}$/.test(hash))) {
    return { ok: false, reason: 'source_pointer_invalid_hash' };
  }
  return {
    ok: true,
    source: {
      kind: compactText(value.kind || 'file', 80),
      path: resolvedPath,
      sha256,
      offset,
      bytes: byteCount,
      event_sha256: optionalHashes.event_sha256,
      text_sha256: optionalHashes.text_sha256,
      source_id: compactText(value.source_id || value.sourceId, 240) || null,
      json_pointer: compactText(value.json_pointer || value.jsonPointer, 240) || null,
      authority_hash: optionalHashes.authority_hash,
      retention_hash: optionalHashes.retention_hash,
      verification: { algorithm: 'sha256', scope: 'file', matched: true },
      authorized: true,
      verified: true,
    },
  };
}

function claimText(value) {
  if (typeof value === 'string') return compactText(value, 2_000);
  if (value === null || value === undefined) return '';
  try { return compactText(JSON.stringify(value), 2_000); }
  catch { return compactText(String(value), 2_000); }
}

function lexicalSignal(task, content) {
  const query = tokenSet(task);
  const body = tokenSet(content);
  const matched = [...query].filter((term) => body.has(term)).sort();
  return { score: rounded(matched.length / Math.max(1, query.size)), matched_terms: matched.slice(0, 16) };
}

function semanticSignal(candidate) {
  const supplied = candidate.semantic_score ?? candidate.semanticScore ?? candidate.retrieval?.semantic_score;
  return {
    score: score01(supplied, 0.5),
    provider: compactText(candidate.semantic_provider || candidate.retrieval?.semantic_provider, 120) || (supplied == null ? 'neutral-unsupplied' : 'candidate-supplied'),
  };
}

function authoritySignal(candidate) {
  const basis = compactText(candidate.authority_basis || candidate.evidence_type || candidate.source?.kind, 120).toLowerCase();
  const fallback = AUTHORITY_SCORES[basis] ?? (basis.includes('receipt') ? AUTHORITY_SCORES.receipt : AUTHORITY_SCORES.source);
  return { score: score01(candidate.authority_score ?? candidate.authorityScore, fallback), basis: basis || 'source' };
}

function recencySignal(observedAt, nowMs) {
  const observedMs = Date.parse(observedAt || '');
  if (!Number.isFinite(observedMs)) return { score: 0.5, observed_at: null, age_days: null, future_dated: false };
  const delta = nowMs - observedMs;
  if (delta < -300_000) return { score: 0, observed_at: new Date(observedMs).toISOString(), age_days: rounded(delta / 86_400_000), future_dated: true };
  const ageDays = Math.max(0, delta / 86_400_000);
  return {
    score: rounded(1 / (1 + ageDays / 30)),
    observed_at: new Date(observedMs).toISOString(),
    age_days: rounded(ageDays),
    future_dated: false,
  };
}

function projectSignal(candidateProject, targetProject) {
  const candidate = normalizeProject(candidateProject);
  const target = normalizeProject(targetProject);
  if (!target) return { score: 1, match: true, candidate: candidateProject || null, target: targetProject || null };
  if (!candidate) return { score: 0.5, match: null, candidate: null, target: targetProject };
  return { score: candidate === target ? 1 : 0, match: candidate === target, candidate: candidateProject, target: targetProject };
}

function supersessionList(candidate) {
  const values = candidate.supersedes;
  return Array.isArray(values) ? [...new Set(values.map((value) => compactText(value, 240)).filter(Boolean))] : [];
}

function baseWorkbenchScore(signals) {
  return rounded(signals.lexical.score * WORKBENCH_WEIGHTS.lexical
    + signals.semantic.score * WORKBENCH_WEIGHTS.semantic
    + signals.project.score * WORKBENCH_WEIGHTS.project
    + signals.authority.score * WORKBENCH_WEIGHTS.authority
    + signals.recency.score * WORKBENCH_WEIGHTS.recency);
}

function compareWorkbenchCandidates(left, right) {
  return right.signals.authority.score - left.signals.authority.score
    || Number(right.observed_ms || 0) - Number(left.observed_ms || 0)
    || right.base_score - left.base_score
    || left.id.localeCompare(right.id);
}

function prepareWorkbenchCandidate(candidate, index, task, project, nowMs) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return { rejected: { id: `candidate-${index}`, reason: 'candidate_invalid' } };
  }
  const id = compactText(candidate.id || candidate.source_id || candidate.source?.source_id || `candidate-${index}`, 240);
  const content = String(candidate.content || candidate.summary || candidate.text || '').trim();
  if (!content) return { rejected: { id, reason: 'content_missing' } };
  const source = normalizeWorkbenchSource(candidate.source || candidate.source_pointer || {});
  if (!source.ok) return { rejected: { id, reason: source.reason } };
  const projectScore = projectSignal(candidate.project, project);
  if (projectScore.match === false) return { rejected: { id, reason: 'project_mismatch', source: source.source } };
  const recency = recencySignal(candidate.observed_at || candidate.observedAt || candidate.ts, nowMs);
  if (recency.future_dated) return { rejected: { id, reason: 'future_dated_source', source: source.source } };
  const signals = {
    lexical: lexicalSignal(task, content),
    semantic: semanticSignal(candidate),
    project: projectScore,
    authority: authoritySignal(candidate),
    recency,
  };
  const claim = claimText(candidate.claim ?? content);
  return {
    candidate: {
      id,
      content,
      project: candidate.project || null,
      claim_key: compactText(candidate.claim_key || candidate.claimKey, 240) || null,
      claim,
      claim_fingerprint: workbenchHash(claim.toLowerCase()),
      supersedes: supersessionList(candidate),
      source: source.source,
      retrieval: candidate.retrieval || null,
      signals,
      base_score: baseWorkbenchScore(signals),
      observed_ms: recency.observed_at ? Date.parse(recency.observed_at) : null,
      supersession: {
        state: 'current',
        basis: 'no-conflict',
        supersedes: supersessionList(candidate),
        superseded_by: null,
        conflicts_with: [],
      },
    },
  };
}

function supersessionClosure(candidate, byId) {
  const reached = new Set();
  const pending = [...candidate.supersedes];
  while (pending.length) {
    const id = pending.pop();
    if (reached.has(id) || !byId.has(id)) continue;
    reached.add(id);
    pending.push(...byId.get(id).supersedes);
  }
  return reached;
}

function contradictionDebts(candidates) {
  const groups = new Map();
  for (const candidate of candidates) {
    if (!candidate.claim_key) continue;
    const key = candidate.claim_key.toLowerCase();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(candidate);
  }
  const debts = [];
  for (const [claimKey, group] of groups) {
    const ordered = [...group].sort(compareWorkbenchCandidates);
    const variants = new Map();
    for (const candidate of ordered) {
      if (!variants.has(candidate.claim_fingerprint)) variants.set(candidate.claim_fingerprint, []);
      variants.get(candidate.claim_fingerprint).push(candidate);
    }
    if (variants.size < 2) continue;
    const byId = new Map(group.map((candidate) => [candidate.id, candidate]));
    for (const candidate of group) {
      candidate.supersession.conflicts_with = ordered
        .filter((other) => other.claim_fingerprint !== candidate.claim_fingerprint)
        .map((other) => other.id);
    }
    const explicitWinners = ordered.filter((candidate) => {
      const closure = supersessionClosure(candidate, byId);
      return candidate.supersession.conflicts_with.every((id) => {
        const conflicting = byId.get(id);
        const isNotOlder = !candidate.observed_ms || !conflicting?.observed_ms
          || candidate.observed_ms >= conflicting.observed_ms;
        return closure.has(id) && isNotOlder;
      });
    });
    const explicitVariants = new Set(explicitWinners.map((candidate) => candidate.claim_fingerprint));
    let winner = explicitVariants.size === 1 ? explicitWinners[0] : null;
    let resolutionBasis = winner ? 'explicit-supersession' : null;
    if (!winner && explicitVariants.size === 0) {
      const candidate = ordered[0];
      const conflicting = ordered.filter((item) => item.claim_fingerprint !== candidate.claim_fingerprint);
      const precedence = conflicting.every((item) => candidate.signals.authority.score > item.signals.authority.score
        && (!candidate.observed_ms || !item.observed_ms || candidate.observed_ms >= item.observed_ms));
      if (precedence) {
        winner = candidate;
        resolutionBasis = 'authority-recency';
      }
    }
    const resolved = Boolean(winner);
    const winningVariant = winner ? variants.get(winner.claim_fingerprint) : [];
    const losing = winner ? ordered.filter((item) => item.claim_fingerprint !== winner.claim_fingerprint) : [];
    if (resolved) {
      for (const item of winningVariant) {
        item.supersession.state = 'current';
        item.supersession.basis = item.id === winner.id ? resolutionBasis : 'agrees-with-current';
      }
      for (const item of losing) {
        item.supersession.state = 'superseded';
        item.supersession.basis = resolutionBasis;
        item.supersession.superseded_by = winner.id;
      }
    } else {
      for (const item of group) {
        item.supersession.state = 'contested';
        item.supersession.basis = 'unresolved-conflict';
      }
    }
    const candidateIds = ordered.map((item) => item.id).sort();
    const reason = resolved
      ? `${winner.id} establishes the current claim through ${resolutionBasis === 'explicit-supersession' ? 'explicit supersession' : 'authority and recency precedence'}.`
      : 'Conflicting source-backed claims remain without a decisive supersession edge.';
    debts.push({
      debt_id: `workbench_debt_${workbenchHash(`${claimKey}|${candidateIds.join('|')}`).slice(0, 32)}`,
      debt_type: 'memory_contradiction',
      status: resolved ? 'resolved' : 'open',
      claim_key: claimKey,
      reason,
      resolution: resolved ? `${winner.id} is current; ${losing.map((item) => item.id).join(', ')} retained as superseded evidence.` : null,
      resolution_basis: resolutionBasis,
      winner_id: resolved ? winner.id : null,
      contradicts: candidateIds,
      claim_variants: [...variants.values()].map((items) => ({
        claim: items[0].claim,
        claim_fingerprint: items[0].claim_fingerprint,
        candidate_ids: items.map((item) => item.id).sort(),
      })).sort((left, right) => left.claim_fingerprint.localeCompare(right.claim_fingerprint)),
      source_pointers: [...group].sort((left, right) => left.id.localeCompare(right.id)).map((item) => item.source),
    });
  }
  return debts;
}

function publicWorkbenchCandidate(candidate) {
  const contradictionScore = candidate.supersession.state === 'superseded'
    ? 0
    : candidate.supersession.state === 'contested' ? 0.5 : 1;
  const signals = {
    ...candidate.signals,
    contradiction: { score: contradictionScore, state: candidate.supersession.state },
  };
  const contributions = Object.fromEntries(Object.keys(WORKBENCH_WEIGHTS).map((name) => [
    name, rounded(signals[name].score * WORKBENCH_WEIGHTS[name]),
  ]));
  const total = rounded(Object.values(contributions).reduce((sum, value) => sum + value, 0));
  const confidence = rounded(Math.min(candidate.supersession.state === 'contested' ? 0.55 : 1, total));
  return {
    id: candidate.id,
    content: compactText(candidate.content, 1_200),
    project: candidate.project,
    claim_key: candidate.claim_key,
    claim: compactText(candidate.claim, 600),
    why: {
      signals,
      weights: WORKBENCH_WEIGHTS,
      contributions,
      formula: 'sum(signal.score * weight)',
      total_score: total,
      summary: [
        `lexical=${signals.lexical.score}`,
        `semantic=${signals.semantic.score}`,
        `project=${signals.project.score}`,
        `authority=${signals.authority.score}`,
        `recency=${signals.recency.score}`,
        `contradiction=${signals.contradiction.score}`,
      ].join('; '),
    },
    source: candidate.source,
    confidence,
    supersession: {
      state: candidate.supersession.state,
      basis: candidate.supersession.basis,
      claim_key: candidate.claim_key,
      supersedes: candidate.supersession.supersedes,
      superseded_by: candidate.supersession.superseded_by,
      conflicts_with: candidate.supersession.conflicts_with,
    },
  };
}

function transcriptCandidate(hit, hydrated) {
  const metadata = hit.workbench && typeof hit.workbench === 'object' && !Array.isArray(hit.workbench) ? hit.workbench : hit;
  return {
    id: `transcript:${hydrated.id}`,
    content: hydrated.content,
    project: metadata.project || null,
    semantic_score: metadata.semantic_score ?? metadata.semanticScore,
    semantic_provider: metadata.semantic_provider || 'superdirectory-fts',
    authority_score: metadata.authority_score ?? metadata.authorityScore ?? AUTHORITY_SCORES.transcript,
    authority_basis: metadata.authority_basis || 'transcript',
    observed_at: metadata.observed_at || metadata.observedAt || hydrated.ts,
    claim_key: metadata.claim_key || metadata.claimKey || null,
    claim: metadata.claim || hydrated.content,
    supersedes: metadata.supersedes || [],
    source: hydrated.source,
    retrieval: { provider: 'superdirectory-fts', rank: hit.rank ?? null },
  };
}

export async function buildSourceBackedWorkbench({
  task,
  project = null,
  candidates = [],
  sourceViewStore = null,
  sourceViewAccess = null,
  sourceViewQuery = null,
  sourceViewLimit = 12,
  transcriptHits = [],
  transcriptRoot = null,
  numericSeries = [],
  budgetBytes = 6_000,
  limit = 8,
  requiredSourceIds = [],
  now = Date.now(),
  debtRecorder = null,
} = {}) {
  if (typeof task !== 'string' || !task.trim()) throw new TypeError('source-backed workbench requires a task');
  if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('source-backed workbench limit must be a positive integer');
  if (!Array.isArray(candidates)) throw new TypeError('source-backed workbench candidates must be an array');
  if (!Array.isArray(transcriptHits)) throw new TypeError('source-backed workbench transcriptHits must be an array');
  if (!Array.isArray(numericSeries)) throw new TypeError('source-backed workbench numericSeries must be an array');
  if (!Array.isArray(requiredSourceIds)) throw new TypeError('source-backed workbench requiredSourceIds must be an array');
  const nowMs = Number.isFinite(Number(now)) ? Number(now) : Date.parse(now);
  if (!Number.isFinite(nowMs)) throw new TypeError('source-backed workbench now must be a timestamp');
  const collected = [...candidates];
  if (sourceViewStore) {
    if (typeof sourceViewStore.queryWorkbenchCandidates !== 'function') {
      throw new TypeError('sourceViewStore must support queryWorkbenchCandidates');
    }
    collected.push(...sourceViewStore.queryWorkbenchCandidates(sourceViewQuery || task, sourceViewAccess, { limit: sourceViewLimit }));
  }

  const hydration = [];
  if (Array.isArray(transcriptHits) && transcriptHits.length) {
    const { hydrateTranscriptHit } = await import('./superdirectory.mjs');
    for (const hit of transcriptHits) {
      const hydrated = await hydrateTranscriptHit(hit, transcriptRoot ? { root: transcriptRoot } : undefined);
      hydration.push({
        id: hydrated.id,
        session_id: hydrated.session_id,
        source: hydrated.source,
      });
      collected.push(transcriptCandidate(hit, hydrated));
    }
  }

  const prepared = [];
  const rejected = [];
  for (let index = 0; index < collected.length; index += 1) {
    const result = prepareWorkbenchCandidate(collected[index], index, task, project, nowMs);
    if (result.rejected) rejected.push(result.rejected);
    else prepared.push(result.candidate);
  }
  const uniqueById = new Map();
  for (const item of prepared.sort((left, right) => right.base_score - left.base_score || left.id.localeCompare(right.id))) {
    if (!uniqueById.has(item.id)) uniqueById.set(item.id, item);
  }
  const unique = [...uniqueById.values()];
  if (!unique.length) throw new Error('source-backed workbench found no authorized, hash-verified evidence');

  const debts = contradictionDebts(unique);
  const publicRanked = unique.map(publicWorkbenchCandidate)
    .sort((left, right) => right.why.total_score - left.why.total_score || left.id.localeCompare(right.id));
  const requiredIds = [...new Set(requiredSourceIds.map((id) => compactText(id, 240)).filter(Boolean))];
  const selectedIds = new Set(publicRanked.filter((item) => item.supersession.state !== 'superseded').slice(0, limit).map((item) => item.id));
  for (const id of requiredIds) {
    if (publicRanked.some((item) => item.id === id)) selectedIds.add(id);
  }
  for (const debt of debts.filter((item) => item.status === 'open')) {
    for (const id of debt.contradicts) selectedIds.add(id);
  }
  const selected = publicRanked.filter((item) => selectedIds.has(item.id));
  const internalById = new Map(unique.map((item) => [item.id, item]));
  const pinned = new Set([selected[0]?.id, ...requiredIds,
    ...debts.filter((item) => item.status === 'open').flatMap((item) => item.contradicts)].filter(Boolean));
  const crystalSources = selected.map((item) => ({
    id: item.id,
    content: internalById.get(item.id).content,
    pointer: `${item.source.path}#offset=${item.source.offset ?? 0}`,
    authority: item.why.signals.authority.score,
    pinned: pinned.has(item.id),
  }));
  const { compileContextCrystal } = await import('./context-crystal.mjs');
  const crystal = compileContextCrystal({
    task,
    sources: crystalSources,
    budgetBytes,
    requiredSourceIds: [...pinned],
    numericSeries,
  });

  const debtReceipts = [];
  if (debtRecorder !== null) {
    if (typeof debtRecorder !== 'function') throw new TypeError('debtRecorder must be a function');
    for (const debt of debts) {
      const receipt = await debtRecorder({
        debt_id: debt.debt_id,
        status: debt.status,
        reason: debt.reason,
        resolution: debt.resolution,
        contradicts: debt.contradicts,
        source_pointers: debt.source_pointers,
        confidence: debt.status === 'resolved' ? 1 : 0.5,
      });
      debtReceipts.push({
        debt_id: debt.debt_id,
        memory_id: receipt?.memory_id || receipt?.body?.memory_id || null,
        lane: receipt?.lane || null,
        hash: receipt?.hash || null,
        deduped: receipt?.deduped === true,
      });
    }
  }

  return {
    schema: SOURCE_BACKED_WORKBENCH_SCHEMA,
    task,
    project,
    generated_at: new Date(nowMs).toISOString(),
    selected,
    ranked: publicRanked,
    superseded: publicRanked.filter((item) => item.supersession.state === 'superseded'),
    rejected,
    contradiction_debt: debts,
    contradiction_debt_receipts: debtReceipts,
    transcript_hydration: hydration,
    equation_packets: crystal.equation_packets,
    context_crystal: crystal,
    proof: {
      source_backed: selected.every((item) => item.source.verified === true),
      authority_enforced: selected.every((item) => item.source.authorized === true),
      transcript_hydration_verified: hydration.every((item) => item.source.verified === true),
      contradictions_preserved: debts.every((item) => item.status === 'open' || Boolean(item.resolution)),
      required_sources_retained: crystal.proof.required_sources_retained,
      supersession_complete: publicRanked.every((item) => ['current', 'contested', 'superseded'].includes(item.supersession.state)),
      numeric_packets_exact: crystal.equation_packets.every((packet) => packet.metrics?.exact_reconstruction === true),
      crystal_complete: crystal.proof.complete,
    },
  };
}
