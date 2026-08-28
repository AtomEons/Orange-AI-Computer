import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ensureSpecialistReady, scheduleSpecialistPrewarm, specialistLeaseSnapshot } from './specialist-lease.mjs';

let server;
const resident = new Set();
let preloadCalls = 0;
let unloadCalls = 0;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === '/api/ps') {
        return Response.json({ models: [...resident].map((name) => ({ name, size: name.includes('embedding') ? 3_000_000_000 : 19_000_000_000, size_vram: 0 })) });
      }
      if (url.pathname === '/api/generate' && request.method === 'POST') {
        const body = await request.json();
        if (body.keep_alive === 0) {
          unloadCalls += 1;
          expect(body.prompt).toBe('');
          resident.delete(body.model);
          return Response.json({ model: body.model, done: true, done_reason: 'unload' });
        }
        preloadCalls += 1;
        expect(body.prompt).toBe('.');
        expect(body.options).toMatchObject({ num_predict: 1, num_ctx: 2048 });
        expect(body.keep_alive).toBe('15m');
        resident.add(body.model);
        if (body.model === 'test-timeout-resident:9b') await Bun.sleep(40);
        return Response.json({ model: body.model, done: true, done_reason: 'load' });
      }
      return new Response('not found', { status: 404 });
    },
  });
});

afterAll(() => server?.stop(true));

describe('bounded specialist lease manager', () => {
  test('cold model is preloaded and verified resident', async () => {
    const result = await ensureSpecialistReady({ tier: 'code', baseUrl: `http://127.0.0.1:${server.port}`, model: 'test-coder:30b' });
    expect(result).toMatchObject({ status: 'ready', source: 'ollama_minimal_warmup', model: 'test-coder:30b' });
    expect(result.resident_bytes).toBe(19_000_000_000);
    expect(preloadCalls).toBe(1);
  });

  test('warm model reuses residency without another load', async () => {
    const result = await ensureSpecialistReady({ tier: 'code', baseUrl: `http://127.0.0.1:${server.port}`, model: 'test-coder:30b' });
    expect(result.source).toBe('already_resident');
    expect(preloadCalls).toBe(1);
  });

  test('background prewarm is nonblocking and converges to ready', async () => {
    const scheduled = scheduleSpecialistPrewarm({ tier: 'heavy', baseUrl: `http://127.0.0.1:${server.port}`, model: 'test-heavy:30b' });
    expect(scheduled).toMatchObject({ scheduled: true, status: 'warming' });
    for (let attempt = 0; attempt < 30 && specialistLeaseSnapshot('test-heavy:30b').status !== 'ready'; attempt += 1) {
      await Bun.sleep(10);
    }
    expect(specialistLeaseSnapshot('test-heavy:30b').status).toBe('ready');
    expect(preloadCalls).toBe(2);
    expect(unloadCalls).toBe(1);
    expect([...resident]).toEqual(['test-heavy:30b']);
  });

  test('retains a bounded embedding utility beside one generative specialist', async () => {
    resident.add('qwen3-embedding:0.6b');
    const result = await ensureSpecialistReady({ tier: 'code', baseUrl: `http://127.0.0.1:${server.port}`, model: 'test-coder:30b' });
    expect(result).toMatchObject({
      status: 'ready',
      model: 'test-coder:30b',
      total_resident_bytes: 22_000_000_000,
      retained_utility_models: ['qwen3-embedding:0.6b'],
    });
    expect([...resident].sort()).toEqual(['qwen3-embedding:0.6b', 'test-coder:30b']);
  });

  test('accepts residency proven just after the warmup response timeout', async () => {
    const result = await ensureSpecialistReady({
      tier: 'navigator',
      baseUrl: `http://127.0.0.1:${server.port}`,
      model: 'test-timeout-resident:9b',
      loadTimeoutMs: 5,
    });
    expect(result).toMatchObject({
      status: 'ready',
      source: 'ollama_warmup_timeout_residency_recovered',
      model: 'test-timeout-resident:9b',
    });
  });
});
