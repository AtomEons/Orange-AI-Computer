import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import {
  CUSTODY_MODEL_OPERATIONS,
  auditCustodyInvariants,
  checkCustodyInterleavings,
  createCustodyModelState,
  stepCustodyModel,
} from '../ae-link/custody-interleaving-checker.mjs';

function commit(state, command) {
  const journaled = stepCustodyModel(state, { kind: 'record', command });
  expect(journaled.decision).toBe('journaled');
  const applied = stepCustodyModel(journaled.state, {
    kind: 'apply',
    evidenceId: journaled.evidenceId,
  });
  expect(applied.decision).toBe('accepted');
  return applied.state;
}

function completedState() {
  let state = createCustodyModelState();
  state = commit(state, {
    operation: 'offer', writer: 'writer-a', owner: 'node-a', ownerEpoch: 1,
  });
  state = commit(state, {
    operation: 'persist', writer: 'writer-a', owner: 'node-a', ownerEpoch: 1,
  });
  state = commit(state, {
    operation: 'start', writer: 'writer-a', owner: 'node-a', ownerEpoch: 1,
  });
  state = commit(state, {
    operation: 'effect', writer: 'writer-a', owner: 'node-a', ownerEpoch: 1, effectId: 'primary-effect',
  });
  return commit(state, {
    operation: 'terminal', writer: 'writer-a', owner: 'node-a', ownerEpoch: 1, outcome: 'completed',
  });
}

function violationCodes(state) {
  return auditCustodyInvariants(state).violations.map(({ code }) => code);
}

describe('AE Link independent bounded custody model', () => {
  test('has no imports from the production custody path', () => {
    const source = fs.readFileSync(
      new URL('../ae-link/custody-interleaving-checker.mjs', import.meta.url),
      'utf8',
    );
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toContain("from './custody.mjs'");
    expect(source).not.toContain("from './index.mjs'");
  });

  test('exhaustively checks the bounded two-writer interleaving state space', () => {
    const report = checkCustodyInterleavings();

    expect(report.ok).toBe(true);
    expect(report.independentSpecification).toBe(true);
    expect(report.reachabilityProjection).toBe('current-work+pending-evidence+journal-budget');
    expect(report.truncated).toBe(false);
    expect(report.violations).toEqual([]);
    expect(report.missingCoverage).toEqual([]);
    expect(report.statesExplored).toBeGreaterThan(100);
    expect(report.transitionsExplored).toBeGreaterThan(report.statesExplored);
    expect(report.raceWindows).toBeGreaterThan(0);
    expect(report.terminalStates).toBeGreaterThan(0);
    expect(report.coverage.acceptedOperations).toEqual(CUSTODY_MODEL_OPERATIONS);
    expect(report.coverage.cancelModes).toEqual(['pre-start', 'post-start']);
    expect(report.coverage.writers).toEqual(['writer-a', 'writer-b']);
    expect(report.coverage.duplicateEffectAttemptsBlocked).toBeGreaterThan(0);
    expect(report.coverage.executionAfterPreStartCancelBlocked).toBeGreaterThan(0);
    expect(report.coverage.terminalConflictsBlocked).toBeGreaterThan(0);
    expect(report.coverage.staleOwnerEpochBlocked).toBeGreaterThan(0);
  });

  test('will not apply a transition without durable journal evidence', () => {
    const initial = createCustodyModelState();
    const missing = stepCustodyModel(initial, { kind: 'apply', evidenceId: 'not-recorded' });
    expect(missing).toMatchObject({ decision: 'rejected', reason: 'missing-journal-evidence' });

    const volatile = stepCustodyModel(initial, {
      kind: 'record',
      durable: false,
      command: {
        operation: 'offer', writer: 'writer-a', owner: 'node-a', ownerEpoch: 1,
      },
    });
    const refused = stepCustodyModel(volatile.state, {
      kind: 'apply', evidenceId: volatile.evidenceId,
    });
    expect(refused).toMatchObject({ decision: 'rejected', reason: 'journal-evidence-not-durable' });
    expect(refused.state.work.phase).toBe('empty');
  });

  test('orphan recovery cannot erase an accepted cancellation', () => {
    let state = createCustodyModelState();
    state = commit(state, {
      operation: 'offer', writer: 'writer-a', owner: 'node-a', ownerEpoch: 1,
    });
    state = commit(state, {
      operation: 'persist', writer: 'writer-a', owner: 'node-a', ownerEpoch: 1,
    });
    state = commit(state, {
      operation: 'start', writer: 'writer-a', owner: 'node-a', ownerEpoch: 1,
    });
    state = commit(state, {
      operation: 'cancel', writer: 'writer-b', owner: 'node-a', ownerEpoch: 1,
    });
    state = commit(state, {
      operation: 'recovery',
      writer: 'writer-b',
      owner: 'node-a',
      ownerEpoch: 1,
      toOwner: 'node-b',
      toEpoch: 2,
      orphanEvidence: 'lease-expired',
    });
    expect(state.work).toMatchObject({
      phase: 'cancel-requested', owner: 'node-b', ownerEpoch: 2,
    });

    const journaled = stepCustodyModel(state, {
      kind: 'record',
      command: {
        operation: 'start', writer: 'writer-a', owner: 'node-b', ownerEpoch: 2,
      },
    });
    const refused = stepCustodyModel(journaled.state, {
      kind: 'apply', evidenceId: journaled.evidenceId,
    });
    expect(refused).toMatchObject({ decision: 'rejected', reason: 'start-not-enabled' });
  });

  test('the independent auditor detects every named invariant violation', () => {
    const valid = completedState();
    expect(auditCustodyInvariants(valid)).toEqual({ ok: true, violations: [] });

    const duplicateEffect = structuredClone(valid);
    duplicateEffect.work.effectIds.push('primary-effect');
    expect(violationCodes(duplicateEffect)).toContain('duplicate_effect');

    const multipleTerminal = structuredClone(valid);
    multipleTerminal.work.terminalOutcomes.push('failed');
    expect(violationCodes(multipleTerminal)).toContain('multiple_terminal_outcomes');

    const epochRegression = structuredClone(valid);
    epochRegression.acceptedTransitions.at(-1).afterEpoch = 0;
    expect(violationCodes(epochRegression)).toContain('owner_epoch_regressed');

    const missingEvidence = structuredClone(valid);
    missingEvidence.journal = missingEvidence.journal.slice(0, -1);
    expect(violationCodes(missingEvidence)).toContain('accepted_without_durable_journal');

    let cancelled = createCustodyModelState();
    cancelled = commit(cancelled, {
      operation: 'offer', writer: 'writer-a', owner: 'node-a', ownerEpoch: 1,
    });
    cancelled = commit(cancelled, {
      operation: 'persist', writer: 'writer-a', owner: 'node-a', ownerEpoch: 1,
    });
    cancelled = commit(cancelled, {
      operation: 'cancel', writer: 'writer-b', owner: 'node-a', ownerEpoch: 1,
    });
    const executionAfterCancel = structuredClone(cancelled);
    const prior = executionAfterCancel.journal.at(-1);
    executionAfterCancel.journal.push({
      id: 'forged-start',
      sequence: prior.sequence + 1,
      previousEvidenceId: prior.id,
      durable: true,
      operation: 'start',
      writer: 'writer-a',
      command: {},
      observed: {},
    });
    executionAfterCancel.acceptedTransitions.push({
      sequence: executionAfterCancel.acceptedTransitions.length + 1,
      operation: 'start',
      evidenceId: 'forged-start',
      writer: 'writer-a',
      beforePhase: 'terminal',
      afterPhase: 'started',
      beforeRevision: executionAfterCancel.work.revision,
      afterRevision: executionAfterCancel.work.revision + 1,
      beforeOwner: 'node-a',
      afterOwner: 'node-a',
      beforeEpoch: 1,
      afterEpoch: 1,
    });
    executionAfterCancel.work.phase = 'started';
    executionAfterCancel.work.revision += 1;
    expect(violationCodes(executionAfterCancel)).toContain('execution_after_prestart_cancel');
  });
});
