import { describe, expect, test } from 'bun:test';
import { proxyAeEyesChat } from './ae-eyes-route.mjs';

const IMAGE_MESSAGES = [{
  role: 'user',
  content: [
    { type: 'text', text: 'Inspect the status panel.' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } },
  ],
}];

describe('AE Eyes chat capability route', () => {
  test('uses the operational visual endpoint with frontier fallback disabled', async () => {
    let request = null;
    const result = await proxyAeEyesChat({
      messages: IMAGE_MESSAGES,
      response_format: { json_schema: { name: 'orange_report_draft' } },
    }, async (url, init) => {
      request = { url, body: JSON.parse(init.body) };
      return new Response(JSON.stringify({
        answer: { summary: 'The status panel is visible.', confidence: 0.9, next_action: 'review the panel' },
        cortex_model: 'eyes-test-model',
        cortex_route: 'http://127.0.0.1:11437',
        frontier_used: false,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });

    expect(request.url).toEndWith('/v1/visual/describe');
    expect(request.body.allow_frontier).toBe(false);
    expect(request.body.deep).toBe(false);
    expect(result.status).toBe(200);
    expect(result.body.ae_route_mode).toBe('ae-eyes-operational-vision');
    expect(result.body.ae_frontier_used).toBe(false);
    expect(JSON.parse(result.body.choices[0].message.content).f[0]).toContain('status panel');
  });

  test('returns an honest blocker when operational vision is unavailable', async () => {
    const result = await proxyAeEyesChat({ messages: IMAGE_MESSAGES }, async () => new Response(JSON.stringify({
      error: { code: 'CORTEX_UNREACHABLE', message: 'Ollama endpoint refused the connection' },
    }), { status: 503, headers: { 'content-type': 'application/json' } }));

    expect(result.status).toBe(503);
    expect(result.body.error.code).toBe('ae_eyes_unavailable');
    expect(result.body.error.details.upstream_code).toBe('CORTEX_UNREACHABLE');
    expect(result.body.ae_route_mode).toBe('ae-eyes-blocked');
    expect(result.body.ae_frontier_used).toBe(false);
    expect(result.body.choices).toBeUndefined();
  });

  test('does not substitute another lane when image bytes are absent', async () => {
    let called = false;
    const result = await proxyAeEyesChat({ messages: [{ role: 'user', content: 'Inspect C:\\missing.png' }] }, async () => {
      called = true;
      throw new Error('unexpected call');
    });
    expect(called).toBe(false);
    expect(result.status).toBe(422);
    expect(result.body.error.code).toBe('ae_eyes_input_unavailable');
    expect(result.body.ae_requested_model).toBe('ae-eyes');
  });
});
