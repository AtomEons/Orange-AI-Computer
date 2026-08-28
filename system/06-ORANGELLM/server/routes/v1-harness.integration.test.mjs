import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BuildRunStore } from '../../../04-CONTROL-PLANE/build-runs/store.mjs';

let upstream;
let handleV1ChatCompletions;
let reconcileReportWithRuntimeRoute;
let resolveRequestedModelRoute;
const priorLightUrl = process.env.ORANGE5_LIGHT_URL;
const priorPartyLinePath = process.env.ORANGE5_PARTY_LINE_PATH;
let partyLineRoot;

beforeAll(async () => {
  upstream = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === '/healthz') return Response.json({ status: 'ok' });
      if (path === '/v1/chat/completions') {
        const body = await request.json();
        if (body.messages?.some((message) => String(message?.content || '').includes('MALFORMED_COMPLETION'))) {
          return Response.json({ id: 'chatcmpl-malformed-test', object: 'chat.completion', model: 'test-reflex', choices: [] });
        }
        return Response.json({
          id: 'chatcmpl-governed-test',
          object: 'chat.completion',
          model: 'test-reflex',
          choices: [{ index: 0, message: { role: 'assistant', content: 'Orange is ready.' }, finish_reason: 'stop' }],
        });
      }
      return new Response('not found', { status: 404 });
    },
  });
  process.env.ORANGE5_LIGHT_URL = `http://127.0.0.1:${upstream.port}`;
  partyLineRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orange-v1-party-line-'));
  process.env.ORANGE5_PARTY_LINE_PATH = path.join(partyLineRoot, 'events.jsonl');
  ({ handleV1ChatCompletions, reconcileReportWithRuntimeRoute, resolveRequestedModelRoute } = await import(`./v1.mjs?harness-integration=${Date.now()}`));
});

afterAll(() => {
  upstream?.stop(true);
  if (priorLightUrl == null) delete process.env.ORANGE5_LIGHT_URL;
  else process.env.ORANGE5_LIGHT_URL = priorLightUrl;
  if (priorPartyLinePath == null) delete process.env.ORANGE5_PARTY_LINE_PATH;
  else process.env.ORANGE5_PARTY_LINE_PATH = priorPartyLinePath;
  if (partyLineRoot) fs.rmSync(partyLineRoot, { recursive: true, force: true });
});

describe('OrangeBrain mandatory turn integration', () => {
  test('exact installed model ids retain explicit lane authority', () => {
    const targets = {
      light: { model: 'skinny:test' }, navigator: { model: 'navigator:test' },
      code: { model: 'qwen3-coder:30b' }, heavy: { model: 'qwen3:30b-a3b' },
    };
    expect(resolveRequestedModelRoute('qwen3-coder:30b', targets)).toMatchObject({ valid: true, mode: 'explicit', tier: 'code' });
    expect(resolveRequestedModelRoute('qwen3:30b-a3b', targets)).toMatchObject({ valid: true, mode: 'explicit', tier: 'heavy' });
    expect(resolveRequestedModelRoute('navigator:test', targets)).toMatchObject({ valid: true, mode: 'explicit', tier: 'navigator' });
  });

  test('unknown explicit model ids fail instead of silently becoming auto', async () => {
    const result = await handleV1ChatCompletions({
      model: 'unregistered-model:latest',
      ae_response_mode: 'conversation',
      messages: [{ role: 'user', content: 'Do not silently reroute this.' }],
    });
    expect(result._ae_http_status).toBe(400);
    expect(result.error.code).toBe('unknown_orange_model');
  });

  test('runtime route truth removes a model claim contradicted by the successful route', () => {
    const payload = {
      choices: [{ message: { content: JSON.stringify({
        schema: 'orange.report.v1', orderId: 'route-truth', status: 'needs_action', confidence: 0.5,
        actionsTaken: [], evidence: [], findings: ['Connectivity issue with Codexa'],
        blockers: ['orange-navigator is not reachable on Codexa', 'no governed evidence supplied'],
        nextAction: 'run a governed probe or provide evidence', receiptPath: null,
      }) } }],
    };
    const result = reconcileReportWithRuntimeRoute(payload, {
      succeeded: true, tier: 'navigator', model: 'orange-navigator:hot-v1', node: 'codexa-tunnel',
    });
    const report = JSON.parse(payload.choices[0].message.content);
    expect(result.repaired).toBe(true);
    expect(report.findings[0]).toContain('runtime route observed');
    expect(report.blockers).toEqual(['no governed evidence supplied']);
    expect(JSON.stringify(report)).not.toContain('not reachable');
    expect(payload.ae_route_truth_repair.removed_claims).toHaveLength(2);
  });

  test('every ordinary completion carries governed turn identity and no mutation claim', async () => {
    const result = await handleV1ChatCompletions({
      model: 'orangellm-light',
      messages: [{ role: 'user', content: 'Explain the active Orange system.' }],
    }, { partyLineFilePath: process.env.ORANGE5_PARTY_LINE_PATH });
    expect(result._ae_http_status).toBe(200);
    expect(result.choices[0].message.content).toBe('Orange is ready.');
    expect(result.ae_order_id).toStartWith('gw-order-');
    expect(result.ae_turn.schema).toBe('orange.chat-turn.v1');
    expect(result.ae_turn.route.lane).toBe('light');
    expect(result.ae_turn.route).toMatchObject({
      requested_tier: 'light',
      execution_tier: 'light',
      route_mode: 'specialist',
      requested_model: 'orangellm-smart-skinny-0.5b',
      effective_model: 'orangellm-smart-skinny-0.5b',
      requested_node: 'n150',
      effective_node: 'n150',
    });
    expect(result.ae_turn.governance).toMatchObject({
      status: 'completed',
      report_status: 'completed',
      topology: 'solo',
      adversarial_required: false,
      execution_performed: false,
    });
    expect(result.ae_execution_performed).toBe(false);
  });

  test('successful chat settles its BuildRun as completed', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orange-v1-build-run-'));
    const buildRunFilePath = path.join(dir, 'events.jsonl');
    try {
      const result = await handleV1ChatCompletions({
        model: 'orangellm-light',
        ae_response_mode: 'conversation',
        ae_thread_id: 'thread-completed-chat',
        ae_party_line: { enabled: false },
        messages: [{ role: 'user', content: 'Complete this chat turn.' }],
      }, { buildRunFilePath, partyLineFilePath: process.env.ORANGE5_PARTY_LINE_PATH });

      expect(result._ae_http_status).toBe(200);
      expect(result.ae_build_run).toMatchObject({ status: 'completed', stage: 'settle', warning: null });
      const page = new BuildRunStore(buildRunFilePath).list({ threadId: 'thread-completed-chat' });
      expect(page.chain.ok).toBe(true);
      expect(page.runs).toHaveLength(1);
      expect(page.runs[0]).toMatchObject({ status: 'completed', stage: 'settle', nextAction: null });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('report normalization failure settles the created BuildRun as failed', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orange-v1-build-run-'));
    const buildRunFilePath = path.join(dir, 'events.jsonl');
    try {
      const result = await handleV1ChatCompletions({
        model: 'orangellm-light',
        ae_response_contract: 'orange.report.v1',
        ae_thread_id: 'thread-failed-report',
        ae_party_line: { enabled: false },
        messages: [{ role: 'user', content: 'MALFORMED_COMPLETION' }],
      }, { buildRunFilePath, partyLineFilePath: process.env.ORANGE5_PARTY_LINE_PATH });

      expect(result._ae_http_status).toBe(502);
      expect(result.error.code).toBe('report_contract_compile_failed');
      expect(result.ae_build_run).toMatchObject({ status: 'failed', stage: 'settle', warning: null });
      const page = new BuildRunStore(buildRunFilePath).list({ threadId: 'thread-failed-report' });
      expect(page.chain.ok).toBe(true);
      expect(page.runs).toHaveLength(1);
      expect(page.runs[0]).toMatchObject({ status: 'failed', stage: 'settle' });
      expect(page.runs[0].blockers[0]).toContain('no assistant message');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('orange-auto enforces the report contract without client-specific fields', async () => {
    const result = await handleV1ChatCompletions({
      model: 'orange-auto',
      messages: [{ role: 'user', content: 'Which health route should I probe?' }],
    }, { partyLineFilePath: process.env.ORANGE5_PARTY_LINE_PATH });
    expect(result._ae_http_status).toBe(200);
    const report = JSON.parse(result.choices[0].message.content);
    expect(report.schema).toBe('orange.report.v1');
    expect(report.orderId).toBe(result.ae_order_id);
    expect(Array.isArray(report.evidence)).toBe(true);
  });

  test('Atomic Orange conversation stays natural while publishing a governed Party Line turn', async () => {
    const result = await handleV1ChatCompletions({
      model: 'orangellm-light',
      ae_response_mode: 'conversation',
      ae_project_id: 'atomic-orange',
      messages: [{ role: 'user', content: 'Tell me what the system is doing in plain language.' }],
    }, { partyLineFilePath: process.env.ORANGE5_PARTY_LINE_PATH });
    expect(result._ae_http_status).toBe(200);
    expect(result.choices[0].message.content).toBe('Orange is ready.');
    expect(result.ae_response_mode).toBe('conversation');
    expect(result.ae_party_line).toMatchObject({
      enabled: true,
      projectId: 'atomic-orange',
      warning: null,
    });
    expect(result.ae_party_line.inboundEventId).toStartWith('pl-');
    expect(result.ae_party_line.outboundEventId).toStartWith('pl-');
    const events = fs.readFileSync(process.env.ORANGE5_PARTY_LINE_PATH, 'utf8')
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line))
      .filter((event) => event.correlationId === result.ae_order_id);
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.actor.kind)).toEqual(['operator', 'model']);
  });
});
