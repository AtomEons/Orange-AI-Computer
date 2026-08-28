import {
  SYSTEMS_LAW_REGISTRY_SCHEMA,
  SYSTEMS_LAW_SOURCE,
  SYSTEMS_LAW_STATUS,
  hashSystemsLawValue,
} from './registry.mjs';

export const SYSTEMS_LAW_COMPILED_SCHEMA = 'orange5.systems-design-law.compiled.v1';
export const SYSTEMS_LAW_REPORT_SCHEMA = 'orange5.systems-design-law.report.v1';
export const SYSTEMS_LAW_AUDIT_SCHEMA = 'orange5.systems-design-law.audit.v1';

const POLICY_RULES = Object.freeze({
  'GSA-007': Object.freeze([
    rule('source-identity-present', 'source.identity', 'present'),
    rule('source-hash-present', 'source.hash', 'present'),
    rule('source-bytes-immutable', 'source.bytesImmutable', 'equals', true),
    rule('source-hash-verified', 'source.hashVerified', 'equals', true),
    rule('projection-source-bound', 'projection.sourceHash', 'same-as', 'source.hash'),
    rule('transform-version-present', 'projection.transformVersion', 'present'),
    rule('unknown-fields-preserved', 'projection.unknownFieldsPreserved', 'equals', true),
    rule('characters-preserved', 'projection.charactersPreserved', 'equals', true),
    rule('projection-rebuildable', 'projection.rebuildable', 'equals', true),
    rule('authority-not-widened', 'authority.widened', 'equals', false),
    rule('authority-preserved', 'projection.authorityPreserved', 'equals', true),
    rule('retention-preserved', 'projection.retentionPreserved', 'equals', true),
    rule('exact-source-hydratable', 'hydration.exactSourceAvailable', 'equals', true),
  ]),
  'GSA-008': Object.freeze([
    rule('feedback-explicit', 'feedback.explicit', 'equals', true),
    rule('feedback-attributable', 'feedback.attributedToOperator', 'equals', true),
    rule('no-model-generated-labels', 'feedback.modelGenerated', 'equals', false),
    rule('project-isolated', 'feedback.projectScoped', 'equals', true),
    rule('no-cross-project-influence', 'scope.crossProjectInfluence', 'equals', false),
    rule('temporal-holdout', 'training.temporalHoldout', 'equals', true),
    rule('ranking-replayable', 'ranking.replayable', 'equals', true),
    rule('rollback-exact-parity', 'rollback.exactParity', 'equals', true),
    rule('ndcg-gain', 'metrics.ndcgAt10Gain', 'gte', 0.02),
    rule('exact-id-recall-preserved', 'metrics.exactIdentifierRecallDelta', 'gte', 0),
  ]),
  'GSA-010': Object.freeze([
    rule('observations-append-only', 'observations.appendOnly', 'equals', true),
    rule('history-not-rewritten', 'history.rewritten', 'equals', false),
    rule('no-lookahead', 'evaluation.lookaheadUsed', 'equals', false),
    rule('old-baseline-retained', 'baseline.oldScoreRetained', 'equals', true),
    rule('explicit-change-point', 'baseline.explicitChangePoint', 'equals', true),
    rule('minimum-sample-count', 'baseline.minimumSampleCountMet', 'equals', true),
    rule('stationary-false-alarm-bound', 'metrics.stationaryFalseAlarmRate', 'lte', 0.05),
    rule('seeded-drift-detected', 'metrics.seededDriftDetected', 'equals', true),
    rule('detection-delay-bound', 'metrics.maxDetectionDelaySamples', 'lte', 20),
    rule('beats-stronger-baseline', 'metrics.beatsStrongerBaseline', 'equals', true),
  ]),
});

const ALLOWED_OPERATORS = new Set(['equals', 'present', 'same-as', 'gte', 'lte']);
const AUTHORITATIVE_STATUSES = new Set([SYSTEMS_LAW_STATUS.ACTIVE, SYSTEMS_LAW_STATUS.SHADOW]);

export class SystemsLawCompilerError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'SystemsLawCompilerError';
    this.code = code;
    this.details = details;
  }
}

export class SystemsLawViolationError extends Error {
  constructor(report) {
    super(`active systems design law checks rejected ${report.summary.activeFailures} policy set(s)`);
    this.name = 'SystemsLawViolationError';
    this.code = 'ACTIVE_SYSTEMS_LAW_REJECTED';
    this.report = report;
  }
}

function fail(code, message, details) {
  throw new SystemsLawCompilerError(code, message, details);
}

function rule(id, path, operator, expected) {
  const value = { id, path, operator };
  if (expected !== undefined) {
    if (operator === 'same-as') value.expectedPath = expected;
    else value.expected = expected;
  }
  return Object.freeze(value);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function payloadWithoutHash(value, hashField) {
  const payload = {};
  for (const [key, item] of Object.entries(value)) {
    if (key !== hashField) payload[key] = item;
  }
  return payload;
}

function reviewedSourcePins() {
  return Object.values(SYSTEMS_LAW_SOURCE)
    .map((source) => ({ document: source.document, sha256: source.sha256 }));
}

function validateRegistry(registry) {
  if (!registry || typeof registry !== 'object' || registry.schema !== SYSTEMS_LAW_REGISTRY_SCHEMA) {
    fail('INVALID_REGISTRY', `registry must use ${SYSTEMS_LAW_REGISTRY_SCHEMA}`);
  }
  if (!Array.isArray(registry.records)) fail('INVALID_REGISTRY', 'registry.records must be an array');
  const observedHash = hashSystemsLawValue(payloadWithoutHash(registry, 'registryHash'));
  if (registry.registryHash !== observedHash) {
    fail('REGISTRY_HASH_MISMATCH', 'registry content does not match its registry hash');
  }

  const expectedSources = reviewedSourcePins();
  if (hashSystemsLawValue(registry.sources) !== hashSystemsLawValue(expectedSources)) {
    fail('REGISTRY_SOURCE_MISMATCH', 'registry sources do not match the reviewed source pins');
  }

  const sourceHashes = new Map(registry.sources.map((source) => [source.document, source.sha256]));
  const ids = new Set();
  for (const record of registry.records) {
    if (!record || typeof record !== 'object' || typeof record.id !== 'string' || !record.id) {
      fail('INVALID_REGISTRY_RECORD', 'registry contains a record without an id');
    }
    if (ids.has(record.id)) fail('DUPLICATE_RECORD_ID', `registry repeats ${record.id}`);
    ids.add(record.id);
    if (!record.provenance || sourceHashes.get(record.provenance.sourceDocument) !== record.provenance.sourceSha256) {
      fail('RECORD_SOURCE_MISMATCH', `${record.id} does not resolve to a pinned registry source`);
    }
  }
}

function validateRules(policyId, rules) {
  if (!Array.isArray(rules) || rules.length === 0) fail('MISSING_POLICY_RULES', `${policyId} has no runtime rules`);
  const ids = new Set();
  for (const candidate of rules) {
    if (typeof candidate.id !== 'string' || !candidate.id) fail('INVALID_RULE', `${policyId} has a rule without an id`);
    if (ids.has(candidate.id)) fail('DUPLICATE_RULE', `${policyId} repeats rule ${candidate.id}`);
    ids.add(candidate.id);
    if (typeof candidate.path !== 'string' || !candidate.path) fail('INVALID_RULE', `${candidate.id} has no observation path`);
    if (!ALLOWED_OPERATORS.has(candidate.operator)) fail('INVALID_RULE', `${candidate.id} has unsupported operator ${candidate.operator}`);
    if (candidate.operator === 'same-as' && typeof candidate.expectedPath !== 'string') {
      fail('INVALID_RULE', `${candidate.id} requires expectedPath`);
    }
  }
}

export function compileSystemsDesignLaws(registry) {
  validateRegistry(registry);
  const selected = registry.records
    .filter((record) => AUTHORITATIVE_STATUSES.has(record.status))
    .sort((left, right) => left.id.localeCompare(right.id));
  const selectedIds = new Set(selected.map((record) => record.id));

  for (const policyId of Object.keys(POLICY_RULES)) {
    if (!selectedIds.has(policyId)) {
      fail('POLICY_AUTHORITY_MISMATCH', `${policyId} has rules but is not active or shadow in the pinned adoption ledger`);
    }
  }

  const policies = selected.map((record) => {
    const rules = POLICY_RULES[record.id];
    validateRules(record.id, rules);
    return {
      id: record.id,
      title: record.title,
      status: record.status,
      mode: record.status === SYSTEMS_LAW_STATUS.ACTIVE ? 'enforce' : 'observe',
      owner: record.owner,
      enforcementPoint: record.enforcementPoint,
      invariant: record.invariant,
      falsifier: record.falsifier,
      failureThreshold: record.failureThreshold ?? record.rejectThreshold,
      rejectThreshold: record.rejectThreshold,
      evidenceRefs: record.evidenceRefs,
      receiptRefs: record.receiptRefs,
      provenance: record.provenance,
      sourceDecision: record.sourceDecision,
      rules,
    };
  });

  const payload = {
    schema: SYSTEMS_LAW_COMPILED_SCHEMA,
    version: 1,
    sourceRegistryHash: registry.registryHash,
    sourcePins: registry.sources,
    policies,
  };
  return deepFreeze({ ...payload, bundleHash: hashSystemsLawValue(payload) });
}

function readObservationPath(observation, path) {
  const parts = path.split('.');
  let value = observation;
  for (const part of parts) {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(part)) fail('INVALID_RULE_PATH', `invalid observation path ${path}`);
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, part)) return { found: false, value: null };
    value = value[part];
  }
  return { found: true, value };
}

function reportableValue(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return null;
}

function evaluateRule(candidate, observation) {
  const actualResult = readObservationPath(observation, candidate.path);
  let expected = Object.hasOwn(candidate, 'expected') ? candidate.expected : null;
  let pass = false;
  let reason = 'observation is missing';

  if (candidate.operator === 'present') {
    pass = actualResult.found
      && actualResult.value !== null
      && actualResult.value !== undefined
      && (typeof actualResult.value !== 'string' || actualResult.value.trim().length > 0);
    reason = pass ? 'present' : 'required observation is absent or empty';
  } else if (candidate.operator === 'same-as') {
    const expectedResult = readObservationPath(observation, candidate.expectedPath);
    expected = expectedResult.value;
    pass = actualResult.found && expectedResult.found && Object.is(actualResult.value, expectedResult.value);
    reason = pass ? 'matches referenced observation' : `must match ${candidate.expectedPath}`;
  } else if (candidate.operator === 'equals') {
    pass = actualResult.found && Object.is(actualResult.value, candidate.expected);
    reason = pass ? 'equal' : 'value differs from required value';
  } else if (candidate.operator === 'gte') {
    pass = actualResult.found && typeof actualResult.value === 'number'
      && Number.isFinite(actualResult.value) && actualResult.value >= candidate.expected;
    reason = pass ? 'within lower bound' : `must be at least ${candidate.expected}`;
  } else if (candidate.operator === 'lte') {
    pass = actualResult.found && typeof actualResult.value === 'number'
      && Number.isFinite(actualResult.value) && actualResult.value <= candidate.expected;
    reason = pass ? 'within upper bound' : `must be at most ${candidate.expected}`;
  }

  return {
    ruleId: candidate.id,
    path: candidate.path,
    operator: candidate.operator,
    pass,
    actual: reportableValue(actualResult.value),
    expected: reportableValue(expected),
    reason,
  };
}

function validateCompiledBundle(compiled) {
  if (!compiled || typeof compiled !== 'object' || compiled.schema !== SYSTEMS_LAW_COMPILED_SCHEMA) {
    fail('INVALID_COMPILED_BUNDLE', `compiled bundle must use ${SYSTEMS_LAW_COMPILED_SCHEMA}`);
  }
  if (!Array.isArray(compiled.policies)) fail('INVALID_COMPILED_BUNDLE', 'compiled.policies must be an array');
  if (!Array.isArray(compiled.sourcePins)) fail('INVALID_COMPILED_BUNDLE', 'compiled.sourcePins must be an array');
  const observedHash = hashSystemsLawValue(payloadWithoutHash(compiled, 'bundleHash'));
  if (compiled.bundleHash !== observedHash) fail('COMPILED_HASH_MISMATCH', 'compiled bundle hash is invalid');
  if (hashSystemsLawValue(compiled.sourcePins) !== hashSystemsLawValue(reviewedSourcePins())) {
    fail('COMPILED_SOURCE_MISMATCH', 'compiled source pins do not match the reviewed registry sources');
  }

  const ids = new Set();
  const sourceHashes = new Map(compiled.sourcePins.map((source) => [source.document, source.sha256]));
  const requiredStrings = [
    'id',
    'title',
    'owner',
    'enforcementPoint',
    'invariant',
    'falsifier',
    'failureThreshold',
    'rejectThreshold',
  ];
  for (const policy of compiled.policies) {
    if (!policy || typeof policy !== 'object') fail('INVALID_COMPILED_POLICY', 'compiled bundle contains a non-object policy');
    for (const field of requiredStrings) {
      if (typeof policy[field] !== 'string' || !policy[field].trim()) {
        fail('INVALID_COMPILED_POLICY', `${policy.id ?? 'unknown'} has invalid ${field}`);
      }
    }
    if (ids.has(policy.id)) fail('DUPLICATE_COMPILED_POLICY', `compiled bundle repeats ${policy.id}`);
    ids.add(policy.id);
    if (!AUTHORITATIVE_STATUSES.has(policy.status)) {
      fail('INVALID_COMPILED_POLICY', `${policy.id} has non-authoritative status ${policy.status}`);
    }
    const expectedMode = policy.status === SYSTEMS_LAW_STATUS.ACTIVE ? 'enforce' : 'observe';
    if (policy.mode !== expectedMode) fail('INVALID_COMPILED_POLICY', `${policy.id} mode does not match ${policy.status}`);
    if (!policy.provenance || typeof policy.provenance !== 'object') {
      fail('INVALID_COMPILED_POLICY', `${policy.id} lacks provenance`);
    }
    if (sourceHashes.get(policy.provenance.sourceDocument) !== policy.provenance.sourceSha256) {
      fail('COMPILED_POLICY_SOURCE_MISMATCH', `${policy.id} does not resolve to a compiled source pin`);
    }
    if (!Array.isArray(policy.evidenceRefs) || policy.evidenceRefs.length === 0) {
      fail('INVALID_COMPILED_POLICY', `${policy.id} lacks evidence refs`);
    }
    if (!Array.isArray(policy.receiptRefs)) fail('INVALID_COMPILED_POLICY', `${policy.id} lacks receipt refs`);
    validateRules(policy.id, policy.rules);
  }
}

export function queryCompiledSystemsDesignLaw(compiled, policyId) {
  validateCompiledBundle(compiled);
  if (typeof policyId !== 'string' || !policyId.trim()) {
    fail('INVALID_POLICY_QUERY', 'policy id must be a non-empty string');
  }
  return compiled.policies.find((policy) => policy.id === policyId) ?? null;
}

export function auditCompiledSystemsDesignLaws(compiled) {
  validateCompiledBundle(compiled);
  const sourceHashes = new Map(compiled.sourcePins.map((source) => [source.document, source.sha256]));
  const policies = compiled.policies.map((policy) => {
    const checks = {
      sourcePinned: sourceHashes.get(policy.provenance.sourceDocument) === policy.provenance.sourceSha256,
      ownerDeclared: policy.owner.trim().length > 0,
      enforcementPointDeclared: policy.enforcementPoint.trim().length > 0,
      falsifierDeclared: policy.falsifier.trim().length > 0,
      failureThresholdDeclared: policy.failureThreshold.trim().length > 0,
      evidenceReferenced: policy.evidenceRefs.length > 0,
      runtimeRulesPresent: policy.rules.length > 0,
      modeMatchesStatus: policy.mode === (policy.status === SYSTEMS_LAW_STATUS.ACTIVE ? 'enforce' : 'observe'),
    };
    const queryable = queryCompiledSystemsDesignLaw(compiled, policy.id)?.id === policy.id;
    return {
      id: policy.id,
      status: policy.status,
      mode: policy.mode,
      owner: policy.owner,
      enforcementPoint: policy.enforcementPoint,
      falsifier: policy.falsifier,
      failureThreshold: policy.failureThreshold,
      ruleIds: policy.rules.map((candidate) => candidate.id),
      provenance: policy.provenance,
      evidenceRefs: policy.evidenceRefs,
      receiptRefs: policy.receiptRefs,
      checks,
      queryable,
      auditable: Object.values(checks).every(Boolean),
    };
  });
  const payload = {
    schema: SYSTEMS_LAW_AUDIT_SCHEMA,
    version: 1,
    bundleHash: compiled.bundleHash,
    sourceRegistryHash: compiled.sourceRegistryHash,
    sourcePins: compiled.sourcePins,
    passed: policies.every((policy) => policy.queryable && policy.auditable),
    summary: {
      policies: policies.length,
      active: policies.filter((policy) => policy.mode === 'enforce').length,
      shadow: policies.filter((policy) => policy.mode === 'observe').length,
      queryable: policies.filter((policy) => policy.queryable).length,
      auditable: policies.filter((policy) => policy.auditable).length,
    },
    activePolicyIds: policies.filter((policy) => policy.mode === 'enforce').map((policy) => policy.id),
    shadowPolicyIds: policies.filter((policy) => policy.mode === 'observe').map((policy) => policy.id),
    policies,
  };
  return deepFreeze({ ...payload, auditHash: hashSystemsLawValue(payload) });
}

export function evaluateSystemsDesignLaws(compiled, observations = {}) {
  validateCompiledBundle(compiled);
  if (!observations || typeof observations !== 'object' || Array.isArray(observations)) {
    fail('INVALID_OBSERVATIONS', 'observations must be an object keyed by policy id');
  }

  const policies = compiled.policies.map((policy) => {
    const observation = Object.hasOwn(observations, policy.id) ? observations[policy.id] : {};
    const checks = policy.rules.map((candidate) => evaluateRule(candidate, observation));
    const passed = checks.every((check) => check.pass);
    return {
      id: policy.id,
      title: policy.title,
      status: policy.status,
      mode: policy.mode,
      passed,
      decision: passed ? 'pass' : policy.mode === 'enforce' ? 'reject' : 'shadow_reject',
      failedRuleIds: checks.filter((check) => !check.pass).map((check) => check.ruleId),
      checks,
    };
  });

  const activeFailures = policies.filter((policy) => policy.mode === 'enforce' && !policy.passed).length;
  const shadowFailures = policies.filter((policy) => policy.mode === 'observe' && !policy.passed).length;
  const payload = {
    schema: SYSTEMS_LAW_REPORT_SCHEMA,
    version: 1,
    bundleHash: compiled.bundleHash,
    allowed: activeFailures === 0,
    summary: {
      policies: policies.length,
      active: policies.filter((policy) => policy.mode === 'enforce').length,
      shadow: policies.filter((policy) => policy.mode === 'observe').length,
      activeFailures,
      shadowFailures,
    },
    policies,
  };
  return deepFreeze({ ...payload, reportHash: hashSystemsLawValue(payload) });
}

export function assertActiveSystemsDesignLaws(report) {
  if (!report || report.schema !== SYSTEMS_LAW_REPORT_SCHEMA) {
    fail('INVALID_REPORT', `report must use ${SYSTEMS_LAW_REPORT_SCHEMA}`);
  }
  if (!report.allowed) throw new SystemsLawViolationError(report);
  return report;
}
