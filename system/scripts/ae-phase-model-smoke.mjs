#!/usr/bin/env bun
import { requestAEPhaseModel } from '../03-BACKEND/ae-phase-model-client.mjs';

const model = process.argv[2] || process.env.ORANGE5_NAVIGATOR_MODEL || 'qwen3.8:27b-current';
const prompt = process.argv.slice(3).join(' ') || 'Reply exactly: ORANGE PHASE LIVE';
const chunks = [];
const startedAt = performance.now();
const result = await requestAEPhaseModel({
  tier: 'navigator',
  model,
  timeoutMs: Number(process.env.ORANGE5_PHASE_MODEL_SMOKE_TIMEOUT_MS || 240_000),
  body: {
    model,
    stream: true,
    max_tokens: 64,
    temperature: 0,
    messages: [
      { role: 'system', content: 'Answer directly. Do not expose chain of thought. No preamble.' },
      { role: 'user', content: prompt },
    ],
  },
  onChunk(chunk) {
    chunks.push(chunk);
  },
});

process.stdout.write(`${JSON.stringify({
  schema: 'orange.ae-phase.model-smoke.v1',
  ok: result.status === 200,
  elapsedMs: Math.round(performance.now() - startedAt),
  chunkCount: chunks.length,
  content: result.body?.choices?.[0]?.message?.content || '',
  model: result.body?.model || model,
  transport: result.phase || result.body?.ae_transport || null,
  error: result.body?.error || null,
}, null, 2)}\n`);

process.exitCode = result.status === 200 ? 0 : 1;
