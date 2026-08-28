import { describe, expect, test } from 'bun:test';
import { chat, healthSnapshot } from '../orange5-headless-core.mjs';

describe('OrangeFive governed chat', () => {
  test('health reads the local AE Phase fabric without probing direct Codexa services', async () => {
    let phaseUrl = null;
    const result = await healthSnapshot({
      fetchBrain: async () => ({ ok: true, body: { primary: { live: true } } }),
      fetchPhase: async (url) => {
        phaseUrl = url;
        return { ok: true, body: { ok: true, status: 'AE_PHASE_FABRIC_ACTIVE', authenticated: true, connectedPeers: 1, backpressured: false, peers: [{ nodeId: 'CODEXA', stateConverged: true }] } };
      },
      resolveFabric: () => ({ crossNodeTransport: 'ae-phase', phaseUrl: 'http://127.0.0.1:8907', inferenceHost: 'CODEXA', inferenceNodeId: 'codexa' }),
    });
    expect(phaseUrl).toBe('http://127.0.0.1:8907/health');
    expect(result.codexa).toMatchObject({ reachable: true, authorized: true, executable: true, transport: 'ae-phase' });
  });

  test('Codexa offline is explicit while the local brain remains honestly operational', async () => {
    const result = await healthSnapshot({
      fetchBrain: async () => ({ ok: true, status: 200, latencyMs: 2, body: { version: 'test', primary: { tier: 'reflex', model: 'deterministic', host: 'local', live: true } } }),
      fetchPhase: async () => ({ ok: true, body: { ok: true, status: 'AE_PHASE_FABRIC_ACTIVE', authenticated: true, connectedPeers: 0, backpressured: false, peers: [] } }),
      resolveFabric: () => ({ crossNodeTransport: 'ae-phase', phaseUrl: 'http://127.0.0.1:8907', inferenceHost: 'CODEXA', inferenceNodeId: 'codexa' }),
    });
    expect(result.status).toBe('OPERATIONAL');
    expect(result.codexa).toMatchObject({ reachable: false, authorized: false, executable: false });
    expect(result.blockers).toContain('AE Phase has no authenticated Codexa compute peer; Orange continues in local-only mode.');
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
