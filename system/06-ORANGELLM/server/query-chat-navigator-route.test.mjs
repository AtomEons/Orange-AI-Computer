import { afterEach, describe, expect, test } from 'bun:test';
import { validateOrangeReport } from '../contracts/orange-report.mjs';

const MODEL = 'orange-navigator:ornith-1.5-9b-q4km';
const ENV_KEYS = [
  'ORANGE5_CHAT_MEMORY',
  'ORANGE5_CHAT_RECEIPTS',
  'ORANGE5_CODEXA_OLLAMA_URL',
  'ORANGE5_COMPUTE_FABRIC_PATH',
  'ORANGE5_CURRENT_AWARENESS',
  'ORANGE5_NAVIGATOR_KEEP_ALIVE',
  'ORANGE5_NAVIGATOR_MODEL',
  'ORANGE5_NAVIGATOR_TRANSPORT',
  'ORANGE5_NAVIGATOR_URL',
];
const previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

let upstream;

afterEach(() => {
  upstream?.stop(true);
  upstream = null;
  for (const key of ENV_KEYS) {
    if (previous[key] == null) delete process.env[key];
    else process.env[key] = previous[key];
  }
});

describe('Orange query.chat Navigator route', () => {
  test('leases the selected Ornith model and returns a valid Orange report', async () => {
    let resident = false;
    let preloadBody = null;
    let chatBody = null;
    upstream = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === '/api/tags') return Response.json({ models: [{ name: MODEL }] });
        if (url.pathname === '/api/ps') {
          return Response.json({ models: resident ? [{ name: MODEL, size: 7_000_000_000, size_vram: 7_000_000_000 }] : [] });
        }
        if (url.pathname === '/api/generate') {
          preloadBody = await request.json();
          resident = true;
          return Response.json({ model: MODEL, done: true, done_reason: 'load' });
        }
        if (url.pathname === '/api/chat') {
          chatBody = await request.json();
          return Response.json({
            model: MODEL,
            message: { role: 'assistant', content: JSON.stringify({
              answer: 'Operational success requires governed evidence before Orange can call the action complete.',
              nextAction: 'Run a governed probe.',
            }) },
            done: true,
            done_reason: 'stop',
            prompt_eval_count: 10,
            eval_count: 12,
          });
        }
        return new Response('not found', { status: 404 });
      },
    });

    process.env.ORANGE5_CHAT_MEMORY = '0';
    process.env.ORANGE5_CHAT_RECEIPTS = '0';
    process.env.ORANGE5_CURRENT_AWARENESS = '0';
    process.env.ORANGE5_CODEXA_OLLAMA_URL = `http://127.0.0.1:${upstream.port}`;
    process.env.ORANGE5_NAVIGATOR_TRANSPORT = 'ollama';
    process.env.ORANGE5_NAVIGATOR_MODEL = MODEL;
    process.env.ORANGE5_NAVIGATOR_KEEP_ALIVE = '15m';
    delete process.env.ORANGE5_NAVIGATOR_URL;
    delete process.env.ORANGE5_COMPUTE_FABRIC_PATH;

    const { handleV1ChatCompletions } = await import(`./routes/v1.mjs?query-chat-navigator=${Date.now()}`);
    const orderId = 'query-chat-navigator-proof';
    const result = await handleV1ChatCompletions({
      model: 'orange-auto',
      ae_response_contract: 'orange.report.v1',
      ae_order_id: orderId,
      ae_evidence_policy: 'none',
      messages: [{
        role: 'user',
        content: 'Summarize why an Orange report must not claim operational success without governed evidence.',
      }],
      max_tokens: 128,
    });

    expect(result._ae_http_status).toBe(200);
    const report = validateOrangeReport(JSON.parse(result.choices[0].message.content), orderId);
    expect(report.status).toBe('needs_action');
    expect(report.evidence).toEqual([]);
    expect(report.blockers).toContain('no governed evidence supplied');
    expect(result.ae_turn.action).toBe('query.chat');
    expect(result.ae_turn.prompt_budget).toMatchObject({ budget_tokens: 256, within_budget: true });
    expect(result.ae_reflex).toBeUndefined();
    expect(result.ae_auto_route).toMatchObject({ lane: 'local-fast', tier: 'navigator', model: MODEL });
    expect(result).toMatchObject({
      ae_route_mode: 'specialist',
      ae_execution_tier: 'navigator',
      ae_effective_model: MODEL,
      ae_specialist_lease: { tier: 'navigator', model: MODEL, status: 'ready' },
    });
    expect(preloadBody).toMatchObject({ model: MODEL, keep_alive: '15m' });
    expect(chatBody).toMatchObject({
      model: MODEL,
      stream: false,
      think: false,
      keep_alive: '15m',
      think: false,
      format: {
        type: 'object',
        required: ['answer', 'nextAction'],
      },
      options: { num_ctx: 4096, num_predict: 128, temperature: 0 },
    });
    expect(chatBody.response_format).toBeUndefined();
    expect(result.ae_report_repair_applied).toBe(false);
    expect(result.ae_specialist_context).toEqual({
      schema: 'orange.specialist-context.v1',
      num_ctx: 4096,
      policy: 'adaptive_least_action',
    });
    expect(result.ae_inference_optimization.mode).toBe('compact_no_evidence_ollama_json_object');
  }, 15_000);
});
