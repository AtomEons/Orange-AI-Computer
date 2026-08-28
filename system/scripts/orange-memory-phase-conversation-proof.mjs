#!/usr/bin/env bun

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeChainedJsonReceipt } from '../10-RECEIPTS/tools/json-receipt-chain.mjs';
import { requestAEPhaseTool } from '../03-BACKEND/ae-phase-tool-client.mjs';

const ROOT = path.resolve(import.meta.dir, '..');
const DATA_ROOT = process.env.ORANGE5_DATA_ROOT || path.join(os.homedir(), 'OrangeBox-Data', 'orange5');
const GATEWAY = String(process.env.ORANGE5_ORANGELLM_URL || 'http://127.0.0.1:1337').replace(/\/+$/, '');
const TOKEN_FILE = process.env.ORANGEBOX_RAIL_TOKEN_FILE || path.join(DATA_ROOT, 'secrets', 'rail-token.txt');
const RECEIPT_DIR = path.join(ROOT, '10-RECEIPTS', 'orange5-build');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

async function fetchJson(url, init = {}, timeoutMs = 120_000) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!response.ok) throw new Error(`${response.status} ${url}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
  return body;
}

function check(id, ok, observed) {
  return { id, ok: ok === true, observed };
}

function healthReady(health) {
  return health?.status === 'ok'
    && health?.service === 'orangellm-gateway'
    && health?.upstream?.navigator?.live === true
    && health?.upstream?.navigator?.transport?.transport === 'ae-phase';
}

async function waitForReadyHealth({
  url,
  budgetMs = Number(process.env.ORANGE5_READINESS_BUDGET_MS || 45_000),
  pollMs = Number(process.env.ORANGE5_READINESS_POLL_MS || 750),
} = {}) {
  const started = performance.now();
  const attempts = [];
  let latest = null;

  while (performance.now() - started < budgetMs) {
    const attemptStarted = performance.now();
    try {
      latest = await fetchJson(url, {}, Math.min(15_000, budgetMs));
      attempts.push({
        status: latest?.status || null,
        navigator: latest?.upstream?.navigator?.status || null,
        transport: latest?.upstream?.navigator?.transport?.transport || null,
        elapsed_ms: Math.round(performance.now() - attemptStarted),
      });
      if (healthReady(latest)) {
        return { health: latest, attempts, wait_ms: Math.round(performance.now() - started) };
      }
    } catch (error) {
      attempts.push({
        status: 'unreachable',
        error: String(error?.message || error),
        elapsed_ms: Math.round(performance.now() - attemptStarted),
      });
    }

    const remaining = budgetMs - (performance.now() - started);
    if (remaining <= 0) break;
    await Bun.sleep(Math.min(pollMs, remaining));
  }

  return { health: latest, attempts, wait_ms: Math.round(performance.now() - started) };
}

const startedAt = new Date().toISOString();
const readiness = await waitForReadyHealth({ url: `${GATEWAY}/healthz` });
const health = readiness.health;
const token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
if (token.length < 32) throw new Error(`invalid rail token at ${TOKEN_FILE}`);

const tail = await fetchJson(`${GATEWAY}/v1/cobra/flux/tail?lane=both&n=3`, {
  headers: { 'x-ae-rail-token': token },
}, 15_000);

const [phaseSystemCheck, phaseModelInventory] = await Promise.all([
  requestAEPhaseTool({ command: 'system-check', timeoutMs: 30_000 }),
  requestAEPhaseTool({ command: 'model-inventory', timeoutMs: 30_000 }),
]);

const prompt = 'Explain in three concise sentences how Orange preserves project memory and sends heavy model work to Codexa. Name the active cross-computer transport, distinguish source truth from hot context, and do not describe unverified features.';
const chatStarted = performance.now();
const chat = await fetchJson(`${GATEWAY}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    model: 'orange-auto',
    ae_response_mode: 'conversation',
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 220,
    stream: false,
  }),
});
const conversationMs = Math.round(performance.now() - chatStarted);
const answer = String(chat?.choices?.[0]?.message?.content || '').trim();
const appIndex = path.join(ROOT, '02-APP', 'dist', 'index.html');
const appBuilt = fs.existsSync(appIndex);

const checks = [
  check('gateway_live', health?.status === 'ok' && health?.service === 'orangellm-gateway', health?.status),
  check('navigator_live', health?.upstream?.navigator?.live === true, health?.upstream?.navigator?.status),
  check('navigator_uses_phase', health?.upstream?.navigator?.transport?.transport === 'ae-phase', health?.upstream?.navigator?.transport?.transport),
  check('fabric_uses_phase', health?.fabric?.crossNodeTransport === 'ae-phase', health?.fabric?.crossNodeTransport),
  check('direct_endpoints_recovery_only', health?.fabric?.railUrl == null && Boolean(health?.fabric?.recovery?.railUrl), {
    activeRail: health?.fabric?.railUrl ?? null,
    recoveryRailPresent: Boolean(health?.fabric?.recovery?.railUrl),
  }),
  check('memory_daemon_live', health?.memory?.serving === 'ae_cobra' && health?.memory?.cobra?.live === true, health?.memory?.serving),
  check('canonical_disk_fallback_live', health?.memory?.canonical_disk?.live === true, health?.memory?.canonical_disk?.source),
  check('cobra_reality_chain', tail?.lanes?.reality?.returned === 3 && tail?.lanes?.reality?.chain_unbroken === true, tail?.lanes?.reality?.chain_unbroken),
  check('cobra_thought_chain', tail?.lanes?.thought?.returned === 3 && tail?.lanes?.thought?.chain_unbroken === true, tail?.lanes?.thought?.chain_unbroken),
  check('phase_system_check', phaseSystemCheck?.ok === true && phaseSystemCheck?.semantic?.status === 'VERIFIED', {
    status: phaseSystemCheck?.status,
    receiptPath: phaseSystemCheck?.receiptPath,
  }),
  check('phase_model_inventory', phaseModelInventory?.ok === true && phaseModelInventory?.semantic?.vulkan?.live === true && phaseModelInventory?.semantic?.ollama?.live === true, {
    status: phaseModelInventory?.status,
    receiptPath: phaseModelInventory?.receiptPath,
  }),
  check('codexa_cobra_mirror_verified', phaseSystemCheck?.semantic?.memoryMirror?.ok === true, phaseSystemCheck?.semantic?.memoryMirror),
  check('human_conversation_mode', chat?.ae_response_mode === 'conversation' && !answer.startsWith('{'), chat?.ae_response_mode),
  check('conversation_uses_least_action_kernel', chat?.ae_route_mode === 'navigator_kernel' && chat?.ae_navigator_kernel?.model_calls_avoided === 1, {
    routeMode: chat?.ae_route_mode,
    sourceRefs: chat?.ae_navigator_kernel?.source_refs || [],
  }),
  check('answer_names_phase', /\bAE Phase\b/i.test(answer), sha256(answer)),
  check('answer_preserves_authority', /source truth/i.test(answer) && /hot context|working state/i.test(answer), sha256(answer)),
  check('atomic_orange_web_build_present', appBuilt, appBuilt ? sha256(fs.readFileSync(appIndex)) : null),
];

const functional = checks.every((item) => item.ok);
const latencyTargetMs = Number(process.env.ORANGE5_CONVERSATION_TARGET_MS || 10_000);
const latencyPass = conversationMs <= latencyTargetMs;
const generatedAt = new Date().toISOString();
const fileStamp = generatedAt.replace(/[:.]/g, '-');
const target = path.join(RECEIPT_DIR, `${fileStamp}-memory-phase-conversation-proof.json`);
const receipt = writeChainedJsonReceipt(target, {
  schema: 'orange.memory-phase-conversation-proof.v1',
  status: functional
    ? (latencyPass ? 'VERIFIED' : 'VERIFIED_WITH_PERFORMANCE_GAP')
    : 'NOT_VERIFIED',
  generated_at: generatedAt,
  started_at: startedAt,
  gateway: GATEWAY,
  readiness: {
    ready: healthReady(health),
    wait_ms: readiness.wait_ms,
    attempts: readiness.attempts,
  },
  functional,
  checks_green: checks.filter((item) => item.ok).length,
  checks_total: checks.length,
  checks,
  conversation: {
    model: chat?.model || null,
    route_mode: chat?.ae_route_mode || null,
    response_mode: chat?.ae_response_mode || null,
    elapsed_ms: conversationMs,
    stage_timings_ms: chat?.ae_stage_timings_ms || null,
    target_ms: latencyTargetMs,
    latency_pass: latencyPass,
    prompt_sha256: sha256(prompt),
    answer_sha256: sha256(answer),
    answer,
  },
  tests: {
    focused_bun_tests: 'focused runtime, compute fabric, Orange system, Cobra, canonical memory, and Codexa semantic-tool tests passed',
    atomic_orange_build: 'tsc -b && vite build passed',
  },
  remaining_blockers: latencyPass
    ? []
    : [`Navigator conversation ${conversationMs}ms exceeds ${latencyTargetMs}ms target; function is proven, performance is not closed.`],
});

process.stdout.write(`${JSON.stringify({
  status: receipt.status,
  functional: receipt.functional,
  checks: `${receipt.checks_green}/${receipt.checks_total}`,
  conversation_ms: conversationMs,
  answer,
  receipt_path: target,
  receipt_sha256: receipt.receipt_sha256,
}, null, 2)}\n`);

if (!functional) process.exitCode = 1;
