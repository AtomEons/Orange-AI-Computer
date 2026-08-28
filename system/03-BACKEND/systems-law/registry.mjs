import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createWave3GlobalMechanisms } from './wave3-mechanisms.mjs';

export const SYSTEMS_LAW_REGISTRY_SCHEMA = 'orange5.systems-design-law.registry.v1';
export const SYSTEMS_LAW_RECORD_SCHEMA = 'orange5.systems-design-law.record.v1';

export const SYSTEMS_LAW_STATUS = Object.freeze({
  ACTIVE: 'active',
  SHADOW: 'shadow',
  RESEARCH: 'research',
  ARCHIVED: 'archived',
});

export const SYSTEMS_LAW_SOURCE = Object.freeze({
  GAD: Object.freeze({
    document: '00-CHARTER/GUIDES/FEMALE_SYSTEMS_DESIGN_INNOVATIONS.md',
    sha256: '4e0f542037667a41f32c4909217f62cbd746a16823abfa6061bb50eb162e4a3d',
    path: fileURLToPath(new URL('../../00-CHARTER/GUIDES/FEMALE_SYSTEMS_DESIGN_INNOVATIONS.md', import.meta.url)),
  }),
  ADOPTION: Object.freeze({
    document: '00-CHARTER/GUIDES/GLOBAL_SYSTEMS_ALPHA_ADOPTION_LEDGER.md',
    sha256: 'b0c61f5829a0e93c3646823e17de2f0e1b7ad7e1109164201603bc6f68a3e650',
    path: fileURLToPath(new URL('../../00-CHARTER/GUIDES/GLOBAL_SYSTEMS_ALPHA_ADOPTION_LEDGER.md', import.meta.url)),
  }),
  RESEARCH_GROUNDING: Object.freeze({
    document: '01-DOCTRINE/ORANGE5_RESEARCH_GROUNDING_2026-07-04.md',
    sha256: 'feae08ac0b443c665dbcc79d106a5149c30fcc2ccc8575eb4afaaed21b6b6d14',
    path: fileURLToPath(new URL('../../01-DOCTRINE/ORANGE5_RESEARCH_GROUNDING_2026-07-04.md', import.meta.url)),
  }),
});

const GAD_ASSIGNMENTS = new Map([
  ['GAD-001', ['orange5.runtime-admission', 'research registry; proposed queue admission gate']],
  ['GAD-002', ['orange5.reference-graph', 'research registry; proposed typed dereference boundary']],
  ['GAD-003', ['orange5.route-calibration', 'research registry; proposed route outcome calibration']],
  ['GAD-004', ['orange5.memory-retrieval', 'research registry; proposed retrieval scoring boundary']],
  ['GAD-005', ['orange5.verification', 'research registry; proposed staged diagnosis gate']],
  ['GAD-006', ['orange5.source-view', 'research registry; proposed exchange and projection boundary']],
  ['GAD-007', ['orange5.verification', 'research registry; proposed independent certificate checker']],
  ['GAD-008', ['orange5.memory-governance', 'research registry; proposed semantic-memory validation']],
  ['GAD-009', ['orange5.federation', 'research registry; proposed cross-organization interface gate']],
  ['GAD-010', ['orange5.navigator', 'research registry; proposed problem-formulation intake']],
  ['GAD-011', ['orange5.control-synthesis', 'research registry; proposed controller conformance gate']],
  ['GAD-012', ['orange5.ae-eyes', 'research registry; proposed calibration and instrument boundary']],
  ['GAD-013', ['orange5.cross-organ', 'research registry; proposed composite-model boundary validation']],
  ['GAD-014', ['orange5.workflow-composition', 'research registry; proposed composition coherence gate']],
  ['GAD-015', ['orange5.superdirectory', 'research registry; proposed reconciliation and handoff boundary']],
  ['GAD-016', ['orange5.build-planning', 'research registry; proposed constraint-to-concept compiler']],
  ['GAD-017', ['orange5.route-calibration', 'research registry; proposed time-indexed forecast correction']],
  ['GAD-018', ['orange5.query-planning', 'research registry; proposed inspectable query compiler']],
  ['GAD-019', ['orange5.outcome-receipts', 'research registry; proposed paired preflight/outcome gate']],
  ['GAD-020', ['orange5.import-qc', 'research registry; proposed read-only decode boundary']],
  ['GAD-021', ['orange5.runtime-scheduler', 'research registry; proposed priority fault-recovery gate']],
  ['GAD-022', ['orange5.order-compiler', 'research registry; proposed portable intent compiler']],
  ['GAD-023', ['orange5.optimizer', 'research registry; proposed semantics-preservation gate']],
  ['GAD-024', ['orange5.provider-contracts', 'research registry; proposed substitution conformance gate']],
  ['GAD-025', ['orange5.operator-interface', 'research registry; proposed live-state mutation boundary']],
  ['GAD-026', ['orange5.routing-topology', 'research registry; proposed route convergence gate']],
  ['GAD-027', ['orange5.build-system', 'research registry; proposed design-rule and generator gate']],
  ['GAD-028', ['orange5.operator-research', 'research registry; proposed consented whole-task measurement']],
  ['GAD-029', ['orange5.operational-executor', 'research registry; proposed transactional work boundary']],
  ['GAD-030', ['orange5.data-authority', 'research registry; proposed community authority gate']],
  ['GAD-031', ['orange5.model-governance', 'research registry; proposed algorithmic authority gate']],
  ['GAD-032', ['orange5.language-governance', 'research registry; proposed benefit-bound use gate']],
  ['GAD-033', ['orange5.annotation-governance', 'research registry; proposed expert adjudication gate']],
  ['GAD-034', ['orange5.adapter-promotion', 'research registry; proposed interference and forgetting gate']],
  ['GAD-035', ['orange5.transfer-selection', 'research registry; proposed source-model selection gate']],
]);

const ADOPTION_ASSIGNMENTS = Object.freeze([
  Object.freeze(['GSA-001', 'AE Link Work Custody', 'ADOPT_FOR_ALPHA_PROOF', SYSTEMS_LAW_STATUS.RESEARCH,
    'orange5.ae-link', 'alpha proof queue; work-custody state machine']),
  Object.freeze(['GSA-002', 'Owicki-Gries Interference Freedom', 'ADOPT_FOR_ALPHA_PROOF', SYSTEMS_LAW_STATUS.RESEARCH,
    'orange5.systems-law', 'alpha proof queue; bounded interleaving checker']),
  Object.freeze(['GSA-003', 'Calibrated Cost Routing', 'ADOPT_FOR_ALPHA_PROOF_AFTER_OUTCOME_RECEIPTS', SYSTEMS_LAW_STATUS.RESEARCH,
    'orange5.route-calibration', 'alpha proof queue after outcome receipts']),
  Object.freeze(['GSA-004', 'Active Sensing', 'ADOPT_FOR_AE_EYES_SANDBOX', SYSTEMS_LAW_STATUS.RESEARCH,
    'orange5.ae-eyes', 'authorized AE Eyes sandbox only']),
  Object.freeze(['GSA-005', 'Scoped Evidence Lattice', 'ADOPT_FOR_ALPHA_PROOF', SYSTEMS_LAW_STATUS.RESEARCH,
    'orange5.evidence-poset', 'alpha proof queue; scoped evidence joins']),
  Object.freeze(['GSA-006', 'Route Hysteresis', 'ADOPT_AFTER_CALIBRATED_ROUTING', SYSTEMS_LAW_STATUS.RESEARCH,
    'orange5.routing-topology', 'deferred proof queue after calibrated routing']),
  Object.freeze(['GSA-007', 'Source / Representation Separation', 'ADOPT_AS_ALPHA_INVARIANT', SYSTEMS_LAW_STATUS.ACTIVE,
    'orange5.source-view', 'source ingestion, projection creation, rebuild, and hydration boundaries']),
  Object.freeze(['GSA-008', 'Relevance Feedback', 'ADOPT_SHADOW_ONLY', SYSTEMS_LAW_STATUS.SHADOW,
    'orange5.memory-retrieval', 'shadow relevance-feedback evaluator; never changes production rank']),
  Object.freeze(['GSA-009', 'Recurrence Certificates', 'ARCHIVE_PENDING_VALUE', SYSTEMS_LAW_STATUS.ARCHIVED,
    'orange5.verification', 'archive; no runtime compilation']),
  Object.freeze(['GSA-010', 'Adaptive Baselines', 'ADOPT_SHADOW_ONLY', SYSTEMS_LAW_STATUS.SHADOW,
    'orange5.benchmark-governance', 'shadow drift detector; never rewrites accepted baselines']),
  Object.freeze(['GSA-011', 'Outcome Receipts', 'ADOPT_FOR_ALPHA_PROOF', SYSTEMS_LAW_STATUS.RESEARCH,
    'orange5.outcome-receipts', 'alpha proof queue; action/effect receipt verifier']),
  Object.freeze(['GSA-012', 'Federated Registry', 'ARCHIVE_DEPENDENT', SYSTEMS_LAW_STATUS.ARCHIVED,
    'orange5.federation', 'archive pending custody, evidence-order, and source-view proofs']),
]);

const STATUS_VALUES = new Set(Object.values(SYSTEMS_LAW_STATUS));

export class SystemsLawRegistryError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'SystemsLawRegistryError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new SystemsLawRegistryError(code, message, details);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('INVALID_CANONICAL_VALUE', 'canonical values must use finite numbers');
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    fail('INVALID_CANONICAL_VALUE', 'canonical values must be plain JSON objects');
  }
  return `{${Object.keys(value).sort().map((key) => {
    if (value[key] === undefined) fail('INVALID_CANONICAL_VALUE', `canonical field ${key} may not be undefined`);
    return `${JSON.stringify(key)}:${canonicalJson(value[key])}`;
  }).join(',')}}`;
}

export function hashSystemsLawValue(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function sha256Bytes(value) {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeMarkdown(value) {
  return value.replace(/\s+/g, ' ').trim();
}

function collectSections(lines, headingPattern, stopPattern) {
  const starts = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(headingPattern);
    if (match) starts.push({ index, match });
  }
  return starts.map((start, position) => {
    const nextStart = starts[position + 1]?.index ?? lines.findIndex((line, index) => index > start.index && stopPattern.test(line));
    const end = nextStart < 0 ? lines.length : nextStart;
    return {
      match: start.match,
      lines: lines.slice(start.index + 1, end),
      lineStart: start.index + 1,
      lineEnd: end,
    };
  });
}

function readParagraph(lines, marker, context) {
  const start = lines.findIndex((line) => line.trimStart().startsWith(marker));
  if (start < 0) fail('SOURCE_FORMAT_MISMATCH', `${context} is missing ${marker}`);
  const first = lines[start].trim().slice(marker.length).trim();
  const parts = first ? [first] : [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) break;
    if (/^-?\s*\*\*[^*]+\*\*/.test(line)) break;
    parts.push(line);
  }
  const value = normalizeMarkdown(parts.join(' '));
  if (!value) fail('SOURCE_FORMAT_MISMATCH', `${context} has an empty ${marker} field`);
  return value;
}

function markdownLinks(value) {
  const links = [];
  const seen = new Set();
  for (const match of value.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)) {
    const ref = match[2].trim();
    if (seen.has(ref)) continue;
    seen.add(ref);
    links.push(Object.freeze({
      kind: /^https?:\/\//i.test(ref) ? 'external-source' : 'repository-evidence',
      label: normalizeMarkdown(match[1]),
      ref,
    }));
  }
  return links;
}

function evidenceRefs({ document, lineStart, lineEnd, title, text }) {
  return Object.freeze([
    Object.freeze({ kind: 'registry-source', label: title, ref: document, lineStart, lineEnd }),
    ...markdownLinks(text),
  ]);
}

function receiptRefs(text) {
  return Object.freeze(markdownLinks(text)
    .map((item) => item.ref)
    .filter((ref) => /(?:^|\/)10-RECEIPTS\//i.test(ref))
    .filter((ref, index, all) => all.indexOf(ref) === index)
    .sort());
}

function authorityForStatus(status) {
  if (status === SYSTEMS_LAW_STATUS.ACTIVE) return 'enforce';
  if (status === SYSTEMS_LAW_STATUS.SHADOW) return 'observe';
  return 'none';
}

function validateRecord(record) {
  const requiredStrings = ['id', 'family', 'title', 'invariant', 'owner', 'enforcementPoint', 'falsifier', 'rejectThreshold', 'status'];
  for (const field of requiredStrings) {
    if (typeof record[field] !== 'string' || record[field].trim().length === 0) {
      fail('INVALID_RECORD', `${record.id ?? 'unknown'} has invalid ${field}`);
    }
  }
  if (!STATUS_VALUES.has(record.status)) fail('INVALID_STATUS', `${record.id} has unsupported status ${record.status}`);
  if (!record.provenance || typeof record.provenance !== 'object') fail('INVALID_RECORD', `${record.id} lacks provenance`);
  if (!Array.isArray(record.evidenceRefs) || record.evidenceRefs.length === 0) fail('INVALID_RECORD', `${record.id} lacks evidence refs`);
  if (!Array.isArray(record.receiptRefs)) fail('INVALID_RECORD', `${record.id} lacks receipt refs`);
  if (record.runtimeAuthority !== authorityForStatus(record.status)) {
    fail('INVALID_AUTHORITY', `${record.id} runtime authority does not match ${record.status}`);
  }
  return record;
}

function createSupplementalMechanisms({ adoptionSha256, researchGroundingSha256 }) {
  const records = createWave3GlobalMechanisms({
    recordSchema: SYSTEMS_LAW_RECORD_SCHEMA,
    researchStatus: SYSTEMS_LAW_STATUS.RESEARCH,
    sources: {
      adoption: { document: SYSTEMS_LAW_SOURCE.ADOPTION.document, sha256: adoptionSha256 },
      researchGrounding: {
        document: SYSTEMS_LAW_SOURCE.RESEARCH_GROUNDING.document,
        sha256: researchGroundingSha256,
      },
    },
  });
  if (records.length !== 13) fail('SUPPLEMENTAL_COUNT_MISMATCH', `expected 13 supplemental mechanisms, found ${records.length}`);
  records.forEach(validateRecord);
  return deepFreeze(records);
}

export function parseGadMechanisms(markdown, { sourceSha256 = sha256Bytes(markdown) } = {}) {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const sections = collectSections(lines, /^### (GAD-\d{3}): (.+)$/, /^## Promotion Record Required$/);
  if (sections.length !== 35) fail('GAD_COUNT_MISMATCH', `expected 35 GAD mechanisms, found ${sections.length}`);

  const records = sections.map(({ match, lines: sectionLines, lineStart, lineEnd }, index) => {
    const id = match[1];
    const expectedId = `GAD-${String(index + 1).padStart(3, '0')}`;
    if (id !== expectedId) fail('GAD_SEQUENCE_MISMATCH', `expected ${expectedId}, found ${id}`);
    const assignment = GAD_ASSIGNMENTS.get(id);
    if (!assignment) fail('MISSING_ASSIGNMENT', `${id} lacks an owner and enforcement assignment`);

    const title = normalizeMarkdown(match[2]);
    const attribution = readParagraph(sectionLines, '**Attribution and source.**', id);
    const invariant = readParagraph(sectionLines, '**Mechanism.**', id);
    const gap = readParagraph(sectionLines, '**Exact Orange gap.**', id);
    const falsifier = readParagraph(sectionLines, '**Smallest falsifier.**', id);
    const rejectThreshold = readParagraph(sectionLines, '**Reject threshold.**', id);
    const sourceStatus = readParagraph(sectionLines, '**Status.**', id).replace(/[.`]/g, '').trim();
    if (sourceStatus !== 'RESEARCH_ONLY') fail('GAD_AUTHORITY_MISMATCH', `${id} is not RESEARCH_ONLY in its source ledger`);
    const sourceText = sectionLines.join('\n');

    return validateRecord({
      schema: SYSTEMS_LAW_RECORD_SCHEMA,
      id,
      family: 'gad-mechanism',
      title,
      provenance: {
        sourceDocument: SYSTEMS_LAW_SOURCE.GAD.document,
        sourceSha256,
        section: `${id}: ${title}`,
        lineStart,
        lineEnd,
        attribution,
      },
      invariant,
      owner: assignment[0],
      enforcementPoint: assignment[1],
      falsifier,
      rejectThreshold,
      evidenceRefs: evidenceRefs({
        document: SYSTEMS_LAW_SOURCE.GAD.document,
        lineStart,
        lineEnd,
        title,
        text: attribution,
      }),
      receiptRefs: receiptRefs(sourceText),
      status: SYSTEMS_LAW_STATUS.RESEARCH,
      sourceDecision: 'RESEARCH_ONLY',
      runtimeAuthority: 'none',
      orangeGap: gap,
    });
  });
  return deepFreeze(records);
}

export function parseAdoptionDecisions(markdown, { sourceSha256 = sha256Bytes(markdown) } = {}) {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const sections = collectSections(lines, /^### (\d+)\. (.+)$/, /^## Ranked First-Proof Queue$/);
  if (sections.length !== ADOPTION_ASSIGNMENTS.length) {
    fail('ADOPTION_COUNT_MISMATCH', `expected ${ADOPTION_ASSIGNMENTS.length} adoption decisions, found ${sections.length}`);
  }

  const records = sections.map(({ match, lines: sectionLines, lineStart, lineEnd }, index) => {
    const [id, expectedTitle, expectedDecision, status, owner, enforcementPoint] = ADOPTION_ASSIGNMENTS[index];
    const sourceNumber = Number.parseInt(match[1], 10);
    const title = normalizeMarkdown(match[2]);
    if (sourceNumber !== index + 1 || title !== expectedTitle) {
      fail('ADOPTION_SEQUENCE_MISMATCH', `expected decision ${index + 1}: ${expectedTitle}, found ${match[1]}: ${title}`);
    }

    const fact = readParagraph(sectionLines, '- **FACT:**', id);
    const inference = readParagraph(sectionLines, '- **INFERENCE:**', id);
    const invariant = readParagraph(sectionLines, '- **CANDIDATE / mechanism:**', id);
    const gap = readParagraph(sectionLines, '- **Orange gap:**', id);
    const falsifier = readParagraph(sectionLines, '- **Smallest falsifiable proof:**', id);
    const rejectThreshold = readParagraph(sectionLines, '- **Reject threshold:**', id);
    const decisionText = readParagraph(sectionLines, '- **Decision:**', id);
    const sourceDecision = decisionText.match(/`([A-Z][A-Z0-9_]+)`/)?.[1];
    if (sourceDecision !== expectedDecision) {
      fail('ADOPTION_DECISION_MISMATCH', `${id} expected ${expectedDecision}, found ${sourceDecision ?? 'none'}`);
    }
    const sourceText = sectionLines.join('\n');

    return validateRecord({
      schema: SYSTEMS_LAW_RECORD_SCHEMA,
      id,
      family: 'alpha-adoption-decision',
      title,
      provenance: {
        sourceDocument: SYSTEMS_LAW_SOURCE.ADOPTION.document,
        sourceSha256,
        section: `${sourceNumber}. ${title}`,
        lineStart,
        lineEnd,
        attribution: fact,
      },
      invariant,
      owner,
      enforcementPoint,
      falsifier,
      rejectThreshold,
      evidenceRefs: evidenceRefs({
        document: SYSTEMS_LAW_SOURCE.ADOPTION.document,
        lineStart,
        lineEnd,
        title,
        text: fact,
      }),
      receiptRefs: receiptRefs(sourceText),
      status,
      sourceDecision,
      decisionText,
      runtimeAuthority: authorityForStatus(status),
      orangeGap: gap,
      inference,
    });
  });
  return deepFreeze(records);
}

function verifyPinnedSource(buffer, source) {
  const observed = sha256Bytes(buffer);
  if (observed !== source.sha256) {
    fail('SOURCE_HASH_MISMATCH', `${source.document} changed without a reviewed registry update`, {
      expected: source.sha256,
      observed,
    });
  }
  return observed;
}

export function createSystemsDesignLawRegistry({
  gadMarkdown,
  adoptionMarkdown,
  researchGroundingMarkdown,
  sourceHashes = {},
}) {
  if (typeof gadMarkdown !== 'string'
    || typeof adoptionMarkdown !== 'string'
    || typeof researchGroundingMarkdown !== 'string') {
    fail('INVALID_SOURCE', 'GAD, adoption, and research-grounding Markdown sources are required');
  }
  const gadSha256 = sourceHashes.gad ?? sha256Bytes(gadMarkdown);
  const adoptionSha256 = sourceHashes.adoption ?? sha256Bytes(adoptionMarkdown);
  const researchGroundingSha256 = sourceHashes.researchGrounding ?? sha256Bytes(researchGroundingMarkdown);
  const records = [
    ...parseGadMechanisms(gadMarkdown, { sourceSha256: gadSha256 }),
    ...createSupplementalMechanisms({ adoptionSha256, researchGroundingSha256 }),
    ...parseAdoptionDecisions(adoptionMarkdown, { sourceSha256: adoptionSha256 }),
  ];
  if (records.length !== 60) fail('REGISTRY_COUNT_MISMATCH', `expected exactly 60 systems law records, found ${records.length}`);
  const ids = new Set(records.map((record) => record.id));
  if (ids.size !== records.length) fail('DUPLICATE_RECORD_ID', 'systems law record IDs must be unique');

  const payload = {
    schema: SYSTEMS_LAW_REGISTRY_SCHEMA,
    version: 1,
    reviewDate: '2026-08-28',
    sources: [
      { document: SYSTEMS_LAW_SOURCE.GAD.document, sha256: gadSha256 },
      { document: SYSTEMS_LAW_SOURCE.ADOPTION.document, sha256: adoptionSha256 },
      { document: SYSTEMS_LAW_SOURCE.RESEARCH_GROUNDING.document, sha256: researchGroundingSha256 },
    ],
    records,
  };
  return deepFreeze({ ...payload, registryHash: hashSystemsLawValue(payload) });
}

export function loadSystemsDesignLawRegistry({
  gadPath = SYSTEMS_LAW_SOURCE.GAD.path,
  adoptionPath = SYSTEMS_LAW_SOURCE.ADOPTION.path,
  researchGroundingPath = SYSTEMS_LAW_SOURCE.RESEARCH_GROUNDING.path,
} = {}) {
  const gadBuffer = readFileSync(gadPath);
  const adoptionBuffer = readFileSync(adoptionPath);
  const researchGroundingBuffer = readFileSync(researchGroundingPath);
  const gadSha256 = verifyPinnedSource(gadBuffer, SYSTEMS_LAW_SOURCE.GAD);
  const adoptionSha256 = verifyPinnedSource(adoptionBuffer, SYSTEMS_LAW_SOURCE.ADOPTION);
  const researchGroundingSha256 = verifyPinnedSource(researchGroundingBuffer, SYSTEMS_LAW_SOURCE.RESEARCH_GROUNDING);
  return createSystemsDesignLawRegistry({
    gadMarkdown: gadBuffer.toString('utf8'),
    adoptionMarkdown: adoptionBuffer.toString('utf8'),
    researchGroundingMarkdown: researchGroundingBuffer.toString('utf8'),
    sourceHashes: { gad: gadSha256, adoption: adoptionSha256, researchGrounding: researchGroundingSha256 },
  });
}
