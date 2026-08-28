import { createHash } from 'node:crypto';
import {
  createWave3MechanismAbi,
  describeWave3MechanismAbi,
  rankWave3Mechanisms,
  resolveWave3Constitution,
} from './wave3-mechanism-abi.mjs';

export const WAVE3_KERNEL_SCHEMA = 'orange.wave3-intelligent-kernel.v1';
export const WAVE3_WORKSET_SCHEMA = 'orange.wave3-intelligent-kernel.workset.v1';
export const WAVE3_KERNEL_STATUS = 'law_compiled_unverified';

const ORGAN_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: 'W3O-01',
    name: 'Signal, Reference, and Retrieval',
    keywords: ['overload', 'signal', 'feedback', 'reference', 'pointer', 'retrieval', 'memory', 'query', 'corpus', 'source'],
  }),
  Object.freeze({
    id: 'W3O-02',
    name: 'Planning, Composition, and Verification',
    keywords: ['plan', 'problem', 'workflow', 'compose', 'composition', 'simulation', 'constraint', 'preflight', 'verify', 'diagnosis'],
  }),
  Object.freeze({
    id: 'W3O-03',
    name: 'Continuity, Portability, and Live Objects',
    keywords: ['priority', 'portable', 'intent', 'optimize', 'substitute', 'inspect', 'topology', 'fabrication', 'operator', 'realtime'],
  }),
  Object.freeze({
    id: 'W3O-04',
    name: 'Sovereignty, Learning, and Long Memory',
    keywords: ['sovereignty', 'authority', 'consent', 'culture', 'language', 'adapter', 'transfer', 'concurrent', 'perception', 'mamba', 'state space'],
  }),
  Object.freeze({
    id: 'W3O-05',
    name: 'Routing, Acceleration, and Work Custody',
    keywords: ['cache', 'route', 'routing', 'model', 'speculative', 'compression', 'compress', 'work custody', 'custody', 'interference'],
  }),
  Object.freeze({
    id: 'W3O-06',
    name: 'Calibration, Evidence, and Federation',
    keywords: ['calibrate', 'evidence', 'hysteresis', 'representation', 'relevance', 'recurrence', 'baseline', 'outcome', 'receipt', 'federated'],
  }),
  Object.freeze({
    id: 'W3O-07',
    name: 'Conservation and Epistemic Control',
    keywords: ['conservation', 'epistemic', 'semantic', 'proof', 'entropy', 'causal', 'pulse', 'cup', 'disconnect', 'capability'],
  }),
  Object.freeze({
    id: 'W3O-08',
    name: 'Continuity, Adaptation, and Compression Intelligence',
    keywords: ['continuity', 'infinitus', 'crystal', 'atomsmasher', 'workset', 'failure memory', 'research', 'typed delta', 'counterfactual', 'morphogenesis'],
  }),
  Object.freeze({
    id: 'W3O-09',
    name: 'Collective Discipline and Flow Governance',
    keywords: ['chatbackup', 'party line', 'strongarm', 'gremlin', 'mirror', 'judgement', 'judgment', 'swarm', 'flow', 'human approval'],
  }),
  Object.freeze({
    id: 'W3O-10',
    name: 'Operational Orchestration and Interface Boundaries',
    keywords: ['navigator', 'orangebrain', 'hermes', 'codexa', 'lease', 'computer mode', 'memento', 'supersession', 'interface', 'intelligence'],
  }),
]);

const TREASURY = Object.freeze([
  ['Hoover Overload Control', 'attributed_historical_systems_design'],
  ['Yushchenko Typed Indirect References', 'attributed_historical_systems_design'],
  ['West Residual Calibration', 'attributed_historical_systems_design'],
  ['Sparck Jones Collection-Aware Retrieval', 'attributed_historical_systems_design'],
  ['Xia Staged Reliability and Diagnosis', 'attributed_historical_systems_design'],
  ['Avram Machine-Independent Exchange Records', 'attributed_historical_systems_design'],
  ['Fasenmyer Recurrence Certificates', 'attributed_historical_systems_design'],
  ['Dieng-Kuntz Validated Semantic Memory', 'attributed_historical_systems_design'],
  ['Castro-Kelly Interface-Governed Constellations', 'attributed_historical_systems_design'],
  ['Wing Computational Problem Formulation', 'attributed_historical_systems_design'],

  ['Aitkhozhayeva Control Synthesis from Algorithm Sets', 'attributed_historical_systems_design'],
  ['Chatterjee Theory-to-Instrument Engineering', 'attributed_historical_systems_design'],
  ['Chawla Decomposed Complex-Flow Simulation', 'attributed_historical_systems_design'],
  ['Hoang Xuan Sinh Coherent Higher-Order Composition', 'attributed_historical_systems_design'],
  ['Charity Adams Earley Directory Reconciliation', 'attributed_historical_systems_design'],
  ['Raye Montague Multi-Constraint Concept Design', 'attributed_historical_systems_design'],
  ['Melba Roy Mouton Observation-Corrected Prediction Timetables', 'attributed_historical_systems_design'],
  ['Marsha Rhea Williams Assisted Enterprise Queries', 'attributed_historical_systems_design'],
  ['Jane Cooke Wright Paired Preflight and Observed Outcome', 'attributed_historical_systems_design'],
  ['Valerie Thomas Decode-First Quality Control', 'attributed_historical_systems_design'],

  ['Hamilton Priority-Preserving Fault Response', 'attributed_historical_systems_design'],
  ['Hopper Portable Intent Compilation', 'attributed_historical_systems_design'],
  ['Allen Semantics-Preserving Optimization', 'attributed_historical_systems_design'],
  ['Liskov Behavioral Substitutability', 'attributed_historical_systems_design'],
  ['Goldberg Inspectable Live Objects', 'attributed_historical_systems_design'],
  ['Perlman Self-Stabilizing Topology', 'attributed_historical_systems_design'],
  ['Conway Shared Fabrication Rules', 'attributed_historical_systems_design'],
  ['Gilbreth Human-Motion Economy', 'attributed_historical_systems_design'],
  ['Berezin Real-Time Operator Tools', 'attributed_historical_systems_design'],
  ['Indigenous Community Data Authority', 'community_sovereignty'],

  ['Maori Algorithmic Sovereignty', 'community_sovereignty'],
  ['Te Hiku Benefit-Bound Language Technology', 'community_sovereignty'],
  ['Expert Authority for Ambiguity', 'community_sovereignty'],
  ['Adaptation Interference Gates', 'published_systems_research'],
  ['Similarity-Selected Transfer', 'published_systems_research'],
  ['Owicki-Gries Interference Freedom', 'published_systems_research'],
  ['Bajcsy Active Perception', 'published_systems_research'],
  ['Dao-Gu Structured State Space Duality', 'published_systems_research'],
  ['Fixed-State Copying Limits', 'published_systems_research'],
  ['Jamba Hybrid Recall', 'published_systems_research'],

  ['KV Cache Management Portfolio', 'published_systems_research'],
  ['Frugal LLM Cascades', 'published_systems_research'],
  ['RouteLLM Preference-Trained Routing', 'published_systems_research'],
  ['Lossless Speculative Decoding', 'published_systems_research'],
  ['Distribution-Preserving Speculative Sampling', 'published_systems_research'],
  ['Brotli Exact Structural Compression', 'published_systems_research'],
  ['LLMLingua Evidence-Preserving Semantic Compression', 'published_systems_research'],
  ['LongLLMLingua Query-Aware Compression', 'published_systems_research'],
  ['AE Link Work Custody', 'orange_adopted_mechanism'],
  ['Bounded Interference', 'orange_adopted_mechanism'],

  ['Calibrated Routing', 'orange_adopted_mechanism'],
  ['Active Sensing', 'orange_adopted_mechanism'],
  ['Scoped Evidence Lattice', 'orange_adopted_mechanism'],
  ['Route Hysteresis', 'orange_adopted_mechanism'],
  ['Source and Representation Separation', 'orange_adopted_mechanism'],
  ['Shadow Relevance Learning', 'orange_adopted_mechanism'],
  ['Recurrence Certificates for Repeated Work', 'orange_adopted_mechanism'],
  ['Adaptive Baselines', 'orange_adopted_mechanism'],
  ['Outcome Receipts', 'orange_adopted_mechanism'],
  ['Federated Registry', 'orange_adopted_mechanism'],

  ['Conservation Kernel', 'orange_native_innovation'],
  ['Epistemic Transactions', 'orange_native_innovation'],
  ['Semantic CRC', 'orange_native_innovation'],
  ['Minimum Proof Cut', 'orange_native_innovation'],
  ['Entropy Accounting', 'orange_native_innovation'],
  ['Causal Memory', 'orange_native_innovation'],
  ['Solar Wave', 'orange_native_innovation'],
  ['AE Pulse Carrier', 'orange_native_innovation'],
  ['Cup Topology', 'orange_native_innovation'],
  ['Graceful Amputation', 'orange_native_innovation'],

  ['Capability Morphogenesis', 'orange_native_innovation'],
  ['Counterfactual Twin', 'orange_native_innovation'],
  ['Truth Latency', 'orange_native_innovation'],
  ['Epistemic Immune System', 'orange_native_innovation'],
  ['Research Demand Generation', 'orange_native_innovation'],
  ['Typed Deltas', 'orange_native_innovation'],
  ['Operator Continuity Object', 'orange_native_innovation'],
  ['Complex Infinitus', 'orange_native_innovation'],
  ['Context Crystal', 'orange_native_innovation'],
  ['AtomSmasher Full Codec and Work Compiler', 'orange_native_innovation'],

  ['ChatBackup', 'orange_native_innovation'],
  ['Party Line', 'orange_native_innovation'],
  ['STRONGARM', 'orange_native_innovation'],
  ['Gremlin Packet', 'orange_native_innovation'],
  ['Mirror', 'orange_native_innovation'],
  ['JUDGEMENT', 'orange_native_innovation'],
  ['Operator-First Authority Chain', 'orange_native_innovation'],
  ['SwarmGate', 'orange_native_innovation'],
  ['SwarmSentinel', 'orange_native_innovation'],
  ['FLOW', 'orange_native_innovation'],

  ['Navigator', 'orange_native_innovation'],
  ['OrangeBrain', 'orange_native_innovation'],
  ['Hermes Bounded Workers', 'orange_native_innovation'],
  ['Codexa Leases', 'orange_native_innovation'],
  ['One-Computer and Two-Computer Parity', 'orange_native_innovation'],
  ['Memento Ledger', 'orange_native_innovation'],
  ['Full-Strength Fidelity', 'orange_native_innovation'],
  ['No Silent Supersession', 'orange_native_innovation'],
  ['No Weaker Replacement Without Falsifier and Reconsideration', 'orange_native_innovation'],
  ['Interface Is Not Intelligence', 'orange_native_innovation'],
]);

function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

const hash = (value) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const organForIndex = (index) => ORGAN_DEFINITIONS[Math.floor(index / 10)];

export const WAVE3_KERNEL_ORGANS = ORGAN_DEFINITIONS;
export const WAVE3_MECHANISMS = Object.freeze(TREASURY.map(([name, lineageClass], index) => {
  const organ = organForIndex(index);
  return Object.freeze({
    id: `W3K-${String(index + 1).padStart(3, '0')}`,
    name,
    organ: organ.name,
    organId: organ.id,
    lineageClass,
    status: WAVE3_KERNEL_STATUS,
  });
}));

function validateManifest() {
  if (WAVE3_KERNEL_ORGANS.length !== 10) throw new Error('Wave 3 kernel requires exactly 10 organs');
  if (WAVE3_MECHANISMS.length !== 100) throw new Error('Wave 3 kernel requires exactly 100 mechanisms');
  const ids = new Set();
  const names = new Set();
  for (let index = 0; index < WAVE3_MECHANISMS.length; index += 1) {
    const mechanism = WAVE3_MECHANISMS[index];
    const expectedId = `W3K-${String(index + 1).padStart(3, '0')}`;
    if (mechanism.id !== expectedId) throw new Error(`Wave 3 kernel sequence mismatch: expected ${expectedId}`);
    if (ids.has(mechanism.id)) throw new Error(`duplicate Wave 3 mechanism id: ${mechanism.id}`);
    if (names.has(mechanism.name)) throw new Error(`duplicate Wave 3 mechanism name: ${mechanism.name}`);
    if (mechanism.status !== WAVE3_KERNEL_STATUS) throw new Error(`${mechanism.id} has invalid status`);
    ids.add(mechanism.id);
    names.add(mechanism.name);
  }
  for (const organ of WAVE3_KERNEL_ORGANS) {
    const count = WAVE3_MECHANISMS.filter((mechanism) => mechanism.organId === organ.id).length;
    if (count !== 10) throw new Error(`${organ.id} requires exactly 10 mechanisms, found ${count}`);
  }
}

validateManifest();

const MANIFEST_PAYLOAD = Object.freeze({
  schema: WAVE3_KERNEL_SCHEMA,
  status: WAVE3_KERNEL_STATUS,
  organs: WAVE3_KERNEL_ORGANS.map(({ id, name }) => ({ id, name })),
  mechanisms: WAVE3_MECHANISMS,
});

export const WAVE3_KERNEL_MANIFEST_HASH = hash(MANIFEST_PAYLOAD);
export const WAVE3_NON_NEGOTIABLE_IDS = Object.freeze([
  'W3K-061', 'W3K-062', 'W3K-063', 'W3K-064', 'W3K-065', 'W3K-066',
  'W3K-077', 'W3K-087', 'W3K-097', 'W3K-098', 'W3K-099', 'W3K-100',
]);

const MECHANISM_IDS = Object.freeze(WAVE3_MECHANISMS.map(({ id }) => id));
const MECHANISM_ID_SET = new Set(MECHANISM_IDS);
export const WAVE3_MECHANISM_ABI = createWave3MechanismAbi({
  mechanisms: WAVE3_MECHANISMS,
  organs: WAVE3_KERNEL_ORGANS,
  nonNegotiableIds: WAVE3_NON_NEGOTIABLE_IDS,
});
export const WAVE3_MECHANISM_ABI_MANIFEST = describeWave3MechanismAbi(WAVE3_MECHANISM_ABI);

export function encodeWave3Activation(activeMechanismIds = []) {
  const requested = new Set(activeMechanismIds);
  for (const id of requested) {
    if (!MECHANISM_ID_SET.has(id)) throw new Error(`unknown Wave 3 mechanism id: ${id}`);
  }
  const bits = MECHANISM_IDS.map((id) => requested.has(id) ? '1' : '0').join('');
  return bits.match(/.{4}/g).map((nibble) => Number.parseInt(nibble, 2).toString(16)).join('');
}

export function decodeWave3Activation(activationBitset) {
  const encoded = String(activationBitset ?? '').toLowerCase();
  if (!/^[0-9a-f]{25}$/.test(encoded)) {
    throw new Error('Wave 3 activation bitset must be exactly 25 hexadecimal characters');
  }
  const bits = [...encoded]
    .map((nibble) => Number.parseInt(nibble, 16).toString(2).padStart(4, '0'))
    .join('');
  const activeMechanisms = WAVE3_MECHANISMS.filter((_, index) => bits[index] === '1');
  const sleepingMechanisms = WAVE3_MECHANISMS.filter((_, index) => bits[index] === '0');
  return Object.freeze({
    manifestHash: WAVE3_KERNEL_MANIFEST_HASH,
    activeMechanismIds: Object.freeze(activeMechanisms.map(({ id }) => id)),
    sleepingMechanismIds: Object.freeze(sleepingMechanisms.map(({ id }) => id)),
    activeMechanisms: Object.freeze(activeMechanisms),
    sleepingMechanisms: Object.freeze(sleepingMechanisms),
  });
}

function workText(work) {
  if (typeof work === 'string') return work;
  return [
    work?.objective,
    ...(work?.deliverables ?? []),
    ...(work?.constraints ?? []),
    ...(work?.forbidden ?? []),
    ...(work?.acceptance ?? []),
    ...(work?.evidenceRequired ?? []),
    ...(work?.unknowns ?? []),
    work?.source?.preview,
  ].filter(Boolean).join('\n');
}

function containsKeyword(normalizedText, keyword) {
  const normalizedKeyword = keyword.toLowerCase();
  if (normalizedKeyword.includes(' ')) return normalizedText.includes(normalizedKeyword);
  return new RegExp(`\\b${normalizedKeyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(normalizedText);
}

function selectedOrgans(text) {
  const normalized = String(text ?? '').toLowerCase();
  return WAVE3_KERNEL_ORGANS.map((organ) => Object.freeze({
    organId: organ.id,
    signals: Object.freeze(organ.keywords.filter((keyword) => containsKeyword(normalized, keyword))),
  })).filter(({ signals }) => signals.length > 0);
}

export function compileWave3Kernel(work, {
  inheritedKernel = null,
  maxMechanisms = 24,
  maxPerOrgan = 3,
} = {}) {
  const text = workText(work);
  const ranked = rankWave3Mechanisms({ text, abi: WAVE3_MECHANISM_ABI });
  const organMatches = selectedOrgans(text);
  const activeIds = new Set(WAVE3_NON_NEGOTIABLE_IDS);
  const selection = new Map(WAVE3_NON_NEGOTIABLE_IDS.map((mechanismId) => [mechanismId, Object.freeze({
    mechanismId,
    reason: 'constitutional_non_negotiable',
    score: Number.POSITIVE_INFINITY,
    signals: Object.freeze([]),
  })]));
  if (inheritedKernel) {
    if (inheritedKernel.manifestHash && inheritedKernel.manifestHash !== WAVE3_KERNEL_MANIFEST_HASH) {
      throw new Error('inherited Wave 3 kernel manifest does not match the active manifest');
    }
    const inheritedIds = Array.isArray(inheritedKernel.activeMechanismIds)
      ? inheritedKernel.activeMechanismIds
      : decodeWave3Activation(inheritedKernel.activationBitset).activeMechanismIds;
    for (const id of inheritedIds) {
      if (!MECHANISM_ID_SET.has(id)) throw new Error(`unknown inherited Wave 3 mechanism id: ${id}`);
      activeIds.add(id);
      if (!selection.has(id)) selection.set(id, Object.freeze({
        mechanismId: id,
        reason: 'inherited_active_law',
        score: Number.POSITIVE_INFINITY,
        signals: Object.freeze([]),
      }));
    }
  }

  const explicitIds = Array.isArray(work?.requiredMechanismIds) ? [...new Set(work.requiredMechanismIds)] : [];
  for (const id of explicitIds) {
    if (!MECHANISM_ID_SET.has(id)) throw new Error(`unknown required Wave 3 mechanism id: ${id}`);
    activeIds.add(id);
    selection.set(id, Object.freeze({
      mechanismId: id,
      reason: 'work_object_required',
      score: Number.POSITIVE_INFINITY,
      signals: Object.freeze([]),
    }));
  }

  const boundedMaximum = Math.max(activeIds.size, Math.min(100, Math.max(12, Number(maxMechanisms) || 24)));
  const perOrganCount = new Map();
  for (const id of activeIds) {
    const organId = WAVE3_MECHANISMS.find((mechanism) => mechanism.id === id)?.organId;
    if (organId) perOrganCount.set(organId, (perOrganCount.get(organId) ?? 0) + 1);
  }
  for (const candidate of ranked) {
    if (activeIds.size >= boundedMaximum) break;
    const { mechanismId, descriptor, score, signals } = candidate;
    if (activeIds.has(mechanismId)) continue;
    const selectedInOrgan = perOrganCount.get(descriptor.organId) ?? 0;
    if (selectedInOrgan >= Math.max(1, Number(maxPerOrgan) || 3)) continue;
    activeIds.add(mechanismId);
    perOrganCount.set(descriptor.organId, selectedInOrgan + 1);
    selection.set(mechanismId, Object.freeze({
      mechanismId,
      reason: 'task_signal_match',
      score,
      signals,
    }));
  }

  if (ranked.length === 0 && !activeIds.has('W3K-010')) {
    activeIds.add('W3K-010');
    selection.set('W3K-010', Object.freeze({
      mechanismId: 'W3K-010',
      reason: 'default_problem_formulation',
      score: 1,
      signals: Object.freeze(['default_problem_formulation']),
    }));
  }

  const activeMechanismIds = WAVE3_MECHANISMS
    .filter((mechanism) => activeIds.has(mechanism.id))
    .map(({ id }) => id);
  const activationBitset = encodeWave3Activation(activeMechanismIds);
  const payload = {
    activationBitset,
    activeMechanismIds,
    manifestHash: WAVE3_KERNEL_MANIFEST_HASH,
    mechanismAbiHash: WAVE3_MECHANISM_ABI_MANIFEST.abiHash,
  };
  const workId = String(work?.workId ?? `work-${hash(text).slice(0, 20)}`);
  const objective = String((work?.objective ?? text) || 'govern work');
  const obligations = activeMechanismIds.map((mechanismId) => WAVE3_MECHANISM_ABI.get(mechanismId).enforce({
    workId,
    objective,
    manifestHash: WAVE3_KERNEL_MANIFEST_HASH,
  }));
  const constitution = resolveWave3Constitution(obligations);
  const worksetHash = hash({
    ...payload,
    obligations,
    constitutionHash: constitution.resolutionHash,
    inheritedWorksetHash: inheritedKernel?.worksetHash || null,
    sourceWorkId: work?.workId ?? null,
    sourceHash: work?.source?.sha256 ?? hash(text),
  });
  return Object.freeze({
    ...payload,
    worksetHash,
    selection: Object.freeze(activeMechanismIds.map((id) => selection.get(id))),
    selectedOrgans: Object.freeze(organMatches),
    obligations: Object.freeze(obligations),
    constitution,
    sleepingMechanismCount: WAVE3_MECHANISMS.length - activeMechanismIds.length,
  });
}
