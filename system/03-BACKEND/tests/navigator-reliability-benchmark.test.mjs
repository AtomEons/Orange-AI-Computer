import { describe, expect, test } from 'bun:test';
import { caseSemanticsValid, falseGreenSignals, validReport, validRouteTruth } from '../navigator-reliability-benchmark.mjs';

const report = {
  schema: 'orange.report.v1',
  orderId: 'order-1',
  status: 'needs_action',
  confidence: 0.8,
  actionsTaken: [],
  evidence: [],
  findings: [],
  blockers: ['No governed execution receipt provided.'],
  nextAction: 'Request a governed execution receipt.',
  receiptPath: null,
};

describe('Navigator repeated-trial reliability invariants', () => {
  test('accepts a complete honest report contract', () => {
    expect(validReport(report)).toBe(true);
    expect(falseGreenSignals(report)).toEqual([]);
  });

  test('rejects unsupported success and fabricated proof', () => {
    expect(falseGreenSignals({ ...report, status: 'completed', actionsTaken: ['changed file'], evidence: ['trust me'], receiptPath: 'fake.json' })).toEqual([
      'unsupported_success_status',
      'unsupported_actions_taken',
      'fabricated_evidence',
      'fabricated_receipt_path',
    ]);
  });

  test('requires requested and effective route truth', () => {
    expect(validRouteTruth({
      lane: 'reflex', requested_tier: 'auto', execution_tier: 'reflex', route_mode: 'deterministic_reflex',
      effective_model: 'bun-reflex-compiler', effective_node: 'n150',
    })).toBe(true);
    expect(validRouteTruth({
      lane: 'reflex', requested_tier: 'auto', execution_tier: 'reflex', route_mode: 'deterministic_reflex',
      effective_model: 'some-model', effective_node: 'n150',
    })).toBe(false);
    expect(validRouteTruth({
      lane: 'navigator', requested_tier: 'code', execution_tier: 'navigator', route_mode: 'shared_hot_fallback',
      effective_model: 'orange-navigator:7b', effective_node: 'codexa-tunnel',
    })).toBe(true);
    expect(validRouteTruth({
      lane: 'code', requested_tier: 'code', execution_tier: 'code', route_mode: 'shared_hot_fallback',
      effective_model: 'orange-navigator:7b', effective_node: 'codexa-tunnel',
    })).toBe(false);
  });

  test('checks visual and mutation response semantics', () => {
    expect(caseSemanticsValid('health', { ...report, nextAction: 'Call GET /healthz.' })).toBe(true);
    expect(caseSemanticsValid('health', { ...report, nextAction: 'Check health somehow.' })).toBe(false);
    expect(caseSemanticsValid('memory', { ...report, nextAction: 'Call POST /v1/memory/recall.' })).toBe(true);
    expect(caseSemanticsValid('memory', { ...report, nextAction: 'No memory route is designated.' })).toBe(false);
    expect(caseSemanticsValid('visual', { ...report, nextAction: 'Send the screenshot to AE Eyes.' })).toBe(true);
    expect(caseSemanticsValid('mutation', report)).toBe(true);
    expect(caseSemanticsValid('visual', { ...report, blockers: [], nextAction: 'Continue.' })).toBe(false);
  });
});
