import { createHash } from 'node:crypto';

export const WAVE3_HANDOFF_CAPSULE_SCHEMA = 'orange.wave3-handoff-capsule.v1';

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

function compactStrings(values, limit = 32) {
  return Object.freeze([...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value ?? '').trim())
    .filter(Boolean))].slice(0, limit));
}

export function createWave3HandoffCapsule({
  workObject,
  order,
  route,
  evidencePointers = [],
  unresolved = [],
  parentCapsule = null,
} = {}) {
  if (!workObject || typeof workObject !== 'object') throw new TypeError('workObject is required');
  if (!workObject.wave3Kernel || typeof workObject.wave3Kernel !== 'object') {
    throw new Error('workObject.wave3Kernel is required');
  }
  if (!String(workObject.workId ?? '').trim()) throw new Error('workObject.workId is required');
  if (!String(workObject.objective ?? '').trim()) throw new Error('workObject.objective is required');
  if (parentCapsule && parentCapsule.schema !== WAVE3_HANDOFF_CAPSULE_SCHEMA) {
    throw new Error('parent capsule schema mismatch');
  }

  const kernel = workObject.wave3Kernel;
  const payload = {
    schema: WAVE3_HANDOFF_CAPSULE_SCHEMA,
    project: String(workObject.project ?? order?.targetProject ?? order?.scope ?? 'orange'),
    workId: workObject.workId,
    orderId: String(order?.orderId ?? workObject.workId),
    objective: workObject.objective,
    constraints: compactStrings(workObject.constraints),
    forbidden: compactStrings(workObject.forbidden ?? order?.forbiddenActions),
    acceptance: compactStrings(workObject.acceptance),
    evidenceRequired: compactStrings(workObject.evidenceRequired),
    evidencePointers: compactStrings([
      ...evidencePointers,
      ...(Array.isArray(order?.evidence) ? order.evidence : []),
    ], 64),
    unresolved: compactStrings([
      ...unresolved,
      ...(Array.isArray(workObject.unknowns) ? workObject.unknowns : []),
    ]),
    authority: Object.freeze({
      owner: String(workObject.owner ?? 'navigator'),
      source: String(workObject.authority ?? 'operator'),
      riskLevel: String(order?.riskLevel ?? 'medium'),
      requiresReceipt: order?.requiresReceipt !== false,
    }),
    route: Object.freeze({
      lane: route?.lane ?? null,
      model: route?.model ?? null,
      decisionId: route?.decision_id ?? route?.decisionId ?? null,
    }),
    kernel: Object.freeze({
      manifestHash: kernel.manifestHash,
      mechanismAbiHash: kernel.mechanismAbiHash,
      activationBitset: kernel.activationBitset,
      activeMechanismIds: Object.freeze([...(kernel.activeMechanismIds ?? [])]),
      worksetHash: kernel.worksetHash,
      constitutionHash: kernel.constitution?.resolutionHash ?? null,
      obligationHashes: Object.freeze((kernel.obligations ?? []).map(({ obligationHash }) => obligationHash)),
    }),
    source: Object.freeze({
      sha256: workObject.source?.sha256 ?? null,
      compilationHash: workObject.compilationHash ?? null,
    }),
    reportContract: Object.freeze({
      schema: 'orange.report.v1',
      required: Object.freeze([
        'orderId', 'status', 'confidence', 'actionsTaken', 'evidence', 'blockers', 'nextAction', 'receiptPath',
      ]),
      terminalStatuses: Object.freeze(['completed', 'blocked', 'cancelled', 'failed']),
    }),
    parentCapsuleHash: parentCapsule?.capsuleHash ?? null,
  };
  const capsuleHash = sha256(payload);
  return Object.freeze({ ...payload, capsuleId: `handoff-${capsuleHash.slice(0, 24)}`, capsuleHash });
}

export function verifyWave3HandoffCapsule(capsule) {
  if (!capsule || capsule.schema !== WAVE3_HANDOFF_CAPSULE_SCHEMA) {
    return Object.freeze({ ok: false, reason: 'schema_mismatch' });
  }
  const { capsuleId, capsuleHash, ...payload } = capsule;
  const calculated = sha256(payload);
  if (capsuleHash !== calculated) return Object.freeze({ ok: false, reason: 'hash_mismatch', calculated });
  if (capsuleId !== `handoff-${calculated.slice(0, 24)}`) {
    return Object.freeze({ ok: false, reason: 'id_mismatch', calculated });
  }
  return Object.freeze({ ok: true, capsuleHash: calculated });
}
