import { createHash } from 'node:crypto';

export const EVIDENCE_POSET_SCHEMA = 'orange5.scoped-evidence-poset.alpha.v1';
export const EVIDENCE_NODE_SCHEMA = 'orange5.scoped-evidence-node.alpha.v1';
export const EVIDENCE_EDGE_SCHEMA = 'orange5.scoped-evidence-edge.alpha.v1';

export const EVIDENCE_TYPES = Object.freeze({
  SEMANTIC_LIVE_PROBE: 'semantic_live_probe',
  HASH_CHAINED_RECEIPT: 'hash_chained_receipt',
  EXECUTABLE_TEST: 'executable_test',
  SOURCE_OR_CONFIGURATION: 'source_or_configuration',
  RUNTIME_AUTHORITY: 'runtime_authority',
  HISTORICAL_PLAN: 'historical_plan',
  CHAT_CLAIM: 'chat_claim',
});

export const EVIDENCE_TYPE_RANKS = Object.freeze({
  [EVIDENCE_TYPES.SEMANTIC_LIVE_PROBE]: 700,
  [EVIDENCE_TYPES.HASH_CHAINED_RECEIPT]: 600,
  [EVIDENCE_TYPES.EXECUTABLE_TEST]: 500,
  [EVIDENCE_TYPES.SOURCE_OR_CONFIGURATION]: 400,
  [EVIDENCE_TYPES.RUNTIME_AUTHORITY]: 300,
  [EVIDENCE_TYPES.HISTORICAL_PLAN]: 200,
  [EVIDENCE_TYPES.CHAT_CLAIM]: 100,
});

export const CLAIM_POLARITIES = Object.freeze({
  SUPPORTS: 'supports',
  REFUTES: 'refutes',
});

export const EVIDENCE_EDGE_TYPES = Object.freeze({
  SOURCE: 'SOURCE',
  PROVES: 'PROVES',
  REQUIRES: 'REQUIRES',
  BLOCKED_BY: 'BLOCKED_BY',
  SUPERSEDES: 'SUPERSEDES',
  APPROVED_BY: 'APPROVED_BY',
  OBSERVED_BY: 'OBSERVED_BY',
  CONTRADICTS: 'CONTRADICTS',
});

export const EVIDENCE_ORDER = Object.freeze({
  LESS: 'less',
  EQUAL: 'equal',
  GREATER: 'greater',
  INCOMPARABLE: 'incomparable',
});

export const FRESHNESS_STATES = Object.freeze({
  NOT_YET_OBSERVED: 'not_yet_observed',
  STALE: 'stale',
  OPEN_ENDED: 'open_ended',
  FRESH: 'fresh',
});

const TYPE_VALUES = new Set(Object.values(EVIDENCE_TYPES));
const POLARITY_VALUES = new Set(Object.values(CLAIM_POLARITIES));
const EDGE_TYPE_VALUES = new Set(Object.values(EVIDENCE_EDGE_TYPES));
const EPOCH = '1970-01-01T00:00:00.000Z';

export class EvidencePosetError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'EvidencePosetError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new EvidencePosetError(code, message, details);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalSerialize(value, path, ancestors) {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('INVALID_JSON_NUMBER', `${path} must be a finite number`);
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (typeof value !== 'object') fail('INVALID_JSON_VALUE', `${path} is not canonical JSON data`);
  if (ancestors.has(value)) fail('CYCLIC_JSON_VALUE', `${path} contains a cycle`);

  ancestors.add(value);
  let result;
  if (Array.isArray(value)) {
    result = `[${value.map((item, index) => canonicalSerialize(item, `${path}[${index}]`, ancestors)).join(',')}]`;
  } else {
    if (!isPlainObject(value)) fail('INVALID_JSON_OBJECT', `${path} must be a plain object`);
    const fields = Object.keys(value).sort().map((key) => {
      const item = value[key];
      if (item === undefined) fail('INVALID_JSON_VALUE', `${path}.${key} may not be undefined`);
      return `${JSON.stringify(key)}:${canonicalSerialize(item, `${path}.${key}`, ancestors)}`;
    });
    result = `{${fields.join(',')}}`;
  }
  ancestors.delete(value);
  return result;
}

export function canonicalJson(value) {
  return canonicalSerialize(value, '$', new WeakSet());
}

export function sha256Canonical(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function canonicalClone(value) {
  return JSON.parse(canonicalJson(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function nonEmptyString(value, field, maxLength = 512) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail('INVALID_STRING', `${field} must be a non-empty string`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) fail('STRING_TOO_LONG', `${field} exceeds ${maxLength} characters`);
  return normalized;
}

function normalizeTimestamp(value, field) {
  const text = nonEmptyString(value, field, 128);
  const milliseconds = Date.parse(text);
  if (!Number.isFinite(milliseconds)) fail('INVALID_TIMESTAMP', `${field} must be an ISO-compatible timestamp`);
  return new Date(milliseconds).toISOString();
}

function normalizeOptionalJson(value, field) {
  if (value === undefined) return undefined;
  try {
    return canonicalClone(value);
  } catch (error) {
    if (error instanceof EvidencePosetError) throw error;
    fail('INVALID_JSON_VALUE', `${field} must contain canonical JSON data`);
  }
}

export function normalizeEvidenceScope(input) {
  if (!isPlainObject(input)) fail('INVALID_SCOPE', 'scope must be a plain object');
  const normalized = {};
  for (const key of Object.keys(input).sort()) {
    const dimension = nonEmptyString(key, 'scope dimension', 128);
    const raw = input[key];
    const values = Array.isArray(raw) ? raw : [raw];
    if (values.length === 0) fail('INVALID_SCOPE', `scope.${dimension} must not be empty`);
    const clean = values.map((value) => nonEmptyString(value, `scope.${dimension}`, 512));
    if (clean.includes('*')) continue;
    normalized[dimension] = [...new Set(clean)].sort();
  }
  if (Object.keys(normalized).length === 0) {
    fail('INVALID_SCOPE', 'scope must contain at least one constrained dimension');
  }
  return deepFreeze(normalized);
}

export function evidenceScopeContains(containerInput, candidateInput) {
  const container = normalizeEvidenceScope(containerInput);
  const candidate = normalizeEvidenceScope(candidateInput);
  for (const [dimension, allowed] of Object.entries(container)) {
    const selected = candidate[dimension];
    if (!selected || selected.some((value) => !allowed.includes(value))) return false;
  }
  return true;
}

export function evidenceScopesEqual(left, right) {
  return canonicalJson(normalizeEvidenceScope(left)) === canonicalJson(normalizeEvidenceScope(right));
}

export function intersectEvidenceScopes(leftInput, rightInput) {
  const left = normalizeEvidenceScope(leftInput);
  const right = normalizeEvidenceScope(rightInput);
  const result = {};
  const dimensions = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
  for (const dimension of dimensions) {
    if (!left[dimension]) result[dimension] = [...right[dimension]];
    else if (!right[dimension]) result[dimension] = [...left[dimension]];
    else {
      const overlap = left[dimension].filter((value) => right[dimension].includes(value));
      if (overlap.length === 0) return null;
      result[dimension] = overlap;
    }
  }
  return normalizeEvidenceScope(result);
}

function normalizeClaim(input, fallbackPolarity) {
  const claim = typeof input === 'string' ? { id: input, polarity: fallbackPolarity } : input;
  if (!isPlainObject(claim)) fail('INVALID_CLAIM', 'claim must be a string or plain object');
  const polarity = claim.polarity ?? fallbackPolarity;
  if (!POLARITY_VALUES.has(polarity)) {
    fail('INVALID_POLARITY', `claim.polarity must be one of: ${[...POLARITY_VALUES].join(', ')}`);
  }
  const normalized = {
    id: nonEmptyString(claim.id, 'claim.id', 512),
    polarity,
  };
  if (claim.statement !== undefined) normalized.statement = nonEmptyString(claim.statement, 'claim.statement', 4096);
  if (claim.value !== undefined) normalized.value = normalizeOptionalJson(claim.value, 'claim.value');
  return normalized;
}

function normalizeAuthority(input) {
  if (!isPlainObject(input)) fail('INVALID_AUTHORITY', 'authority must be a plain object');
  const rank = input.rank;
  if (!Number.isInteger(rank) || rank < 0 || rank > 1000) {
    fail('INVALID_AUTHORITY_RANK', 'authority.rank must be an integer from 0 through 1000');
  }
  const normalized = {
    id: nonEmptyString(input.id ?? input.issuer, 'authority.id', 512),
    rank,
  };
  if (input.basis !== undefined) normalized.basis = normalizeOptionalJson(input.basis, 'authority.basis');
  return normalized;
}

export function createEvidenceNode(input) {
  if (!isPlainObject(input)) fail('INVALID_NODE', 'evidence node must be a plain object');
  if (input.schema !== undefined && input.schema !== EVIDENCE_NODE_SCHEMA) {
    fail('INVALID_NODE_SCHEMA', `node schema must be ${EVIDENCE_NODE_SCHEMA}`);
  }
  const type = input.type ?? input.evidenceType;
  if (!TYPE_VALUES.has(type)) fail('INVALID_EVIDENCE_TYPE', `unsupported evidence type: ${String(type)}`);
  const observedAt = normalizeTimestamp(input.observedAt ?? input.observed_at, 'observedAt');
  const validUntilInput = input.validUntil ?? input.valid_until ?? null;
  const validUntil = validUntilInput === null ? null : normalizeTimestamp(validUntilInput, 'validUntil');
  if (validUntil !== null && Date.parse(validUntil) < Date.parse(observedAt)) {
    fail('INVALID_FRESHNESS_WINDOW', 'validUntil must not precede observedAt');
  }

  const core = {
    schema: EVIDENCE_NODE_SCHEMA,
    type,
    claim: normalizeClaim(input.claim ?? input.claimId, input.polarity),
    scope: normalizeEvidenceScope(input.scope),
    authority: normalizeAuthority(input.authority),
    observedAt,
    validUntil,
  };
  const source = normalizeOptionalJson(input.source, 'source');
  const metadata = normalizeOptionalJson(input.metadata, 'metadata');
  if (source !== undefined) core.source = source;
  if (metadata !== undefined) core.metadata = metadata;

  const id = input.id === undefined
    ? `evidence_${sha256Canonical(core).slice(0, 32)}`
    : nonEmptyString(input.id, 'node.id', 512);
  return deepFreeze({ id, ...core });
}

export function createEvidenceEdge(input) {
  if (!isPlainObject(input)) fail('INVALID_EDGE', 'evidence edge must be a plain object');
  if (input.schema !== undefined && input.schema !== EVIDENCE_EDGE_SCHEMA) {
    fail('INVALID_EDGE_SCHEMA', `edge schema must be ${EVIDENCE_EDGE_SCHEMA}`);
  }
  const type = input.type ?? input.predicate;
  if (!EDGE_TYPE_VALUES.has(type)) fail('INVALID_EDGE_TYPE', `unsupported evidence edge type: ${String(type)}`);
  let from = nonEmptyString(input.from ?? input.sourceId, 'edge.from', 512);
  let to = nonEmptyString(input.to ?? input.targetId, 'edge.to', 512);
  if (from === to) fail('INVALID_EDGE', 'evidence edge endpoints must differ');
  if (type === EVIDENCE_EDGE_TYPES.CONTRADICTS && from.localeCompare(to) > 0) [from, to] = [to, from];

  const core = { schema: EVIDENCE_EDGE_SCHEMA, type, from, to };
  if (input.scope !== undefined) core.scope = normalizeEvidenceScope(input.scope);
  const metadata = normalizeOptionalJson(input.metadata, 'edge.metadata');
  if (metadata !== undefined) core.metadata = metadata;
  const id = input.id === undefined
    ? `edge_${sha256Canonical(core).slice(0, 32)}`
    : nonEmptyString(input.id, 'edge.id', 512);
  return deepFreeze({ id, ...core });
}

function defaultAsOf(nodes) {
  if (nodes.length === 0) return EPOCH;
  return new Date(Math.max(...nodes.map((node) => Date.parse(node.observedAt)))).toISOString();
}

export function rankEvidence(input, options = {}) {
  const node = createEvidenceNode(input);
  const asOf = options.asOf === undefined
    ? node.observedAt
    : normalizeTimestamp(options.asOf, 'asOf');
  const asOfTime = Date.parse(asOf);
  const observedAtTime = Date.parse(node.observedAt);
  let freshness;
  let freshnessRank;
  if (observedAtTime > asOfTime) {
    freshness = FRESHNESS_STATES.NOT_YET_OBSERVED;
    freshnessRank = -1;
  } else if (node.validUntil === null) {
    freshness = FRESHNESS_STATES.OPEN_ENDED;
    freshnessRank = 1;
  } else if (Date.parse(node.validUntil) >= asOfTime) {
    freshness = FRESHNESS_STATES.FRESH;
    freshnessRank = 2;
  } else {
    freshness = FRESHNESS_STATES.STALE;
    freshnessRank = 0;
  }
  return deepFreeze({
    evidenceTypeRank: EVIDENCE_TYPE_RANKS[node.type],
    authorityRank: node.authority.rank,
    freshnessRank,
    observedAtEpochMs: observedAtTime,
    freshness,
    asOf,
  });
}

function dominance(left, right) {
  const dimensions = ['evidenceTypeRank', 'authorityRank', 'freshnessRank', 'observedAtEpochMs'];
  return dimensions.every((dimension) => left[dimension] >= right[dimension])
    && dimensions.some((dimension) => left[dimension] > right[dimension]);
}

export function compareEvidence(leftInput, rightInput, options = {}) {
  const left = createEvidenceNode(leftInput);
  const right = createEvidenceNode(rightInput);
  if (left.id === right.id) {
    if (canonicalJson(left) !== canonicalJson(right)) {
      fail('NODE_ID_CONFLICT', `node id ${left.id} identifies different evidence`);
    }
    return EVIDENCE_ORDER.EQUAL;
  }
  if (left.claim.id !== right.claim.id
    || left.claim.polarity !== right.claim.polarity
    || !evidenceScopesEqual(left.scope, right.scope)) {
    return EVIDENCE_ORDER.INCOMPARABLE;
  }
  const asOf = options.asOf ?? defaultAsOf([left, right]);
  const leftRank = rankEvidence(left, { asOf });
  const rightRank = rankEvidence(right, { asOf });
  if (dominance(leftRank, rightRank)) return EVIDENCE_ORDER.GREATER;
  if (dominance(rightRank, leftRank)) return EVIDENCE_ORDER.LESS;
  return EVIDENCE_ORDER.INCOMPARABLE;
}

export function evidencePrecedesOrEquals(left, right, options = {}) {
  const relation = compareEvidence(left, right, options);
  return relation === EVIDENCE_ORDER.LESS || relation === EVIDENCE_ORDER.EQUAL;
}

function contradictionFor(left, right) {
  if (left.claim.id !== right.claim.id || left.claim.polarity === right.claim.polarity) return null;
  return intersectEvidenceScopes(left.scope, right.scope);
}

function addById(map, value, conflictCode, label) {
  const previous = map.get(value.id);
  if (previous && canonicalJson(previous) !== canonicalJson(value)) {
    fail(conflictCode, `${label} id ${value.id} has conflicting definitions`);
  }
  if (!previous) map.set(value.id, value);
}

function normalizeEdgeAgainstNodes(input, nodeById) {
  const edge = createEvidenceEdge(input);
  const from = nodeById.get(edge.from);
  const to = nodeById.get(edge.to);
  if (!from || !to) {
    fail('MISSING_EDGE_ENDPOINT', `edge ${edge.id} references a missing endpoint`, {
      from: edge.from,
      to: edge.to,
    });
  }
  if (edge.type !== EVIDENCE_EDGE_TYPES.CONTRADICTS) return edge;

  const overlap = contradictionFor(from, to);
  if (!overlap) fail('INVALID_CONTRADICTION_EDGE', `edge ${edge.id} does not join contradictory scoped claims`);
  if (edge.scope !== undefined && !evidenceScopesEqual(edge.scope, overlap)) {
    fail('INVALID_CONTRADICTION_SCOPE', `edge ${edge.id} must carry the full overlap scope`);
  }
  return createEvidenceEdge({ ...edge, scope: overlap });
}

function sortedValues(map) {
  return [...map.values()].sort((left, right) => left.id.localeCompare(right.id)
    || canonicalJson(left).localeCompare(canonicalJson(right)));
}

function deriveOrder(nodes, asOf) {
  const strictEdges = [];
  for (let leftIndex = 0; leftIndex < nodes.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < nodes.length; rightIndex += 1) {
      const left = nodes[leftIndex];
      const right = nodes[rightIndex];
      const relation = compareEvidence(left, right, { asOf });
      if (relation !== EVIDENCE_ORDER.LESS && relation !== EVIDENCE_ORDER.GREATER) continue;
      const lower = relation === EVIDENCE_ORDER.LESS ? left : right;
      const higher = relation === EVIDENCE_ORDER.LESS ? right : left;
      const core = {
        relation: 'PRECEDES',
        lower: lower.id,
        higher: higher.id,
        scope: lower.scope,
      };
      strictEdges.push(deepFreeze({ id: `order_${sha256Canonical(core).slice(0, 32)}`, ...core }));
    }
  }
  strictEdges.sort((left, right) => left.id.localeCompare(right.id));
  return deepFreeze({
    relation: 'RANK_DOMINANCE',
    comparability: 'IDENTICAL_CLAIM_POLARITY_AND_SCOPE',
    rankDimensions: ['evidenceTypeRank', 'authorityRank', 'freshnessRank', 'observedAtEpochMs'],
    reflexiveNodeIds: nodes.map((node) => node.id),
    strictEdges,
  });
}

export function createEvidencePoset(input = {}) {
  if (!isPlainObject(input)) fail('INVALID_POSET', 'poset input must be a plain object');
  if (!Array.isArray(input.nodes ?? [])) fail('INVALID_POSET', 'poset.nodes must be an array');
  if (!Array.isArray(input.edges ?? [])) fail('INVALID_POSET', 'poset.edges must be an array');

  const nodeById = new Map();
  for (const rawNode of input.nodes ?? []) {
    addById(nodeById, createEvidenceNode(rawNode), 'NODE_ID_CONFLICT', 'node');
  }
  const nodes = sortedValues(nodeById);
  const asOf = input.asOf === undefined
    ? defaultAsOf(nodes)
    : normalizeTimestamp(input.asOf, 'asOf');

  const edgeById = new Map();
  for (const rawEdge of input.edges ?? []) {
    const edge = normalizeEdgeAgainstNodes(rawEdge, nodeById);
    addById(edgeById, edge, 'EDGE_ID_CONFLICT', 'edge');
  }

  const representedContradictions = new Set(
    [...edgeById.values()]
      .filter((edge) => edge.type === EVIDENCE_EDGE_TYPES.CONTRADICTS)
      .map((edge) => `${edge.from}\u0000${edge.to}`),
  );
  for (let leftIndex = 0; leftIndex < nodes.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < nodes.length; rightIndex += 1) {
      const left = nodes[leftIndex];
      const right = nodes[rightIndex];
      const overlap = contradictionFor(left, right);
      if (!overlap) continue;
      const [from, to] = [left.id, right.id].sort();
      const key = `${from}\u0000${to}`;
      if (representedContradictions.has(key)) continue;
      const edge = createEvidenceEdge({
        type: EVIDENCE_EDGE_TYPES.CONTRADICTS,
        from,
        to,
        scope: overlap,
        metadata: { origin: 'detected_by_scoped_join' },
      });
      addById(edgeById, edge, 'EDGE_ID_CONFLICT', 'edge');
      representedContradictions.add(key);
    }
  }

  const edges = sortedValues(edgeById);
  const sourceEdgeIds = edges
    .filter((edge) => edge.type !== EVIDENCE_EDGE_TYPES.CONTRADICTS)
    .map((edge) => edge.id);
  const contradictionEdgeIds = edges
    .filter((edge) => edge.type === EVIDENCE_EDGE_TYPES.CONTRADICTS)
    .map((edge) => edge.id);
  const partialOrder = deriveOrder(nodes, asOf);
  const payload = {
    schema: EVIDENCE_POSET_SCHEMA,
    classification: 'ALPHA_ONLY',
    productionWired: false,
    asOf,
    nodes,
    edges,
    sourceEdgeIds,
    contradictionEdgeIds,
    partialOrder,
  };
  return deepFreeze({ ...payload, contentHash: sha256Canonical(payload) });
}

export function joinEvidencePosets(...inputs) {
  const nodes = [];
  const edges = [];
  const asOfValues = [];
  for (const input of inputs) {
    if (!isPlainObject(input)) fail('INVALID_POSET', 'every join input must be a poset-like object');
    if (!Array.isArray(input.nodes ?? []) || !Array.isArray(input.edges ?? [])) {
      fail('INVALID_POSET', 'every join input must provide node and edge arrays');
    }
    nodes.push(...(input.nodes ?? []));
    edges.push(...(input.edges ?? []));
    if (input.asOf !== undefined) asOfValues.push(normalizeTimestamp(input.asOf, 'asOf'));
  }
  const asOf = asOfValues.length === 0
    ? undefined
    : new Date(Math.max(...asOfValues.map(Date.parse))).toISOString();
  return createEvidencePoset({ nodes, edges, ...(asOf === undefined ? {} : { asOf }) });
}

export function queryEvidence(posetInput, query) {
  if (!isPlainObject(query)) fail('INVALID_QUERY', 'evidence query must be a plain object');
  const poset = createEvidencePoset({
    nodes: posetInput?.nodes,
    edges: posetInput?.edges,
    asOf: posetInput?.asOf,
  });
  const claimId = nonEmptyString(query.claimId ?? query.claim_id, 'query.claimId', 512);
  const scope = normalizeEvidenceScope(query.scope);
  const asOf = query.asOf === undefined ? poset.asOf : normalizeTimestamp(query.asOf, 'query.asOf');
  const asOfTime = Date.parse(asOf);
  const candidates = poset.nodes.filter((node) => node.claim.id === claimId
    && Date.parse(node.observedAt) <= asOfTime
    && evidenceScopeContains(node.scope, scope));
  const candidateIds = new Set(candidates.map((node) => node.id));
  const contradictions = poset.edges.filter((edge) => edge.type === EVIDENCE_EDGE_TYPES.CONTRADICTS
    && candidateIds.has(edge.from)
    && candidateIds.has(edge.to)
    && evidenceScopeContains(edge.scope, scope));
  const frontier = candidates.filter((candidate) => !candidates.some((other) => (
    candidate.id !== other.id
      && compareEvidence(candidate, other, { asOf }) === EVIDENCE_ORDER.LESS
  )));
  const polarities = new Set(candidates.map((node) => node.claim.polarity));
  let status = 'NO_EVIDENCE';
  if (contradictions.length > 0) status = 'CONTRADICTED';
  else if (polarities.size > 1) status = 'CONTRADICTED';
  else if (polarities.has(CLAIM_POLARITIES.SUPPORTS)) status = 'SUPPORTED';
  else if (polarities.has(CLAIM_POLARITIES.REFUTES)) status = 'REFUTED';

  return deepFreeze({
    claimId,
    scope,
    asOf,
    status,
    candidateNodeIds: candidates.map((node) => node.id),
    frontierNodeIds: frontier.map((node) => node.id),
    contradictionEdgeIds: contradictions.map((edge) => edge.id),
    ranks: candidates.map((node) => ({ nodeId: node.id, ...rankEvidence(node, { asOf }) })),
  });
}

export function validateEvidencePoset(input) {
  try {
    const rebuilt = createEvidencePoset({ nodes: input?.nodes, edges: input?.edges, asOf: input?.asOf });
    const ok = canonicalJson(rebuilt) === canonicalJson(input);
    return deepFreeze({ ok, errors: ok ? [] : ['poset differs from its canonical derivation'] });
  } catch (error) {
    return deepFreeze({
      ok: false,
      errors: [{
        code: error?.code ?? 'UNEXPECTED_ERROR',
        message: error?.message ?? String(error),
      }],
    });
  }
}
