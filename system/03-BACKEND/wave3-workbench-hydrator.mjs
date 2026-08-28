import { createHash } from 'node:crypto';

import {
  WAVE3_KERNEL_MANIFEST_HASH,
  WAVE3_MECHANISMS,
  decodeWave3Activation,
  encodeWave3Activation,
} from './wave3-intelligent-kernel.mjs';
import {
  DEFAULT_WAVE3_KERNEL_STATE_LEDGER,
  readWave3KernelStateEvents,
} from './wave3-kernel-state.mjs';

export const WAVE3_WORKBENCH_HYDRATION_SCHEMA = 'orange.wave3-intelligent-kernel.workbench.v1';

const MECHANISMS_BY_ID = new Map(WAVE3_MECHANISMS.map((mechanism) => [mechanism.id, mechanism]));

function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function hash(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function assertManifest(value, label) {
  if (value?.manifestHash && value.manifestHash !== WAVE3_KERNEL_MANIFEST_HASH) {
    throw new Error(`${label} manifest does not match the active Wave 3 kernel manifest`);
  }
}

function idsFromKernel(kernel, label) {
  if (!kernel) return [];
  assertManifest(kernel, label);
  const ids = Array.isArray(kernel.activeMechanismIds)
    ? kernel.activeMechanismIds
    : decodeWave3Activation(kernel.activationBitset).activeMechanismIds;
  return ids.map((id) => {
    if (!MECHANISMS_BY_ID.has(id)) throw new Error(`unknown ${label} Wave 3 mechanism id: ${id}`);
    return id;
  });
}

function inheritedIdsFromWorkbench(workbench) {
  if (!workbench) return [];
  assertManifest(workbench, 'inherited workbench');
  if (!Array.isArray(workbench.activeMechanismIds)) {
    throw new TypeError('inherited workbench activeMechanismIds must be an array');
  }
  const descriptorIds = Array.isArray(workbench.descriptors)
    ? workbench.descriptors.map((descriptor) => descriptor?.id)
    : [];
  const ids = [...workbench.activeMechanismIds, ...descriptorIds];
  return ids.map((id) => {
    if (!MECHANISMS_BY_ID.has(id)) throw new Error(`unknown inherited Wave 3 mechanism id: ${id}`);
    return id;
  });
}

function latestStatesForIds(events, ids) {
  const requested = new Set(ids);
  const latest = new Map();
  for (const event of events) {
    if (requested.has(event.mechanismId)) latest.set(event.mechanismId, event);
  }
  return latest;
}

function compactDescriptor(mechanism, state) {
  return Object.freeze({
    id: mechanism.id,
    name: mechanism.name,
    organId: mechanism.organId,
    organ: mechanism.organ,
    lineageClass: mechanism.lineageClass,
    status: 'active',
    owner: state.owner,
    invariant: state.invariant,
    enforcementReference: state.enforcementReference,
    falsifier: state.falsifier,
    failureThreshold: state.failureThreshold,
    evidenceRefs: Object.freeze([...state.evidenceRefs]),
    authorizedBy: state.authorizedBy,
    stateEventHash: state.eventHash,
    stateTimestamp: state.timestamp,
  });
}

export function hydrateWave3LeastActionWorkbench(
  wave3Kernel,
  {
    inheritedKernel = null,
    inheritedWorkbench = null,
    ledgerPath = DEFAULT_WAVE3_KERNEL_STATE_LEDGER,
  } = {},
) {
  if (!wave3Kernel || typeof wave3Kernel !== 'object') {
    throw new TypeError('wave3Kernel workset is required');
  }
  assertManifest(wave3Kernel, 'workset');

  const requestedIds = idsFromKernel(wave3Kernel, 'workset');
  const inheritedCandidateIds = new Set(idsFromKernel(inheritedKernel, 'inherited kernel'));
  const inheritedActiveIds = new Set(inheritedIdsFromWorkbench(inheritedWorkbench));
  const inheritedIds = new Set([...inheritedCandidateIds, ...inheritedActiveIds]);
  const candidateIds = [...new Set([...requestedIds, ...inheritedIds])]
    .sort((left, right) => left.localeCompare(right));

  // The ledger is cold truth. Only latest events for candidate IDs cross into the workbench.
  const events = readWave3KernelStateEvents({ ledgerPath });
  const latestStates = latestStatesForIds(events, candidateIds);
  const descriptors = [];

  for (const mechanismId of candidateIds) {
    const state = latestStates.get(mechanismId);
    if (state?.status !== 'active') {
      if (inheritedActiveIds.has(mechanismId)) {
        throw new Error(
          `inherited Wave 3 law ${mechanismId} is ${state?.status ?? 'unassessed'}; refusing silent removal`,
        );
      }
      continue;
    }
    descriptors.push(compactDescriptor(MECHANISMS_BY_ID.get(mechanismId), state));
  }

  const activeMechanismIds = Object.freeze(descriptors.map(({ id }) => id));
  const preservedInheritedMechanismIds = Object.freeze(
    activeMechanismIds.filter((id) => inheritedIds.has(id)),
  );
  const evidencePointers = Object.freeze(descriptors.flatMap((descriptor) =>
    descriptor.evidenceRefs.map((reference) => Object.freeze({
      mechanismId: descriptor.id,
      reference,
    }))));
  const ledgerHeadHash = events.at(-1)?.eventHash ?? '0'.repeat(64);
  const payload = {
    schema: WAVE3_WORKBENCH_HYDRATION_SCHEMA,
    manifestHash: WAVE3_KERNEL_MANIFEST_HASH,
    sourceWorksetHash: wave3Kernel.worksetHash ?? null,
    sourceLedgerHeadHash: ledgerHeadHash,
    activationBitset: encodeWave3Activation(activeMechanismIds),
    activeMechanismIds,
    inheritedMechanismIds: preservedInheritedMechanismIds,
    descriptors: Object.freeze(descriptors),
    evidencePointers,
  };

  return Object.freeze({
    ...payload,
    workbenchHash: hash(payload),
  });
}

export function hydrateWave3WorkbenchForWorkObject(
  workObject,
  {
    inheritedKernel = null,
    inheritedWorkbench = null,
    ledgerPath = DEFAULT_WAVE3_KERNEL_STATE_LEDGER,
  } = {},
) {
  if (!workObject?.wave3Kernel) throw new Error('work object requires wave3Kernel selector metadata');
  return Object.freeze({
    ...workObject,
    wave3Workbench: hydrateWave3LeastActionWorkbench(workObject.wave3Kernel, {
      inheritedKernel,
      inheritedWorkbench,
      ledgerPath,
    }),
  });
}
