import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFlux } from './flux/reader.mjs';
import { canonicalFluxRoot } from './paths.mjs';

const QDRANT_URL = (process.env.AE_COBRA_QDRANT_URL || 'http://127.0.0.1:6333').replace(/\/+$/, '');
const OLLAMA_URL = (process.env.AE_COBRA_EMBED_URL || 'http://127.0.0.1:11437').replace(/\/+$/, '');
const EMBED_MODEL = process.env.AE_COBRA_EMBED_MODEL || 'qwen3-embedding:0.6b';
const COLLECTION = process.env.AE_COBRA_MEMORY_COLLECTION || 'orange5-memory';
const SCORE_THRESHOLD = Number(process.env.AE_COBRA_SEMANTIC_THRESHOLD || 0.55);
const EMBED_BATCH_SIZE = Math.max(1, Number(process.env.AE_COBRA_EMBED_BATCH || 8));
const EMBED_TIMEOUT_MS = Math.max(5_000, Number(process.env.AE_COBRA_EMBED_TIMEOUT_MS || 180_000));
let lexicalCorpusSnapshot = { signature: null, points: [] };
let lexicalMirrorRefresh = null;
let lastLexicalMirrorCheckAt = 0;
const payloadTokenCache = new WeakMap();

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function pointId(hash) {
  const hex = String(hash || sha256('missing')).replace(/[^a-f0-9]/gi, '').padEnd(32, '0').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function recordText(record) {
  const body = record?.body || {};
  return [
    `lane ${record?.lane || 'unknown'}`,
    `kind ${record?.kind || 'unknown'}`,
    `origin ${record?.origin || 'unknown'}`,
    body.source_file ? `source ${body.source_file}` : '',
    body.section ? `section ${body.section}` : '',
    body.summary || '',
    ...(body.entities || []),
    ...(body.files || []),
    ...(body.commands || []),
    body.next_action || '',
  ].filter(Boolean).join('\n');
}

function recordPayload(record) {
  const body = record?.body || {};
  return {
    hash: record.hash,
    ts: record.ts,
    lane: record.lane,
    origin: record.origin,
    kind: record.kind,
    summary: body.summary || '',
    entities: body.entities || [],
    files: body.files || [],
    commands: (body.commands || []).slice(0, 5),
    risk: body.risk || null,
    next_action: body.next_action || null,
    confidence: body.confidence ?? null,
    authority: body.authority ?? null,
    source_file: body.source_file ?? null,
    source_hash: body.source_hash ?? null,
    section: body.section ?? null,
    chunk_index: body.chunk_index ?? null,
  };
}

const TOKEN_STOPWORDS = new Set([
  'about', 'after', 'before', 'does', 'from', 'have', 'into', 'just', 'that', 'their',
  'them', 'then', 'there', 'these', 'they', 'this', 'those', 'what', 'when', 'where',
  'which', 'while', 'with', 'would', 'could', 'should', 'your',
]);

function normalizeToken(token) {
  if (/^auth(?:enticated|entication|orized|orization)?$/.test(token)) return 'auth';
  if (/^verif(?:y|ied|ication|ications)$/.test(token)) return 'verify';
  if (/^complet(?:e|ed|ion|ions)$/.test(token)) return 'complete';
  if (/^fail(?:ed|ure|ures|ing)?$/.test(token)) return 'fail';
  if (/^halt(?:ed|ing|s)?$/.test(token)) return 'halt';
  if (/^rout(?:e|ed|er|ers|ing)$/.test(token)) return 'route';
  if (/^retriev(?:e|ed|al|als|ing)$/.test(token)) return 'retrieve';
  return token;
}

function tokens(value) {
  const raw = String(value || '').toLowerCase().match(/[a-z0-9]{3,}/g) || [];
  return new Set(raw.filter((token) => !TOKEN_STOPWORDS.has(token)).map(normalizeToken));
}

function payloadTokens(payload) {
  if (!payload || typeof payload !== 'object') {
    return { lexical: new Set(), document: new Set(), section: new Set() };
  }
  const cached = payloadTokenCache.get(payload);
  if (cached) return cached;
  const shared = [
    payload.summary,
    payload.source_file,
    payload.section,
    ...(payload.entities || []),
    ...(payload.files || []),
    ...(payload.commands || []),
  ].filter(Boolean);
  const result = {
    lexical: tokens(shared.join(' ')),
    document: tokens([...shared, payload.next_action].filter(Boolean).join(' ')),
    section: tokens(payload.section || ''),
  };
  payloadTokenCache.set(payload, result);
  return result;
}

function lowInformationPayload(payload) {
  const summary = String(payload?.summary || '').trim().toLowerCase();
  const generic = new Set(['verified runtime event', 'runtime event', 'operation completed', 'ok']);
  const nextAction = String(payload?.next_action || '').trim().toLowerCase();
  const meaningfulNextAction = nextAction && !new Set(['no action required.', 'no action required', 'none']).has(nextAction);
  const detailCount = [
    ...(payload?.entities || []),
    ...(payload?.files || []),
    ...(payload?.commands || []),
    meaningfulNextAction,
  ].filter(Boolean).length;
  return generic.has(summary) && detailCount === 0;
}

function usefulRecord(record) {
  const payload = recordPayload(record);
  return typeof payload.summary === 'string' && payload.summary.trim().length >= 12 && !lowInformationPayload(payload);
}

function machineTelemetryPayload(payload) {
  const summary = String(payload?.summary || '');
  const source = String(payload?.source_file || '');
  const pathLines = summary.split(/\r?\n/).filter((line) => /^\s*\$\.[a-z0-9_[\].-]+\s*:/i.test(line)).length;
  const benchmarkSource = /(?:system-performance|navigator-performance|reliability)-benchmark\.json$/i.test(source);
  const recursiveSummary = /\$\.(?:semantic_recall\.)?top_summary\s*:/i.test(summary);
  return {
    telemetry: benchmarkSource || pathLines >= 4,
    recursive: recursiveSummary,
    path_lines: pathLines,
  };
}

function rerankHits(query, hits) {
  const queryTokens = tokens(query);
  const now = Date.now();
  return hits.map((hit) => {
    const payload = hit.payload || {};
    const cachedTokens = payloadTokens(payload);
    const documentTokens = cachedTokens.document;
    const overlap = [...queryTokens].filter((token) => documentTokens.has(token)).length;
    const lexicalCoverage = queryTokens.size ? overlap / queryTokens.size : 0;
    const sectionTokens = cachedTokens.section;
    const sectionOverlap = [...queryTokens].filter((token) => sectionTokens.has(token)).length;
    const sectionCoverage = queryTokens.size ? sectionOverlap / queryTokens.size : 0;
    const semanticScore = Number(hit.score || 0);
    const lexicalRetrievalScore = Number(hit.lexical_retrieval_score || 0);
    const lowInformation = lowInformationPayload(payload);
    const actionable = payload.next_action || payload.commands?.length || payload.files?.length ? 0.03 : 0;
    const authority = Number(payload.authority || 0);
    const authorityBoost = Number.isFinite(authority) ? Math.min(0.06, Math.max(0, authority) * 0.06) : 0;
    const ageDays = Number.isFinite(Number(payload.ts)) ? Math.max(0, (now - Number(payload.ts)) / 86_400_000) : 365;
    const freshnessBoost = Math.exp(-ageDays / 14) * 0.05;
    const receiptBoost = String(payload.source_file || '').startsWith('10-RECEIPTS/') ? 0.02 : 0;
    const telemetry = machineTelemetryPayload(payload);
    const telemetryIntent = /\b(?:benchmark|performance|latency|p50|p95|throughput|timings?|health metrics?|routes per second|proof|receipt|current status|fully operational|green)\b/i.test(query);
    const telemetryPenalty = telemetry.telemetry && !telemetryIntent
      ? (telemetry.recursive ? 0.7 : 0.3)
      : 0;
    const lexicalCandidateBoost = lexicalRetrievalScore >= 0.45 ? 0.16 : lexicalRetrievalScore * 0.12;
    const definitionIntentBoost = /\b(?:what makes|definition|define|requirements?)\b/i.test(query)
      && /\bdefinition\b/i.test(payload.section || '') ? 0.1 : 0;
    const recoveryIntentBoost = /\b(?:what should|after|recover|recovery|retry|blocked|halt|failed work|recalled before|before another action)\b/i.test(query)
      && /\b(?:read the blocker|do not retry|before retrying|recover once|satisfy (?:its|the) (?:evidence|condition)|next action)\b/i.test(payload.summary || '')
      ? 0.14 : 0;
    const hierarchyIntentBoost = /\b(?:evidence|proof)\b.*\b(?:outrank|hierarchy|claims?)\b|\b(?:outrank|hierarchy)\b.*\b(?:evidence|proof|claims?)\b/i.test(query)
      && /\bevidence hierarchy\b/i.test(`${payload.section || ''} ${payload.summary || ''}`)
      ? 0.2 : 0;
    const rerankScore = semanticScore * 0.42 + lexicalCoverage * 0.3 + lexicalRetrievalScore * 0.18
      + sectionCoverage * 0.12 + definitionIntentBoost + recoveryIntentBoost + hierarchyIntentBoost + lexicalCandidateBoost + actionable
      + authorityBoost + freshnessBoost + receiptBoost - (lowInformation ? 0.4 : 0) - telemetryPenalty;
    return {
      ...hit,
      score: rerankScore,
      semantic_score: semanticScore,
      lexical_coverage: lexicalCoverage,
      section_coverage: sectionCoverage,
      lexical_retrieval_score: lexicalRetrievalScore,
      age_days: Number(ageDays.toFixed(3)),
      freshness_boost: Number(freshnessBoost.toFixed(6)),
      receipt_boost: receiptBoost,
      hierarchy_intent_boost: hierarchyIntentBoost,
      telemetry_penalty: telemetryPenalty,
      machine_telemetry: telemetry.telemetry,
      recursive_telemetry: telemetry.recursive,
      low_information: lowInformation,
    };
  }).sort((a, b) => b.score - a.score);
}

async function lexicalCorpus() {
  const fluxRoot = canonicalFluxRoot();
  let mirror = loadLexicalMirror();
  if (!mirror) mirror = await refreshLexicalMirror();
  else if (Date.now() - lastLexicalMirrorCheckAt > 30_000 && !lexicalMirrorRefresh) {
    lastLexicalMirrorCheckAt = Date.now();
    lexicalMirrorRefresh = refreshLexicalMirrorIfChanged(mirror)
      .catch(() => null)
      .finally(() => { lexicalMirrorRefresh = null; });
  }
  const signature = `${mirror?.receipt_sha256 || 'no-mirror'}:${lexicalLedgerSignature(fluxRoot)}`;
  if (lexicalCorpusSnapshot.signature === signature) return lexicalCorpusSnapshot.points;
  // The disk mirror carries project documents indexed in Qdrant; the local
  // hash-chained ledger overlays newer runtime truth. Normal recall therefore
  // uses SSD, not a full-corpus network scroll, without dropping either class.
  const localPoints = readFlux({ fluxRoot, lanes: ['reality', 'thought', 'merge'], maxRecords: Infinity })
    .filter(usefulRecord)
    .map((record) => ({ id: pointId(record.hash), score: 0, payload: recordPayload(record) }));
  const merged = new Map((mirror?.points || []).map((point) => [String(point.id), point]));
  for (const point of localPoints) merged.set(String(point.id), point);
  const points = [...merged.values()];
  lexicalCorpusSnapshot = { signature, points };
  return points;
}

function lexicalMirrorPath() {
  return path.join(dataRoot(), 'knowledge', 'lexical-corpus-mirror.json');
}

function loadLexicalMirror() {
  try {
    const value = JSON.parse(fs.readFileSync(lexicalMirrorPath(), 'utf8'));
    if (value?.schema !== 'orange5.cobra-lexical-mirror.v1' || !Array.isArray(value.points)) return null;
    const expected = sha256(JSON.stringify({ collection: value.collection, point_count: value.point_count, points: value.points }));
    return expected === value.receipt_sha256 ? value : null;
  } catch { return null; }
}

async function fetchQdrantLexicalPoints() {
  const points = [];
  let offset = null;
  do {
    const body = { limit: 512, with_payload: true, with_vector: false };
    if (offset != null) body.offset = offset;
    const response = await jsonFetch(`${QDRANT_URL}/collections/${COLLECTION}/points/scroll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    points.push(...(response?.result?.points || []));
    offset = response?.result?.next_page_offset ?? null;
  } while (offset != null && points.length < 50_000);
  return points;
}

async function refreshLexicalMirror() {
  const points = await fetchQdrantLexicalPoints();
  const mirror = {
    schema: 'orange5.cobra-lexical-mirror.v1',
    collection: COLLECTION,
    point_count: points.length,
    points,
    generated_at: new Date().toISOString(),
  };
  mirror.receipt_sha256 = sha256(JSON.stringify({ collection: mirror.collection, point_count: mirror.point_count, points }));
  const destination = lexicalMirrorPath();
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(mirror)}\n`, 'utf8');
  fs.renameSync(temporary, destination);
  lexicalCorpusSnapshot = { signature: null, points: [] };
  return mirror;
}

async function refreshLexicalMirrorIfChanged(current) {
  const info = await collectionInfo();
  if (!info.exists || Number(info.points) === Number(current.point_count)) return current;
  return refreshLexicalMirror();
}

function lexicalLedgerSignature(fluxRoot) {
  const parts = [];
  for (const lane of ['reality', 'thought', 'merge']) {
    const directory = path.join(fluxRoot, 'events', lane);
    try {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
        const stat = fs.statSync(path.join(directory, entry.name));
        parts.push(`${lane}/${entry.name}:${stat.size}:${stat.mtimeMs}`);
      }
    } catch { /* absent lane contributes no records */ }
  }
  return sha256(parts.sort().join('\n'));
}

function lexicalCandidates(query, points, limit = 96) {
  const queryTokens = [...tokens(query)];
  if (!queryTokens.length || !points.length) return [];
  const documents = points.map((point) => ({ point, tokens: payloadTokens(point.payload).lexical }));
  const idf = new Map(queryTokens.map((token) => {
    const df = documents.reduce((count, item) => count + Number(item.tokens.has(token)), 0);
    return [token, Math.log((documents.length + 1) / (df + 1)) + 1];
  }));
  const totalWeight = [...idf.values()].reduce((sum, value) => sum + value, 0) || 1;
  return documents.map(({ point, tokens: documentTokens }) => {
    const matchedWeight = queryTokens.reduce((sum, token) => sum + (documentTokens.has(token) ? idf.get(token) : 0), 0);
    return { ...point, score: 0, lexical_retrieval_score: matchedWeight / totalWeight };
  }).filter((point) => point.lexical_retrieval_score > 0)
    .sort((a, b) => b.lexical_retrieval_score - a.lexical_retrieval_score)
    .slice(0, limit);
}

function mergeCandidates(dense, lexical) {
  const merged = new Map();
  for (const hit of dense) merged.set(String(hit.id), hit);
  for (const hit of lexical) {
    const id = String(hit.id);
    const prior = merged.get(id);
    merged.set(id, prior ? { ...prior, lexical_retrieval_score: hit.lexical_retrieval_score } : hit);
  }
  return [...merged.values()];
}

function uniqueRankedHits(hits) {
  const seen = new Set();
  return hits.filter((hit) => {
    const payload = hit.payload || {};
    const key = `${payload.source_file || payload.lane || 'unknown'}\n${String(payload.summary || '').trim().toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function deleteSemanticSource(sourceFile) {
  if (!sourceFile) return { deleted: false, reason: 'source_file_required' };
  const info = await collectionInfo();
  if (!info.exists) return { deleted: false, reason: 'collection_missing' };
  await jsonFetch(`${QDRANT_URL}/collections/${COLLECTION}/points/delete?wait=true`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filter: { must: [{ key: 'source_file', match: { value: sourceFile } }] },
    }),
  }, 120_000);
  fs.rmSync(lexicalMirrorPath(), { force: true });
  lexicalCorpusSnapshot = { signature: null, points: [] };
  return { deleted: true, source_file: sourceFile };
}

async function jsonFetch(url, init = {}, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = { text }; }
    if (!response.ok) throw new Error(`${response.status} ${url}: ${text.slice(0, 400)}`);
    return body;
  } finally {
    clearTimeout(timer);
  }
}

function dataRoot() {
  return process.env.ORANGE5_DATA_ROOT
    || path.join(process.env.USERPROFILE || process.env.HOME || '.', 'OrangeBox-Data', 'orange5');
}

function defaultCheckpointPath() {
  return path.join(dataRoot(), 'knowledge', 'semantic-index-checkpoint.json');
}

async function embed(texts, timeoutMs = EMBED_TIMEOUT_MS) {
  const body = await jsonFetch(`${OLLAMA_URL}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts, keep_alive: '10m' }),
  }, timeoutMs);
  if (!Array.isArray(body?.embeddings) || body.embeddings.length !== texts.length) {
    throw new Error('embedding endpoint returned an invalid batch');
  }
  return body.embeddings;
}

async function adaptiveEmbed(texts, {
  embedder = embed,
  timeoutMs = EMBED_TIMEOUT_MS,
  onRetry = () => {},
} = {}) {
  try {
    return { vectors: await embedder(texts, timeoutMs), retries: 0, requests: 1 };
  } catch (error) {
    if (texts.length <= 1) throw error;
    const midpoint = Math.ceil(texts.length / 2);
    onRetry({ size: texts.length, next_sizes: [midpoint, texts.length - midpoint], error: error.message });
    const left = await adaptiveEmbed(texts.slice(0, midpoint), { embedder, timeoutMs, onRetry });
    const right = await adaptiveEmbed(texts.slice(midpoint), { embedder, timeoutMs, onRetry });
    return {
      vectors: [...left.vectors, ...right.vectors],
      retries: 1 + left.retries + right.retries,
      requests: 1 + left.requests + right.requests,
    };
  }
}

async function collectionInfo() {
  try {
    const response = await jsonFetch(`${QDRANT_URL}/collections/${COLLECTION}`);
    return {
      exists: true,
      dimensions: response?.result?.config?.params?.vectors?.dense?.size ?? null,
      points: response?.result?.points_count ?? 0,
    };
  } catch (error) {
    if (String(error.message).startsWith('404 ')) return { exists: false, dimensions: null, points: 0 };
    throw error;
  }
}

async function ensureCollection(dimensions) {
  const existing = await collectionInfo();
  if (existing.exists) {
    const current = existing.dimensions;
    if (Number(current) !== Number(dimensions)) {
      throw new Error(`Qdrant ${COLLECTION} dimension mismatch: ${current} != ${dimensions}`);
    }
    return { created: false, dimensions };
  }
  await jsonFetch(`${QDRANT_URL}/collections/${COLLECTION}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ vectors: { dense: { size: dimensions, distance: 'Cosine' } } }),
  });
  return { created: true, dimensions };
}

function loadCheckpoint(checkpointPath, sourceHash) {
  if (!checkpointPath || !sourceHash || !fs.existsSync(checkpointPath)) return null;
  try {
    const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
    if (checkpoint.source_hash !== sourceHash || checkpoint.model !== EMBED_MODEL || checkpoint.collection !== COLLECTION) return null;
    return checkpoint;
  } catch {
    return null;
  }
}

function saveCheckpoint(checkpointPath, checkpoint) {
  if (!checkpointPath) return;
  fs.mkdirSync(path.dirname(checkpointPath), { recursive: true });
  fs.writeFileSync(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`, 'utf8');
}

async function existingPointIds(hashes) {
  if (!hashes.length) return new Set();
  try {
    const response = await jsonFetch(`${QDRANT_URL}/collections/${COLLECTION}/points`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: hashes.map(pointId), with_payload: false, with_vector: false }),
    });
    return new Set((response?.result || []).map((point) => point.id));
  } catch (error) {
    if (String(error.message).startsWith('404 ')) return new Set();
    throw error;
  }
}

export async function upsertSemanticRecords(records, {
  batchSize = EMBED_BATCH_SIZE,
  timeoutMs = EMBED_TIMEOUT_MS,
  checkpointPath = null,
  sourceHash = null,
} = {}) {
  const usable = records.filter(usefulRecord);
  if (!usable.length) return { indexed: 0, model: EMBED_MODEL, collection: COLLECTION };

  const checkpoint = loadCheckpoint(checkpointPath, sourceHash);
  let completed = new Set(checkpoint?.completed_hashes || []);
  const usableHashes = new Set(usable.map((record) => record.hash));
  completed = new Set([...completed].filter((hash) => usableHashes.has(hash)));
  const candidatesForExistenceCheck = completed.size ? [...completed] : [...usableHashes];
  const existing = await existingPointIds(candidatesForExistenceCheck);
  completed = new Set(candidatesForExistenceCheck.filter((hash) => existing.has(pointId(hash))));

  const pending = usable.filter((record) => !completed.has(record.hash));
  const info = await collectionInfo();
  let dimensions = info.dimensions;
  let created = false;
  let indexed = 0;
  let retries = 0;
  let embeddingRequests = 0;
  for (let offset = 0; offset < pending.length; offset += batchSize) {
    const batch = pending.slice(offset, offset + batchSize);
    const embedded = await adaptiveEmbed(batch.map(recordText), { timeoutMs });
    const vectors = embedded.vectors;
    retries += embedded.retries;
    embeddingRequests += embedded.requests;
    if (dimensions === null) {
      dimensions = vectors[0].length;
      ({ created } = await ensureCollection(dimensions));
    }
    const points = batch.map((record, index) => ({
      id: pointId(record.hash),
      vector: { dense: vectors[index] },
      payload: recordPayload(record),
    }));
    await jsonFetch(`${QDRANT_URL}/collections/${COLLECTION}/points?wait=true`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ points }),
    }, 120_000);
    indexed += points.length;
    for (const record of batch) completed.add(record.hash);
    saveCheckpoint(checkpointPath, {
      schema: 'orange5.cobra-semantic-index.checkpoint.v1',
      source_hash: sourceHash,
      model: EMBED_MODEL,
      collection: COLLECTION,
      completed_hashes: [...completed].sort(),
      completed: completed.size,
      total: usable.length,
      updated_at: new Date().toISOString(),
    });
  }
  if (indexed > 0) {
    fs.rmSync(lexicalMirrorPath(), { force: true });
    lexicalCorpusSnapshot = { signature: null, points: [] };
  }
  return {
    indexed,
    skipped_existing: usable.length - pending.length,
    total_usable: usable.length,
    model: EMBED_MODEL,
    collection: COLLECTION,
    dimensions,
    created,
    batch_size: batchSize,
    embedding_requests: embeddingRequests,
    adaptive_retries: retries,
    complete: completed.size === usable.length,
    checkpoint_path: checkpointPath,
  };
}

export async function buildSemanticIndex({ fluxRoot = canonicalFluxRoot() } = {}) {
  const started = Date.now();
  const records = readFlux({ fluxRoot, lanes: ['reality', 'thought', 'merge'], maxRecords: Infinity });
  const sourceHash = sha256(records.map((record) => record.hash).join('\n'));
  const result = await upsertSemanticRecords(records, {
    checkpointPath: defaultCheckpointPath(),
    sourceHash,
  });
  const receipt = {
    schema: 'orange5.cobra-semantic-index.receipt.v1',
    status: 'INDEXED',
    source: fluxRoot,
    source_records: records.length,
    source_hash: sourceHash,
    ...result,
    elapsed_ms: Date.now() - started,
    generated_at: new Date().toISOString(),
  };
  receipt.receipt_sha256 = sha256(JSON.stringify(receipt));
  const receiptRoot = dataRoot();
  const receiptPath = path.join(receiptRoot, 'receipts', 'cobra-semantic-index-latest.json');
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  return { ...receipt, receipt_path: receiptPath };
}

export async function querySemanticMemory(query, { limit = 12, scoreThreshold = SCORE_THRESHOLD, mode = 'hybrid' } = {}) {
  if (typeof query !== 'string' || !query.trim()) return { hits: [], elapsed_ms: 0, skipped: 'empty_query' };
  const retrievalMode = ['lexical', 'dense', 'hybrid'].includes(mode) ? mode : 'hybrid';
  const started = Date.now();
  // Wide dense recall is cheap in the local collection and prevents fresh,
  // generic receipts from crowding exact doctrine out before lexical reranking.
  const candidateLimit = Math.min(256, Math.max(192, limit * 16));
  let embeddingMs = 0;
  let qdrantMs = 0;
  const densePromise = retrievalMode === 'lexical'
    ? Promise.resolve({ result: { points: [] } })
    : (async () => {
        const embedStarted = Date.now();
        const [vector] = await embed([query]);
        embeddingMs = Date.now() - embedStarted;
        const qdrantStarted = Date.now();
        const response = await jsonFetch(`${QDRANT_URL}/collections/${COLLECTION}/points/query`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: vector, using: 'dense', limit: candidateLimit, score_threshold: scoreThreshold, with_payload: true }),
        });
        qdrantMs = Date.now() - qdrantStarted;
        return response;
      })();
  const lexicalPromise = retrievalMode === 'dense' ? Promise.resolve([]) : lexicalCorpus();
  const [response, corpus] = await Promise.all([densePromise, lexicalPromise]);
  const points = response?.result?.points || [];
  const lexical = retrievalMode === 'dense' ? [] : lexicalCandidates(query, corpus);
  const ranked = uniqueRankedHits(rerankHits(query, mergeCandidates(points, lexical)))
    .filter((point) => !point.low_information || point.lexical_coverage > 0)
    .slice(0, limit);
  const conflicts = detectContradictions(query, ranked);
  return {
    hits: ranked,
    elapsed_ms: Date.now() - started,
    model: EMBED_MODEL,
    collection: COLLECTION,
    threshold: scoreThreshold,
    candidates: points.length,
    lexical_candidates: lexical.length,
    lexical_corpus: corpus.length,
    component_latency_ms: { embedding: embeddingMs, qdrant: qdrantMs },
    retrieval_mode: retrievalMode,
    reranker: retrievalMode === 'hybrid' ? 'orange5.hybrid-dense-idf.v2' : `orange5.${retrievalMode}.ablation.v1`,
    conflicts,
  };
}

function statusPolarity(value) {
  const text = String(value || '').toLowerCase();
  const negative = /needs[_ -]?work|not fully|regressed|do not ship|blocked|failed|15\s*\/\s*16|94%/.test(text);
  const positive = /\bgreen\b|fully operational|100%|verified|all gates pass|\boperational\b/.test(text);
  if (negative && !positive) return -1;
  if (positive && !negative) return 1;
  return 0;
}

function detectContradictions(query, hits) {
  const relevant = hits.filter((hit) => hit.lexical_coverage >= 0.15).map((hit) => ({
    hash: hit.payload?.hash || null,
    source: hit.payload?.source_file || `ae-cobra:${hit.payload?.lane || 'unknown'}`,
    ts: hit.payload?.ts || null,
    polarity: statusPolarity(hit.payload?.summary),
    summary: String(hit.payload?.summary || '').slice(0, 280),
  })).filter((item) => item.polarity !== 0);
  const positive = relevant.filter((item) => item.polarity === 1);
  const negative = relevant.filter((item) => item.polarity === -1);
  if (!positive.length || !negative.length) return [];
  const preferred = [...relevant].sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0))[0];
  return [{
    type: 'runtime_status_conflict',
    query: String(query).slice(0, 240),
    positive_sources: positive.map((item) => item.source),
    negative_sources: negative.map((item) => item.source),
    preferred_fresh_source: preferred?.source || null,
    rule: 'fresh receipts and live probes outrank older prose',
  }];
}

function semanticCite(hit) {
  const payload = hit.payload || {};
  return {
    id: String(payload.hash || 'unknown').slice(0, 12),
    ts: payload.ts,
    lane: payload.lane,
    origin: payload.origin,
    kind: payload.kind,
    summary: payload.summary || '',
    entities: payload.entities || [],
    files: payload.files || [],
    commands: payload.commands || [],
    risk: payload.risk || null,
    next_action: payload.next_action || null,
    confidence: payload.confidence ?? null,
    semantic_score: hit.semantic_score ?? hit.score,
    rerank_score: hit.score,
    lexical_coverage: hit.lexical_coverage ?? null,
    source_pointer: payload.source_file
      ? {
          type: 'project-source',
          file: payload.source_file,
          section: payload.section || null,
          source_hash: payload.source_hash || null,
          chunk_index: payload.chunk_index ?? null,
          hash: payload.hash || null,
        }
      : { ledger: 'ae-cobra-flux', lane: payload.lane, ts: payload.ts, hash: payload.hash || null },
  };
}

export function mergeSemanticMemory(brief, semantic, maxRecords = 50) {
  const out = { ...brief, reality: [...(brief.reality || [])], thought: [...(brief.thought || [])] };
  const seen = new Set([...out.reality, ...out.thought].map((item) => item.source_pointer?.hash).filter(Boolean));
  let added = 0;
  for (const hit of semantic?.hits || []) {
    const cite = semanticCite(hit);
    if (!cite.source_pointer.hash || seen.has(cite.source_pointer.hash)) continue;
    const lane = cite.lane === 'reality' ? out.reality : out.thought;
    if (lane.length >= maxRecords) continue;
    lane.push(cite);
    seen.add(cite.source_pointer.hash);
    added += 1;
  }
  out.retrieval = {
    ...(brief.retrieval || {}),
    semantic: {
      active: true,
      model: semantic.model,
      collection: semantic.collection,
      threshold: semantic.threshold,
      hits: semantic.hits?.length || 0,
      added,
      latency_ms: semantic.elapsed_ms,
    },
  };
  return out;
}

async function main() {
  const command = process.argv[2] || 'health';
  if (command === 'index') console.log(JSON.stringify(await buildSemanticIndex(), null, 2));
  else if (command === 'search') console.log(JSON.stringify(await querySemanticMemory(process.argv.slice(3).join(' ')), null, 2));
  else {
    const [qdrant, ollama] = await Promise.allSettled([
      jsonFetch(`${QDRANT_URL}/collections/${COLLECTION}`, {}, 5_000),
      jsonFetch(`${OLLAMA_URL}/api/tags`, {}, 5_000),
    ]);
    console.log(JSON.stringify({
      schema: 'orange5.cobra-semantic-health.v1',
      qdrant: qdrant.status === 'fulfilled',
      embedding_endpoint: ollama.status === 'fulfilled',
      model: EMBED_MODEL,
      collection: COLLECTION,
    }, null, 2));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

export const __semanticInternals = Object.freeze({
  pointId,
  recordText,
  recordPayload,
  semanticCite,
  adaptiveEmbed,
  loadCheckpoint,
  lowInformationPayload,
  machineTelemetryPayload,
  usefulRecord,
  rerankHits,
  lexicalCandidates,
  mergeCandidates,
  uniqueRankedHits,
  lexicalLedgerSignature,
  loadLexicalMirror,
  detectContradictions,
  statusPolarity,
});
