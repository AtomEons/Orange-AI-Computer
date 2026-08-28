#!/usr/bin/env bun
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OLLAMA = (process.env.ORANGE5_CODEXA_OLLAMA_URL || 'http://127.0.0.1:11437').replace(/\/$/, '');
const NAVIGATOR = (process.env.ORANGE5_NAVIGATOR_URL || 'http://127.0.0.1:11436').replace(/\/$/, '');
const MODELS = [
  { id: 'qwen3-coder:30b', role: 'code', kind: 'ollama', endpoint: OLLAMA },
  { id: 'qwen3:30b-a3b', role: 'general_moe', kind: 'ollama', endpoint: OLLAMA },
  { id: 'orange-navigator:7b', role: 'navigator', kind: 'openai', endpoint: NAVIGATOR },
];

const CASES = [
  {
    id: 'dedupe-sort',
    instruction: 'Write a JavaScript function expression accepting xs and returning unique finite numbers sorted ascending.',
    assertions: [
      [[3, 1, 3, 2], [1, 2, 3]],
      [[-1, 5, -1, 0], [-1, 0, 5]],
      [[], []],
    ],
  },
  {
    id: 'balanced-brackets',
    instruction: 'Write a JavaScript function expression accepting a string and returning true only when (), [], and {} are correctly balanced and nested.',
    assertions: [
      ['([]{})', true],
      ['([)]', false],
      ['', true],
      ['(()', false],
    ],
  },
  {
    id: 'chunk-array',
    instruction: 'Write a JavaScript function expression accepting xs and positive integer n and returning consecutive chunks of at most n items.',
    assertions: [
      [[[1, 2, 3, 4, 5], 2], [[1, 2], [3, 4], [5]]],
      [[[], 3], []],
      [[[1, 2], 5], [[1, 2]]],
    ],
    spread: true,
  },
];

const results = [];
for (const model of MODELS) {
  const cases = [];
  for (const item of CASES) cases.push(await runCase(model, item));
  results.push({
    model: model.id,
    role: model.role,
    passed: cases.filter((item) => item.passed).length,
    total: cases.length,
    pass_rate: Number((cases.filter((item) => item.passed).length / cases.length).toFixed(4)),
    mean_latency_ms: Number((cases.reduce((sum, item) => sum + item.latency_ms, 0) / cases.length).toFixed(2)),
    cases,
  });
}

const ranked = [...results].sort((a, b) => b.passed - a.passed || a.mean_latency_ms - b.mean_latency_ms);
const candidate = results.find((item) => item.model === 'qwen3-coder:30b');
const promoted = candidate?.passed === CASES.length && ranked[0]?.model === candidate.model && candidate.mean_latency_ms <= 20_000;
const generatedAt = new Date().toISOString();
const receipt = {
  schema: 'orange.specialist-code-bakeoff.v1',
  generated_at: generatedAt,
  status: promoted ? 'ORANGE5_QWEN3_CODER_SPECIALIST_GREEN' : 'ORANGE5_QWEN3_CODER_SPECIALIST_NEEDS_WORK',
  promoted_model: promoted ? candidate.model : null,
  rule: 'Promotion requires all hidden executable cases, top rank, and mean latency at or below 20 seconds.',
  results,
};
receipt.sha256 = crypto.createHash('sha256').update(JSON.stringify(results)).digest('hex');
const outDir = path.join(ROOT, '10-RECEIPTS', 'orange5-build');
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, `${generatedAt.replace(/[:.]/g, '-')}-specialist-code-bakeoff.json`);
fs.writeFileSync(outPath, `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify({ ...receipt, receipt_path: outPath }, null, 2));

async function runCase(model, item) {
  const prompt = `${item.instruction}\nReturn JSON only: {"code":"<function expression>"}. The code string MUST begin with '(' and end with ')'. It MUST be one parenthesized function expression, never a const/let/var declaration or named function declaration. No markdown, imports, process, require, fetch, filesystem, or network.`;
  const started = performance.now();
  let text = '';
  try {
    text = model.kind === 'ollama' ? await callOllama(model, prompt) : await callOpenAI(model, prompt);
    const parsed = JSON.parse(text);
    if (typeof parsed.code !== 'string') throw new Error('missing code string');
    const fn = vm.runInNewContext(`(${parsed.code})`, Object.create(null), { timeout: 250 });
    if (typeof fn !== 'function') throw new Error('code is not a function');
    const checks = item.assertions.map(([input, expected]) => {
      const args = item.spread ? input : [input];
      const actual = fn(...args);
      return JSON.stringify(actual) === JSON.stringify(expected);
    });
    return { id: item.id, passed: checks.every(Boolean), checks, latency_ms: Number((performance.now() - started).toFixed(2)), code: parsed.code };
  } catch (error) {
    return { id: item.id, passed: false, checks: [], latency_ms: Number((performance.now() - started).toFixed(2)), error: error?.message || String(error), raw_output: typeof text === 'string' ? text.slice(0, 1000) : null };
  }
}

async function callOllama(model, prompt) {
  const response = await fetch(`${model.endpoint}/api/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: model.id, stream: false, think: false, keep_alive: '10m',
      format: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] },
      messages: [{ role: 'user', content: prompt }],
      options: { temperature: 0, num_predict: 256, num_ctx: 4096 },
    }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (await response.json())?.message?.content || '';
}

async function callOpenAI(model, prompt) {
  const response = await fetch(`${model.endpoint}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: model.id, stream: false, temperature: 0, max_tokens: 256,
      response_format: { type: 'json_schema', json_schema: { name: 'code_packet', strict: true, schema: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'], additionalProperties: false } } },
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (await response.json())?.choices?.[0]?.message?.content || '';
}
