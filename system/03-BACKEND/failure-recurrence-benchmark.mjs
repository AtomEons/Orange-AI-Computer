#!/usr/bin/env bun

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ingestReceipt, lessonFor } from './learning-loop.mjs';
import { writeChainedJsonReceipt } from '../10-RECEIPTS/tools/json-receipt-chain.mjs';

const ROOT = resolve(import.meta.dir, '..');
const RECEIPT_DIR = join(ROOT, '10-RECEIPTS', 'orange5-build');

function percentile(values, ratio) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))];
}

async function write(root, now, offset, receipt) {
  return ingestReceipt(receipt, { fluxRoot: root, ts: now + offset });
}

export async function runFailureRecurrenceBenchmark({ writeReceipt = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'orange5-recurrence-'));
  const now = Date.parse('2026-08-26T20:00:00Z');
  try {
    await write(root, now, -9_000, { action: 'probe.network', status: 'error', summary: 'Codexa connection timeout', receipt_id: 'network-fail-1' });
    await write(root, now, -8_000, { action: 'probe.network', status: 'error', summary: 'Codexa connection timeout', receipt_id: 'network-fail-2' });
    await write(root, now, -7_000, { action: 'probe.network', status: 'completed', summary: 'Codexa reachability and credentials verified', receipt_id: 'network-pass' });

    await write(root, now, -6_000, { action: 'build.api', status: 'error', summary: 'typecheck verification failed', receipt_id: 'build-fail' });
    await write(root, now, -5_000, { action: 'build.api', status: 'completed', summary: 'typecheck and focused tests passed', receipt_id: 'build-pass' });

    await write(root, now, -4_000, { action: 'query.code', status: 'error', summary: 'context token budget overflow', receipt_id: 'context-old' });
    await write(root, now, -3_000, { action: 'query.code', status: 'completed', summary: 'source-addressed workset completed', receipt_id: 'context-pass' });
    await write(root, now, -2_000, { action: 'query.code', status: 'error', summary: 'new context token budget overflow', receipt_id: 'context-new' });

    await write(root, now, -1_500, { action: 'query.chat', status: 'error', summary: 'navigator connection timeout', receipt_id: 'chat-fail' });
    await write(root, now, -1_000, { action: 'query.chat', status: 'needs_action', summary: 'run a governed probe or provide evidence', receipt_id: 'chat-guarded' });
    await write(root, now, -500, { action: 'review.capability', status: 'blocked', summary: 'required specialist model is unavailable', receipt_id: 'capability-open' });

    const cases = {
      connectivity_closed: lessonFor('probe.network', { fluxRoot: root, nowMs: now, limit: 10 }),
      verification_closed: lessonFor('build.api', { fluxRoot: root, nowMs: now, limit: 10 }),
      context_reopened: lessonFor('query.code', { fluxRoot: root, nowMs: now, limit: 10 }),
      guarded_stop_closed: lessonFor('query.chat', { fluxRoot: root, nowMs: now, limit: 10 }),
      capability_unresolved: lessonFor('review.capability', { fluxRoot: root, nowMs: now, limit: 10 }),
    };
    const checks = {
      connectivity_success_closes_failures: cases.connectivity_closed.count === 0 && cases.connectivity_closed.resolved_count === 2,
      verification_success_closes_failure: cases.verification_closed.count === 0 && cases.verification_closed.resolved_count === 1,
      post_resolution_failure_reopens_episode: cases.context_reopened.count === 1 && cases.context_reopened.patterns[0]?.failureClass === 'context_pressure',
      correct_evidence_refusal_is_not_failure: cases.guarded_stop_closed.count === 0 && cases.guarded_stop_closed.last_resolution_disposition === 'guarded_stop',
      unresolved_capability_block_remains_active: cases.capability_unresolved.count === 1 && cases.capability_unresolved.patterns[0]?.failureClass === 'capability_route_failure',
      query_lanes_remain_isolated: lessonFor('query.visual', { fluxRoot: root, nowMs: now, limit: 10 }).count === 0,
    };

    const hotReadMs = [];
    for (let run = 0; run < 20; run += 1) {
      const started = performance.now();
      lessonFor('query.code', { fluxRoot: root, nowMs: now, limit: 10 });
      hotReadMs.push(performance.now() - started);
    }
    const p95 = percentile(hotReadMs, 0.95);
    checks.hot_episode_read_under_100ms = p95 < 100;

    let liveQueryChat;
    const liveStarted = performance.now();
    try { liveQueryChat = lessonFor('query.chat', { limit: 50, scanLimit: 5_000 }); }
    catch (error) { liveQueryChat = { error: error?.message || String(error) }; }
    const liveReadMs = performance.now() - liveStarted;
    const passed = Object.values(checks).every(Boolean);
    const receipt = {
      schema: 'orange5.failure-recurrence-benchmark.v1',
      generated_at: new Date().toISOString(),
      status: passed ? 'RECURRENCE_MECHANISM_PROVEN' : 'RECURRENCE_MECHANISM_NEEDS_WORK',
      checks,
      cases: Object.fromEntries(Object.entries(cases).map(([name, value]) => [name, {
        unresolved_count: value.count,
        resolved_count: value.resolved_count,
        classes: value.patterns.map((item) => item.failureClass),
        last_resolution_at: value.last_resolution_at,
        last_resolution_disposition: value.last_resolution_disposition,
      }])),
      performance: {
        synthetic_runs: hotReadMs.length,
        synthetic_p95_ms: Number(p95.toFixed(2)),
        live_query_chat_read_ms: Number(liveReadMs.toFixed(2)),
      },
      live_observation: liveQueryChat,
      claim_boundary: {
        mechanism_proven: passed,
        live_longitudinal_reduction_proven: false,
        reason: 'Independent post-deployment sessions are required before claiming a real-world recurrence-rate reduction.',
      },
    };
    if (!writeReceipt) return { ...receipt, receiptPath: null };
    const receiptPath = join(RECEIPT_DIR, `${receipt.generated_at.replace(/[:.]/g, '-')}-failure-recurrence-benchmark.json`);
    return { ...writeChainedJsonReceipt(receiptPath, receipt), receiptPath };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const result = await runFailureRecurrenceBenchmark();
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== 'RECURRENCE_MECHANISM_PROVEN') process.exitCode = 1;
}
