import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { writeChainedJsonReceipt } from '../10-RECEIPTS/tools/json-receipt-chain.mjs';

const root = path.resolve(import.meta.dir, '..');
const gateway = String(process.env.ORANGE5_ORANGEBRAIN_URL || 'http://127.0.0.1:1337').replace(/\/+$/, '');
const correlationId = `party-proof-${crypto.randomUUID()}`;
const marker = `Party Line live proof ${correlationId}`;

async function requestJson(url, init = {}, timeoutMs = 180_000) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  return { response, body };
}

async function proveStream(cursor) {
  const controller = new AbortController();
  const streamUrl = new URL(`${gateway}/v1/party-line/stream`);
  streamUrl.searchParams.set('cursor', String(cursor));
  streamUrl.searchParams.set('detail', 'normal');
  streamUrl.searchParams.set('project', 'orange5');
  streamUrl.searchParams.set('correlation', correlationId);
  const response = await fetch(streamUrl, { signal: controller.signal });
  if (!response.ok || !response.body) {
    controller.abort();
    return { ok: false, status: response.status, eventId: null };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let eventId = null;
  const waitForEvent = (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.includes(correlationId) && buffer.includes('event: party-line')) {
        eventId = buffer.match(/id:\s*([^\r\n]+)/)?.[1] || null;
        return true;
      }
    }
    return false;
  })();

  const written = await requestJson(`${gateway}/v1/party-line`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      projectId: 'orange5',
      topic: 'party-line-live-proof',
      actor: { id: 'codex-live-proof', displayName: 'Codex Live Proof', kind: 'agent' },
      eventType: 'status',
      detailLevel: 'deep',
      summary: marker,
      body: 'SSE receives a newly appended disk event without replaying or caching the transcript.',
      correlationId,
      tags: ['party-line', 'live-proof', 'sse'],
      importance: 0.9,
    }),
  }, 15_000);

  let received = false;
  try {
    received = await Promise.race([
      waitForEvent,
      new Promise((resolve) => setTimeout(() => resolve(false), 12_000)),
    ]);
  } finally {
    controller.abort();
    await reader.cancel().catch(() => {});
  }
  return {
    ok: written.response.status === 201 && received === true,
    status: response.status,
    appendedStatus: written.response.status,
    appendedEventId: written.body?.event?.id || null,
    streamedEventId: eventId,
  };
}

const startedAt = new Date().toISOString();
const started = performance.now();
const health = await requestJson(`${gateway}/healthz`, {}, 10_000);
const before = await requestJson(`${gateway}/v1/party-line?detail=quiet&limit=1&tail=true`, {}, 10_000);
const stream = await proveStream(before.body?.cursor ?? 0);

const pageUrl = new URL(`${gateway}/v1/party-line`);
pageUrl.searchParams.set('detail', 'deep');
pageUrl.searchParams.set('limit', '10');
pageUrl.searchParams.set('tail', 'true');
pageUrl.searchParams.set('project', 'orange5');
pageUrl.searchParams.set('correlation', correlationId);
const page = await requestJson(pageUrl, {}, 10_000);
const chainPage = await requestJson(`${gateway}/v1/party-line?detail=quiet&limit=100&tail=true`, {}, 10_000);

const hydration = await requestJson(`${gateway}/v1/party-line/hydrate`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ query: marker, projectId: 'orange5', limit: 3 }),
}, 15_000);

const chat = await requestJson(`${gateway}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    model: 'orange-auto',
    ae_response_mode: 'conversation',
    ae_project_id: 'atomic-orange',
    messages: [{
      role: 'user',
      content: `Briefly explain the current Party Line proof named ${correlationId}. Cite the Party Line source event you used.`,
    }],
  }),
}, 180_000);

const answer = String(chat.body?.choices?.[0]?.message?.content || '');
const partyTurn = chat.body?.ae_party_line || {};
const answerRefusal = /(?:cannot|can't|could not|couldn't|do not|don't)\s+(?:locate|find|access|verify)|no evidence|won't fabricate/i.test(answer);
const checks = {
  gateway_live: health.response.ok && health.body?.service === 'orangellm-gateway',
  party_line_version_live: /party-line/.test(String(health.body?.version || '')),
  sse_increment_received: stream.ok === true && stream.appendedEventId === stream.streamedEventId,
  disk_page_chain_valid: chainPage.response.ok && chainPage.body?.chain?.ok === true,
  disk_page_contains_marker: page.body?.events?.some((event) => event.correlationId === correlationId && event.summary === marker) === true,
  hydration_source_addressed: hydration.response.ok
    && hydration.body?.selected?.some((event) => event.correlationId === correlationId) === true
    && hydration.body?.context?.includes(`[party:${stream.appendedEventId}]`) === true,
  conversation_roundtrip: chat.response.ok && answer.length >= 20,
  conversation_not_report_json: chat.body?.ae_response_mode === 'conversation' && !/^\s*\{/.test(answer),
  model_used_party_context: Array.isArray(partyTurn.hydratedEventIds)
    && partyTurn.hydratedEventIds.includes(stream.appendedEventId)
    && answer.includes(stream.appendedEventId)
    && answerRefusal === false,
  model_turn_published: /^pl-/.test(String(partyTurn.inboundEventId || ''))
    && /^pl-/.test(String(partyTurn.outboundEventId || '')),
  governed_turn_receipted: /^rcpt_/.test(String(chat.body?.ae_turn?.receipt?.id || '')),
};
const green = Object.values(checks).every(Boolean);
const receiptDir = path.join(root, '10-RECEIPTS', 'orange5-build');
const supersedes = fs.existsSync(receiptDir)
  ? fs.readdirSync(receiptDir)
      .filter((name) => name.endsWith('-party-line-live-proof.json'))
      .sort()
      .slice(-1)
  : [];
const proof = {
  schema: 'orange5.party-line-live-proof.v1',
  status: green ? 'ORANGE5_PARTY_LINE_LIVE_GREEN' : 'ORANGE5_PARTY_LINE_LIVE_NEEDS_WORK',
  generatedAt: new Date().toISOString(),
  startedAt,
  elapsedMs: Number((performance.now() - started).toFixed(2)),
  gateway,
  supersedes,
  checks,
  evidence: {
    gatewayVersion: health.body?.version || null,
    cursorBefore: before.body?.cursor ?? null,
    cursorAfter: page.body?.cursor ?? null,
    stream,
    pageEventIds: page.body?.events?.map((event) => event.id) || [],
    chainChecked: chainPage.body?.chain?.checked ?? null,
    hydratedEventIds: hydration.body?.selected?.map((event) => event.id) || [],
    chat: {
      orderId: chat.body?.ae_order_id || null,
      model: chat.body?.model || null,
      lane: chat.body?.ae_turn?.route?.lane || null,
      host: chat.body?.ae_turn?.route?.effective_host || null,
      answer,
      partyTurn,
      receipt: chat.body?.ae_turn?.receipt || null,
    },
  },
};
proof.sha256 = crypto.createHash('sha256').update(JSON.stringify(proof)).digest('hex');

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const receiptPath = path.join(receiptDir, `${stamp}-party-line-live-proof.json`);
fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
writeChainedJsonReceipt(receiptPath, proof);
console.log(JSON.stringify({ ...proof, receiptPath }, null, 2));
if (!green) process.exitCode = 1;
