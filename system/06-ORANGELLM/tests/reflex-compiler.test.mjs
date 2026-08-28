#!/usr/bin/env bun
import { describe, expect, test } from 'bun:test';
import { classifyReflexIntent, compileReflexCompletion } from '../server/reflex-compiler.mjs';

const message = (content) => [{ role: 'user', content }];

describe('Orange deterministic reflex compiler', () => {
  test('compiles the five fixed operational intents without a model call', () => {
    const cases = [
      ['Report the OrangeFive health route. Do not claim execution.', 'health-route', '/healthz'],
      ['Explain which OrangeFive memory route should answer a project recall request.', 'memory-recall-route', '/v1/memory/recall'],
      ['A screenshot needs inspection. Route it to the correct OrangeFive organ.', 'visual-route', 'AE Eyes'],
      ['Codexa is unreachable. State the honest fallback and next action.', 'codexa-offline-policy', 'N150'],
      ['Plan a source edit, but do not claim any file changed without a governed execution receipt.', 'mutation-proof-boundary', 'Hermes'],
    ];
    for (const [prompt, intent, marker] of cases) {
      const compiled = compileReflexCompletion({ messages: message(prompt), orderId: `order-${intent}` });
      expect(compiled.decision.id).toBe(intent);
      expect(compiled.envelope.ae_reflex.model_calls_avoided).toBe(1);
      expect(compiled.envelope.ae_route_mode).toBe('deterministic_reflex');
      expect(JSON.stringify(compiled.report)).toContain(marker);
    }
  });

  test('does not steal ambiguous, creative, evidentiary, or real mutation work', () => {
    const prompts = [
      'Design a new memory architecture for OrangeFive.',
      'Use this health report as evidence and diagnose the failure.',
      'Edit the health route implementation and run tests.',
      'Edit the source file and run its tests.',
      'Explain why the visual system architecture is effective.',
      'Write a launch brief for Codexa.',
    ];
    for (const prompt of prompts) expect(classifyReflexIntent(message(prompt))).toBeNull();
  });

  test('returns a complete Orange report with no fake evidence or action', () => {
    const compiled = compileReflexCompletion({
      messages: message('Report the OrangeFive health endpoint.'),
      orderId: 'order-health',
    });
    expect(compiled.report.schema).toBe('orange.report.v1');
    expect(compiled.report.orderId).toBe('order-health');
    expect(compiled.report.actionsTaken).toEqual([]);
    expect(compiled.report.evidence).toEqual([]);
    expect(compiled.report.receiptPath).toBeNull();
    expect(compiled.envelope.usage.prompt_tokens).toBe(0);
  });
});
