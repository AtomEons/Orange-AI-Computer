import { describe, expect, test } from 'bun:test';
import { chat, healthSnapshot } from '../orange5-headless-core.mjs';

describe('OrangeFive governed chat', () => {
  test('health discovery never rewrites live compute-fabric state', async () => {
    let options = null;
    await healthSnapshot({
      discoverFabric: async (input) => {
        options = input;
        return { status: 'OPERATIONAL_DISTRIBUTED', operational: true, selections: {}, nodes: [] };
      },
    });
    expect(options).toMatchObject({ timeoutMs: 900, persist: false });
  });

  test('Codexa offline is explicit while the local brain remains honestly operational', async () => {
    const result = await healthSnapshot({
      fetchBrain: async () => ({ ok: true, status: 200, latencyMs: 2, body: { version: 'test', primary: { tier: 'reflex', model: 'deterministic', host: 'local', live: true } } }),
      discoverFabric: async () => ({
        status: 'OPERATIONAL_SINGLE_MACHINE', operational: true, operatorDecisionRequired: false,
        selections: { rail: null, inference: { nodeId: 'local', host: '127.0.0.1' } }, nodes: [],
      }),
    });
    expect(result.status).toBe('OPERATIONAL');
    expect(result.codexa).toMatchObject({ reachable: false, authorized: false, executable: false });
    expect(result.blockers).toContain('Codexa command rail is unavailable; Orange continues in local-only mode.');
  });

  test('ordinary chat crosses the spine and closes the learning loop', async () => {
    let order = null;
    let options = null;
    const result = await chat('What is OrangeFive?', {
      model: 'orange-auto',
      maxTokens: 128,
      execute: async (input, opts) => {
        order = input;
        options = opts;
        return {
          ok: true,
          result: {
            status: 'completed',
            report: { status: 'completed', model: 'orange-navigator:latest', lane: 'navigator', host: 'codexa', output: { answer: 'governed' }, memory_context: { mistakeCount: 1 } },
            receipt: { receipt_id: 'rcpt_chat', hash: 'a'.repeat(64), seq: 1 },
            learning: { ingested: true, transport: 'ae-cobra-http' },
          },
        };
      },
    });
    expect(order.action).toBe('query.chat');
    expect(order.requiresReceipt).toBe(true);
    expect(options).toMatchObject({ learn: true, model: 'orange-auto' });
    expect(result).toMatchObject({ ok: true, model: 'orange-navigator:latest', receipt: { receipt_id: 'rcpt_chat' }, learning: { ingested: true } });
    expect(result.content).toEqual({ answer: 'governed' });
  });
});
