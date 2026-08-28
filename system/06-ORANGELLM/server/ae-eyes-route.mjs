const GATEWAY_SELF_URL = process.env.ORANGE5_GATEWAY_SELF_URL || 'http://127.0.0.1:1337';
const AE_EYES_TIMEOUT_MS = Math.max(5_000, Math.min(
  Number(process.env.ORANGE5_AE_EYES_TIMEOUT_MS || 95_000),
  300_000,
));

export const AE_EYES_TARGET = Object.freeze({
  model: 'ae-eyes',
  host: GATEWAY_SELF_URL,
  node: 'n150',
  capability: 'operational-vision',
});

function latestUserContent(messages = []) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') return messages[index].content;
  }
  return null;
}

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => typeof part === 'string' ? part : String(part?.text || ''))
    .filter(Boolean)
    .join('\n');
}

function imageFromContent(content) {
  if (!Array.isArray(content)) return null;
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    const candidate = typeof part.image_url === 'string'
      ? part.image_url
      : (typeof part.image_url?.url === 'string'
          ? part.image_url.url
          : (typeof part.url === 'string' ? part.url : null));
    if (candidate) return candidate;
  }
  return null;
}

function compactVisualDraft(answer = {}) {
  const findings = [
    answer.summary,
    Array.isArray(answer.entities) && answer.entities.length ? `Entities: ${answer.entities.join(', ')}` : null,
    Array.isArray(answer.files) && answer.files.length ? `Files: ${answer.files.join(', ')}` : null,
  ].filter(Boolean).map((item) => String(item).slice(0, 240)).slice(0, 3);
  return {
    s: 'needs_action',
    c: Math.max(0, Math.min(Number(answer.confidence ?? 0.5), 1)),
    e: [],
    f: findings.length ? findings : ['AE Eyes returned a visual result without a textual summary.'],
    b: [],
    n: String(answer.next_action || 'review the AE Eyes visual findings').slice(0, 96),
  };
}

function completionContent(body, visual) {
  if (body?.response_format?.json_schema?.name === 'orange_report_draft') {
    return JSON.stringify(compactVisualDraft(visual.answer));
  }
  if (typeof visual.answer === 'string') return visual.answer;
  return JSON.stringify(visual.answer ?? visual);
}

function blocker(status, code, message, details = null) {
  return {
    status,
    body: {
      error: {
        type: 'ae_eyes_error',
        code,
        message,
        ...(details ? { details } : {}),
      },
      ae_requested_tier: 'visual',
      ae_execution_tier: 'visual',
      ae_requested_model: 'ae-eyes',
      ae_effective_model: null,
      ae_effective_host: GATEWAY_SELF_URL,
      ae_route_mode: 'ae-eyes-blocked',
      ae_frontier_used: false,
    },
  };
}

export async function proxyAeEyesChat(body = {}, fetchImpl = fetch) {
  const content = latestUserContent(body.messages);
  const imageUrl = imageFromContent(content);
  if (!imageUrl) {
    return blocker(
      422,
      'ae_eyes_input_unavailable',
      'AE Eyes was selected, but the request did not contain a consumable image_url payload.',
    );
  }

  let response;
  let payload;
  try {
    response = await fetchImpl(`${GATEWAY_SELF_URL}/v1/visual/describe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        image_url: imageUrl,
        prompt: textFromContent(content) || undefined,
        max_tokens: body.max_tokens ?? body.max_completion_tokens,
        deep: false,
        allow_frontier: false,
      }),
      signal: AbortSignal.timeout(AE_EYES_TIMEOUT_MS),
    });
    const text = await response.text();
    payload = text ? JSON.parse(text) : {};
  } catch (error) {
    return blocker(
      503,
      'ae_eyes_unavailable',
      `AE Eyes operational vision is unavailable: ${error.message}`,
    );
  }

  if (!response.ok) {
    const upstreamCode = payload?.error?.code || 'AE_EYES_HTTP_ERROR';
    const upstreamMessage = payload?.error?.message || `visual describe returned HTTP ${response.status}`;
    return blocker(
      response.status >= 500 ? 503 : response.status,
      response.status >= 500 ? 'ae_eyes_unavailable' : 'ae_eyes_input_invalid',
      `AE Eyes could not inspect the image: ${upstreamMessage}`,
      { upstream_code: upstreamCode, upstream_status: response.status },
    );
  }

  if (payload.frontier_used === true) {
    return blocker(
      502,
      'ae_eyes_route_violation',
      'AE Eyes returned a frontier-assisted result even though frontier fallback was disabled.',
    );
  }

  const cortexModel = payload.cortex_model || 'unknown';
  return {
    status: 200,
    body: {
      id: `chatcmpl-ae-eyes-${crypto.randomUUID()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: 'ae-eyes',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: completionContent(body, payload) },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      ae_requested_tier: 'visual',
      ae_execution_tier: 'visual',
      ae_requested_model: 'ae-eyes',
      ae_effective_model: `ae-eyes:${cortexModel}`,
      ae_requested_host: GATEWAY_SELF_URL,
      ae_effective_host: payload.cortex_route || GATEWAY_SELF_URL,
      ae_requested_node: 'n150',
      ae_effective_node: 'n150',
      ae_route_mode: 'ae-eyes-operational-vision',
      ae_frontier_used: false,
      ae_visual: payload,
    },
  };
}
