import { createHash } from 'node:crypto';

export const OUTCOME_RECEIPT_SCHEMA = 'orange5.outcome-receipt.alpha.v1';
export const OUTCOME_ALPHA_PROOF_SCHEMA = 'orange5.outcome-receipt.alpha-proof.v1';
export const OUTCOME_RECEIPT_MODE = 'ALPHA_PROOF_ONLY';
export const RECEIPT_GENESIS = 'GENESIS';
export const TERMINAL_OUTCOMES = Object.freeze({
  PROVEN: 'PROVEN',
  REFUSED: 'REFUSED',
});
export const OUTCOME_DOMAINS = Object.freeze(['file', 'process', 'http', 'artifact']);

const CANONICALIZATION = 'orange5.canonical-json.sorted-keys.v1';
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const WAVE3_ACTIVATION_PATTERN = /^[a-f0-9]{25}$/;
const RESERVED_TERMINAL_KEY = 'terminal_outcome';
const ARTIFACT_HASH_FIELD = Object.freeze({
  file: 'content_sha256',
  process: 'executable_sha256',
  http: 'body_sha256',
  artifact: 'content_sha256',
});

export class OutcomeReceiptError extends Error {
  constructor(message, code = 'OUTCOME_RECEIPT_ERROR') {
    super(message);
    this.name = 'OutcomeReceiptError';
    this.code = code;
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalPart(value, ancestors, location) {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new OutcomeReceiptError(`non-finite number at ${location}`, 'NON_CANONICAL_VALUE');
    }
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') {
    throw new OutcomeReceiptError(`unsupported canonical value at ${location}`, 'NON_CANONICAL_VALUE');
  }
  if (ancestors.has(value)) {
    throw new OutcomeReceiptError(`cyclic canonical value at ${location}`, 'NON_CANONICAL_VALUE');
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item, index) => canonicalPart(item, ancestors, `${location}[${index}]`)).join(',')}]`;
    }
    if (!isPlainObject(value)) {
      throw new OutcomeReceiptError(`non-plain object at ${location}`, 'NON_CANONICAL_VALUE');
    }
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalPart(value[key], ancestors, `${location}.${key}`)}`
    )).join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalJson(value) {
  return canonicalPart(value, new Set(), '$');
}

export function sha256Bytes(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function sha256Canonical(value) {
  return sha256Bytes(canonicalJson(value));
}

function canonicalClone(value) {
  return JSON.parse(canonicalJson(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function nonEmptyText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validHash(value) {
  return typeof value === 'string' && HASH_PATTERN.test(value);
}

function wave3ActiveIds(activationBitset) {
  const bits = [...activationBitset]
    .map((nibble) => Number.parseInt(nibble, 16).toString(2).padStart(4, '0'))
    .join('');
  return [...bits]
    .map((bit, index) => bit === '1' ? `W3K-${String(index + 1).padStart(3, '0')}` : null)
    .filter(Boolean);
}

function wave3Hex(value, pattern, field, code) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!pattern.test(normalized)) {
    throw new OutcomeReceiptError(`wave3Kernel ${field} is invalid`, code);
  }
  return normalized;
}

export function normalizeWave3KernelSummary(value) {
  if (value == null) return null;
  if (!isPlainObject(value)) {
    throw new OutcomeReceiptError('wave3Kernel summary must be an object', 'INVALID_WAVE3_KERNEL_SUMMARY');
  }
  const activationBitset = wave3Hex(
    value.activationBitset ?? value.activation_bitset,
    WAVE3_ACTIVATION_PATTERN,
    'activationBitset',
    'INVALID_WAVE3_KERNEL_ACTIVATION_BITSET',
  );
  const manifestHash = wave3Hex(
    value.manifestHash ?? value.manifest_hash,
    HASH_PATTERN,
    'manifestHash',
    'INVALID_WAVE3_KERNEL_MANIFEST_HASH',
  );
  const worksetHash = wave3Hex(
    value.worksetHash ?? value.workset_hash,
    HASH_PATTERN,
    'worksetHash',
    'INVALID_WAVE3_KERNEL_WORKSET_HASH',
  );
  const suppliedIds = value.activeMechanismIds
    ?? value.active_mechanism_ids
    ?? value.activeIds
    ?? value.active_ids;
  if (!Array.isArray(suppliedIds)) {
    throw new OutcomeReceiptError(
      'wave3Kernel activeMechanismIds must be an array',
      'INVALID_WAVE3_KERNEL_ACTIVE_IDS',
    );
  }
  const normalizedIds = suppliedIds.map((id) => String(id ?? '').trim().toUpperCase());
  const activeMechanismIds = wave3ActiveIds(activationBitset);
  const suppliedSet = new Set(normalizedIds);
  if (suppliedSet.size !== normalizedIds.length
    || suppliedSet.size !== activeMechanismIds.length
    || activeMechanismIds.some((id) => !suppliedSet.has(id))) {
    throw new OutcomeReceiptError(
      'wave3Kernel activationBitset does not match activeMechanismIds',
      'WAVE3_KERNEL_ACTIVATION_MISMATCH',
    );
  }
  return { activationBitset, manifestHash, worksetHash, activeMechanismIds };
}

function sameWave3Kernel(left, right) {
  return left?.activationBitset === right?.activationBitset
    && left?.manifestHash === right?.manifestHash
    && left?.worksetHash === right?.worksetHash
    && Array.isArray(left?.activeMechanismIds)
    && Array.isArray(right?.activeMechanismIds)
    && left.activeMechanismIds.length === right.activeMechanismIds.length
    && left.activeMechanismIds.every((id, index) => id === right.activeMechanismIds[index]);
}

export function extractWave3KernelSummary(value = {}) {
  const containers = [
    value,
    value.request,
    value.request?.workObject,
    value.request?.work_object,
  ].filter((container) => container && typeof container === 'object');
  const candidates = containers
    .flatMap((container) => [container.wave3Kernel, container.wave3_kernel])
    .filter((candidate) => candidate != null)
    .map(normalizeWave3KernelSummary);
  if (candidates.length === 0) return null;
  if (candidates.some((candidate) => !sameWave3Kernel(candidate, candidates[0]))) {
    throw new OutcomeReceiptError(
      'outcome receipt contains conflicting wave3Kernel summaries',
      'WAVE3_KERNEL_SUMMARY_CONFLICT',
    );
  }
  return candidates[0];
}

function validIdentity(identity) {
  return isPlainObject(identity)
    && nonEmptyText(identity.id)
    && validHash(identity.implementation_sha256);
}

function canonicalEqual(left, right) {
  try {
    return canonicalJson(left) === canonicalJson(right);
  } catch {
    return false;
  }
}

function safeCanonicalHash(value) {
  try {
    return sha256Canonical(value === undefined ? null : value);
  } catch {
    return null;
  }
}

function artifactHash(domain, state) {
  const field = ARTIFACT_HASH_FIELD[domain];
  return field && isPlainObject(state) ? (state[field] ?? null) : null;
}

function countKey(value, key) {
  if (!value || typeof value !== 'object') return 0;
  if (Array.isArray(value)) return value.reduce((total, child) => total + countKey(child, key), 0);
  return Object.entries(value).reduce(
    (total, [childKey, child]) => total + Number(childKey === key) + countKey(child, key),
    0,
  );
}

export function countTerminalOutcomes(value) {
  return countKey(value, RESERVED_TERMINAL_KEY);
}

function assertNoTerminalOutcome(value, location = '$') {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertNoTerminalOutcome(child, `${location}[${index}]`));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === RESERVED_TERMINAL_KEY) {
      throw new OutcomeReceiptError(
        `reserved terminal outcome key at ${location}.${key}`,
        'RESERVED_TERMINAL_OUTCOME',
      );
    }
    assertNoTerminalOutcome(child, `${location}.${key}`);
  }
}

function expectedScope(request) {
  return {
    domain: request?.domain ?? null,
    expected_state_sha256: request?.expected_state_sha256 ?? null,
    target: request?.target ?? null,
  };
}

function componentHashes(input, oracle) {
  const hashes = {
    authorization_sha256: safeCanonicalHash(input.authorization),
    executor_attestation_sha256: safeCanonicalHash(input.executor_attestation),
    independent_oracle_sha256: safeCanonicalHash(oracle),
    independent_verifier_sha256: safeCanonicalHash(input.independent_verifier),
    observed_effect_sha256: safeCanonicalHash(input.observed_effect),
    request_sha256: safeCanonicalHash(input.request),
  };
  if (input.wave3Kernel) hashes.wave3_kernel_sha256 = safeCanonicalHash(input.wave3Kernel);
  return hashes;
}

function artifactStateHashes(input, oracle) {
  const domain = input.request?.domain;
  return {
    expected_artifact_sha256: artifactHash(domain, input.request?.expected_state),
    expected_state_sha256: safeCanonicalHash(input.request?.expected_state),
    observed_artifact_sha256: artifactHash(domain, input.observed_effect?.state),
    observed_state_sha256: safeCanonicalHash(input.observed_effect?.state),
    oracle_artifact_sha256: artifactHash(domain, oracle?.state),
    oracle_state_sha256: safeCanonicalHash(oracle?.state),
  };
}

function assess(input, oracle, proposals) {
  const refusalCodes = [];
  const add = (condition, code) => {
    if (condition && !refusalCodes.includes(code)) refusalCodes.push(code);
  };
  const request = input.request ?? {};
  const authorization = input.authorization ?? {};
  const executor = input.executor_attestation ?? {};
  const observation = input.observed_effect ?? {};
  const verifier = input.independent_verifier ?? {};
  const limitations = input.limitations;
  const claim = input.public_claim ?? {};
  const expectedStateHash = safeCanonicalHash(request.expected_state);
  const observedStateHash = safeCanonicalHash(observation.state);
  const oracleStateHash = safeCanonicalHash(oracle?.state);
  const expectedArtifactHash = artifactHash(request.domain, request.expected_state);
  const observedArtifactHash = artifactHash(request.domain, observation.state);
  const oracleArtifactHash = artifactHash(request.domain, oracle?.state);
  const oracleSatisfied = canonicalEqual(request.expected_state, oracle?.state);
  const observationMatchesOracle = canonicalEqual(observation.state, oracle?.state);
  const expectedObservationHash = safeCanonicalHash(observation);
  const expectedScopeHash = safeCanonicalHash(expectedScope(request));

  add(!nonEmptyText(input.receipt_id), 'MISSING_RECEIPT_ID');
  add(!nonEmptyText(input.issued_at) || Number.isNaN(Date.parse(input.issued_at)), 'INVALID_ISSUED_AT');
  add(!nonEmptyText(request.request_id), 'MISSING_REQUEST_ID');
  add(!OUTCOME_DOMAINS.includes(request.domain), 'UNSUPPORTED_OUTCOME_DOMAIN');
  add(!nonEmptyText(request.target), 'MISSING_REQUEST_TARGET');
  add(request.expected_state_sha256 !== expectedStateHash, 'EXPECTED_STATE_HASH_MISMATCH');
  add(request.expected_artifact_sha256 !== expectedArtifactHash, 'EXPECTED_ARTIFACT_HASH_MISMATCH');

  add(authorization.granted !== true, 'AUTHORIZATION_NOT_GRANTED');
  add(authorization.request_id !== request.request_id, 'AUTHORIZATION_REQUEST_MISMATCH');
  add(!nonEmptyText(authorization.authorization_id), 'MISSING_AUTHORIZATION_ID');
  add(!nonEmptyText(authorization.principal?.id), 'MISSING_AUTHORIZER_IDENTITY');
  add(authorization.scope_sha256 !== expectedScopeHash, 'AUTHORIZATION_SCOPE_MISMATCH');

  add(!validIdentity(executor.identity), 'EXECUTOR_IDENTITY_MISSING');
  add(executor.request_id !== request.request_id, 'EXECUTOR_REQUEST_MISMATCH');
  add(executor.authorization_id !== authorization.authorization_id, 'EXECUTOR_AUTHORIZATION_MISMATCH');
  add(executor.claimed_success !== oracleSatisfied, 'EXECUTOR_ORACLE_DISAGREEMENT');
  add(executor.claimed_state_sha256 !== oracleStateHash, 'EXECUTOR_STATE_ORACLE_MISMATCH');

  add(!validIdentity(oracle?.identity), 'ORACLE_IDENTITY_MISSING');
  add(oracle?.identity?.id === executor.identity?.id, 'ORACLE_NOT_INDEPENDENT');
  add(oracle?.identity?.id === verifier.identity?.id, 'ORACLE_VERIFIER_IDENTITY_COLLISION');
  add(oracle?.request_id !== request.request_id, 'ORACLE_REQUEST_MISMATCH');
  add(oracle?.target !== request.target, 'ORACLE_TARGET_MISMATCH');
  add(oracle?.state_sha256 !== oracleStateHash, 'ORACLE_STATE_HASH_MISMATCH');
  add(oracle?.artifact_sha256 !== oracleArtifactHash, 'ORACLE_ARTIFACT_HASH_MISMATCH');
  add(!oracleSatisfied, 'ORACLE_EFFECT_NOT_SATISFIED');

  add(!validIdentity(observation.observer_identity), 'OBSERVER_IDENTITY_MISSING');
  add(observation.request_id !== request.request_id, 'OBSERVATION_REQUEST_MISMATCH');
  add(observation.target !== request.target, 'OBSERVATION_TARGET_MISMATCH');
  add(observation.state_sha256 !== observedStateHash, 'OBSERVED_STATE_HASH_MISMATCH');
  add(observation.artifact_sha256 !== observedArtifactHash, 'OBSERVED_ARTIFACT_HASH_MISMATCH');
  add(!observationMatchesOracle, 'OBSERVATION_ORACLE_MISMATCH');

  const timeline = [
    authorization.authorized_at_ms,
    executor.completed_at_ms,
    observation.observed_at_ms,
    oracle?.captured_at_ms,
    verifier.verified_at_ms,
  ];
  const timelineValid = timeline.every(Number.isFinite)
    && Number.isFinite(input.max_observation_age_ms)
    && input.max_observation_age_ms >= 0;
  add(!timelineValid, 'INVALID_EVIDENCE_TIMELINE');
  if (timelineValid) {
    add(executor.completed_at_ms < authorization.authorized_at_ms, 'EXECUTION_PRECEDES_AUTHORIZATION');
    add(observation.observed_at_ms < executor.completed_at_ms, 'OBSERVATION_PRECEDES_EXECUTION');
    add(oracle.captured_at_ms < observation.observed_at_ms, 'ORACLE_PRECEDES_OBSERVATION');
    add(
      oracle.captured_at_ms - observation.observed_at_ms > input.max_observation_age_ms,
      'STALE_OBSERVATION',
    );
    add(verifier.verified_at_ms < oracle.captured_at_ms, 'VERIFICATION_PRECEDES_ORACLE');
  }

  add(!validIdentity(verifier.identity), 'VERIFIER_IDENTITY_MISSING');
  add(verifier.identity?.id === executor.identity?.id, 'VERIFIER_NOT_INDEPENDENT');
  add(verifier.request_id !== request.request_id, 'VERIFIER_REQUEST_MISMATCH');
  add(verifier.observed_effect_sha256 !== expectedObservationHash, 'VERIFIER_OBSERVATION_HASH_MISMATCH');
  add(verifier.oracle_state_sha256 !== oracleStateHash, 'VERIFIER_ORACLE_HASH_MISMATCH');
  add(verifier.effect_satisfied !== oracleSatisfied, 'VERIFIER_ORACLE_DISAGREEMENT');

  const limitationsValid = Array.isArray(limitations)
    && limitations.every(nonEmptyText)
    && new Set(limitations).size === limitations.length;
  add(!limitationsValid, 'INVALID_LIMITATIONS');
  add(claim.request_id !== request.request_id, 'PUBLIC_CLAIM_REQUEST_MISMATCH');
  add(!nonEmptyText(claim.statement), 'PUBLIC_CLAIM_STATEMENT_MISSING');
  add(!canonicalEqual(claim.limitations, limitations), 'LIMITATIONS_NOT_CARRIED');

  add(proposals.length === 0, 'MISSING_TERMINAL_ATTEMPT');
  add(proposals.length > 1, 'DUPLICATE_TERMINAL_ATTEMPT');
  add(proposals.some((proposal) => !Object.values(TERMINAL_OUTCOMES).includes(proposal)), 'INVALID_TERMINAL_ATTEMPT');
  add(proposals.length === 1 && proposals[0] !== TERMINAL_OUTCOMES.PROVEN, 'TERMINAL_PROPOSAL_REFUSED');

  const terminalOutcome = refusalCodes.length === 0
    ? TERMINAL_OUTCOMES.PROVEN
    : TERMINAL_OUTCOMES.REFUSED;
  const publicLimitations = Array.isArray(limitations) ? limitations : [];
  const publicClaim = {
    claim_id: nonEmptyText(claim.claim_id) ? claim.claim_id : `claim:${request.request_id ?? 'unknown'}`,
    evidence_receipt_id: input.receipt_id ?? null,
    limitations: publicLimitations,
    request_id: request.request_id ?? null,
    statement: terminalOutcome === TERMINAL_OUTCOMES.PROVEN
      ? claim.statement
      : `Outcome for ${request.request_id ?? 'unknown request'} is not proven.`,
  };
  const evidenceCurrent = timelineValid
    && executor.completed_at_ms >= authorization.authorized_at_ms
    && observation.observed_at_ms >= executor.completed_at_ms
    && oracle.captured_at_ms >= observation.observed_at_ms
    && oracle.captured_at_ms - observation.observed_at_ms <= input.max_observation_age_ms
    && verifier.verified_at_ms >= oracle.captured_at_ms;

  return {
    artifact_state_hashes: artifactStateHashes(input, oracle),
    component_hashes: componentHashes(input, oracle),
    public_claim: publicClaim,
    terminal_outcome: terminalOutcome,
    terminal_protocol: {
      attempt_count: proposals.length,
      attempts_sha256: safeCanonicalHash(proposals),
      duplicate_attempt_refused: proposals.length > 1,
      exactly_one_attempt: proposals.length === 1,
      proposals,
    },
    verification: {
      evidence_current: evidenceCurrent,
      observed_matches_oracle: observationMatchesOracle,
      oracle_effect_satisfied: oracleSatisfied,
      refusal_codes: refusalCodes,
      verifier_matches_oracle: verifier.effect_satisfied === oracleSatisfied,
    },
  };
}

export function chainCanonicalRecord(body, { previousReceiptHash = RECEIPT_GENESIS } = {}) {
  const canonicalBody = canonicalClone(body);
  if (Object.hasOwn(canonicalBody, 'chain')) {
    throw new OutcomeReceiptError('canonical record body already has a chain', 'CHAIN_ALREADY_PRESENT');
  }
  if (previousReceiptHash !== RECEIPT_GENESIS && !validHash(previousReceiptHash)) {
    throw new OutcomeReceiptError('invalid previous receipt hash', 'INVALID_PREVIOUS_RECEIPT_HASH');
  }
  if (countTerminalOutcomes(canonicalBody) !== 1) {
    throw new OutcomeReceiptError(
      'canonical record must contain exactly one terminal outcome',
      'TERMINAL_OUTCOME_CARDINALITY',
    );
  }
  const unsigned = {
    ...canonicalBody,
    chain: {
      algorithm: 'sha256',
      canonicalization: CANONICALIZATION,
      previous_receipt_hash: previousReceiptHash,
    },
  };
  const receipt = {
    ...unsigned,
    chain: {
      ...unsigned.chain,
      receipt_hash: sha256Canonical(unsigned),
    },
  };
  return deepFreeze(receipt);
}

export function verifyCanonicalRecord(record, { expectedPreviousReceiptHash } = {}) {
  const errors = [];
  try {
    const candidate = canonicalClone(record);
    const chain = candidate.chain;
    if (!isPlainObject(chain)) return { ok: false, errors: ['CHAIN_MISSING'] };
    const claimedHash = chain.receipt_hash;
    delete chain.receipt_hash;
    if (chain.algorithm !== 'sha256') errors.push('CHAIN_ALGORITHM_MISMATCH');
    if (chain.canonicalization !== CANONICALIZATION) errors.push('CHAIN_CANONICALIZATION_MISMATCH');
    if (chain.previous_receipt_hash !== RECEIPT_GENESIS && !validHash(chain.previous_receipt_hash)) {
      errors.push('PREVIOUS_RECEIPT_HASH_INVALID');
    }
    if (expectedPreviousReceiptHash !== undefined
      && chain.previous_receipt_hash !== expectedPreviousReceiptHash) {
      errors.push('PREVIOUS_RECEIPT_HASH_MISMATCH');
    }
    if (!validHash(claimedHash) || sha256Canonical(candidate) !== claimedHash) {
      errors.push('RECEIPT_HASH_MISMATCH');
    }
    if (countTerminalOutcomes(record) !== 1) errors.push('TERMINAL_OUTCOME_CARDINALITY');
  } catch {
    errors.push('RECEIPT_NOT_CANONICAL_DATA');
  }
  return { ok: errors.length === 0, errors: [...new Set(errors)] };
}

export class OutcomeReceiptSession {
  #input;
  #proposals = [];
  #sealed = false;

  constructor(input) {
    assertNoTerminalOutcome(input);
    const canonicalInput = canonicalClone(input);
    const wave3Kernel = extractWave3KernelSummary(canonicalInput);
    if (wave3Kernel) canonicalInput.wave3Kernel = wave3Kernel;
    this.#input = canonicalInput;
  }

  proposeTerminal(outcome) {
    if (this.#sealed) {
      throw new OutcomeReceiptError('outcome receipt is already sealed', 'RECEIPT_ALREADY_SEALED');
    }
    if (!Object.values(TERMINAL_OUTCOMES).includes(outcome)) {
      throw new OutcomeReceiptError(`unsupported terminal proposal: ${outcome}`, 'INVALID_TERMINAL_ATTEMPT');
    }
    this.#proposals.push(outcome);
    return this;
  }

  seal({ oracle, previousReceiptHash = RECEIPT_GENESIS, sequence = 1 } = {}) {
    if (this.#sealed) {
      throw new OutcomeReceiptError('outcome receipt is already sealed', 'RECEIPT_ALREADY_SEALED');
    }
    if (!Number.isSafeInteger(sequence) || sequence < 1) {
      throw new OutcomeReceiptError('receipt sequence must be a positive safe integer', 'INVALID_RECEIPT_SEQUENCE');
    }
    assertNoTerminalOutcome(oracle, '$.oracle');
    const canonicalOracle = canonicalClone(oracle);
    const proposals = canonicalClone(this.#proposals);
    const assessment = assess(this.#input, canonicalOracle, proposals);
    this.#sealed = true;
    return chainCanonicalRecord({
      schema: OUTCOME_RECEIPT_SCHEMA,
      mode: OUTCOME_RECEIPT_MODE,
      production_wired: false,
      receipt_id: this.#input.receipt_id ?? null,
      issued_at: this.#input.issued_at ?? null,
      sequence,
      ...(this.#input.wave3Kernel ? { wave3Kernel: this.#input.wave3Kernel } : {}),
      request: this.#input.request ?? null,
      authorization: this.#input.authorization ?? null,
      executor_attestation: this.#input.executor_attestation ?? null,
      observed_effect: this.#input.observed_effect ?? null,
      independent_verifier: this.#input.independent_verifier ?? null,
      independent_oracle: canonicalOracle,
      artifact_state_hashes: assessment.artifact_state_hashes,
      binding_hashes: assessment.component_hashes,
      limitations: this.#input.limitations ?? null,
      claim_submission: this.#input.public_claim ?? null,
      public_claim: assessment.public_claim,
      max_observation_age_ms: this.#input.max_observation_age_ms ?? null,
      terminal_protocol: assessment.terminal_protocol,
      verification: assessment.verification,
      terminal_outcome: assessment.terminal_outcome,
    }, { previousReceiptHash });
  }
}

export function verifyOutcomeReceipt(receipt, { expectedPreviousReceiptHash } = {}) {
  const errors = [];
  const chainResult = verifyCanonicalRecord(receipt, { expectedPreviousReceiptHash });
  errors.push(...chainResult.errors);
  try {
    const candidate = canonicalClone(receipt);
    if (candidate.schema !== OUTCOME_RECEIPT_SCHEMA) errors.push('OUTCOME_RECEIPT_SCHEMA_MISMATCH');
    if (candidate.mode !== OUTCOME_RECEIPT_MODE || candidate.production_wired !== false) {
      errors.push('PRODUCTION_ISOLATION_MISMATCH');
    }
    let wave3Kernel = null;
    try {
      wave3Kernel = extractWave3KernelSummary(candidate);
      if (wave3Kernel && !candidate.wave3Kernel) {
        errors.push('WAVE3_KERNEL_SUMMARY_MISSING');
      } else if (wave3Kernel && !sameWave3Kernel(candidate.wave3Kernel, wave3Kernel)) {
        errors.push('WAVE3_KERNEL_SUMMARY_NON_CANONICAL');
      }
    } catch (error) {
      errors.push(error instanceof OutcomeReceiptError ? error.code : 'INVALID_WAVE3_KERNEL_SUMMARY');
    }
    const input = {
      authorization: candidate.authorization,
      executor_attestation: candidate.executor_attestation,
      independent_verifier: candidate.independent_verifier,
      issued_at: candidate.issued_at,
      limitations: candidate.limitations,
      max_observation_age_ms: candidate.max_observation_age_ms,
      observed_effect: candidate.observed_effect,
      public_claim: candidate.claim_submission,
      receipt_id: candidate.receipt_id,
      request: candidate.request,
      ...(wave3Kernel ? { wave3Kernel } : {}),
    };
    const proposals = candidate.terminal_protocol?.proposals ?? [];
    const assessment = assess(input, candidate.independent_oracle, proposals);
    if (candidate.terminal_outcome !== assessment.terminal_outcome) {
      errors.push('TERMINAL_OUTCOME_MISMATCH');
    }
    if (!canonicalEqual(candidate.verification, assessment.verification)) {
      errors.push('VERIFICATION_SUMMARY_MISMATCH');
    }
    if (!canonicalEqual(candidate.terminal_protocol, assessment.terminal_protocol)) {
      errors.push('TERMINAL_PROTOCOL_MISMATCH');
    }
    if (!canonicalEqual(candidate.public_claim, assessment.public_claim)) {
      errors.push('PUBLIC_CLAIM_MISMATCH');
    }
    if (!canonicalEqual(candidate.artifact_state_hashes, assessment.artifact_state_hashes)) {
      errors.push('ARTIFACT_STATE_HASH_BINDING_MISMATCH');
    }
    if (!canonicalEqual(candidate.binding_hashes, assessment.component_hashes)) {
      errors.push('COMPONENT_HASH_BINDING_MISMATCH');
    }
  } catch {
    errors.push('OUTCOME_RECEIPT_SEMANTIC_VALIDATION_FAILED');
  }
  return { ok: errors.length === 0, errors: [...new Set(errors)] };
}
