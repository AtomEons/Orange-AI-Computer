import { describe, expect, test } from 'bun:test';
import { completionToSse } from './openai-sse.mjs';

describe('OpenAI-compatible buffered SSE', () => {
  test('preserves content, finish state, and Orange receipt metadata', () => {
    const output = completionToSse({
      id: 'chatcmpl-test',
      model: 'orange-auto',
      choices: [{ message: { role: 'assistant', content: 'ready' }, finish_reason: 'stop' }],
      ae_order_id: 'order-1',
      ae_turn: { schema: 'orange.chat-turn.v1' },
    });
    expect(output).toContain('"content":"ready"');
    expect(output).toContain('"ae_order_id":"order-1"');
    expect(output).toContain('"finish_reason":"stop"');
    expect(output.endsWith('data: [DONE]\n\n')).toBe(true);
  });
});
