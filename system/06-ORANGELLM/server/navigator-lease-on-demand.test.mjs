import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const previous = {};
const ENV_KEYS = [
  'ORANGE5_CODEXA_OLLAMA_URL',
  'ORANGE5_COMPUTE_FABRIC_PATH',
  'ORANGE5_NAVIGATOR_KEEP_ALIVE',
  'ORANGE5_NAVIGATOR_MODEL',
  'ORANGE5_NAVIGATOR_TRANSPORT',
  'ORANGE5_NAVIGATOR_URL',
];
for (const key of ENV_KEYS) previous[key] = process.env[key];

let server;
let scratch;

afterEach(() => {
  server?.stop(true);
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    if (previous[key] == null) delete process.env[key];
    else process.env[key] = previous[key];
  }
  server = null;
  scratch = null;
});

describe('Navigator lease-on-demand routing', () => {
  test('ignores stale 4B environment identity and leases the selected cold Ornith model', async () => {
    const model = 'orange-navigator:ornith-1.5-9b-q4km';
    let resident = false;
    let preloadBody = null;
    let chatBody = null;
    server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === '/api/tags') return Response.json({ models: [{ name: model }] });
        if (url.pathname === '/api/ps') {
          return Response.json({ models: resident ? [{ name: model, size: 7_000_000_000 }] : [] });
        }
        if (url.pathname === '/api/generate') {
          preloadBody = await request.json();
          resident = true;
          return Response.json({ model, done: true, done_reason: 'load' });
        }
        if (url.pathname === '/v1/chat/completions') {
          chatBody = await request.json();
          return Response.json({
            id: 'chatcmpl-test',
            object: 'chat.completion',
            choices: [{ index: 0, message: { role: 'assistant', content: '{"status":"ok"}' }, finish_reason: 'stop' }],
          });
        }
        return new Response('not found', { status: 404 });
      },
    });

    scratch = mkdtempSync(join(tmpdir(), 'orange5-navigator-lease-'));
    const fabricPath = join(scratch, 'compute-fabric.json');
    writeFileSync(fabricPath, JSON.stringify({
      schema: 'orange.compute-fabric.v1',
      selections: {
        inference: { kind: 'ollama', url: `http://127.0.0.1:${server.port}`, host: 'codexa', nodeId: 'codexa-tunnel' },
        navigator: { kind: 'ollama', url: `http://127.0.0.1:${server.port}`, model, host: 'codexa', nodeId: 'codexa-tunnel' },
      },
    }));
    process.env.ORANGE5_COMPUTE_FABRIC_PATH = fabricPath;
    process.env.ORANGE5_CODEXA_OLLAMA_URL = `http://127.0.0.1:${server.port}`;
    process.env.ORANGE5_NAVIGATOR_TRANSPORT = 'ollama';
    process.env.ORANGE5_NAVIGATOR_MODEL = 'orange-navigator:hot-v1';
    process.env.ORANGE5_NAVIGATOR_KEEP_ALIVE = '15m';
    delete process.env.ORANGE5_NAVIGATOR_URL;

    const upstream = await import(`./upstream.mjs?navigator-lease=${Date.now()}`);
    expect(upstream.UPSTREAM.navigator).toMatchObject({
      backend: 'ollama',
      base_url: `http://127.0.0.1:${server.port}`,
      model,
      state: 'leased-on-demand',
    });

    const cold = await upstream.probeUpstream('navigator');
    expect(cold).toMatchObject({
      live: true,
      preferred_route: 'direct_ollama',
      capability_mode: 'lease_on_demand',
      model_loaded: false,
    });

    const result = await upstream.proxyChatCompletions({
      messages: [{ role: 'user', content: 'status' }],
      max_tokens: 32,
    }, 'navigator');
    expect(result.status).toBe(200);
    expect(preloadBody).toMatchObject({ model, keep_alive: '15m', options: { num_predict: 1, num_ctx: 2048 } });
    expect(chatBody).toMatchObject({ model, keep_alive: '15m' });
    expect(result.body.ae_specialist_lease).toMatchObject({ tier: 'navigator', model, status: 'ready' });
  });
});
