function completionMeta(completion = {}) {
  const meta = {};
  for (const [key, value] of Object.entries(completion)) {
    if (key.startsWith('ae_')) meta[key] = value;
  }
  return meta;
}

export function completionToSse(completion = {}) {
  if (completion.error) {
    return `data: ${JSON.stringify(completion)}\n\ndata: [DONE]\n\n`;
  }

  const id = completion.id || `chatcmpl-orange-${Date.now()}`;
  const created = completion.created || Math.floor(Date.now() / 1000);
  const model = completion.model || 'orange-auto';
  const choice = completion.choices?.[0] || {};
  const message = choice.message || {};
  const base = { id, object: 'chat.completion.chunk', created, model };
  const events = [
    { ...base, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] },
  ];

  if (message.content !== undefined && message.content !== null) {
    events.push({ ...base, choices: [{ index: 0, delta: { content: message.content }, finish_reason: null }] });
  }
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    events.push({ ...base, choices: [{ index: 0, delta: { tool_calls: message.tool_calls }, finish_reason: null }] });
  }
  events.push({
    ...base,
    ...completionMeta(completion),
    choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason || 'stop' }],
  });
  return `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`;
}
