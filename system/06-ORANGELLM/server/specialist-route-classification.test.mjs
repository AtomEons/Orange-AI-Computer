import { afterEach, describe, expect, test } from 'bun:test';
import { specialistLeaseSnapshot } from './specialist-lease.mjs';

const NAVIGATOR = 'orange-navigator:ornith-1.5-9b-q4km';
const CODE = 'qwen3-coder:30b';
const HEAVY = 'qwen3:30b-a3b';
const ENV_KEYS = [
  'ORANGE5_CODEXA_CODE_MODEL',
  'ORANGE5_CODEXA_HEAVY_MODEL',
  'ORANGE5_CODEXA_OLLAMA_URL',
  'ORANGE5_COMPUTE_FABRIC_PATH',
  'ORANGE5_NAVIGATOR_MODEL',
  'ORANGE5_NAVIGATOR_TRANSPORT',
  'ORANGE5_NAVIGATOR_URL',
];
const previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

let server;

function configure(baseUrl) {
  process.env.ORANGE5_CODEXA_CODE_MODEL = CODE;
  process.env.ORANGE5_CODEXA_HEAVY_MODEL = HEAVY;
  process.env.ORANGE5_CODEXA_OLLAMA_URL = baseUrl;
  process.env.ORANGE5_NAVIGATOR_MODEL = NAVIGATOR;
  process.env.ORANGE5_NAVIGATOR_TRANSPORT = 'ollama';
  delete process.env.ORANGE5_NAVIGATOR_URL;
  delete process.env.ORANGE5_COMPUTE_FABRIC_PATH;
}

function runtimeRow(model) {
  if (model === NAVIGATOR) {
    return { name: model, size: 10_000_000_000, size_vram: 0, details: { parameter_size: '9.0B' } };
  }
  return { name: model, size: 19_000_000_000, size_vram: 0, details: { parameter_size: '30.0B' } };
}

function serveRuntime(initialResidents = []) {
  const resident = new Set(initialResidents);
  const events = [];
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === '/api/tags') {
        return Response.json({ models: [NAVIGATOR, CODE, HEAVY].map((name) => ({ name })) });
      }
      if (url.pathname === '/api/ps') {
        return Response.json({ models: [...resident].map(runtimeRow) });
      }
      if (url.pathname === '/api/generate') {
        const body = await request.json();
        if (body.keep_alive === 0) {
          events.push(`unload:${body.model}`);
          resident.delete(body.model);
        } else {
          events.push(`preload:${body.model}`);
          resident.add(body.model);
        }
        return Response.json({ model: body.model, done: true, done_reason: body.keep_alive === 0 ? 'unload' : 'load' });
      }
      if (url.pathname === '/v1/chat/completions') {
        const body = await request.json();
        events.push(`chat:${body.model}`);
        return Response.json({
          id: 'chatcmpl-specialist-route',
          object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        });
      }
      return new Response('not found', { status: 404 });
    },
  });
  return { baseUrl: `http://127.0.0.1:${server.port}`, resident, events };
}

afterEach(() => {
  server?.stop(true);
  server = null;
  for (const key of ENV_KEYS) {
    if (previous[key] == null) delete process.env[key];
    else process.env[key] = previous[key];
  }
});

describe('installed specialist route classification', () => {
  test('uses the resident 9B Navigator before scheduling specialist prewarm', async () => {
    const fake = serveRuntime([NAVIGATOR]);
    configure(fake.baseUrl);
    const upstream = await import(`./upstream.mjs?hot-specialist=${Date.now()}`);

    for (const tier of ['code', 'heavy']) {
      const probe = await upstream.probeUpstream(tier);
      expect(probe).toMatchObject({
        live: true,
        preferred_route: 'hot_navigator',
        capability_mode: 'lease_on_demand',
        model_loaded: false,
        hot_fallback: { reachable: true, model: NAVIGATOR, model_loaded: true, latency_ready: true },
      });
    }

    const result = await upstream.proxyChatCompletions({
      messages: [{ role: 'user', content: 'Review this code request.' }],
      max_tokens: 16,
    }, 'code');
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      ae_requested_tier: 'code',
      ae_execution_tier: 'navigator',
      ae_route_mode: 'shared_hot_fallback',
      ae_effective_model: NAVIGATOR,
      ae_specialist_lease: { status: 'warming', model: CODE, scheduled: true },
    });

    for (let attempt = 0; attempt < 100 && specialistLeaseSnapshot(CODE).status !== 'ready'; attempt += 1) {
      await Bun.sleep(10);
    }
    expect(specialistLeaseSnapshot(CODE).status).toBe('ready');
    expect(fake.events.indexOf(`chat:${NAVIGATOR}`)).toBeGreaterThanOrEqual(0);
    expect(fake.events.indexOf(`unload:${NAVIGATOR}`)).toBeGreaterThan(fake.events.indexOf(`chat:${NAVIGATOR}`));
    expect(fake.events.indexOf(`preload:${CODE}`)).toBeGreaterThan(fake.events.indexOf(`chat:${NAVIGATOR}`));

    fake.resident.clear();
    fake.events.length = 0;

    const coldProbe = await upstream.probeUpstream('code');
    expect(coldProbe).toMatchObject({
      live: true,
      preferred_route: 'direct_ollama',
      capability_mode: 'lease_on_demand',
      model: CODE,
      model_loaded: false,
    });

    const coldResult = await upstream.proxyChatCompletions({
      messages: [{ role: 'user', content: 'Review this code request.' }],
      max_tokens: 16,
    }, 'code');
    expect(coldResult.status).toBe(200);
    expect(coldResult.body).toMatchObject({
      ae_requested_tier: 'code',
      ae_execution_tier: 'code',
      ae_route_mode: 'specialist',
      ae_effective_model: CODE,
      ae_specialist_lease: { status: 'ready', model: CODE },
    });
    expect(fake.events.indexOf(`preload:${CODE}`)).toBeGreaterThanOrEqual(0);
    expect(fake.events.indexOf(`chat:${CODE}`)).toBeGreaterThan(fake.events.indexOf(`preload:${CODE}`));
  }, 15_000);
});
