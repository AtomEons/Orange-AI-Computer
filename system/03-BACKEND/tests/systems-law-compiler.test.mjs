import { describe, expect, test } from 'bun:test';

import {
  SystemsLawCompilerError,
  SystemsLawViolationError,
  assertActiveSystemsDesignLaws,
  auditCompiledSystemsDesignLaws,
  compileSystemsDesignLaws,
  evaluateSystemsDesignLaws,
  hashSystemsLawValue,
  loadSystemsDesignLawRegistry,
  queryCompiledSystemsDesignLaw,
} from '../systems-law/index.mjs';

function sourceViewObservation(overrides = {}) {
  return {
    source: {
      identity: 'sha256:source-object',
      hash: '8f4f2f6af4f97eb0f884f79ac6ef07bc8f0864b56c37ac07f44a8f612d7f5150',
      bytesImmutable: true,
      hashVerified: true,
    },
    projection: {
      sourceHash: '8f4f2f6af4f97eb0f884f79ac6ef07bc8f0864b56c37ac07f44a8f612d7f5150',
      transformVersion: 'N+1',
      unknownFieldsPreserved: true,
      charactersPreserved: true,
      rebuildable: true,
      authorityPreserved: true,
      retentionPreserved: true,
    },
    authority: { widened: false },
    hydration: { exactSourceAvailable: true },
    ...overrides,
  };
}

function relevanceObservation() {
  return {
    feedback: {
      explicit: true,
      attributedToOperator: true,
      modelGenerated: false,
      projectScoped: true,
    },
    scope: { crossProjectInfluence: false },
    training: { temporalHoldout: true },
    ranking: { replayable: true },
    rollback: { exactParity: true },
    metrics: { ndcgAt10Gain: 0.025, exactIdentifierRecallDelta: 0 },
  };
}

function baselineObservation() {
  return {
    observations: { appendOnly: true },
    history: { rewritten: false },
    evaluation: { lookaheadUsed: false },
    baseline: {
      oldScoreRetained: true,
      explicitChangePoint: true,
      minimumSampleCountMet: true,
    },
    metrics: {
      stationaryFalseAlarmRate: 0.05,
      seededDriftDetected: true,
      maxDetectionDelaySamples: 20,
      beatsStrongerBaseline: true,
    },
  };
}

function passingObservations() {
  return {
    'GSA-007': sourceViewObservation(),
    'GSA-008': relevanceObservation(),
    'GSA-010': baselineObservation(),
  };
}

describe('systems design law runtime compiler', () => {
  test('compiles only the active and shadow decisions in stable order', () => {
    const compiled = compileSystemsDesignLaws(loadSystemsDesignLawRegistry());

    expect(compiled.policies.map((policy) => policy.id)).toEqual(['GSA-007', 'GSA-008', 'GSA-010']);
    expect(compiled.policies.map((policy) => policy.mode)).toEqual(['enforce', 'observe', 'observe']);
    expect(compiled.policies.some((policy) => policy.id.startsWith('GAD-'))).toBe(false);
    expect(compiled.policies.every((policy) => policy.rules.length > 0)).toBe(true);
    expect(compiled.policies.every((policy) => policy.falsifier.length > 0)).toBe(true);
    expect(compiled.policies.every((policy) => policy.failureThreshold === policy.rejectThreshold)).toBe(true);
    expect(compiled.sourcePins).toHaveLength(3);
    expect(compiled.bundleHash).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.isFrozen(compiled)).toBe(true);
    expect(Object.isFrozen(compiled.policies[0].rules)).toBe(true);
  });

  test('makes every authoritative law machine-queryable and auditable', () => {
    const compiled = compileSystemsDesignLaws(loadSystemsDesignLawRegistry());
    const sourceView = queryCompiledSystemsDesignLaw(compiled, 'GSA-007');
    const firstAudit = auditCompiledSystemsDesignLaws(compiled);
    const secondAudit = auditCompiledSystemsDesignLaws(compiled);

    expect(sourceView).toEqual(expect.objectContaining({
      id: 'GSA-007',
      mode: 'enforce',
      owner: 'orange5.source-view',
    }));
    expect(sourceView.provenance.sourceDocument).toContain('GLOBAL_SYSTEMS_ALPHA_ADOPTION_LEDGER.md');
    expect(sourceView.falsifier.length).toBeGreaterThan(0);
    expect(sourceView.failureThreshold.length).toBeGreaterThan(0);
    expect(queryCompiledSystemsDesignLaw(compiled, 'GAD-036')).toBeNull();
    expect(firstAudit.passed).toBe(true);
    expect(firstAudit.summary).toEqual({
      policies: 3,
      active: 1,
      shadow: 2,
      queryable: 3,
      auditable: 3,
    });
    expect(firstAudit.activePolicyIds).toEqual(['GSA-007']);
    expect(firstAudit.shadowPolicyIds).toEqual(['GSA-008', 'GSA-010']);
    expect(firstAudit.policies.every((policy) => policy.ruleIds.length > 0)).toBe(true);
    expect(firstAudit.policies.every((policy) => Object.values(policy.checks).every(Boolean))).toBe(true);
    expect(firstAudit.auditHash).toBe(secondAudit.auditHash);
    expect(Object.isFrozen(firstAudit)).toBe(true);
  });

  test('passes deterministic boundary values and emits stable hashes', () => {
    const compiled = compileSystemsDesignLaws(loadSystemsDesignLawRegistry());
    const first = evaluateSystemsDesignLaws(compiled, passingObservations());
    const second = evaluateSystemsDesignLaws(compiled, passingObservations());

    expect(first.allowed).toBe(true);
    expect(first.summary).toEqual({
      policies: 3,
      active: 1,
      shadow: 2,
      activeFailures: 0,
      shadowFailures: 0,
    });
    expect(first.reportHash).toBe(second.reportHash);
    expect(first.policies).toEqual(second.policies);
    expect(assertActiveSystemsDesignLaws(first)).toBe(first);
  });

  test('blocks on one active source/view invariant failure', () => {
    const compiled = compileSystemsDesignLaws(loadSystemsDesignLawRegistry());
    const observations = passingObservations();
    observations['GSA-007'].projection.sourceHash = 'different-source';
    const report = evaluateSystemsDesignLaws(compiled, observations);
    const active = report.policies.find((policy) => policy.id === 'GSA-007');

    expect(report.allowed).toBe(false);
    expect(report.summary.activeFailures).toBe(1);
    expect(active.decision).toBe('reject');
    expect(active.failedRuleIds).toContain('projection-source-bound');
    expect(() => assertActiveSystemsDesignLaws(report)).toThrow(SystemsLawViolationError);
  });

  test('reports shadow rejection without gaining enforcement authority', () => {
    const compiled = compileSystemsDesignLaws(loadSystemsDesignLawRegistry());
    const report = evaluateSystemsDesignLaws(compiled, {
      'GSA-007': sourceViewObservation(),
      'GSA-008': {
        ...relevanceObservation(),
        metrics: { ndcgAt10Gain: 0.0199, exactIdentifierRecallDelta: -0.0001 },
      },
      'GSA-010': {
        ...baselineObservation(),
        metrics: {
          ...baselineObservation().metrics,
          stationaryFalseAlarmRate: 0.0501,
        },
      },
    });

    expect(report.allowed).toBe(true);
    expect(report.summary.activeFailures).toBe(0);
    expect(report.summary.shadowFailures).toBe(2);
    expect(report.policies.filter((policy) => policy.decision === 'shadow_reject')).toHaveLength(2);
  });

  test('fails closed when the active observation or a numeric metric is missing', () => {
    const compiled = compileSystemsDesignLaws(loadSystemsDesignLawRegistry());
    const missingActive = evaluateSystemsDesignLaws(compiled, {});
    expect(missingActive.allowed).toBe(false);
    expect(missingActive.policies.find((policy) => policy.id === 'GSA-007').failedRuleIds)
      .toContain('source-identity-present');

    const observations = passingObservations();
    observations['GSA-010'].metrics.stationaryFalseAlarmRate = Number.NaN;
    const invalidShadow = evaluateSystemsDesignLaws(compiled, observations);
    const falseAlarm = invalidShadow.policies
      .find((policy) => policy.id === 'GSA-010')
      .checks.find((check) => check.ruleId === 'stationary-false-alarm-bound');
    expect(falseAlarm.pass).toBe(false);
    expect(falseAlarm.actual).toBeNull();
    expect(invalidShadow.allowed).toBe(true);
  });

  test('refuses to compile newly authoritative text without reviewed runtime rules', () => {
    const original = loadSystemsDesignLawRegistry();
    const changed = JSON.parse(JSON.stringify(original));
    delete changed.registryHash;
    const research = changed.records.find((record) => record.id === 'GAD-001');
    research.status = 'active';
    research.runtimeAuthority = 'enforce';
    changed.registryHash = hashSystemsLawValue(changed);

    expect(() => compileSystemsDesignLaws(changed)).toThrow(SystemsLawCompilerError);
    try {
      compileSystemsDesignLaws(changed);
    } catch (error) {
      expect(error.code).toBe('MISSING_POLICY_RULES');
      expect(error.message).toContain('GAD-001');
    }
  });
});
