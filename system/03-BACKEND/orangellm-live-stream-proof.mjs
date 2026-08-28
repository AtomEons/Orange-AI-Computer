#!/usr/bin/env bun

import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeChainedJsonReceipt } from '../10-RECEIPTS/tools/json-receipt-chain.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RECEIPT_ROOT = path.join(ROOT, '10-RECEIPTS', 'orange5-build');
const GATEWAY = String(process.env.ORANGE5_ORANGELLM_URL || 'http://127.0.0.1:1337').replace(/\/$/, '');
const PROMPT = 'Give four concise numbered reasons receipt-backed execution is stronger than unsupported model claims.';
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

const started = performance.now();
const response = await fetch(`${GATEWAY}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    model: 'orange-auto',
    stream: true,
    ae_response_mode: 'conversation',
    max_tokens: 192,
    messages: [{ role: 'user', content: PROMPT }],
  }),
  signal: AbortSignal.timeout(Number(process.env.ORANGE5_STREAM_PROOF_TIMEOUT_MS || 180_000)),
});

const reader = response.body?.getReader();
if (!reader) throw new Error('OrangeLLM streaming response has no readable body.');
const decoder = new TextDecoder();
let buffer = '';
let content = '';
let contentChunks = 0;
let firstContentMs = null;
let finalMetadata = null;

const consumeFrame = (frame) => {
  const data = frame.split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');
  if (!data || data === '[DONE]') return;
  const event = JSON.parse(data);
  const delta = event.choices?.[0]?.delta?.content;
  if (typeof delta === 'string' && delta.length) {
    firstContentMs ??= performance.now() - started;
    contentChunks += 1;
    content += delta;
  }
  if (event.ae_turn) finalMetadata = event;
};

while (true) {
  const { value, done } = await reader.read();
  buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
  const frames = buffer.split(/\r?\n\r?\n/);
  buffer = frames.pop() || '';
  for (const frame of frames) consumeFrame(frame);
  if (done) break;
}
if (buffer.trim()) consumeFrame(buffer);

const totalMs = performance.now() - started;
const receipt = finalMetadata?.ae_turn?.receipt ?? null;
const refusal = /\bi (?:cannot|can't|won't|will not|refuse to)\b/i.test(content);
const checks = {
  http_200: response.status === 200,
  event_stream_content_type: String(response.headers.get('content-type') || '').includes('text/event-stream'),
  content_arrived_incrementally: contentChunks >= 5,
  first_content_preceded_completion: Number.isFinite(firstContentMs) && firstContentMs < totalMs - 50,
  substantive_answer: content.trim().length >= 120 && /receipt/i.test(content),
  harmless_request_not_refused: !refusal,
  final_receipt_present: Boolean(receipt?.id)
    && Number.isInteger(receipt?.seq)
    && /^[a-f0-9]{64}$/i.test(receipt?.hash || ''),
  governed_route_present: typeof finalMetadata?.ae_effective_model === 'string'
    && typeof finalMetadata?.ae_execution_tier === 'string',
};
const green = Object.values(checks).every(Boolean);
const generatedAt = new Date().toISOString();
const proof = {
  schema: 'orange5.orangellm-live-stream-proof.v1',
  status: green ? 'ORANGE5_ORANGELLM_LIVE_STREAM_GREEN' : 'ORANGE5_ORANGELLM_LIVE_STREAM_NEEDS_WORK',
  generated_at: generatedAt,
  gateway: GATEWAY,
  checks,
  metrics: {
    first_content_ms: firstContentMs == null ? null : Number(firstContentMs.toFixed(2)),
    total_ms: Number(totalMs.toFixed(2)),
    content_chunks: contentChunks,
    output_characters: content.length,
  },
  route: {
    lane: finalMetadata?.ae_lane ?? null,
    tier: finalMetadata?.ae_execution_tier ?? null,
    model: finalMetadata?.ae_effective_model ?? null,
    node: finalMetadata?.ae_effective_node ?? null,
  },
  turn_receipt: receipt,
  prompt_sha256: sha256(PROMPT),
  output_sha256: sha256(content),
  output_preview: content.slice(0, 800),
};
const receiptPath = path.join(RECEIPT_ROOT, `${generatedAt.replace(/[:.]/g, '-')}-orangellm-live-stream-proof.json`);
const written = writeChainedJsonReceipt(receiptPath, proof);
console.log(JSON.stringify({ ...written, receipt_path: receiptPath }, null, 2));
if (!green) process.exitCode = 1;
