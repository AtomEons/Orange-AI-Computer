#!/usr/bin/env bun
import { describe, expect, test } from 'bun:test';
import { compileOrangeReport, createMissionOrder, validateOrangeReport } from '../cross-organ-mission.mjs';

describe('OrangeFive cross-organ conductor contracts', () => {
  test('creates a bounded read-only Orange order', () => {
    const order = createMissionOrder('prove it');
    expect(order.schema).toBe('orange.order.v1');
    expect(order.action).toBe('query_only');
    expect(order.allowedActions).toEqual(['query_only']);
    expect(order.forbiddenActions).toContain('production_deploy');
    expect(order.requiresReceipt).toBe(true);
  });

  test('accepts a complete report and binds its order id', () => {
    const report = validateOrangeReport({
      schema: 'orange.report.v1', orderId: 'ord-1', status: 'needs_action', confidence: 0.8,
      actionsTaken: [], evidence: [], blockers: ['no action'], nextAction: 'provide work', receiptPath: null,
    }, 'ord-1');
    expect(report.schema).toBe('orange.report.v1');
    expect(report.orderId).toBe('ord-1');
  });

  test('rejects theater reports without evidence fields', () => {
    expect(() => validateOrangeReport({
      schema: 'orange.report.v1', orderId: 'ord-2', status: 'completed', confidence: 1,
      actionsTaken: [], blockers: [], nextAction: 'stop', receiptPath: null,
    }, 'ord-2')).toThrow('missing evidence');
  });

  test('repairs an echoed order into an honest report', () => {
    const compiled = compileOrangeReport({ schema: 'orange.order.v1', orderId: 'ord-3' }, 'ord-3');
    expect(compiled.repair_applied).toBe(true);
    expect(compiled.report.schema).toBe('orange.report.v1');
    expect(compiled.report.status).toBe('needs_action');
    expect(compiled.report.blockers.length).toBe(1);
  });
});
