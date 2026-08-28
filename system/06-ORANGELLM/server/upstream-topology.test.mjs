import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_CODEXA_ETHERNET_OLLAMA_URL,
  DEFAULT_CODEXA_OLLAMA_URL,
  DEFAULT_CODEXA_RAIL_URL,
  DEFAULT_MAX_TOKENS,
  MAX_MAX_TOKENS,
  UPSTREAM,
  canUseCompactNoEvidenceGrammar,
  coalesceSystemMessages,
  loadedModelNames,
  modelIsLoaded,
  normalizeLoopbackUrl,
  resolveOllamaCandidates,
  selectOllamaCandidate,
  resolveMaxTokens,
  resolveSpecialistContext,
  normalizeNativeOllamaChat,
} from './upstream.mjs';
import { prepareOperationalRequest } from '../contracts/orange-report.mjs';

describe('OrangeBrain Codexa topology', () => {
  test('canonicalizes private loopback tunnels to IPv4 for Bun fetch', () => {
    expect(normalizeLoopbackUrl('http://localhost:11437')).toBe('http://127.0.0.1:11437');
    expect(normalizeLoopbackUrl('http://10.0.0.4:11434')).toBe('http://10.0.0.4:11434');
  });
  test('defaults to the direct CAT8 service address with Wi-Fi recovery', () => {
    expect(DEFAULT_CODEXA_ETHERNET_OLLAMA_URL).toBe('http://10.0.99.1:11434');
    expect(DEFAULT_CODEXA_OLLAMA_URL).toBe('http://10.0.0.4:11434');
    expect(DEFAULT_CODEXA_RAIL_URL).toBe('http://10.0.0.4:8097');
    if (!process.env.ORANGE5_CODEXA_OLLAMA_URL) {
      expect(UPSTREAM.navigator.base_url).toBe(DEFAULT_CODEXA_ETHERNET_OLLAMA_URL);
      expect(UPSTREAM.code.base_url).toBe(DEFAULT_CODEXA_ETHERNET_OLLAMA_URL);
      expect(UPSTREAM.heavy.base_url).toBe(DEFAULT_CODEXA_ETHERNET_OLLAMA_URL);
      expect(UPSTREAM.navigator.candidates).toContain(DEFAULT_CODEXA_OLLAMA_URL);
    }
    if (!process.env.ORANGE5_CODEXA_RAIL_URL) {
      expect(UPSTREAM.heavy.fallback.base_url).toBe(DEFAULT_CODEXA_RAIL_URL);
    }
  });

  test('orders explicit, CAT8, discovered, and recovery routes without duplicates', () => {
    expect(resolveOllamaCandidates({
      configuredUrl: 'http://127.0.0.1:11437',
      ethernetUrl: DEFAULT_CODEXA_ETHERNET_OLLAMA_URL,
      fabricUrl: 'http://127.0.0.1:11437',
      fallbackUrls: `${DEFAULT_CODEXA_OLLAMA_URL};http://10.0.0.8:11434`,
      wifiUrl: DEFAULT_CODEXA_OLLAMA_URL,
    })).toEqual([
      'http://127.0.0.1:11437',
      DEFAULT_CODEXA_ETHERNET_OLLAMA_URL,
      DEFAULT_CODEXA_OLLAMA_URL,
      'http://10.0.0.8:11434',
    ]);
  });

  test('fails over from a dead tunnel and automatically returns to CAT8', () => {
    const deadTunnel = { path: 'http://127.0.0.1:11437', reachable: false, model_available: false };
    const cat8 = { path: DEFAULT_CODEXA_ETHERNET_OLLAMA_URL, reachable: true, model_available: true, model_loaded: false };
    const wifi = { path: DEFAULT_CODEXA_OLLAMA_URL, reachable: true, model_available: true, model_loaded: false };
    expect(selectOllamaCandidate([deadTunnel, cat8, wifi], 'navigator').lease.path).toBe(DEFAULT_CODEXA_ETHERNET_OLLAMA_URL);
    expect(selectOllamaCandidate([deadTunnel, { ...cat8, reachable: false }, wifi], 'navigator').lease.path).toBe(DEFAULT_CODEXA_OLLAMA_URL);
    expect(selectOllamaCandidate([deadTunnel, cat8, wifi], 'navigator').lease.path).toBe(DEFAULT_CODEXA_ETHERNET_OLLAMA_URL);
  });

  test('binds each deterministic lane to a concrete installed-model contract', () => {
    expect(UPSTREAM.light.model).toBe('orangellm-smart-skinny-0.5b');
    expect(UPSTREAM.navigator.model).toBeTruthy();
    expect(UPSTREAM.code.model).toBe(process.env.ORANGE5_CODEXA_CODE_MODEL || 'qwen3-coder:30b');
    expect(UPSTREAM.heavy.model).toBeTruthy();
  });

  test('respects bounded caller token budgets', () => {
    expect(resolveMaxTokens({ max_tokens: 32 })).toBe(32);
    expect(resolveMaxTokens({ max_completion_tokens: 16 })).toBe(16);
    expect(resolveMaxTokens({})).toBe(DEFAULT_MAX_TOKENS);
    expect(resolveMaxTokens({ max_tokens: 0 })).toBe(DEFAULT_MAX_TOKENS);
    expect(resolveMaxTokens({ max_tokens: 100_000 })).toBe(MAX_MAX_TOKENS);
  });

  test('sizes specialist context by actual prompt pressure', () => {
    expect(resolveSpecialistContext({ messages: [{ content: 'small request' }], max_tokens: 64 }, 'code')).toBe(4096);
    expect(resolveSpecialistContext({ messages: [{ content: 'x'.repeat(20_000) }], max_tokens: 256 }, 'code')).toBe(8192);
    expect(resolveSpecialistContext({ messages: [{ content: 'x'.repeat(50_000) }], max_tokens: 256 }, 'code')).toBe(16384);
    expect(resolveSpecialistContext({ messages: [], options: { num_ctx: 5000 } }, 'code')).toBe(5000);
  });

  test('operational report contract explicitly earns its larger budget', () => {
    expect(prepareOperationalRequest({ messages: [] }).max_tokens).toBe(128);
    expect(prepareOperationalRequest({ messages: [], max_tokens: 512 }).max_tokens).toBe(512);
    const prepared = prepareOperationalRequest({ messages: [{ role: 'user', content: 'order' }] });
    expect(prepared.messages.at(-1).content).toBe('order\n/no_think');
  });

  test('never combines the compact report grammar with Atomic tool calling', () => {
    const base = {
      response_format: { json_schema: { name: 'orange_report_draft' } },
      messages: [{ role: 'system', content: 'No governed evidence was supplied.' }],
    };
    expect(canUseCompactNoEvidenceGrammar(base, 'navigator', 'llama.cpp-vulkan')).toBe(true);
    expect(canUseCompactNoEvidenceGrammar({
      ...base,
      tools: [{ type: 'function', function: { name: 'probe', parameters: { type: 'object' } } }],
    }, 'navigator', 'llama.cpp-vulkan')).toBe(false);
  });

  test('coalesces system frames for strict Ollama chat templates', () => {
    const messages = coalesceSystemMessages([
      { role: 'system', content: 'contract' },
      { role: 'user', content: 'first' },
      { role: 'system', content: 'memory' },
      { role: 'assistant', content: 'answer' },
      { role: 'user', content: 'latest' },
    ]);
    expect(messages).toEqual([
      { role: 'system', content: 'contract\n\nmemory' },
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'answer' },
      { role: 'user', content: 'latest' },
    ]);
  });
  test('normalizes native Ollama chat into the OpenAI-compatible envelope', () => {
    const result = normalizeNativeOllamaChat({
      model: 'orange-navigator:test',
      message: { role: 'assistant', content: '{"f":["bounded"],"n":"probe"}' },
      done: true,
      done_reason: 'stop',
      prompt_eval_count: 7,
      eval_count: 9,
    });
    expect(result.choices[0].message.content).toBe('{"f":["bounded"],"n":"probe"}');
    expect(result.choices[0].finish_reason).toBe('stop');
    expect(result.usage).toEqual({ prompt_tokens: 7, completion_tokens: 9, total_tokens: 16 });
    expect(result.ae_native_ollama.done).toBe(true);
  });

  test('internal derive policy tells the terminal refuter to evaluate its authenticated packet', () => {
    const prepared = prepareOperationalRequest({ messages: [{ role: 'user', content: '{"role":"falsifier","evidence":["probe"]}' }] }, 'order:refuter', {
      evidencePolicy: 'derive',
    });
    const contract = prepared.messages[0].content;
    expect(contract).toContain('Internal refuter protocol');
    expect(contract).toContain('REFUTED=true or REFUTED=false');
    expect(contract).toContain('packet evidence field is nonempty');
  });

  test('distinguishes a resident model from a merely reachable Ollama host', () => {
    const state = { models: [{ name: 'orange-navigator:hot-v1' }] };
    expect(loadedModelNames(state)).toEqual(['orange-navigator:hot-v1']);
    expect(modelIsLoaded(state, 'orange-navigator:hot-v1')).toBe(true);
    expect(modelIsLoaded({ models: [] }, 'orange-navigator:hot-v1')).toBe(false);
  });

  test('treats a small resident Navigator as interactive even when context allocation is large', async () => {
    const previousOllama = process.env.ORANGE5_CODEXA_OLLAMA_URL;
    const previousNavigator = process.env.ORANGE5_NAVIGATOR_URL;
    const previousModel = process.env.ORANGE5_NAVIGATOR_MODEL;
    const previousFabricPath = process.env.ORANGE5_COMPUTE_FABRIC_PATH;
    const model = 'orange-navigator:test-small-v2';
    const fakeOllama = Bun.serve({
      port: 0,
      fetch(request) {
        const pathname = new URL(request.url).pathname;
        if (pathname === '/api/tags') return Response.json({ models: [{ name: model }] });
        if (pathname === '/api/ps') return Response.json({ models: [{ name: model, size: 13_231_309_453, size_vram: 0, details: { parameter_size: '4.0B' } }] });
        return new Response('not found', { status: 404 });
      },
    });
    process.env.ORANGE5_CODEXA_OLLAMA_URL = `http://127.0.0.1:${fakeOllama.port}`;
    process.env.ORANGE5_NAVIGATOR_MODEL = model;
    process.env.ORANGE5_COMPUTE_FABRIC_PATH = `${process.env.TEMP || '.'}/orange5-upstream-ollama-test-${Date.now()}.json`;
    delete process.env.ORANGE5_NAVIGATOR_URL;
    try {
      const runtime = await import(`./upstream.mjs?large-context-test=${Date.now()}`);
      const result = await runtime.probeUpstream('navigator');
      expect(result.live).toBe(true);
      expect(result.preferred_route).toBe('direct_ollama');
      expect(result.primary.latency_ready).toBe(true);
    } finally {
      fakeOllama.stop(true);
      if (previousOllama == null) delete process.env.ORANGE5_CODEXA_OLLAMA_URL; else process.env.ORANGE5_CODEXA_OLLAMA_URL = previousOllama;
      if (previousNavigator == null) delete process.env.ORANGE5_NAVIGATOR_URL; else process.env.ORANGE5_NAVIGATOR_URL = previousNavigator;
      if (previousModel == null) delete process.env.ORANGE5_NAVIGATOR_MODEL; else process.env.ORANGE5_NAVIGATOR_MODEL = previousModel;
      if (previousFabricPath == null) delete process.env.ORANGE5_COMPUTE_FABRIC_PATH; else process.env.ORANGE5_COMPUTE_FABRIC_PATH = previousFabricPath;
    }
  });

  test('selects the loopback Vulkan Navigator only when its endpoint is configured', async () => {
    const previous = process.env.ORANGE5_NAVIGATOR_URL;
    process.env.ORANGE5_NAVIGATOR_URL = 'http://127.0.0.1:11436';
    try {
      const accelerated = await import(`./upstream.mjs?vulkan-test=${Date.now()}`);
      expect(accelerated.UPSTREAM.navigator.base_url).toBe('http://127.0.0.1:11436');
      expect(accelerated.UPSTREAM.navigator.backend).toBe('llama.cpp-vulkan');
      expect(accelerated.UPSTREAM.code.base_url).toBe(process.env.ORANGE5_CODEXA_OLLAMA_URL ?? DEFAULT_CODEXA_OLLAMA_URL);
    } finally {
      if (previous == null) delete process.env.ORANGE5_NAVIGATOR_URL;
      else process.env.ORANGE5_NAVIGATOR_URL = previous;
    }
  });

  test('falls back to Ollama when the accelerated Navigator transport is down', async () => {
    const previousNavigator = process.env.ORANGE5_NAVIGATOR_URL;
    const previousOllama = process.env.ORANGE5_CODEXA_OLLAMA_URL;
    const previousModel = process.env.ORANGE5_NAVIGATOR_MODEL;
    const navigatorModel = UPSTREAM.navigator.model;
    const fakeOllama = Bun.serve({
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === '/api/tags') return Response.json({ models: [{ name: navigatorModel }] });
        if (path === '/api/ps') return Response.json({ models: [{ name: navigatorModel }] });
        return new Response('not found', { status: 404 });
      },
    });
    process.env.ORANGE5_NAVIGATOR_URL = 'http://127.0.0.1:1';
    process.env.ORANGE5_CODEXA_OLLAMA_URL = `http://127.0.0.1:${fakeOllama.port}`;
    process.env.ORANGE5_NAVIGATOR_MODEL = navigatorModel;
    try {
      const accelerated = await import(`./upstream.mjs?fallback-test=${Date.now()}`);
      const result = await accelerated.probeUpstream('navigator');
      expect(result.live).toBe(true);
      expect(result.preferred_route).toBe('direct_ollama');
      expect(result.primary.reachable).toBe(false);
      expect(result.fallback.model_loaded).toBe(true);
    } finally {
      fakeOllama.stop(true);
      if (previousNavigator == null) delete process.env.ORANGE5_NAVIGATOR_URL;
      else process.env.ORANGE5_NAVIGATOR_URL = previousNavigator;
      if (previousOllama == null) delete process.env.ORANGE5_CODEXA_OLLAMA_URL;
      else process.env.ORANGE5_CODEXA_OLLAMA_URL = previousOllama;
      if (previousModel == null) delete process.env.ORANGE5_NAVIGATOR_MODEL;
      else process.env.ORANGE5_NAVIGATOR_MODEL = previousModel;
    }
  });
});
