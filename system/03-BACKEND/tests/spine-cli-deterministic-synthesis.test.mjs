import { describe, expect, test } from 'bun:test';
import { deterministicAdversarialAttestation } from '../spine-cli.mjs';

describe('spine CLI deterministic synthesis attestation', () => {
  test('attests only completed receipt-backed deterministic synthesis', () => {
    const result = deterministicAdversarialAttestation(
      { action: 'synthesize.delegation' },
      { evidence: { source: 'receipt_backed_deterministic_synthesis', execution: 'cognitive_report_completed' } },
    );
    expect(result).toMatchObject({ completed: true, preExecution: true, refuted: false, model: null, lane: 'reflex' });
  });

  test('does not bypass review for model synthesis or incomplete aggregation', () => {
    expect(deterministicAdversarialAttestation(
      { action: 'synthesize.delegation' },
      { evidence: { source: 'orangebrain', execution: 'cognitive_report_completed' } },
    )).toBeNull();
    expect(deterministicAdversarialAttestation(
      { action: 'synthesize.delegation' },
      { evidence: { source: 'receipt_backed_deterministic_synthesis', execution: 'cognitive_report_requires_action' } },
    )).toBeNull();
  });

  test('attests governed reflex analysis but not model analysis', () => {
    expect(deterministicAdversarialAttestation(
      { action: 'analyze.agent' },
      { evidence: { source: 'governed_execution_reflex', execution: 'cognitive_report_completed' } },
    )).toMatchObject({ completed: true, refuted: false, model: null });
    expect(deterministicAdversarialAttestation(
      { action: 'analyze.agent' },
      { evidence: { source: 'orangebrain', execution: 'cognitive_report_completed' } },
    )).toBeNull();
  });
});
