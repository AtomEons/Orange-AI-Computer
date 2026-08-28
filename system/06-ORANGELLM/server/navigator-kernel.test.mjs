#!/usr/bin/env bun
import { describe, expect, test } from 'bun:test';
import { classifyNavigatorKernelQuery, compileNavigatorKernelCompletion } from './navigator-kernel.mjs';

describe('source-backed Navigator Kernel', () => {
  test('answers canonical memory and compute topology without a model lease', () => {
    const compiled = compileNavigatorKernelCompletion({
      orderId: 'kernel-proof-1',
      model: 'orange-auto',
      messages: [{
        role: 'user',
        content: 'Explain how Orange preserves project memory and sends heavy model work to Codexa. Name AE Phase and distinguish source truth from hot context.',
      }],
    });
    expect(compiled).not.toBeNull();
    const answer = compiled.envelope.choices[0].message.content;
    expect(answer).toContain('AE Phase');
    expect(answer).toContain('source truth');
    expect(answer).toContain('hot context');
    expect(compiled.envelope.ae_route_mode).toBe('navigator_kernel');
    expect(compiled.envelope.ae_navigator_kernel.model_calls_avoided).toBe(1);
    expect(compiled.envelope.ae_navigator_kernel.source_refs.length).toBeGreaterThan(2);
  });

  test('does not intercept open-ended design work or live health questions', () => {
    expect(classifyNavigatorKernelQuery([{ role: 'user', content: 'How should we improve AE Phase and hot context?' }])).toBeNull();
    expect(classifyNavigatorKernelQuery([{ role: 'user', content: 'Is AE Phase running right now?' }])).toBeNull();
  });

  test('does not intercept generic conversation', () => {
    expect(classifyNavigatorKernelQuery([{ role: 'user', content: 'Explain the active Orange system.' }])).toBeNull();
    expect(classifyNavigatorKernelQuery([{ role: 'user', content: 'Write a launch note for Orange.' }])).toBeNull();
  });
});
