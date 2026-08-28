import { describe, expect, test } from 'bun:test';
import {
  CLAIM_POLARITIES,
  EVIDENCE_EDGE_TYPES,
  EVIDENCE_ORDER,
  EVIDENCE_TYPES,
  FRESHNESS_STATES,
  EvidencePosetError,
  canonicalJson,
  compareEvidence,
  createEvidenceEdge,
  createEvidenceNode,
  createEvidencePoset,
  evidencePrecedesOrEquals,
  evidenceScopeContains,
  evidenceScopesEqual,
  intersectEvidenceScopes,
  joinEvidencePosets,
  queryEvidence,
  rankEvidence,
  validateEvidencePoset,
} from '../evidence-poset.mjs';
import {
  buildEvidencePosetProofReceipt,
  buildFrozenEvidenceFixtures,
  runGeneratedEvidenceProperties,
  verifyEvidencePosetProofReceipt,
} from '../evidence-poset-proof.mjs';

const AS_OF = '2026-08-28T12:00:00.000Z';
const BROAD_SCOPE = Object.freeze({ system: 'orange5' });
const NARROW_SCOPE = Object.freeze({ system: 'orange5', runtimePath: 'spine/health' });

function node(overrides = {}) {
  return {
    id: Object.hasOwn(overrides, 'id') ? overrides.id : 'node-a',
    type: overrides.type ?? EVIDENCE_TYPES.EXECUTABLE_TEST,
    claim: {
      id: overrides.claimId ?? 'orange5.health.callable',
      polarity: overrides.polarity ?? CLAIM_POLARITIES.SUPPORTS,
    },
    scope: overrides.scope ?? NARROW_SCOPE,
    authority: {
      id: overrides.authorityId ?? 'orange5-test-authority',
      rank: overrides.authorityRank ?? 50,
    },
    observedAt: overrides.observedAt ?? '2026-08-27T00:00:00.000Z',
    validUntil: Object.hasOwn(overrides, 'validUntil') ? overrides.validUntil : '2026-09-01T00:00:00.000Z',
    metadata: overrides.metadata,
  };
}

describe('ranked scoped evidence poset alpha', () => {
  test('creates typed immutable nodes with canonical scope and stable identity', () => {
    const raw = Object.freeze(node({
      id: undefined,
      scope: Object.freeze({ runtimePath: Object.freeze(['spine/health', 'spine/health']), system: 'orange5' }),
      metadata: Object.freeze({ z: 2, a: 1 }),
    }));
    const first = createEvidenceNode(raw);
    const second = createEvidenceNode({ ...raw, scope: { system: 'orange5', runtimePath: ['spine/health'] } });

    expect(first.id).toMatch(/^evidence_[0-9a-f]{32}$/);
    expect(first.id).toBe(second.id);
    expect(first.scope).toEqual({ runtimePath: ['spine/health'], system: ['orange5'] });
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.scope)).toBe(true);
    expect(canonicalJson({ z: 1, a: { y: 2, b: 3 } })).toBe('{"a":{"b":3,"y":2},"z":1}');
    expect(() => createEvidenceNode({ ...node(), type: 'untyped' })).toThrow(EvidencePosetError);
    expect(() => createEvidenceNode({ ...node(), authority: { id: 'x', rank: -1 } })).toThrow('authority.rank');
  });

  test('models scope containment, equality, overlap, and separation explicitly', () => {
    expect(evidenceScopeContains(BROAD_SCOPE, NARROW_SCOPE)).toBe(true);
    expect(evidenceScopeContains(NARROW_SCOPE, BROAD_SCOPE)).toBe(false);
    expect(evidenceScopesEqual({ system: ['orange5'] }, BROAD_SCOPE)).toBe(true);
    expect(intersectEvidenceScopes(BROAD_SCOPE, NARROW_SCOPE)).toEqual({ runtimePath: ['spine/health'], system: ['orange5'] });
    expect(intersectEvidenceScopes(
      { system: 'orange5', runtimePath: 'spine/health' },
      { system: 'orange5', runtimePath: 'gateway/health' },
    )).toBeNull();
  });

  test('uses partial rank dominance without collapsing scope or authority tradeoffs', () => {
    const stale = createEvidenceNode(node({
      id: 'stale',
      observedAt: '2026-08-01T00:00:00.000Z',
      validUntil: '2026-08-10T00:00:00.000Z',
      authorityRank: 40,
    }));
    const current = createEvidenceNode(node({
      id: 'current',
      type: EVIDENCE_TYPES.HASH_CHAINED_RECEIPT,
      observedAt: '2026-08-27T00:00:00.000Z',
      validUntil: '2026-09-01T00:00:00.000Z',
      authorityRank: 80,
    }));
    const freshButWeak = createEvidenceNode(node({
      id: 'fresh-weak',
      type: EVIDENCE_TYPES.CHAT_CLAIM,
      observedAt: '2026-08-28T11:30:00.000Z',
      validUntil: '2026-08-28T13:00:00.000Z',
      authorityRank: 10,
    }));
    const broad = createEvidenceNode(node({ id: 'broad', scope: BROAD_SCOPE }));
    const opposite = createEvidenceNode(node({ id: 'opposite', polarity: CLAIM_POLARITIES.REFUTES }));

    expect(compareEvidence(stale, current, { asOf: AS_OF })).toBe(EVIDENCE_ORDER.LESS);
    expect(evidencePrecedesOrEquals(stale, current, { asOf: AS_OF })).toBe(true);
    expect(rankEvidence(stale, { asOf: AS_OF }).freshness).toBe(FRESHNESS_STATES.STALE);
    expect(rankEvidence(current, { asOf: AS_OF }).freshness).toBe(FRESHNESS_STATES.FRESH);
    expect(compareEvidence(current, freshButWeak, { asOf: AS_OF })).toBe(EVIDENCE_ORDER.INCOMPARABLE);
    expect(compareEvidence(current, broad, { asOf: AS_OF })).toBe(EVIDENCE_ORDER.INCOMPARABLE);
    expect(compareEvidence(current, opposite, { asOf: AS_OF })).toBe(EVIDENCE_ORDER.INCOMPARABLE);
    expect(compareEvidence(current, current, { asOf: AS_OF })).toBe(EVIDENCE_ORDER.EQUAL);
  });

  test('joins by canonical set union while preserving source and contradiction edges', () => {
    const source = createEvidenceNode(node({ id: 'source', claimId: 'source.identity', type: EVIDENCE_TYPES.SOURCE_OR_CONFIGURATION }));
    const support = createEvidenceNode(node({ id: 'support' }));
    const refute = createEvidenceNode(node({ id: 'refute', polarity: CLAIM_POLARITIES.REFUTES, type: EVIDENCE_TYPES.SEMANTIC_LIVE_PROBE }));
    const sourceEdge = createEvidenceEdge({ id: 'source-edge', type: EVIDENCE_EDGE_TYPES.SOURCE, from: support.id, to: source.id });
    const left = createEvidencePoset({ asOf: AS_OF, nodes: [source, support], edges: [sourceEdge] });
    const right = createEvidencePoset({ asOf: AS_OF, nodes: [support, refute] });

    const leftRight = joinEvidencePosets(left, right);
    const rightLeft = joinEvidencePosets(right, left);
    const repeated = joinEvidencePosets(leftRight, leftRight, left, right);

    expect(canonicalJson(leftRight)).toBe(canonicalJson(rightLeft));
    expect(canonicalJson(repeated)).toBe(canonicalJson(leftRight));
    expect(leftRight.sourceEdgeIds).toContain(sourceEdge.id);
    expect(leftRight.contradictionEdgeIds.length).toBe(1);
    expect(leftRight.edges.find((edge) => edge.id === leftRight.contradictionEdgeIds[0])).toMatchObject({
      type: EVIDENCE_EDGE_TYPES.CONTRADICTS,
      from: 'refute',
      to: 'support',
    });
    expect(leftRight.partialOrder.reflexiveNodeIds).toEqual(['refute', 'source', 'support']);
    expect(validateEvidencePoset(leftRight)).toEqual({ ok: true, errors: [] });
  });

  test('fails closed on identity conflicts and false contradiction scopes', () => {
    const first = createEvidenceNode(node({ id: 'same-id', authorityRank: 10 }));
    const conflicting = createEvidenceNode(node({ id: 'same-id', authorityRank: 90 }));
    expect(() => createEvidencePoset({ nodes: [first, conflicting] })).toThrow('conflicting definitions');

    const support = createEvidenceNode(node({ id: 'support-narrow' }));
    const refuteBroad = createEvidenceNode(node({ id: 'refute-broad', scope: BROAD_SCOPE, polarity: CLAIM_POLARITIES.REFUTES }));
    expect(() => createEvidencePoset({
      nodes: [support, refuteBroad],
      edges: [{
        id: 'wrong-contradiction-scope',
        type: EVIDENCE_EDGE_TYPES.CONTRADICTS,
        from: support.id,
        to: refuteBroad.id,
        scope: BROAD_SCOPE,
      }],
    })).toThrow('full overlap scope');
  });

  test('never lets narrow evidence promote a broad claim and never hides overlap conflict', () => {
    const broadFailure = createEvidenceNode(node({
      id: 'broad-failure',
      scope: BROAD_SCOPE,
      polarity: CLAIM_POLARITIES.REFUTES,
      observedAt: '2026-08-01T00:00:00.000Z',
      validUntil: null,
    }));
    const narrowSuccess = createEvidenceNode(node({
      id: 'narrow-success',
      type: EVIDENCE_TYPES.SEMANTIC_LIVE_PROBE,
      authorityRank: 100,
      observedAt: '2026-08-28T11:00:00.000Z',
      validUntil: '2026-08-28T13:00:00.000Z',
    }));
    const poset = createEvidencePoset({ asOf: AS_OF, nodes: [broadFailure, narrowSuccess] });
    const broadQuery = queryEvidence(poset, { claimId: broadFailure.claim.id, scope: BROAD_SCOPE });
    const narrowQuery = queryEvidence(poset, { claimId: broadFailure.claim.id, scope: NARROW_SCOPE });

    expect(broadQuery).toMatchObject({ status: 'REFUTED', candidateNodeIds: ['broad-failure'], contradictionEdgeIds: [] });
    expect(narrowQuery.status).toBe('CONTRADICTED');
    expect(narrowQuery.candidateNodeIds).toEqual(['broad-failure', 'narrow-success']);
    expect(narrowQuery.contradictionEdgeIds.length).toBe(1);
  });

  test('property-checks 64 frozen generated fixtures across permutations and repeated merge', () => {
    const fixtures = buildFrozenEvidenceFixtures(64);
    expect(Object.isFrozen(fixtures)).toBe(true);
    expect(fixtures.every(Object.isFrozen)).toBe(true);

    const summary = runGeneratedEvidenceProperties({ fixtureCount: 64 });
    expect(summary).toMatchObject({
      ok: true,
      fixture_count: 64,
      fixture_floor: 50,
      fixture_floor_met: true,
      permutations_per_fixture: 6,
      repeated_merges_per_fixture: 3,
    });
    expect(summary.assertions_by_property.permutation).toBe(384);
    expect(summary.assertions_by_property.repeated_merge).toBe(192);
    expect(summary.assertions_by_property.source_edge_preservation).toBe(64);
    expect(summary.assertion_count).toBeGreaterThanOrEqual(64 * 20);
  });

  test('builds a canonical tamper-evident receipt with an alpha-only claim boundary', () => {
    const propertySummary = runGeneratedEvidenceProperties({ fixtureCount: 50 });
    const receipt = buildEvidencePosetProofReceipt({
      generatedAt: '2026-08-28T12:30:00.000Z',
      propertySummary,
      focusedTest: {
        executed: true,
        command: 'bun test 03-BACKEND/tests/evidence-poset.test.mjs',
        exit_code: 0,
        passed: true,
        stdout_sha256: 'a'.repeat(64),
        stderr_sha256: 'b'.repeat(64),
      },
      sourceFiles: {
        '03-BACKEND/evidence-poset.mjs': 'c'.repeat(64),
        '03-BACKEND/tests/evidence-poset.test.mjs': 'd'.repeat(64),
        '03-BACKEND/evidence-poset-proof.mjs': 'e'.repeat(64),
      },
    });

    expect(receipt.payload.result).toBe('PASS');
    expect(receipt.payload.adoption_state).toBe('ALPHA_PROOF_ONLY');
    expect(receipt.payload.claim_boundary).toMatchObject({
      production_wired: false,
      operational_status_promoted: false,
      external_observation_accuracy_proven: false,
      fixture_count: 50,
    });
    expect(canonicalJson(JSON.parse(canonicalJson(receipt)))).toBe(canonicalJson(receipt));
    expect(verifyEvidencePosetProofReceipt(receipt)).toEqual({ ok: true, errors: [] });

    const tampered = structuredClone(receipt);
    tampered.payload.checks.scope_boundaries_checked = false;
    expect(verifyEvidencePosetProofReceipt(tampered).ok).toBe(false);
  });
});
