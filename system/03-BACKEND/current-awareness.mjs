import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectResearchEvidence } from './research-capabilities.mjs';
import { compressWorkset } from '../12-ATOMSMASHER/sparse-worksets/compressor.mjs';
import { writeChainedJsonReceipt } from '../10-RECEIPTS/tools/json-receipt-chain.mjs';

export const AWARENESS_SCHEMA = 'orange.current-awareness.v1';
export const REGISTRY_SCHEMA = 'orange.current-awareness-registry.v1';
export const BENCHMARK_SCHEMA = 'orange.current-awareness-benchmark.v1';
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_BUDGET_MS = 60_000;
const DEFAULT_BRIEF_BYTES = 4_000;
const DEFAULT_STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
const FUTURE_TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000;
const MAX_BENCHMARK_ARTIFACT_BYTES = 64 * 1024 * 1024;
const REQUIRED_BENCHMARK_GATES = ['sourceVerified', 'freshnessVerified', 'licenseAccepted', 'localCompatibilityPassed', 'riskAccepted'];
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const TERMINAL_CANDIDATE_LIFECYCLES = new Set(['PROMOTED', 'REJECTED']);

export function defaultAwarenessRoot(env = process.env) {
  const configured = String(env.ORANGE5_AWARENESS_ROOT || '').trim();
  if (configured) return path.resolve(configured);
  return path.join(env.USERPROFILE || env.HOME || os.homedir(), 'OrangeBox-Data', 'orange5', 'knowledge', 'current-awareness');
}

export function shouldScoutIntent(value) {
  const text = String(value || '').toLowerCase();
  if (!text.trim()) return false;
  const localOperationalStatus = /\b(?:runtime|service|system|gateway|server|process|rail|endpoint)\s+(?:health|status|state)\b|\b(?:health|status)\s+(?:report|check|probe)\b/.test(text);
  const strongFreshness = /\b(?:latest|newest|today|this week|just released|state of the art|sota|research|scout|scan|find (?:new )?tools?|new tech|security advisor(?:y|ies)|cve)\b/.test(text);
  const currentExternalSubject = /\bcurrent\b/.test(text)
    && /\b(?:model|llm|paper|research|library|framework|package|sdk|tool|technology|technique|release|version|industry|product|company)\b/.test(text);
  if (strongFreshness || currentExternalSubject) return true;
  if (localOperationalStatus) return false;
  const making = /\b(?:build|create|implement|develop|architect|design|upgrade|replace|integrate|install|choose|select)\b/.test(text);
  const technical = /\b(?:app|api|agent|ai|cli|code|compiler|database|dependency|framework|library|llm|mcp|model|package|pipeline|runtime|sdk|service|software|stack|tool|ui|workflow)\b/.test(text);
  return making && technical;
}

export function projectTechnologySignals(projectState = {}) {
  const root = projectState?.project?.root;
  if (!root || !fs.existsSync(root)) return [];
  const signals = new Set();
  readPackageJson(root, signals);
  readSimpleManifest(path.join(root, 'pyproject.toml'), signals, /^\s*([A-Za-z0-9_.-]+)\s*(?:[<>=~!]|$)/);
  readSimpleManifest(path.join(root, 'requirements.txt'), signals, /^\s*([A-Za-z0-9_.-]+)\s*(?:[<>=~!]|$)/);
  readSimpleManifest(path.join(root, 'Cargo.toml'), signals, /^\s*([A-Za-z0-9_-]+)\s*=\s*/);
  readSimpleManifest(path.join(root, 'go.mod'), signals, /^\s*([A-Za-z0-9_.\/-]+)\s+v\d/);
  return [...signals].filter((item) => item.length > 1).slice(0, 16);
}

export function buildScoutQuery(intent, projectState = {}) {
  const project = projectState?.project?.name || '';
  const tech = projectTechnologySignals(projectState).slice(0, 8).join(' ');
  return [sanitizeScoutIntent(intent), project, tech].filter(Boolean).join(' ').slice(0, 1_500);
}

export function sanitizeScoutIntent(value) {
  let text = String(value || '').trim();
  const userBlocks = [...text.matchAll(/<\|im_start\|>\s*user\s*([\s\S]*?)<\|im_end\|>/gi)];
  if (userBlocks.length) text = userBlocks.at(-1)[1].trim();
  text = text
    .replace(/<\|im_(?:start|end)\|>/gi, ' ')
    .replace(/\b(?:system|assistant|user)\b\s*:/gi, ' ')
    .trim();
  if (text.startsWith('{') && text.endsWith('}')) {
    try {
      const parsed = JSON.parse(text);
      const fields = ['intent', 'query', 'action', 'summary', 'reasoning', 'content', 'text']
        .map((key) => parsed?.[key])
        .filter((item) => typeof item === 'string' && item.trim());
      if (fields.length) text = fields.join(' ');
    } catch {
      // Invalid envelopes remain ordinary text and are still normalized below.
    }
  }
  return text
    .replace(/\b(?:emit only|matching the gbnf grammar|mom'?s law applies|do not change the lane)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1_200);
}

export async function getCurrentAwareness(input = {}, deps = {}) {
  const now = deps.now ? deps.now() : new Date();
  const root = path.resolve(deps.root || defaultAwarenessRoot());
  const query = buildScoutQuery(input.query || input.intent, input.project);
  if (!query.trim()) throw new TypeError('current awareness requires a query');
  const ttlMs = boundedNumber(input.ttlMs, 0, 7 * 24 * 60 * 60 * 1000, DEFAULT_TTL_MS);
  const budgetMs = boundedNumber(input.budgetMs, 1_000, 60_000, DEFAULT_BUDGET_MS);
  const staleAfterMs = boundedNumber(input.staleAfterMs, 60 * 60 * 1000, 365 * 24 * 60 * 60 * 1000, DEFAULT_STALE_AFTER_MS);
  const key = sha256(normalizeKey(query));
  const scoutPath = path.join(root, 'scouts', `${key}.json`);
  const cached = readJson(scoutPath);
  if (!input.force && cacheIsCurrent(cached, now, ttlMs, staleAfterMs)) {
    const brief = buildAwarenessBrief({
      query,
      candidates: cached.candidates || [],
      opportunities: cached.opportunities || [],
      budgetBytes: input.briefBytes,
    });
    return {
      ...cached,
      brief: brief.text,
      compression: brief.compression,
      cacheHit: true,
      ageMs: Math.max(0, now.getTime() - Date.parse(cached.generatedAt)),
    };
  }

  const collector = deps.collector || collectResearchEvidence;
  const evidence = await collector({
    query,
    delegationId: input.delegationId || `awareness-${key.slice(0, 16)}-${now.getTime()}`,
    budgetMs,
    maxSources: boundedNumber(input.maxSources, 1, 20, 12),
  }, deps.collectorDeps || {});
  const candidates = (evidence.sources || []).map((source) => enrichCandidate(source, now, query, staleAfterMs));
  const registry = updateRegistry({ root, candidates, now });
  const opportunities = rankOpportunities(candidates, input.project).slice(0, 6);
  const currentSourceCount = candidates.filter((candidate) => candidate.freshnessVerified).length;
  const staleSourceCount = candidates.filter((candidate) => candidate.staleSource).length;
  const unverifiedFreshnessCount = candidates.length - currentSourceCount - staleSourceCount;
  const briefResult = buildAwarenessBrief({ query, candidates, opportunities, budgetBytes: input.briefBytes });
  const base = {
    schema: AWARENESS_SCHEMA,
    query,
    queryHash: key,
    generatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    cacheHit: false,
    budgetMs,
    staleAfterMs,
    elapsedMs: evidence.elapsedMs ?? null,
    status: currentSourceCount ? 'CURRENT_EVIDENCE_READY' : candidates.length ? 'CURRENT_EVIDENCE_STALE' : 'CURRENT_EVIDENCE_UNAVAILABLE',
    sourceCount: candidates.length,
    currentSourceCount,
    staleSourceCount,
    unverifiedFreshnessCount,
    candidates,
    opportunities,
    brief: briefResult.text,
    compression: briefResult.compression,
    evidenceArtifactPath: evidence.artifactPath || null,
    registryPath: registry.path,
    errors: evidence.errors || [],
  };
  const result = { ...base, sha256: sha256(canonical(base)) };
  writeJson(scoutPath, result);
  writeJson(path.join(root, 'latest-attempt.json'), result);
  if (result.status === 'CURRENT_EVIDENCE_READY') writeJson(path.join(root, 'latest.json'), result);
  appendJsonl(path.join(root, 'scout-receipts.jsonl'), {
    schema: 'orange.current-awareness-receipt.v1',
    generatedAt: result.generatedAt,
    queryHash: key,
    sourceCount: result.sourceCount,
    currentSourceCount: result.currentSourceCount,
    staleSourceCount: result.staleSourceCount,
    status: result.status,
    sha256: result.sha256,
    scoutPath,
    registryPath: registry.path,
  });
  return result;
}

export function readCurrentAwareness({ root = defaultAwarenessRoot(), now = new Date() } = {}) {
  const resolvedRoot = path.resolve(root);
  const observedNow = now instanceof Date ? now : new Date(now);
  const latestPath = path.join(resolvedRoot, 'latest.json');
  const latestAttemptPath = path.join(resolvedRoot, 'latest-attempt.json');
  const latestAttempt = readJson(latestAttemptPath) || readJson(latestPath);
  const persistedLatest = readJson(latestPath);
  const latest = awarenessSnapshotIsReady(persistedLatest, observedNow)
    ? persistedLatest
    : latestReadyScout(resolvedRoot, observedNow);
  const registryPath = path.join(resolvedRoot, 'candidate-registry.json');
  const registry = readJson(registryPath) || { schema: REGISTRY_SCHEMA, candidates: [] };
  const candidates = (registry.candidates || []).map((candidate) => validatedRegistryCandidate(candidate, resolvedRoot));
  const invalidDecisionCount = candidates.filter((candidate) => candidate.decisionIntegrity === 'INVALID').length;
  const latestAttemptReady = awarenessSnapshotIsReady(latestAttempt, observedNow);
  return {
    schema: 'orange.current-awareness-status.v1',
    ready: latest?.status === 'CURRENT_EVIDENCE_READY',
    degraded: Boolean(latestAttempt) && !latestAttemptReady,
    latestPath,
    latestAttemptPath,
    registryPath,
    latest,
    latestAttempt,
    candidateCount: candidates.length,
    invalidDecisionCount,
    lifecycle: countBy(candidates, 'lifecycle'),
  };
}

function latestReadyScout(root, now = new Date()) {
  const scoutRoot = path.join(root, 'scouts');
  if (!fs.existsSync(scoutRoot)) return null;
  return fs.readdirSync(scoutRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => readJson(path.join(scoutRoot, entry.name)))
    .filter((entry) => awarenessSnapshotIsReady(entry, now) && Number.isFinite(Date.parse(entry.generatedAt)))
    .sort((a, b) => Date.parse(b.generatedAt) - Date.parse(a.generatedAt))[0] || null;
}

export function buildAwarenessBrief({ query, candidates = [], opportunities = [], budgetBytes = DEFAULT_BRIEF_BYTES } = {}) {
  if (!candidates.length) return { text: '', compression: { inputItems: 0, keptItems: 0, rawBytes: 0, hotBytes: 0, savedBytes: 0, worksetId: null } };
  const opportunityByUrl = new Map(opportunities.map((item) => [item.url, item]));
  const context = candidates.map((candidate, index) => {
    const idea = opportunityByUrl.get(candidate.url)?.idea || 'Verify compatibility and benchmark before adoption.';
    const content = `[${candidate.provider}] ${candidate.title}; observed=${candidate.observedAt || 'unknown'}; freshness=${candidate.freshness}; sourceState=${candidate.freshnessStatus || 'unknown'}; quarantine=${candidate.quarantineStatus || 'QUARANTINED'}; lifecycle=${candidate.lifecycle}; authority=${candidate.authorityTier || 'unknown'}; quality=${candidate.sourceQuality || 0}; stars=${candidate.stars || 0}; license=${candidate.license || 'unknown'}; sourceHash=${candidate.contentSha256 || 'unknown'}; hashScope=${candidate.contentHashScope || 'provider_metadata_record'}; source=${candidate.url}; finding=${candidate.summary}; idea=${idea}`;
    const scoreHint = (candidate.relevance?.score || 0) * 0.7 + (candidate.sourceQuality || 0) * 0.3;
    return { id: candidate.id || `candidate-${index}`, content, tag: 'current_evidence', size: Buffer.byteLength(content), score_hint: Math.min(0.9, scoreHint) };
  });
  const rawBytes = context.reduce((sum, item) => sum + item.size, 0);
  const workset = compressWorkset({ task: query, context }, { budget: boundedNumber(budgetBytes, 512, 12_000, DEFAULT_BRIEF_BYTES), keepThreshold: 0.04 });
  const lines = [
    'AIR:CURRENT.v1',
    'LAW: This is fresh discovery evidence, not installed capability or proof of superiority.',
    'LAW: Prefer an existing project component unless a candidate passes compatibility, license, benchmark, and receipt gates.',
    'LAW: STALE, UNDATED, or FUTURE_DATED sources require refresh or timestamp verification before benchmarking.',
    ...workset.working_set.map((item) => `C: ${item.content}`),
  ];
  const text = lines.join('\n');
  const hotBytes = Buffer.byteLength(text);
  return {
    text,
    compression: {
      worksetId: workset.workset_id,
      inputItems: workset.stats.input_items,
      keptItems: workset.stats.kept_items,
      droppedItems: workset.stats.dropped_items,
      rawBytes,
      hotBytes,
      savedBytes: Math.max(0, rawBytes - hotBytes),
      warnings: workset.warnings,
    },
  };
}

export function exportBehaviorLearningPack({ root = defaultAwarenessRoot(), outPath } = {}) {
  const resolvedRoot = path.resolve(root);
  const registry = readJson(path.join(resolvedRoot, 'candidate-registry.json')) || { candidates: [] };
  const resolved = (registry.candidates || [])
    .map((item) => validatedRegistryCandidate(item, resolvedRoot))
    .filter((item) => ['PROMOTED', 'REJECTED'].includes(item.lifecycle) && item.decisionIntegrity === 'VALID');
  const rows = resolved.map((item) => ({
    messages: [
      { role: 'system', content: 'Apply Orange current-awareness law. Current facts come from retrieval; learn only the evidence discipline and decision process.' },
      { role: 'user', content: `Evaluate a newly discovered component for an active project. Source type: ${item.provider}. License: ${item.license || 'unknown'}.` },
      { role: 'assistant', content: JSON.stringify({ decision: item.lifecycle, requires_source: true, requires_compatibility_probe: true, requires_benchmark_receipt: true, receipt_sha256: item.decisionReceiptSha256 }) },
    ],
  }));
  const target = path.resolve(outPath || path.join(root, 'training', 'awareness-behavior.jsonl'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
  return { schema: 'orange.awareness-behavior-trainset.v1', rows: rows.length, path: target, factsBakedIntoWeights: false };
}

export function recordCandidateBenchmark(input = {}, deps = {}) {
  const root = path.resolve(input.root || deps.root || defaultAwarenessRoot());
  const registryPath = path.join(root, 'candidate-registry.json');
  const registry = readJson(registryPath);
  if (!registry || !Array.isArray(registry.candidates)) throw new Error('candidate registry is unavailable');
  const candidateIndex = registry.candidates.findIndex((item) => item.id === input.candidateId
    || (input.candidateUrl && canonicalUrl(item.url) === canonicalUrl(input.candidateUrl)));
  if (candidateIndex < 0) throw new Error('candidate is not present in the current-awareness registry');
  const now = deps.now ? deps.now() : new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new TypeError('benchmark decision requires a valid clock');
  const registered = validatedRegistryCandidate(registry.candidates[candidateIndex], root);
  const decisionFreshness = classifyFreshness(registered.updatedAt, now, boundedNumber(input.staleAfterMs, 60 * 60 * 1000, 365 * 24 * 60 * 60 * 1000, DEFAULT_STALE_AFTER_MS));
  const sourceExpiresAtMs = Date.parse(registered.sourceExpiresAt);
  if (!registered.freshnessVerified || !decisionFreshness.verified || !Number.isFinite(sourceExpiresAtMs) || now.getTime() > sourceExpiresAtMs) {
    throw new Error(`candidate freshness gate is not satisfied: ${decisionFreshness.status || registered.freshnessStatus || 'UNKNOWN'}`);
  }
  if (registered.lifecycle === 'SOURCE_VERIFICATION_REQUIRED') throw new Error('candidate source verification gate is not satisfied');
  if (!SHA256_PATTERN.test(String(registered.contentSha256 || ''))) throw new Error('candidate source content hash is missing');

  const workload = normalizeBenchmarkArtifact(input.workload, 'workload', { verifyFile: true });
  const incumbent = normalizeBenchmarkArtifact(input.incumbent, 'incumbent', { verifyFile: true });
  const challenger = normalizeBenchmarkArtifact(input.candidate, 'candidate', { verifyFile: true });
  const comparisons = normalizeComparisons(input.comparisons);
  const gates = Object.fromEntries(REQUIRED_BENCHMARK_GATES.map((gate) => [gate, input.gates?.[gate] === true]));
  const comparisonResult = evaluateComparisons(comparisons);
  const gatesPassed = REQUIRED_BENCHMARK_GATES.every((gate) => gates[gate]);
  const promoted = gatesPassed && comparisonResult.allRequiredPassed && comparisonResult.improvementCount > 0;
  const lifecycle = promoted ? 'PROMOTED' : 'REJECTED';
  const generatedAt = now.toISOString();
  const receipt = {
    schema: BENCHMARK_SCHEMA,
    status: promoted ? 'CANDIDATE_PROMOTED' : 'INCUMBENT_RETAINED',
    generatedAt,
    candidateId: registered.id,
    candidateUrl: registered.url,
    candidateSourceSha256: registered.contentSha256,
    workload,
    incumbent,
    candidate: challenger,
    gates,
    comparisons,
    comparisonResult,
    decision: lifecycle,
    claimBoundary: 'Promotion applies only to this source hash, workload artifact, and measured comparison set.',
  };
  const receiptDir = path.join(root, 'benchmark-receipts');
  const receiptPath = path.join(receiptDir, `${generatedAt.replace(/[:.]/g, '-')}-${registered.id}.json`);
  const written = writeChainedJsonReceipt(receiptPath, receipt);
  const decisionReceiptSha256 = sha256(fs.readFileSync(receiptPath));
  const priorHistory = Array.isArray(registry.candidates[candidateIndex].history) ? registry.candidates[candidateIndex].history : [];
  registry.candidates[candidateIndex] = {
    ...registry.candidates[candidateIndex],
    lifecycle,
    quarantineStatus: promoted ? 'RELEASED_BY_BENCHMARK' : 'QUARANTINED',
    promotionEligible: promoted,
    decisionAt: generatedAt,
    decisionSourceSha256: registered.contentSha256,
    decisionReceiptPath: receiptPath,
    decisionReceiptSha256,
    decisionReceiptContentSha256: written.receipt_sha256,
    history: [...priorHistory, {
      at: generatedAt,
      lifecycle,
      receiptPath,
      receiptSha256: decisionReceiptSha256,
      sourceSha256: registered.contentSha256,
    }],
  };
  registry.updatedAt = generatedAt;
  writeJson(registryPath, registry);
  return {
    schema: BENCHMARK_SCHEMA,
    status: receipt.status,
    candidateId: registered.id,
    lifecycle,
    promotionEligible: promoted,
    receiptPath,
    receiptSha256: decisionReceiptSha256,
    comparisonResult,
  };
}

function updateRegistry({ root, candidates, now }) {
  const registryPath = path.join(root, 'candidate-registry.json');
  const current = readJson(registryPath) || { schema: REGISTRY_SCHEMA, createdAt: now.toISOString(), candidates: [] };
  const byUrl = new Map((current.candidates || []).map((item) => [canonicalUrl(item.url), item]));
  for (const candidate of candidates) {
    const key = canonicalUrl(candidate.url);
    const previous = byUrl.get(key);
    const validatedPrevious = previous ? validatedRegistryCandidate(previous, root) : null;
    const preservesDecision = TERMINAL_CANDIDATE_LIFECYCLES.has(validatedPrevious?.lifecycle)
      && validatedPrevious.decisionIntegrity === 'VALID'
      && validatedPrevious.decisionSourceSha256 === candidate.contentSha256;
    const lifecycle = preservesDecision ? validatedPrevious.lifecycle : candidate.lifecycle;
    const merged = {
      ...previous,
      ...candidate,
      firstSeenAt: previous?.firstSeenAt || now.toISOString(),
      lastSeenAt: now.toISOString(),
      seenCount: (previous?.seenCount || 0) + 1,
      history: previous?.history ?? candidate.history,
      lifecycle,
      quarantineStatus: lifecycle === 'PROMOTED' ? 'RELEASED_BY_BENCHMARK' : 'QUARANTINED',
      promotionEligible: lifecycle === 'PROMOTED' && preservesDecision,
    };
    if (!preservesDecision) clearDecisionFields(merged);
    byUrl.set(key, merged);
  }
  const value = { ...current, schema: REGISTRY_SCHEMA, updatedAt: now.toISOString(), candidates: [...byUrl.values()].sort((a, b) => String(b.lastSeenAt).localeCompare(String(a.lastSeenAt))).slice(0, 5_000) };
  writeJson(registryPath, value);
  return { path: registryPath, value };
}

function enrichCandidate(source, now, query, staleAfterMs = DEFAULT_STALE_AFTER_MS) {
  const freshness = classifyFreshness(source.updatedAt, now, staleAfterMs);
  const requestedLifecycle = source.lifecycle === 'SOURCE_VERIFICATION_REQUIRED'
    ? 'SOURCE_VERIFICATION_REQUIRED'
    : 'BENCHMARK_REQUIRED';
  const lifecycle = freshness.lifecycle || requestedLifecycle;
  const contentSha256 = SHA256_PATTERN.test(String(source.contentSha256 || ''))
    ? source.contentSha256
    : candidateContentSha256(source);
  return {
    id: sha256(canonicalUrl(source.url)).slice(0, 24),
    provider: source.provider,
    title: source.title,
    url: source.url,
    summary: source.summary,
    observedAt: Number.isFinite(Date.parse(source.observedAt)) ? source.observedAt : now.toISOString(),
    updatedAt: source.updatedAt || null,
    ageHours: freshness.ageHours,
    freshness: freshness.label,
    freshnessStatus: freshness.status,
    freshnessVerified: freshness.verified,
    staleSource: freshness.stale,
    sourceExpiresAt: freshness.expiresAt,
    contentSha256,
    contentHashScope: source.contentHashScope || 'provider_metadata_record',
    sourceRecordSha256: SHA256_PATTERN.test(String(source.sourceRecordSha256 || '')) ? source.sourceRecordSha256 : candidateContentSha256(source),
    immutableRef: source.immutableRef || `${source.url}#orange-evidence-sha256=${contentSha256}`,
    license: source.license || null,
    version: source.version || null,
    downloads: source.downloads ?? null,
    likes: source.likes ?? null,
    stars: source.stars ?? null,
    forks: source.forks ?? null,
    ownerType: source.ownerType ?? null,
    sourceQuality: source.sourceQuality ?? 0,
    relevance: source.relevance || { score: 0, matched: 0, queryTerms: 0, terms: [] },
    authorityTier: source.authorityTier,
    discoveryLifecycle: lifecycle,
    lifecycle,
    quarantineStatus: 'QUARANTINED',
    localSuitability: 'UNASSESSED',
    riskClassification: 'UNASSESSED',
    promotionEligible: false,
    discoveredFor: sha256(query),
  };
}

function rankOpportunities(candidates, projectState = {}) {
  const projectName = projectState?.project?.name || 'the active project';
  return [...candidates].map((candidate) => {
    const freshness = candidate.freshness === 'NOW' ? 0.25 : candidate.freshness === 'FRESH' ? 0.18 : candidate.freshness === 'RECENT' ? 0.1 : candidate.freshnessVerified ? 0.04 : -0.25;
    const license = candidate.license && !/unknown|other/i.test(candidate.license) ? 0.1 : 0;
    const popularity = Math.min(0.12, Math.log10(1 + (candidate.stars || candidate.downloads || candidate.likes || 0)) / 35);
    const authority = candidate.lifecycle === 'SOURCE_VERIFICATION_REQUIRED' ? -0.12 : Math.min(0.12, (candidate.sourceQuality || 0) * 0.12);
    const score = Math.max(0, Math.min(1, (candidate.relevance?.score || 0) * 0.62 + freshness + license + popularity + authority));
    return {
      candidateId: candidate.id,
      title: candidate.title,
      url: candidate.url,
      score: Number(score.toFixed(4)),
      idea: opportunityIdea(candidate, projectName),
      nextGate: candidate.lifecycle || 'BENCHMARK_REQUIRED',
    };
  }).sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
}

function opportunityIdea(candidate, projectName) {
  if (!candidate.freshnessVerified) {
    return `Refresh ${candidate.title} from an official timestamped source before compatibility or incumbent benchmarking.`;
  }
  const text = `${candidate.title} ${candidate.summary}`.toLowerCase();
  let target = `the existing ${projectName} path`;
  let experiment = 'measure quality, latency, resource cost, and saved work';
  if (/citation|faithful|provenance|source/.test(text)) {
    target = 'Hermes child-report evidence lineage and Checkmate receipts';
    experiment = 'trace where citations are lost across each agent handoff and compare end-to-end evidence recall';
  } else if (/memory|retriev|vector|embedding|rerank|knowledge/.test(text)) {
    target = 'AE Cobra retrieval plus AtomSmasher hot-context selection';
    experiment = 'measure recall precision, reason-why recovery, context bytes, and warm latency';
  } else if (/compress|token|context/.test(text)) {
    target = 'AtomSmasher pre-inference compression';
    experiment = 'measure task accuracy at equal context budgets and reject any saving that loses commitments';
  } else if (/mcp|tool protocol|connector/.test(text)) {
    target = 'Orange Brain MCP gateway';
    experiment = 'measure tool-call validity, startup latency, boundary enforcement, and receipt coverage';
  } else if (/orchestrat|multi-agent|coding agent|agentic/.test(text)) {
    target = 'Navigator -> Hermes bounded-agent flow';
    experiment = 'compare task completion, handoff loss, false-green rate, and total model work';
  } else if (/visual|vision|multimodal|image/.test(text)) {
    target = 'AE Eyes';
    experiment = 'measure difficult visual recall, grounding, latency, and Intel Arc viability';
  } else if (/inference|kernel|runtime|gpu|vulkan|cuda|intel arc/.test(text)) {
    target = 'Codexa inference fabric';
    experiment = 'measure warm throughput, first-token latency, memory pressure, and model compatibility';
  }
  return `Test ${candidate.title} against ${target}: ${experiment}. Adopt only if its receipt beats the current path.`;
}

function classifyFreshness(value, now, staleAfterMs) {
  const updatedAtMs = Date.parse(value);
  if (!Number.isFinite(updatedAtMs)) {
    return { label: 'UNKNOWN', status: 'UNDATED', verified: false, stale: false, ageHours: null, expiresAt: null, lifecycle: 'FRESHNESS_VERIFICATION_REQUIRED' };
  }
  const deltaMs = now.getTime() - updatedAtMs;
  if (deltaMs < -FUTURE_TIMESTAMP_TOLERANCE_MS) {
    return { label: 'FUTURE_DATED', status: 'FUTURE_DATED', verified: false, stale: false, ageHours: Number((deltaMs / 3_600_000).toFixed(2)), expiresAt: null, lifecycle: 'SOURCE_TIMESTAMP_INVALID' };
  }
  const ageMs = Math.max(0, deltaMs);
  const ageHours = Number((ageMs / 3_600_000).toFixed(2));
  const expiresAt = new Date(updatedAtMs + staleAfterMs).toISOString();
  if (ageMs > staleAfterMs) {
    return { label: 'STALE', status: 'STALE', verified: false, stale: true, ageHours, expiresAt, lifecycle: 'SOURCE_REFRESH_REQUIRED' };
  }
  const label = ageHours <= 6 ? 'NOW' : ageHours <= 24 ? 'FRESH' : ageHours <= 168 ? 'RECENT' : 'ESTABLISHED';
  return { label, status: 'VERIFIED_CURRENT', verified: true, stale: false, ageHours, expiresAt, lifecycle: null };
}

function cacheIsCurrent(cached, now, ttlMs, staleAfterMs) {
  if (!cached || cached.staleAfterMs !== staleAfterMs || !validPersistedHash(cached)) return false;
  const generatedAtMs = Date.parse(cached.generatedAt);
  const ageMs = now.getTime() - generatedAtMs;
  if (!Number.isFinite(generatedAtMs) || ageMs < -FUTURE_TIMESTAMP_TOLERANCE_MS || ageMs > ttlMs) return false;
  const expiresAtMs = Date.parse(cached.expiresAt);
  if (Number.isFinite(expiresAtMs) && now.getTime() > expiresAtMs) return false;
  if (cached.status !== 'CURRENT_EVIDENCE_READY') return true;
  if (!Array.isArray(cached.candidates)) return false;
  const verified = cached.candidates.filter((candidate) => candidate.freshnessVerified === true);
  return verified.length > 0 && verified.every((candidate) => {
    const sourceExpiresAtMs = Date.parse(candidate.sourceExpiresAt);
    return Number.isFinite(sourceExpiresAtMs) && now.getTime() <= sourceExpiresAtMs;
  });
}

function awarenessSnapshotIsReady(snapshot, now) {
  if (snapshot?.status !== 'CURRENT_EVIDENCE_READY' || !validPersistedHash(snapshot) || !Array.isArray(snapshot.candidates)) return false;
  return snapshot.candidates.some((candidate) => {
    const sourceExpiresAtMs = Date.parse(candidate.sourceExpiresAt);
    return candidate.freshnessVerified === true && Number.isFinite(sourceExpiresAtMs) && now.getTime() <= sourceExpiresAtMs;
  });
}

function validPersistedHash(value) {
  if (!SHA256_PATTERN.test(String(value?.sha256 || ''))) return false;
  const { sha256: expected, ...payload } = value;
  return sha256(canonical(payload)) === expected;
}

function normalizeBenchmarkArtifact(value, label, { verifyFile = false } = {}) {
  if (!value || typeof value !== 'object') throw new TypeError(`${label} benchmark artifact is required`);
  const name = String(value.name || value.id || '').trim().slice(0, 200);
  const artifactSha256 = String(value.artifactSha256 || '').toLowerCase();
  if (!name) throw new TypeError(`${label} benchmark artifact requires a name`);
  if (!SHA256_PATTERN.test(artifactSha256)) throw new TypeError(`${label} benchmark artifact requires a SHA-256`);
  const artifactPath = value.artifactPath ? path.resolve(String(value.artifactPath)) : null;
  if (verifyFile) {
    if (!artifactPath) throw new TypeError(`${label} benchmark artifact requires a local path`);
    const stat = fs.statSync(artifactPath);
    if (!stat.isFile() || stat.size > MAX_BENCHMARK_ARTIFACT_BYTES) throw new TypeError(`${label} benchmark artifact is not a bounded file`);
    if (sha256(fs.readFileSync(artifactPath)) !== artifactSha256) throw new TypeError(`${label} benchmark artifact hash mismatch`);
  }
  return { name, artifactPath, artifactSha256, version: value.version ? String(value.version).slice(0, 120) : null };
}

function normalizeComparisons(values) {
  if (!Array.isArray(values) || values.length < 1 || values.length > 32) throw new TypeError('benchmark requires 1-32 metric comparisons');
  const names = new Set();
  return values.map((value) => {
    const name = String(value?.name || '').trim().slice(0, 120);
    const direction = value?.direction;
    const incumbent = Number(value?.incumbent);
    const candidate = Number(value?.candidate);
    const tolerance = value?.tolerance == null ? 0 : Number(value.tolerance);
    if (!name || names.has(name)) throw new TypeError('benchmark metric names must be non-empty and unique');
    if (!['higher', 'lower'].includes(direction)) throw new TypeError(`benchmark metric ${name} requires higher or lower direction`);
    if (![incumbent, candidate, tolerance].every(Number.isFinite) || tolerance < 0) throw new TypeError(`benchmark metric ${name} has invalid values`);
    names.add(name);
    return { name, direction, incumbent, candidate, tolerance, required: value.required !== false };
  });
}

function evaluateComparisons(comparisons) {
  const results = comparisons.map((metric) => {
    const passed = metric.direction === 'higher'
      ? metric.candidate + metric.tolerance >= metric.incumbent
      : metric.candidate <= metric.incumbent + metric.tolerance;
    const improved = metric.direction === 'higher'
      ? metric.candidate > metric.incumbent + metric.tolerance
      : metric.candidate < metric.incumbent - metric.tolerance;
    return { name: metric.name, required: metric.required, passed, improved };
  });
  return {
    allRequiredPassed: results.filter((item) => item.required).every((item) => item.passed),
    improvementCount: results.filter((item) => item.improved).length,
    results,
  };
}

function validatedRegistryCandidate(candidate, root) {
  if (!TERMINAL_CANDIDATE_LIFECYCLES.has(candidate?.lifecycle)) {
    return { ...candidate, quarantineStatus: 'QUARANTINED', promotionEligible: false, decisionIntegrity: 'NONE' };
  }
  const verification = verifyDecisionReceipt(candidate, root);
  if (!verification.valid) {
    return {
      ...candidate,
      lifecycle: candidate.discoveryLifecycle || 'BENCHMARK_REQUIRED',
      quarantineStatus: 'QUARANTINED',
      promotionEligible: false,
      decisionIntegrity: 'INVALID',
      decisionIntegrityError: verification.error,
    };
  }
  return {
    ...candidate,
    quarantineStatus: candidate.lifecycle === 'PROMOTED' ? 'RELEASED_BY_BENCHMARK' : 'QUARANTINED',
    promotionEligible: candidate.lifecycle === 'PROMOTED',
    decisionIntegrity: 'VALID',
  };
}

function verifyDecisionReceipt(candidate, root) {
  try {
    const receiptRoot = path.resolve(root, 'benchmark-receipts');
    const receiptPath = path.resolve(String(candidate.decisionReceiptPath || ''));
    if (!isWithin(receiptRoot, receiptPath)) throw new Error('decision receipt path is outside the benchmark receipt root');
    const stat = fs.statSync(receiptPath);
    if (!stat.isFile() || stat.size > 1_000_000) throw new Error('decision receipt is not a bounded file');
    const bytes = fs.readFileSync(receiptPath);
    if (sha256(bytes) !== candidate.decisionReceiptSha256) throw new Error('decision receipt file hash mismatch');
    const receipt = JSON.parse(bytes.toString('utf8'));
    const { receipt_sha256: receiptSha256, ...receiptPayload } = receipt;
    if (!SHA256_PATTERN.test(String(receiptSha256 || '')) || sha256(JSON.stringify(receiptPayload)) !== receiptSha256) {
      throw new Error('decision receipt content hash mismatch');
    }
    if (receipt.schema !== BENCHMARK_SCHEMA || receipt.candidateId !== candidate.id || canonicalUrl(receipt.candidateUrl) !== canonicalUrl(candidate.url)) {
      throw new Error('decision receipt candidate identity mismatch');
    }
    if (receipt.candidateSourceSha256 !== candidate.decisionSourceSha256 || candidate.decisionSourceSha256 !== candidate.contentSha256) {
      throw new Error('decision receipt source hash mismatch');
    }
    if (candidate.decisionReceiptContentSha256 && candidate.decisionReceiptContentSha256 !== receiptSha256) {
      throw new Error('decision receipt chained content hash mismatch');
    }
    normalizeBenchmarkArtifact(receipt.workload, 'workload');
    normalizeBenchmarkArtifact(receipt.incumbent, 'incumbent');
    normalizeBenchmarkArtifact(receipt.candidate, 'candidate');
    const comparisons = normalizeComparisons(receipt.comparisons);
    const result = evaluateComparisons(comparisons);
    const gatesPassed = REQUIRED_BENCHMARK_GATES.every((gate) => receipt.gates?.[gate] === true);
    const expectedLifecycle = gatesPassed && result.allRequiredPassed && result.improvementCount > 0 ? 'PROMOTED' : 'REJECTED';
    const expectedStatus = expectedLifecycle === 'PROMOTED' ? 'CANDIDATE_PROMOTED' : 'INCUMBENT_RETAINED';
    if (receipt.decision !== expectedLifecycle || receipt.status !== expectedStatus || candidate.lifecycle !== expectedLifecycle) {
      throw new Error('decision receipt outcome does not match measured gates');
    }
    return { valid: true, error: null };
  } catch (error) {
    return { valid: false, error: error?.message || String(error) };
  }
}

function clearDecisionFields(candidate) {
  for (const key of ['decisionAt', 'decisionSourceSha256', 'decisionReceiptPath', 'decisionReceiptSha256', 'decisionReceiptContentSha256', 'decisionIntegrity', 'decisionIntegrityError']) {
    delete candidate[key];
  }
}

function candidateContentSha256(source) {
  return sha256(canonical({
    provider: source.provider || null,
    sourceId: source.sourceId || null,
    title: source.title || null,
    url: source.url || null,
    summary: source.summary || null,
    updatedAt: source.updatedAt || null,
    version: source.version || null,
    license: source.license || null,
  }));
}

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function readPackageJson(root, signals) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    if (pkg.name) signals.add(pkg.name);
    for (const section of ['dependencies', 'devDependencies', 'peerDependencies']) {
      Object.keys(pkg[section] || {}).slice(0, 20).forEach((name) => signals.add(name));
    }
  } catch { /* manifest is optional */ }
}

function readSimpleManifest(file, signals, pattern) {
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/).slice(0, 500)) {
      const match = line.match(pattern);
      if (match?.[1] && !/^(name|version|description|dependencies|package|module|go|python)$/i.test(match[1])) signals.add(match[1]);
    }
  } catch { /* manifest is optional */ }
}

function countBy(rows, field) {
  return rows.reduce((out, row) => { const key = row[field] || 'UNKNOWN'; out[key] = (out[key] || 0) + 1; return out; }, {});
}
function canonicalUrl(value) { return String(value || '').trim().toLowerCase().replace(/\/$/, ''); }
function normalizeKey(value) { return String(value).toLowerCase().replace(/\s+/g, ' ').trim(); }
function sha256(value) { return crypto.createHash('sha256').update(Buffer.isBuffer(value) ? value : String(value)).digest('hex'); }
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}
function boundedNumber(value, min, max, fallback) { const number = Number(value); return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.round(number))) : fallback; }
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function writeJson(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); }
function appendJsonl(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.appendFileSync(file, `${JSON.stringify(value)}\n`, 'utf8'); }

export const __currentAwarenessInternals = Object.freeze({ enrichCandidate, rankOpportunities, normalizeKey, canonicalUrl });
