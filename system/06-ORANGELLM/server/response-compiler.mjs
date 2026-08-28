function latestUserText(messages = []) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user' && typeof messages[index].content === 'string') return messages[index].content.trim();
  }
  return '';
}

export function exactRequestedText(messages = []) {
  const text = latestUserText(messages);
  const match = /(?:^|\n)\s*(?:return|respond|output|print)\s+exactly\s*:\s*([^\r\n]{1,240})\s*$/i.exec(text);
  if (!match) return null;
  return match[1].trim().replace(/^["'`]|["'`]$/g, '');
}

export function removeVisibleReasoning(content) {
  let value = String(content ?? '');
  value = value.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  if (value.includes('</think>')) value = value.slice(value.lastIndexOf('</think>') + 8).trim();
  return value;
}

export function compileModelResponse(payload, messages = []) {
  if (!payload || !Array.isArray(payload.choices)) return { repaired: false, reason: null };
  const exact = exactRequestedText(messages);
  let repaired = false;
  let reason = null;
  for (const choice of payload.choices) {
    if (!choice?.message || typeof choice.message !== 'object') continue;
    const original = typeof choice.message.content === 'string' ? choice.message.content : '';
    let next = removeVisibleReasoning(original);
    if (exact !== null) {
      next = exact;
      choice.finish_reason = 'stop';
      repaired = next !== original;
      reason = 'explicit_exact_output_contract';
    } else if (next !== original) {
      repaired = true;
      reason = 'visible_reasoning_removed';
    }
    choice.message.content = next;
    delete choice.message.reasoning;
    delete choice.message.reasoning_content;
    delete choice.message.thinking;
  }
  if (repaired) payload.ae_output_compiler = { schema: 'orange.output-compiler.v1', repaired: true, reason };
  return { repaired, reason };
}
