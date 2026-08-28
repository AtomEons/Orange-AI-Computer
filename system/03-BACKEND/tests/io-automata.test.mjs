import { describe, expect, test } from 'bun:test';
import {
  auditIoFairness,
  createIoState,
  createOrangeOrderAutomaton,
  defineIoAutomaton,
  stepIoAutomaton,
  validateIoComposition,
  validateIoTrace,
} from '../automata/io-automata.mjs';

function advance(spec, state, action, options = {}) {
  return stepIoAutomaton(spec, state, {
    action,
    actor: options.actor || 'test-runtime',
    payload: options.payload || {},
    evidence: options.evidence || [],
    at: options.at ?? state.seq + 1,
  });
}

describe('Orange I/O automata trace covenant', () => {
  test('refuses an input action that is not always enabled', () => {
    expect(() => defineIoAutomaton({
      id: 'broken-input',
      initialState: 'idle',
      states: ['idle', 'busy'],
      actions: [{ name: 'cancel', kind: 'input', transitions: { busy: 'idle' } }],
    })).toThrow('input action cancel is not enabled in: idle');
  });

  test('accepts and replay-verifies the full governed lifecycle', () => {
    const spec = createOrangeOrderAutomaton();
    let state = createIoState(spec, 0);
    const trace = [];
    for (const [action, extra] of [
      ['order.accept', {}],
      ['route.select', {}],
      ['lease.authorize', {}],
      ['execution.start', {}],
      ['report.emit', { payload: { status: 'completed' }, evidence: [{ receipt: 'execution-proof.json', ok: true }] }],
      ['receipt.bind', { evidence: [{ receipt: 'spine-chain.jsonl', hash: 'abc123' }] }],
    ]) {
      const next = advance(spec, state, action, extra);
      state = next.state;
      trace.push(next.trace);
    }
    expect(state.state).toBe('receipted');
    expect(validateIoTrace(spec, trace)).toEqual(expect.objectContaining({ ok: true, finalState: 'receipted', events: 6 }));
  });

  test('false-green output cannot cross the trace boundary', () => {
    const spec = createOrangeOrderAutomaton();
    let state = createIoState(spec, 0);
    for (const action of ['order.accept', 'route.select', 'execution.reflex']) state = advance(spec, state, action).state;
    expect(() => advance(spec, state, 'report.emit', { payload: { status: 'completed' } })).toThrow('requires governed evidence');
    const honest = advance(spec, state, 'report.emit', { payload: { status: 'needs_action' } });
    expect(honest.state.state).toBe('reported');
  });

  test('illegal lifecycle skips are refused', () => {
    const spec = createOrangeOrderAutomaton();
    const state = createIoState(spec, 0);
    expect(() => advance(spec, state, 'report.emit', { payload: { status: 'needs_action' } })).toThrow('not enabled');
  });

  test('hash or payload tampering fails deterministic replay', () => {
    const spec = createOrangeOrderAutomaton();
    const start = createIoState(spec, 0);
    const first = advance(spec, start, 'order.accept');
    const second = advance(spec, first.state, 'route.select');
    const tampered = structuredClone([first.trace, second.trace]);
    tampered[1].payload = { invented: true };
    const result = validateIoTrace(spec, tampered);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('event_2_payloadHash');
    expect(result.errors).toContain('event_2_eventHash');
  });

  test('fairness reports accepted work that never receives a turn', () => {
    const spec = createOrangeOrderAutomaton({ fairnessMs: 100 });
    const accepted = advance(spec, createIoState(spec, 0), 'order.accept', { at: 10 }).state;
    expect(auditIoFairness(spec, accepted, 50).ok).toBe(true);
    const late = auditIoFairness(spec, accepted, 111);
    expect(late.ok).toBe(false);
    expect(late.violations[0]).toEqual(expect.objectContaining({ task: 'route-accepted-order', debt: 'enabled_work_did_not_receive_a_turn' }));
  });

  test('composition refuses two organs claiming the same output', () => {
    const make = (id) => defineIoAutomaton({
      id,
      initialState: 'ready',
      states: ['ready'],
      actions: [{ name: 'report.emit', kind: 'output', transitions: { ready: 'ready' } }],
    });
    expect(validateIoComposition([make('navigator'), make('hermes')])).toEqual(expect.objectContaining({
      ok: false,
      errors: ['output_collision:report.emit:navigator:hermes'],
    }));
  });
});
