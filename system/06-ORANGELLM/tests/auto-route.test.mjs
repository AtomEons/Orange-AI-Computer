import { describe, expect, test } from 'bun:test';
import { compileChatOrder, isAutoModel, resolveAutoRoute } from '../server/auto-route.mjs';

describe('Orange auto hot conductor', () => {
  test('recognizes only the explicit auto surface and omitted model', () => {
    expect(isAutoModel()).toBe(true);
    expect(isAutoModel('orange-auto')).toBe(true);
    expect(isAutoModel('orange-navigator')).toBe(false);
  });

  test('routes even trivial generated chat to Codexa, not an N150 model', () => {
    const result = resolveAutoRoute({ messages: [{ role: 'user', content: 'Say hello.' }] });
    expect(result.tier).toBe('navigator');
    expect(result.decision.lane).toBe('local-fast');
  });

  test('routes substantive chat to the stronger Codexa Navigator', () => {
    const result = resolveAutoRoute({ messages: [{ role: 'user', content: 'Explain how Orange memory preserves project decisions.' }] });
    expect(result.tier).toBe('navigator');
    expect(result.decision.lane).toBe('local-fast');
    expect(result.decision.model).toBe('orange-navigator:ornith-1.5-9b-q4km');
  });

  test('routes architecture-grade synthesis to the heavy judge lane', () => {
    const result = resolveAutoRoute({ messages: [{ role: 'user', content: 'Explain the active OrangeFive runtime architecture and its cross-discipline trade-offs.' }] });
    expect(result.tier).toBe('heavy');
    expect(result.decision.lane).toBe('heavy');
    expect(result.order.allowedActions).toContain('judge');
  });

  test('routes repository coding to the Codexa code specialist', () => {
    const result = resolveAutoRoute({ messages: [{ role: 'user', content: 'Refactor this TypeScript repository and run its tests.' }] });
    expect(result.tier).toBe('code');
    expect(result.decision.lane).toBe('local-code');
    expect(result.decision.model).toBe('qwen3-coder:30b');
  });

  test('discusses visual routing on Navigator when no image payload exists', () => {
    const result = resolveAutoRoute({ messages: [{ role: 'user', content: 'A screenshot needs inspection. Route it without claiming inspection.' }] });
    expect(result.order.inputModalities).toEqual(['text']);
    expect(result.tier).toBe('navigator');
  });

  test('discusses execution truth on Navigator without inventing tool authority', () => {
    const result = resolveAutoRoute({ messages: [{ role: 'user', content: 'Explain why model output is not real execution. Do not execute anything.' }] });
    expect(result.order.action).toBe('query.chat');
    expect(result.decision.signals.needs).not.toContain('tools');
    expect(result.tier).toBe('navigator');
    expect(result.decision.lane).toBe('local-fast');
  });

  test('earns a visual-capable lane only when image content is present', () => {
    const result = resolveAutoRoute({ ae_order_id: 'visual-route-1', messages: [{ role: 'user', content: [
      { type: 'text', text: 'Inspect this image.' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } },
    ] }] });
    expect(result.order.action).toBe('query.visual');
    expect(result.order.inputModalities).toContain('image');
    expect(result.tier).toBe('visual');
    expect(result.decision.lane).toBe('ae-eyes');
    expect(result.decision.capability).toBe('operational-vision');
    expect(result.decision.model).toBe('ae-eyes');
    expect(result.decision.decision_id).toMatch(/^[a-f0-9]{64}$/);
    expect(result.decision.scorecard.every((lane) => lane.eligible === false)).toBe(true);
  });

  test('FLOW pressure is present in the deterministic decision', () => {
    const body = { ae_order_id: 'flow-pressure-proof', messages: [{ role: 'user', content: 'Explain Orange memory.' }] };
    const result = resolveAutoRoute(body, {
      currents: { one: { id: 'one', status: 'in_progress', pressure: 1, assigned_agent: 'agent-one' } },
      agents: { 'agent-one': { id: 'agent-one', state: 'riding', capability: { lane: 'navigator' } } },
      deltas: []
    });
    expect(result.decision.field.ambient).toBe(1);
    expect(result.decision.field.governor.in_progress).toBe(1);
  });

  test('raises risk instead of executing destructive language', () => {
    const order = compileChatOrder({ messages: [{ role: 'user', content: 'Delete production and deploy it again.' }] });
    expect(order.riskLevel).toBe('high');
    expect(order.forbiddenActions).toContain('execute_without_approval');
  });

  test('does not mistake release status discussion for a destructive release command', () => {
    const result = resolveAutoRoute({ messages: [{ role: 'user', content: 'Name the current Orange product release and give one non-mutating next action.' }] });
    expect(result.order.riskLevel).toBe('low');
    expect(result.order.forbiddenActions).toEqual([]);
    expect(result.tier).toBe('navigator');
  });

  test('same supplied order id and field produce the same route decision', () => {
    const body = { ae_order_id: 'stable-1', messages: [{ role: 'user', content: 'Explain Orange memory.' }] };
    const a = resolveAutoRoute(body);
    const b = resolveAutoRoute(body);
    expect(a.decision.decision_id).toBe(b.decision.decision_id);
  });
});
