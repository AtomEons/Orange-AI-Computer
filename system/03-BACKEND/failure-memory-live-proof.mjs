import fs from 'node:fs';
import path from 'node:path';
import { verifySpineChain } from './receipt-to-reflex.mjs';
import { learningQueueSnapshot } from './learning-queue.mjs';
import { lessonFor } from './learning-loop.mjs';
import { writeChainedJsonReceipt } from '../10-RECEIPTS/tools/json-receipt-chain.mjs';

const ROOT = path.resolve(import.meta.dir, '..');
const RECEIPT_DIR = path.join(ROOT, '10-RECEIPTS', 'orange5-build');
const GATEWAY_URL = process.env.ORANGE5_ORANGEBRAIN_URL || 'http://127.0.0.1:1337';

function latestCanonicalProof() {
  const candidates = fs.readdirSync(RECEIPT_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('-failure-memory-closeout.json'))
    .map((entry) => {
      const fullPath = path.join(RECEIPT_DIR, entry.name);
      return { name: entry.name, fullPath, mtime: fs.statSync(fullPath).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
  if (!candidates.length) return null;
  const selected = candidates[0];
  return { path: selected.fullPath, receipt: JSON.parse(fs.readFileSync(selected.fullPath, 'utf8')) };
}

async function waitForLearningQueue(timeoutMs = 8_000) {
  const started = Date.now();
  let snapshot = learningQueueSnapshot();
  while ((snapshot.open > 0 || snapshot.drain_running) && Date.now() - started < timeoutMs) {
    await Bun.sleep(100);
    snapshot = learningQueueSnapshot();
  }
  return snapshot;
}

function gatewayPid() {
  if (process.platform !== 'win32') return null;
  const result = Bun.spawnSync([
    'powershell.exe',
    '-NoProfile',
    '-Command',
    "(Get-NetTCPConnection -LocalPort 1337 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess)",
  ]);
  const value = result.stdout.toString().trim();
  return /^\d+$/.test(value) ? Number(value) : null;
}

const generatedAt = new Date().toISOString();
const healthResponse = await fetch(`${GATEWAY_URL}/healthz`, { signal: AbortSignal.timeout(8_000) });
const health = await healthResponse.json();
const lessonBefore = lessonFor('query.chat', { limit: 50, scanLimit: 5_000 });
const completionResponse = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  signal: AbortSignal.timeout(30_000),
  body: JSON.stringify({
    model: 'orange-navigator',
    temperature: 0,
    messages: [{ role: 'user', content: 'State the active Orange release name only.' }],
  }),
});
const completion = await completionResponse.json();
const content = String(completion?.choices?.[0]?.message?.content || '').trim().replace(/[.!]$/, '');
const turn = completion?.ae_turn || null;
const queue = await waitForLearningQueue();
const lessonAfter = lessonFor('query.chat', { limit: 50, scanLimit: 5_000 });
const chain = verifySpineChain();
const spineTurn = chain.rows.find((row) => row.seq === turn?.receipt?.seq) || null;
const canonical = latestCanonicalProof();
const canonicalDiscovery = canonical?.receipt?.verification?.canonical_discovery || null;

const checks = {
  gateway_healthy: healthResponse.status === 200 && health?.status === 'ok',
  completion_http_ok: completionResponse.status === 200,
  release_identity_correct: content === 'OrangeFive',
  governed_turn_present: turn?.schema === 'orange.chat-turn.v1' && turn?.action === 'query.chat',
  navigator_route_live: turn?.route?.lane === 'navigator' && Boolean(turn?.route?.effective_model),
  stale_failure_air_absent: turn?.failure_memory?.active === false && turn?.failure_memory?.prior_failure_count === 0,
  resolved_history_visible: Number(turn?.failure_memory?.resolved_count || 0) > 0,
  learning_queue_drained: queue.open === 0 && queue.failed === 0,
  failure_episode_closed: lessonAfter.count === 0 && lessonAfter.resolved_count > 0,
  spine_chain_valid: chain.ok === true,
  turn_joined_to_spine: Boolean(spineTurn)
    && spineTurn.receipt_id === turn?.receipt?.id
    && spineTurn.hash === turn?.receipt?.hash,
  canonical_suite_green: canonicalDiscovery?.green === 169 && canonicalDiscovery?.red === 0,
};
const green = Object.values(checks).every(Boolean);
const fileName = `${generatedAt.replaceAll(':', '-')}-failure-memory-live-activation.json`;
const receiptPath = path.join(RECEIPT_DIR, fileName);
const receipt = writeChainedJsonReceipt(receiptPath, {
  schema: 'orange5.failure-memory-live-activation.v1',
  generated_at: generatedAt,
  status: green ? 'FAILURE_MEMORY_LIVE_ACTIVATION_GREEN' : 'FAILURE_MEMORY_LIVE_ACTIVATION_NEEDS_WORK',
  gateway: {
    url: GATEWAY_URL,
    pid: gatewayPid(),
    health_http: healthResponse.status,
    health_status: health?.status || null,
  },
  live_roundtrip: {
    http_status: completionResponse.status,
    content,
    order_id: completion?.ae_order_id || turn?.order_id || null,
    action: turn?.action || null,
    route: turn?.route || null,
    failure_memory: turn?.failure_memory || null,
    compression: turn?.compression || null,
    receipt: turn?.receipt || null,
  },
  recurrence: {
    before: {
      active_count: lessonBefore.count,
      resolved_count: lessonBefore.resolved_count,
      last_resolution_at: lessonBefore.last_resolution_at,
    },
    after: {
      active_count: lessonAfter.count,
      resolved_count: lessonAfter.resolved_count,
      last_resolution_at: lessonAfter.last_resolution_at,
      last_resolution_disposition: lessonAfter.last_resolution_disposition,
    },
  },
  learning_queue: queue,
  spine: {
    ok: chain.ok,
    count: chain.count,
    broken: chain.broken,
    joined_turn: spineTurn ? {
      seq: spineTurn.seq,
      receipt_id: spineTurn.receipt_id,
      hash: spineTurn.hash,
      status: spineTurn.status,
      summary: spineTurn.summary,
    } : null,
  },
  canonical_verification: canonical ? {
    source_receipt: canonical.path,
    source_receipt_sha256: canonical.receipt.receipt_sha256 || null,
    discovery: canonicalDiscovery,
  } : null,
  checks,
  claim_boundary: {
    recurrence_mechanism_proven: green,
    live_activation_proven: green,
    stale_failure_reinjection_prevented: checks.stale_failure_air_absent,
    independent_longitudinal_reduction_proven: false,
    note: 'Longitudinal reduction requires future independent sessions; this receipt proves the live mechanism and current closure state.',
  },
});

console.log(JSON.stringify({
  status: receipt.status,
  checks,
  receipt_path: receiptPath,
  receipt_sha256: receipt.receipt_sha256,
  live_turn: receipt.live_roundtrip.receipt,
  route: receipt.live_roundtrip.route,
  recurrence: receipt.recurrence,
  learning_queue: {
    status: queue.status,
    total: queue.total,
    open: queue.open,
    failed: queue.failed,
  },
  spine: { ok: chain.ok, count: chain.count },
}, null, 2));

if (!green) process.exitCode = 1;
