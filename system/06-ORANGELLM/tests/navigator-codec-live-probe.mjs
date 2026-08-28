const host = (process.env.ORANGE5_NAVIGATOR_OLLAMA_URL || 'http://10.0.0.4:11434').replace(/\/$/, '');
const model = process.env.ORANGE5_NAVIGATOR_MODEL || 'orange-navigator:ornith-1.5-9b-q4km';
const question = 'Explain how Orange coordinates memory, compression, routing, Hermes execution, reports, receipts, and learning. Separate what is proven from what is planned.';

const cases = [
  {
    id: 'natural-prose',
    system: 'Answer the operator directly in concise useful prose. Do not invent runtime facts. Do not output identifiers by themselves.',
  },
  {
    id: 'named-json',
    system: 'Return JSON with two descriptive keys: answer is a useful direct explanation; nextAction is one concrete next step. Do not output internal identifiers as the answer.',
    format: {
      type: 'object',
      properties: {
        answer: { type: 'string', minLength: 40, maxLength: 1200 },
        nextAction: { type: 'string', minLength: 4, maxLength: 160 },
      },
      required: ['answer', 'nextAction'],
      additionalProperties: false,
    },
  },
  {
    id: 'compact-json',
    system: 'Return only compact JSON. f is one substantive explanation, not a label or identifier. n is one concrete next action.',
    format: {
      type: 'object',
      properties: {
        f: { type: 'array', minItems: 1, maxItems: 1, items: { type: 'string', minLength: 40, maxLength: 1200 } },
        n: { type: 'string', minLength: 4, maxLength: 160 },
      },
      required: ['f', 'n'],
      additionalProperties: false,
    },
  },
];

const output = [];
for (const probe of cases) {
  const started = performance.now();
  const response = await fetch(`${host}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      messages: [
        { role: 'system', content: probe.system },
        { role: 'user', content: `${question}\n/no_think` },
      ],
      ...(probe.format ? { format: probe.format } : {}),
      options: { temperature: 0, num_predict: 384 },
    }),
    signal: AbortSignal.timeout(180_000),
  });
  const body = await response.json();
  output.push({
    id: probe.id,
    ok: response.ok,
    status: response.status,
    latencyMs: Number((performance.now() - started).toFixed(1)),
    evalCount: body.eval_count ?? null,
    promptEvalCount: body.prompt_eval_count ?? null,
    messageKeys: body.message && typeof body.message === 'object' ? Object.keys(body.message) : [],
    content: body.message?.content ?? body.error ?? null,
    thinking: body.message?.thinking ?? null,
  });
}

console.log(JSON.stringify({ schema: 'orange.navigator-codec-live-probe.v1', host, model, question, cases: output }, null, 2));
if (output.some((probe) => !probe.ok)) process.exitCode = 1;
