#!/usr/bin/env bun
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GENESIS, chainHash } from '../04-CONTROL-PLANE/receipt-integrity.mjs';
import {
  CLAIM_POLARITIES,
  EVIDENCE_EDGE_TYPES,
  EVIDENCE_ORDER,
  EVIDENCE_TYPES,
  FRESHNESS_STATES,
  canonicalJson,
  compareEvidence,
  createEvidencePoset,
  evidencePrecedesOrEquals,
  evidenceScopeContains,
  joinEvidencePosets,
  queryEvidence,
  rankEvidence,
  sha256Canonical,
  validateEvidencePoset,
} from './evidence-poset.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEST_PATH = '03-BACKEND/tests/evidence-poset.test.mjs';
const SOURCE_PATHS = [
  '03-BACKEND/evidence-poset.mjs',
  TEST_PATH,
  '03-BACKEND/evidence-poset-proof.mjs',
];
const FIXTURE_AS_OF = '2026-08-28T12:00:00.000Z';
const DEFAULT_FIXTURE_COUNT = 64;
const FIXTURE_FLOOR = 50;

function sha256Bytes(value) {
  return createHash('sha256').update(value).digest('hex');
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function evidenceNode({ id, type, claimId, polarity, scope, authorityRank, observedAt, validUntil }) {
  return {
    id,
    type,
    claim: { id: claimId, polarity },
    scope,
    authority: { id: 'orange5-alpha-fixture-authority', rank: authorityRank },
    observedAt,
    validUntil,
    source: { fixture: id },
  };
}

function makeFixture(index) {
  const tag = String(index).padStart(3, '0');
  const claimId = `alpha.fixture.claim.${tag}`;
  const broadScope = { system: 'orange5' };
  const narrowScope = { system: 'orange5', runtimePath: `fixture-path-${tag}` };
  const source = evidenceNode({
    id: `source-${tag}`,
    type: EVIDENCE_TYPES.SOURCE_OR_CONFIGURATION,
    claimId: `${claimId}.source`,
    polarity: CLAIM_POLARITIES.SUPPORTS,
    scope: narrowScope,
    authorityRank: 60,
    observedAt: '2026-08-20T00:00:00.000Z',
    validUntil: null,
  });
  const broad = evidenceNode({
    id: `broad-${tag}`,
    type: EVIDENCE_TYPES.SOURCE_OR_CONFIGURATION,
    claimId,
    polarity: index % 2 === 0 ? CLAIM_POLARITIES.SUPPORTS : CLAIM_POLARITIES.REFUTES,
    scope: broadScope,
    authorityRank: 50,
    observedAt: '2026-07-01T00:00:00.000Z',
    validUntil: null,
  });
  const stale = evidenceNode({
    id: `stale-${tag}`,
    type: EVIDENCE_TYPES.EXECUTABLE_TEST,
    claimId,
    polarity: CLAIM_POLARITIES.SUPPORTS,
    scope: narrowScope,
    authorityRank: 55,
    observedAt: '2026-08-01T00:00:00.000Z',
    validUntil: '2026-08-10T00:00:00.000Z',
  });
  const current = evidenceNode({
    id: `current-${tag}`,
    type: EVIDENCE_TYPES.HASH_CHAINED_RECEIPT,
    claimId,
    polarity: CLAIM_POLARITIES.SUPPORTS,
    scope: narrowScope,
    authorityRank: 80,
    observedAt: '2026-08-27T00:00:00.000Z',
    validUntil: '2026-09-01T00:00:00.000Z',
  });
  const live = evidenceNode({
    id: `live-${tag}`,
    type: EVIDENCE_TYPES.SEMANTIC_LIVE_PROBE,
    claimId,
    polarity: CLAIM_POLARITIES.REFUTES,
    scope: narrowScope,
    authorityRank: 90,
    observedAt: '2026-08-28T11:00:00.000Z',
    validUntil: '2026-08-28T13:00:00.000Z',
  });
  const parts = [
    {
      asOf: FIXTURE_AS_OF,
      nodes: [source, broad],
      edges: [{ id: `source-edge-${tag}-broad`, type: EVIDENCE_EDGE_TYPES.SOURCE, from: broad.id, to: source.id }],
    },
    {
      asOf: FIXTURE_AS_OF,
      nodes: [source, stale, current],
      edges: [
        { id: `source-edge-${tag}-stale`, type: EVIDENCE_EDGE_TYPES.SOURCE, from: stale.id, to: source.id },
        { id: `source-edge-${tag}-current`, type: EVIDENCE_EDGE_TYPES.PROVES, from: current.id, to: source.id },
      ],
    },
    {
      asOf: FIXTURE_AS_OF,
      nodes: [source, current, live],
      edges: [{ id: `source-edge-${tag}-live`, type: EVIDENCE_EDGE_TYPES.OBSERVED_BY, from: live.id, to: source.id }],
    },
  ];
  return deepFreeze({
    id: `fixture-${tag}`,
    index,
    claimId,
    broadScope,
    narrowScope,
    nodeIds: { source: source.id, broad: broad.id, stale: stale.id, current: current.id, live: live.id },
    sourceEdgeIds: parts.flatMap((part) => part.edges.map((edge) => edge.id)).sort(),
    broadPolarity: broad.claim.polarity,
    parts,
  });
}

export function buildFrozenEvidenceFixtures(count = DEFAULT_FIXTURE_COUNT) {
  if (!Number.isInteger(count) || count < 1) throw new TypeError('fixture count must be a positive integer');
  return deepFreeze(Array.from({ length: count }, (_, index) => makeFixture(index)));
}

const THREE_PART_PERMUTATIONS = Object.freeze([
  [0, 1, 2],
  [0, 2, 1],
  [1, 0, 2],
  [1, 2, 0],
  [2, 0, 1],
  [2, 1, 0],
]);

export function runGeneratedEvidenceProperties({ fixtureCount = DEFAULT_FIXTURE_COUNT } = {}) {
  const fixtures = buildFrozenEvidenceFixtures(fixtureCount);
  const categories = {
    frozen_input: 0,
    canonical_validation: 0,
    permutation: 0,
    repeated_merge: 0,
    associativity: 0,
    source_edge_preservation: 0,
    contradiction: 0,
    narrow_scope_boundary: 0,
    freshness_authority: 0,
    explicit_order: 0,
    partial_order_laws: 0,
  };
  let assertionCount = 0;
  const check = (condition, category, message) => {
    assertionCount += 1;
    categories[category] += 1;
    requireCondition(condition, message);
  };

  for (const fixture of fixtures) {
    const frozenBytesBefore = canonicalJson(fixture);
    check(Object.isFrozen(fixture) && Object.isFrozen(fixture.parts) && fixture.parts.every(Object.isFrozen), 'frozen_input', `${fixture.id}: fixture input is not frozen`);
    const parts = fixture.parts.map((part) => createEvidencePoset(part));
    const baseline = joinEvidencePosets(...parts);
    const baselineCanonical = canonicalJson(baseline);

    check(validateEvidencePoset(baseline).ok, 'canonical_validation', `${fixture.id}: canonical validation failed`);
    check(canonicalJson(fixture) === frozenBytesBefore, 'frozen_input', `${fixture.id}: input fixture was mutated`);
    check(canonicalJson(baseline.sourceEdgeIds) === canonicalJson(fixture.sourceEdgeIds), 'source_edge_preservation', `${fixture.id}: source edge was lost`);

    const broadQuery = queryEvidence(baseline, { claimId: fixture.claimId, scope: fixture.broadScope });
    check(canonicalJson(broadQuery.candidateNodeIds) === canonicalJson([fixture.nodeIds.broad]), 'narrow_scope_boundary', `${fixture.id}: narrow evidence answered a broad query`);
    const expectedBroadStatus = fixture.broadPolarity === CLAIM_POLARITIES.SUPPORTS ? 'SUPPORTED' : 'REFUTED';
    check(broadQuery.status === expectedBroadStatus, 'narrow_scope_boundary', `${fixture.id}: broad result changed by narrow evidence`);
    check(!evidenceScopeContains(fixture.narrowScope, fixture.broadScope), 'narrow_scope_boundary', `${fixture.id}: narrow scope contains broad scope`);

    const narrowQuery = queryEvidence(baseline, { claimId: fixture.claimId, scope: fixture.narrowScope });
    check(narrowQuery.status === 'CONTRADICTED', 'contradiction', `${fixture.id}: contradiction was hidden`);
    check(narrowQuery.contradictionEdgeIds.length >= 1, 'contradiction', `${fixture.id}: contradiction edge was not retained`);
    check(narrowQuery.candidateNodeIds.includes(fixture.nodeIds.current) && narrowQuery.candidateNodeIds.includes(fixture.nodeIds.live), 'contradiction', `${fixture.id}: contradictory endpoints are absent`);

    const stale = baseline.nodes.find((node) => node.id === fixture.nodeIds.stale);
    const current = baseline.nodes.find((node) => node.id === fixture.nodeIds.current);
    check(compareEvidence(stale, current, { asOf: FIXTURE_AS_OF }) === EVIDENCE_ORDER.LESS, 'freshness_authority', `${fixture.id}: ranked dominance did not preserve freshness and authority`);
    check(rankEvidence(stale, { asOf: FIXTURE_AS_OF }).freshness === FRESHNESS_STATES.STALE, 'freshness_authority', `${fixture.id}: stale evidence was not marked stale`);
    check(rankEvidence(current, { asOf: FIXTURE_AS_OF }).freshness === FRESHNESS_STATES.FRESH, 'freshness_authority', `${fixture.id}: current evidence was not marked fresh`);
    check(baseline.partialOrder.strictEdges.some((edge) => edge.lower === stale.id && edge.higher === current.id), 'explicit_order', `${fixture.id}: strict order edge is missing`);

    const leq = (left, right) => evidencePrecedesOrEquals(left, right, { asOf: FIXTURE_AS_OF });
    check(baseline.nodes.every((candidate) => leq(candidate, candidate)), 'partial_order_laws', `${fixture.id}: order is not reflexive`);
    check(baseline.nodes.every((left) => baseline.nodes.every((right) => (
      !(leq(left, right) && leq(right, left)) || left.id === right.id
    ))), 'partial_order_laws', `${fixture.id}: order is not antisymmetric`);
    check(baseline.nodes.every((left) => baseline.nodes.every((middle) => baseline.nodes.every((right) => (
      !(leq(left, middle) && leq(middle, right)) || leq(left, right)
    )))), 'partial_order_laws', `${fixture.id}: order is not transitive`);

    for (const permutation of THREE_PART_PERMUTATIONS) {
      const merged = joinEvidencePosets(...permutation.map((index) => parts[index]));
      check(canonicalJson(merged) === baselineCanonical, 'permutation', `${fixture.id}: merge depends on input permutation ${permutation.join('')}`);
    }

    let repeated = baseline;
    for (let repetition = 0; repetition < 3; repetition += 1) {
      repeated = joinEvidencePosets(repeated, baseline, ...parts);
      check(canonicalJson(repeated) === baselineCanonical, 'repeated_merge', `${fixture.id}: repeated merge ${repetition + 1} was not idempotent`);
    }

    const leftAssociated = joinEvidencePosets(joinEvidencePosets(parts[0], parts[1]), parts[2]);
    const rightAssociated = joinEvidencePosets(parts[0], joinEvidencePosets(parts[1], parts[2]));
    check(canonicalJson(leftAssociated) === canonicalJson(rightAssociated), 'associativity', `${fixture.id}: grouped merge changed the result`);
  }

  return deepFreeze({
    ok: true,
    fixture_count: fixtures.length,
    fixture_floor: FIXTURE_FLOOR,
    fixture_floor_met: fixtures.length >= FIXTURE_FLOOR,
    permutations_per_fixture: THREE_PART_PERMUTATIONS.length,
    repeated_merges_per_fixture: 3,
    assertion_count: assertionCount,
    assertions_by_property: categories,
    fixture_set_sha256: sha256Canonical(fixtures),
  });
}

function readSourceHashes() {
  return Object.fromEntries(SOURCE_PATHS.map((relativePath) => {
    const bytes = fs.readFileSync(path.join(ROOT, relativePath));
    return [relativePath, sha256Bytes(bytes)];
  }));
}

function runFocusedTest() {
  const result = Bun.spawnSync([process.execPath, 'test', TEST_PATH], {
    cwd: ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = result.stdout.toString();
  const stderr = result.stderr.toString();
  return {
    executed: true,
    command: `bun test ${TEST_PATH}`,
    exit_code: result.exitCode,
    passed: result.exitCode === 0,
    stdout_sha256: sha256Bytes(stdout),
    stderr_sha256: sha256Bytes(stderr),
  };
}

function chainEntry(seq, receiptId, payloadHash, previousHash) {
  return {
    seq,
    receipt_id: receiptId,
    sha256: payloadHash,
    prev_hash: previousHash,
    entry_hash: chainHash(previousHash, { seq, receipt_id: receiptId, sha256: payloadHash }),
  };
}

function normalizeGeneratedAt(value) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new TypeError('generatedAt must be an ISO-compatible timestamp');
  return new Date(time).toISOString();
}

export function buildEvidencePosetProofReceipt({
  generatedAt,
  propertySummary,
  focusedTest,
  sourceFiles,
  propertyError = null,
} = {}) {
  const timestamp = normalizeGeneratedAt(generatedAt ?? new Date().toISOString());
  const checks = {
    focused_tests_passed: focusedTest?.passed === true,
    generated_fixture_floor_met: propertySummary?.fixture_floor_met === true,
    generated_properties_passed: propertySummary?.ok === true && propertyError === null,
    permutation_checks_executed: (propertySummary?.assertions_by_property?.permutation ?? 0) >= FIXTURE_FLOOR * THREE_PART_PERMUTATIONS.length,
    repeated_merge_checks_executed: (propertySummary?.assertions_by_property?.repeated_merge ?? 0) >= FIXTURE_FLOOR * 3,
    source_edges_checked: (propertySummary?.assertions_by_property?.source_edge_preservation ?? 0) >= FIXTURE_FLOOR,
    contradictions_checked: (propertySummary?.assertions_by_property?.contradiction ?? 0) >= FIXTURE_FLOOR,
    scope_boundaries_checked: (propertySummary?.assertions_by_property?.narrow_scope_boundary ?? 0) >= FIXTURE_FLOOR,
    freshness_and_authority_checked: (propertySummary?.assertions_by_property?.freshness_authority ?? 0) >= FIXTURE_FLOOR,
    partial_order_laws_checked: (propertySummary?.assertions_by_property?.partial_order_laws ?? 0) >= FIXTURE_FLOOR * 3,
  };
  const passed = Object.values(checks).every(Boolean);
  const fixtureManifest = {
    generator: 'orange5.scoped-evidence-poset.generated-fixtures.alpha.v1',
    count: propertySummary?.fixture_count ?? 0,
    floor: FIXTURE_FLOOR,
    frozen: true,
    fixture_set_sha256: propertySummary?.fixture_set_sha256 ?? null,
  };
  const payload = {
    schema: 'orange5.scoped-evidence-poset-alpha-proof.v1',
    generated_at: timestamp,
    result: passed ? 'PASS' : 'FAIL',
    adoption_state: 'ALPHA_PROOF_ONLY',
    checks,
    evidence: {
      fixture_manifest: fixtureManifest,
      property_summary: propertySummary ?? null,
      property_error: propertyError,
      focused_test: focusedTest ?? null,
      source_files: sourceFiles ?? {},
    },
    claim_boundary: {
      proves_when_passed: [
        'The isolated pure module produced one canonical result for every tested input permutation and repeated merge over the recorded generated fixtures.',
        'The tested joins retained supplied source edges and represented overlapping opposite-polarity claims with explicit contradiction edges.',
        'The tested broad queries excluded evidence whose scope was narrower than the query, while exact-scope rank comparisons retained freshness and authority as separate dimensions.',
      ],
      does_not_prove: [
        'Production integration, runtime adoption, operational promotion, or behavior outside the three isolated alpha files.',
        'Truth or observation accuracy of evidence payloads, sources, authorities, clocks, or external systems.',
        'Completeness of the evidence type policy for every OrangeFive subsystem or a unique valid join for every arbitrary ordered pair.',
      ],
      production_wired: false,
      operational_status_promoted: false,
      external_observation_accuracy_proven: false,
      fixture_count: propertySummary?.fixture_count ?? 0,
    },
  };
  const payloadHash = sha256Canonical(payload);
  const sourceHash = sha256Canonical(sourceFiles ?? {});
  const fixtureHash = sha256Canonical(fixtureManifest);
  const first = chainEntry(0, 'scoped-evidence-poset-alpha-fixtures', fixtureHash, GENESIS);
  const second = chainEntry(1, 'scoped-evidence-poset-alpha-sources', sourceHash, first.entry_hash);
  const third = chainEntry(2, 'scoped-evidence-poset-alpha-proof', payloadHash, second.entry_hash);
  const envelope = {
    schema: 'orange5.scoped-evidence-poset-alpha-proof-receipt.v1',
    canonicalization: 'orange5.recursive-lexicographic-json.v1',
    hash_algorithm: 'sha256',
    payload,
    payload_sha256: payloadHash,
    chain: {
      genesis: GENESIS,
      entries: [first, second, third],
      head_hash: third.entry_hash,
    },
  };
  return deepFreeze({ ...envelope, receipt_sha256: sha256Canonical(envelope) });
}

export function verifyEvidencePosetProofReceipt(receipt) {
  const errors = [];
  try {
    if (receipt?.schema !== 'orange5.scoped-evidence-poset-alpha-proof-receipt.v1') errors.push('schema mismatch');
    const { receipt_sha256: receiptHash, ...envelope } = receipt ?? {};
    if (sha256Canonical(envelope) !== receiptHash) errors.push('receipt hash mismatch');
    if (sha256Canonical(receipt.payload) !== receipt.payload_sha256) errors.push('payload hash mismatch');
    const entries = receipt?.chain?.entries;
    if (!Array.isArray(entries) || entries.length !== 3) errors.push('chain entry count mismatch');
    else {
      let previous = GENESIS;
      for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index];
        if (entry.seq !== index) errors.push(`chain sequence mismatch at ${index}`);
        if (entry.prev_hash !== previous) errors.push(`chain predecessor mismatch at ${index}`);
        const expected = chainHash(previous, {
          seq: entry.seq,
          receipt_id: entry.receipt_id,
          sha256: entry.sha256,
        });
        if (entry.entry_hash !== expected) errors.push(`chain hash mismatch at ${index}`);
        previous = entry.entry_hash;
      }
      if (receipt.chain.head_hash !== previous) errors.push('chain head mismatch');
      if (entries[0].sha256 !== sha256Canonical(receipt.payload.evidence.fixture_manifest)) errors.push('fixture manifest hash mismatch');
      if (entries[1].sha256 !== sha256Canonical(receipt.payload.evidence.source_files)) errors.push('source manifest hash mismatch');
      if (entries[2].sha256 !== receipt.payload_sha256) errors.push('proof payload chain mismatch');
    }
  } catch (error) {
    errors.push(error?.message ?? String(error));
  }
  return deepFreeze({ ok: errors.length === 0, errors });
}

export function runScopedEvidencePosetProof({
  fixtureCount = DEFAULT_FIXTURE_COUNT,
  runFocusedTests = true,
  generatedAt = new Date().toISOString(),
} = {}) {
  let propertySummary = null;
  let propertyError = null;
  try {
    propertySummary = runGeneratedEvidenceProperties({ fixtureCount });
  } catch (error) {
    propertyError = { name: error?.name ?? 'Error', message: error?.message ?? String(error) };
  }
  const focusedTest = runFocusedTests
    ? runFocusedTest()
    : { executed: false, command: `bun test ${TEST_PATH}`, exit_code: null, passed: false, stdout_sha256: null, stderr_sha256: null };
  return buildEvidencePosetProofReceipt({
    generatedAt,
    propertySummary,
    focusedTest,
    sourceFiles: readSourceHashes(),
    propertyError,
  });
}

if (import.meta.main) {
  const receipt = runScopedEvidencePosetProof();
  process.stdout.write(`${canonicalJson(receipt)}\n`);
  if (receipt.payload.result !== 'PASS') process.exitCode = 1;
}
