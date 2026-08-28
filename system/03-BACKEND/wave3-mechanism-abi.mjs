import { createHash } from 'node:crypto';

export const WAVE3_MECHANISM_ABI_SCHEMA = 'orange.wave3-mechanism-abi.v1';
export const WAVE3_CONSTITUTION_SCHEMA = 'orange.wave3-constitution-resolution.v1';

const STOP_WORDS = new Set([
  'and', 'from', 'into', 'only', 'with', 'without', 'the', 'for', 'not', 'one',
  'computer', 'orange', 'system', 'systems', 'work', 'working', 'mechanism',
]);

const STAGE_BY_ORGAN = Object.freeze({
  'W3O-01': 'retrieve',
  'W3O-02': 'formulate',
  'W3O-03': 'preserve',
  'W3O-04': 'learn',
  'W3O-05': 'route',
  'W3O-06': 'observe',
  'W3O-07': 'verify',
  'W3O-08': 'compress',
  'W3O-09': 'govern',
  'W3O-10': 'orchestrate',
});

const CONSTITUTION = Object.freeze([
  Object.freeze({ tier: 0, authority: 'operator_authority' }),
  Object.freeze({ tier: 1, authority: 'source_truth' }),
  Object.freeze({ tier: 2, authority: 'safety_and_custody' }),
  Object.freeze({ tier: 3, authority: 'semantic_fidelity' }),
  Object.freeze({ tier: 4, authority: 'requested_outcome' }),
  Object.freeze({ tier: 5, authority: 'optimization' }),
]);

const AUTHORITY_TIER = new Map(CONSTITUTION.map((entry) => [entry.authority, entry.tier]));

function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function sha256(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : canonicalJson(value)).digest('hex');
}

function normalize(value) {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(value) {
  return [...new Set(normalize(value).split(' ').filter((token) => token.length > 2 && !STOP_WORDS.has(token)))];
}

function authorityFor(mechanism) {
  const text = normalize(mechanism.name);
  if (/operator|authority|consent|sovereignty/.test(text)) return 'operator_authority';
  if (/source|truth|evidence|semantic crc|proof|receipt|validated/.test(text)) return 'source_truth';
  if (/custody|fault|interference|amputation|sentinel|strongarm/.test(text)) return 'safety_and_custody';
  if (/semantic|fidelity|lossless|no silent|weaker replacement/.test(text)) return 'semantic_fidelity';
  if (/intent|problem formulation|goal|workflow|human motion/.test(text)) return 'requested_outcome';
  return 'optimization';
}

function mechanismSignals(mechanism, organ) {
  return Object.freeze([...new Set([
    ...tokens(mechanism.name),
    ...tokens(organ?.name),
    ...(organ?.keywords ?? []).flatMap(tokens),
  ])]);
}

function scoreSignals(text, mechanism, organ) {
  const normalized = normalize(text);
  const title = normalize(mechanism.name);
  const titleTokens = tokens(mechanism.name);
  const organSignals = (organ?.keywords ?? []).flatMap(tokens);
  const matchedTitleTokens = titleTokens.filter((token) => new RegExp(`\\b${token}\\b`, 'i').test(normalized));
  const matchedOrganSignals = organSignals.filter((token) => new RegExp(`\\b${token}\\b`, 'i').test(normalized));
  const exactTitle = title.length > 0 && normalized.includes(title);
  const score = (exactTitle ? 100 : 0)
    + matchedTitleTokens.length * 9
    + matchedOrganSignals.length * 2
    + (matchedTitleTokens.length >= 2 ? 8 : 0);
  return Object.freeze({
    score,
    exactTitle,
    signals: Object.freeze([...new Set([...matchedTitleTokens, ...matchedOrganSignals])]),
  });
}

function observationStatus(value) {
  const status = normalize(value?.status ?? value?.result?.status ?? value?.report?.status);
  if (/fail|error|block|reject|attention|cancel/.test(status)) return 'failed';
  if (/pass|green|complete|success|ok/.test(status)) return 'passed';
  return 'unknown';
}

function makeAdapter(mechanism, organ, nonNegotiableIds) {
  const stage = STAGE_BY_ORGAN[mechanism.organId] ?? 'govern';
  const authority = authorityFor(mechanism);
  const signalSet = mechanismSignals(mechanism, organ);
  const nonNegotiable = nonNegotiableIds.has(mechanism.id);
  const descriptor = Object.freeze({
    schema: WAVE3_MECHANISM_ABI_SCHEMA,
    mechanismId: mechanism.id,
    mechanismName: mechanism.name,
    organId: mechanism.organId,
    organ: mechanism.organ,
    stage,
    authority,
    authorityTier: AUTHORITY_TIER.get(authority),
    nonNegotiable,
    signals: signalSet,
  });

  return Object.freeze({
    descriptor,
    select(context = {}) {
      const result = scoreSignals(context.text ?? context.objective ?? '', mechanism, organ);
      return Object.freeze({ ...result, mechanismId: mechanism.id, nonNegotiable });
    },
    preflight(context = {}) {
      const failures = [];
      if (!String(context.workId ?? '').trim()) failures.push('work_id_missing');
      if (!String(context.objective ?? '').trim()) failures.push('objective_missing');
      if (!String(context.manifestHash ?? '').match(/^[0-9a-f]{64}$/i)) failures.push('manifest_hash_missing_or_invalid');
      return Object.freeze({ pass: failures.length === 0, failures: Object.freeze(failures) });
    },
    enforce(context = {}) {
      const preflight = this.preflight(context);
      if (!preflight.pass) throw new Error(`${mechanism.id} preflight failed: ${preflight.failures.join(', ')}`);
      const obligation = {
        schema: 'orange.wave3-mechanism-obligation.v1',
        mechanismId: mechanism.id,
        mechanismName: mechanism.name,
        stage,
        authority,
        authorityTier: AUTHORITY_TIER.get(authority),
        nonNegotiable,
        workId: context.workId,
        objectiveHash: sha256(context.objective),
        requiredEvidence: Object.freeze(['outcome_status', 'evidence_reference']),
      };
      return Object.freeze({ ...obligation, obligationHash: sha256(obligation) });
    },
    observe(result = {}) {
      const evidence = Array.isArray(result.evidence) ? result.evidence.filter(Boolean) : [];
      const observation = {
        schema: 'orange.wave3-mechanism-observation.v1',
        mechanismId: mechanism.id,
        outcome: observationStatus(result),
        evidenceCount: evidence.length,
        evidenceHashes: evidence.map((entry) => sha256(entry)),
      };
      return Object.freeze({ ...observation, observationHash: sha256(observation) });
    },
    falsify(observation = {}) {
      const reasons = [];
      if (observation.outcome === 'failed') reasons.push('observed_failure');
      if (observation.evidenceCount === 0) reasons.push('evidence_absent');
      return Object.freeze({
        mechanismId: mechanism.id,
        falsified: reasons.length > 0,
        reasons: Object.freeze(reasons),
        smallestFalsifier: 'one failed outcome or one evidence-free completion claim',
      });
    },
    settle({ observation, falsification } = {}) {
      const status = falsification?.falsified ? 'blocked' : observation?.outcome === 'passed' ? 'satisfied' : 'unresolved';
      return Object.freeze({ mechanismId: mechanism.id, status, observationHash: observation?.observationHash ?? null });
    },
    rollback(reason = 'mechanism obligation not satisfied') {
      return Object.freeze({ mechanismId: mechanism.id, action: 'restore_prior_authoritative_state', reason: String(reason) });
    },
  });
}

export function createWave3MechanismAbi({ mechanisms, organs, nonNegotiableIds = [] } = {}) {
  if (!Array.isArray(mechanisms) || mechanisms.length === 0) throw new TypeError('mechanisms must be a non-empty array');
  if (!Array.isArray(organs) || organs.length === 0) throw new TypeError('organs must be a non-empty array');
  const organById = new Map(organs.map((organ) => [organ.id, organ]));
  const nonNegotiable = new Set(nonNegotiableIds);
  const entries = mechanisms.map((mechanism) => [
    mechanism.id,
    makeAdapter(mechanism, organById.get(mechanism.organId), nonNegotiable),
  ]);
  const ids = entries.map(([id]) => id);
  if (new Set(ids).size !== mechanisms.length) throw new Error('mechanism ABI IDs must be unique');
  return new Map(entries);
}

export function rankWave3Mechanisms({ text, abi, excludeIds = [] } = {}) {
  if (!(abi instanceof Map)) throw new TypeError('abi must be a Map');
  const excluded = new Set(excludeIds);
  return Object.freeze([...abi.values()]
    .filter((adapter) => !excluded.has(adapter.descriptor.mechanismId))
    .map((adapter) => Object.freeze({ ...adapter.select({ text }), descriptor: adapter.descriptor }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score
      || left.descriptor.authorityTier - right.descriptor.authorityTier
      || left.descriptor.mechanismId.localeCompare(right.descriptor.mechanismId)));
}

export function resolveWave3Constitution(obligations = []) {
  if (!Array.isArray(obligations)) throw new TypeError('obligations must be an array');
  const normalized = obligations.map((obligation, index) => {
    const authority = AUTHORITY_TIER.has(obligation.authority) ? obligation.authority : 'optimization';
    return Object.freeze({ ...obligation, authority, authorityTier: AUTHORITY_TIER.get(authority), inputIndex: index });
  });
  const ordered = [...normalized].sort((left, right) => left.authorityTier - right.authorityTier
    || Number(right.nonNegotiable) - Number(left.nonNegotiable)
    || String(left.mechanismId).localeCompare(String(right.mechanismId)));
  const conflicts = [];
  const groups = new Map();
  for (const obligation of ordered) {
    const key = String(obligation.resource ?? obligation.stage ?? 'global');
    const group = groups.get(key) ?? [];
    for (const existing of group) {
      if (existing.directive && obligation.directive && existing.directive !== obligation.directive) {
        conflicts.push(Object.freeze({
          resource: key,
          left: existing.mechanismId,
          right: obligation.mechanismId,
          resolution: existing.authorityTier < obligation.authorityTier
            ? `prefer:${existing.mechanismId}`
            : existing.authorityTier > obligation.authorityTier
              ? `prefer:${obligation.mechanismId}`
              : 'unresolved_equal_authority',
        }));
      }
    }
    group.push(obligation);
    groups.set(key, group);
  }
  const payload = {
    schema: WAVE3_CONSTITUTION_SCHEMA,
    constitution: CONSTITUTION,
    orderedMechanismIds: ordered.map(({ mechanismId }) => mechanismId),
    conflicts,
    unresolvedConflictCount: conflicts.filter(({ resolution }) => resolution === 'unresolved_equal_authority').length,
  };
  return Object.freeze({ ...payload, resolutionHash: sha256(payload) });
}

export function describeWave3MechanismAbi(abi) {
  if (!(abi instanceof Map)) throw new TypeError('abi must be a Map');
  const descriptors = [...abi.values()].map(({ descriptor }) => descriptor);
  const payload = { schema: WAVE3_MECHANISM_ABI_SCHEMA, count: descriptors.length, descriptors };
  return Object.freeze({ ...payload, abiHash: sha256(payload) });
}

export const WAVE3_CONSTITUTION = CONSTITUTION;
