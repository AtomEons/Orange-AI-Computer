import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configureComputeNode, discoverComputeFabric, resolveComputeEndpointsSync, resolveRailToken } from '../compute-fabric.mjs';

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function tempState() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orange-fabric-'));
  roots.push(root);
  return { statePath: path.join(root, 'compute-fabric.json'), receiptPath: path.join(root, 'receipt.json') };
}

function fakeFetch(routes) {
  return async (url, init = {}) => {
    const match = Object.entries(routes).find(([needle]) => String(url).includes(needle));
    if (!match) return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
    const value = typeof match[1] === 'function' ? match[1](url, init) : match[1];
    return new Response(JSON.stringify(value.body ?? value), { status: value.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
}

const tcpOff = async () => ({ reachable: false, latencyMs: 1 });

describe('Orange compute fabric', () => {
  test('selects a trusted network AI computer and records distributed mode', async () => {
    const paths = tempState();
    const state = await discoverComputeFabric({
      ...paths,
      fetchFn: fakeFetch({
        '10.0.0.4:11434/api/tags': { models: [{ name: 'orange-navigator:hot-v1' }] },
        '10.0.0.4:8097/health': { body: { status: 'VERIFIED', tokenConfigured: true } },
        '10.0.0.4:8097/receipts': [],
        '10.0.0.4:7440/health': { body: { status: 'ok' } },
      }),
      tcpFn: async (host, port) => ({ reachable: host === '10.0.0.4' && port === 8097, latencyMs: 2 }),
      persist: true,
    });
    expect(state.status).toBe('OPERATIONAL_DISTRIBUTED');
    expect(state.selections.inference).toMatchObject({ nodeId: 'codexa', host: '10.0.0.4', kind: 'ollama' });
    expect(state.selections.inference).toMatchObject({ physicalNodeId: 'codexa', pathId: 'wifi' });
    expect(state.selections.rail.nodeId).toBe('codexa');
    expect(state.selections.rail.authorized).toBe(true);
    expect(state.selections.eyes.nodeId).toBe('codexa');
    const endpoints = resolveComputeEndpointsSync({ statePath: paths.statePath });
    expect(endpoints.inferenceUrl).toBe('http://10.0.0.4:11434');
    expect(endpoints.navigatorNodeId).toBe(endpoints.inferenceNodeId);
  });

  test('falls back to one machine when no trusted network worker answers', async () => {
    const paths = tempState();
    const state = await discoverComputeFabric({
      ...paths,
      fetchFn: fakeFetch({ '127.0.0.1:11434/api/tags': { models: [{ name: 'local-small' }] } }),
      tcpFn: tcpOff,
      persist: false,
    });
    expect(state.status).toBe('OPERATIONAL_SINGLE_MACHINE');
    expect(state.mode).toBe('single_machine');
    expect(state.localFallbackReady).toBe(true);
    expect(state.selections.inference).toMatchObject({ nodeId: 'local', local: true });
  });

  test('discovers unknown AI hardware but never silently trusts it', async () => {
    const paths = tempState();
    const state = await discoverComputeFabric({
      ...paths,
      neighborHosts: ['10.0.0.88'],
      fetchFn: fakeFetch({
        '127.0.0.1:11434/api/tags': { models: [{ name: 'local-small' }] },
        '10.0.0.88:11434/api/tags': { models: [{ name: 'unknown-fast-model' }] },
      }),
      tcpFn: tcpOff,
      persist: false,
    });
    expect(state.operatorDecisionRequired).toBe(true);
    expect(state.untrustedDiscovered[0].host).toBe('10.0.0.88');
    expect(state.selections.inference.nodeId).toBe('local');
  });

  test('configured trusted nodes participate in deterministic priority selection', async () => {
    const paths = tempState();
    configureComputeNode({ id: 'worker-two', host: '10.0.0.8', trusted: true, priority: 250 }, { statePath: paths.statePath });
    const state = await discoverComputeFabric({
      ...paths,
      fetchFn: fakeFetch({
        '10.0.0.4:11434/api/tags': { models: [{ name: 'codexa' }] },
        '10.0.0.8:11434/api/tags': { models: [{ name: 'worker-two' }] },
      }),
      tcpFn: tcpOff,
      persist: false,
    });
    expect(state.selections.inference.nodeId).toBe('worker-two');
  });

  test('models Codexa as one physical node across paths and supports direct-link rollback', async () => {
    const paths = tempState();
    const fetchFn = fakeFetch({
      '10.0.0.4:11434/api/tags': { models: [{ name: 'wifi-model' }] },
      '10.0.99.1:11434/api/tags': { models: [{ name: 'direct-model' }] },
    });
    const direct = await discoverComputeFabric({ ...paths, fetchFn, tcpFn: tcpOff, persist: false });
    expect(direct.selections.inference).toMatchObject({
      nodeId: 'codexa-direct', physicalNodeId: 'codexa', pathId: 'direct-cat8', host: '10.0.99.1',
    });

    const rollback = await discoverComputeFabric({
      ...paths,
      env: { ...process.env, ORANGE5_DISABLE_CODEXA_DIRECT: '1' },
      fetchFn,
      tcpFn: tcpOff,
      persist: false,
    });
    expect(rollback.nodes.some((node) => node.id === 'codexa-direct')).toBe(false);
    expect(rollback.selections.inference).toMatchObject({
      nodeId: 'codexa', physicalNodeId: 'codexa', pathId: 'wifi', host: '10.0.0.4',
    });
  });

  test('prefers the protected disk token over a stale inherited process token', async () => {
    const paths = tempState();
    const tokenPath = path.join(path.dirname(paths.statePath), 'rail-token.txt');
    fs.writeFileSync(tokenPath, 'canonical-token\n', 'utf8');
    const env = {
      USERPROFILE: path.dirname(paths.statePath),
      ORANGEBOX_RAIL_TOKEN: 'stale-token',
      ORANGEBOX_RAIL_TOKEN_FILE: tokenPath,
    };
    expect(resolveRailToken(env)).toBe('canonical-token');
    let observed = null;
    await discoverComputeFabric({
      ...paths,
      env,
      fetchFn: fakeFetch({
        '127.0.0.1:8097/receipts': (_url, init) => {
          observed = init.headers?.['X-Orangebox-Token'];
          return [];
        },
      }),
      tcpFn: tcpOff,
      persist: false,
    });
    expect(observed).toBe('canonical-token');
  });
});
