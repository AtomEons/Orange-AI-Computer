import { describe, expect, test } from 'bun:test';
import { consumeOpenAiSse } from './upstream.mjs';

describe('OrangeLLM live upstream stream', () => {
  test('forwards content incrementally and rebuilds the final completion', async () => {
    const frames = [
      { id: 'stream-1', object: 'chat.completion.chunk', created: 1, model: 'navigator', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] },
      { id: 'stream-1', object: 'chat.completion.chunk', created: 1, model: 'navigator', choices: [{ index: 0, delta: { content: 'Orange ', reasoning_content: 'hidden' }, finish_reason: null }] },
      { id: 'stream-1', object: 'chat.completion.chunk', created: 1, model: 'navigator', choices: [{ index: 0, delta: { content: 'flows.' }, finish_reason: null }] },
      { id: 'stream-1', object: 'chat.completion.chunk', created: 1, model: 'navigator', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { total_tokens: 7 } },
    ];
    const payload = `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('')}data: [DONE]\n\n`;
    const response = new Response(payload, { headers: { 'content-type': 'text/event-stream' } });
    const forwarded = [];

    const completion = await consumeOpenAiSse(response, (chunk) => forwarded.push(chunk));

    expect(forwarded).toHaveLength(3);
    expect(forwarded.map((chunk) => chunk.choices[0].delta.content || '').join('')).toBe('Orange flows.');
    expect(forwarded.some((chunk) => 'reasoning_content' in chunk.choices[0].delta)).toBe(false);
    expect(completion.choices[0].message.content).toBe('Orange flows.');
    expect(completion.choices[0].finish_reason).toBe('stop');
    expect(completion.usage.total_tokens).toBe(7);
  });
});
