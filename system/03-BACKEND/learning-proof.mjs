#!/usr/bin/env bun
// Controlled end-to-end proof that Orange remembers a failure, surfaces it to
// the next real order before execution, and mirrors the resulting ledger.

import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { canonicalFluxRoot } from '../06-ORANGELLM/memory/ae-cobra/paths.mjs';
import { verifyChainStream } from '../06-ORANGELLM/memory/ae-cobra/flux/reader.mjs';
import { ingestReceipt, lessonFor } from './learning-loop.mjs';
import { runMirror } from '../06-ORANGELLM/memory/ae-cobra/mirror-to-codexa.mjs';
import { writeChainedJsonReceipt } from '../10-RECEIPTS/tools/json-receipt-chain.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FLUX_ROOT = canonicalFluxRoot();
const runId = randomUUID();
// The order under test is a mechanical memory read. The script itself proves
// the resulting behavior with deterministic assertions below; naming the
// order proof.* would correctly demand a separate claim refuter before the
// memory path can even run.
const action = `read.memory.recall.${runId}`;
const gateway = process.env.ORANGE5_ORANGEBRAIN_URL || 'http://127.0.0.1:1337';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function gatewayLive() {
  const response = await fetch(`${gateway.replace(/\/$/, '')}/healthz`, { signal: AbortSignal.timeout(20_000) });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.primary?.live) throw new Error(`OrangeBrain is not live at ${gateway}`);
  return body;
}

function parseChildJson(text) {
  const start = text.indexOf('{');
  if (start < 0) throw new Error(`spine returned no JSON: ${text}`);
  return JSON.parse(text.slice(start));
}

const health = await gatewayLive();
const seededSummary = 'CONTROLLED_PROOF: evidence was absent; next run must recall and review before proceeding';
const seeded = await ingestReceipt({
  action,
  status: 'halted',
  summary: seededSummary,
  receipt_id: `controlled-${runId}`,
}, {
  fluxRoot: FLUX_ROOT,
  cobraUrl: 'http://127.0.0.1:7419',
  requireCobra: true,
});

const before = lessonFor(action, { fluxRoot: FLUX_ROOT });
if (before.count < 1 || !before.warning) throw new Error('seeded lesson was not recallable before execution');

const order = {
  orderId: runId,
  action,
  intent: 'Recall a prior failure before a subsequent real OrangeBrain order',
  payload: { controlledProof: true, requiredBehavior: 'review-before-proceeding' },
};
const child = Bun.spawnSync([
  process.execPath,
  path.join(ROOT, '03-BACKEND', 'spine-cli.mjs'),
  '--order', JSON.stringify(order),
  '--learn',
], {
  cwd: ROOT,
  env: { ...process.env, ORANGE5_ORANGEBRAIN_URL: gateway },
  stdout: 'pipe',
  stderr: 'pipe',
});
const stdout = child.stdout.toString();
const stderr = child.stderr.toString();
// This action intentionally has no deterministic executor. The current
// execution-provenance law therefore requires needs_action and CLI exit 1.
// Treating model guidance as a successful execution would be a regression.
if (![0, 1].includes(child.exitCode)) throw new Error(`spine failed (${child.exitCode}): ${stderr || stdout}`);
const spine = parseChildJson(stdout);
if (spine.status !== 'needs_action') throw new Error(`unexecuted proof action must be needs_action, got ${spine.status}`);
if (spine.report?.status !== 'needs_action') throw new Error(`report falsely completed unexecuted work: ${spine.report?.status}`);
if (Number(spine.mistakes_surfaced) < 1) throw new Error('spine did not surface the seeded mistake before execution');
if (!String(spine.lesson || '').includes('prior issue')) throw new Error('learning loop did not emit its operator warning');
if (spine.learning?.ingested !== true || !String(spine.learning?.transport || '').startsWith('ae-cobra-http')) {
  throw new Error(`canonical learning ingest was not proven: ${JSON.stringify(spine.learning)}`);
}

const after = lessonFor(action, { fluxRoot: FLUX_ROOT });
if (after.count !== 0) throw new Error(`guarded stop did not resolve the seeded failure: ${before.count} -> ${after.count}`);
if (after.resolved_count < before.count || after.last_resolution_disposition !== 'guarded_stop') {
  throw new Error(`guarded-stop resolution was not recorded: ${JSON.stringify(after)}`);
}
const chains = Object.fromEntries(['reality', 'thought', 'merge'].map((lane) => [lane, verifyChainStream({ fluxRoot: FLUX_ROOT, lane })]));
if (!Object.values(chains).every((chain) => chain.ok)) throw new Error('canonical memory chain failed after learning proof');

// Force rail verification instead of trusting a prior local mirror-state cache.
const mirror = await runMirror({ force: true });
if (mirror.status !== 'VERIFIED' || mirror.changedFileCount < 1) throw new Error('Codexa mirror did not verify changed memory bytes');

const receipt = {
  schema: 'orange5.learning.behavior-proof.v1',
  status: 'VERIFIED',
  generated_at: new Date().toISOString(),
  run_id: runId,
  controlled_proof: true,
  action,
  canonical_root: FLUX_ROOT,
  orangebrain: { url: gateway, version: health.version ?? null, primary: health.primary ?? null },
  seeded_failure: {
    id: seeded.id ?? null,
    lane: seeded.lane ?? null,
    transport: seeded.transport ?? null,
    summary: seededSummary,
  },
  pre_action_recall: { count: before.count, warning: before.warning },
  subsequent_order: {
    status: spine.status,
    execution_performed: false,
    mistakes_surfaced: spine.mistakes_surfaced,
    lesson: spine.lesson,
    learning: spine.learning,
    report_status: spine.report?.status ?? null,
    receipt: spine.receipt,
  },
  post_action_recall: {
    count: after.count,
    warning: after.warning,
    resolved_count: after.resolved_count,
    last_resolution_at: after.last_resolution_at,
    last_resolution_disposition: after.last_resolution_disposition,
  },
  chains,
  codexa_mirror: {
    status: mirror.status,
    file_count: mirror.fileCount,
    changed_file_count: mirror.changedFileCount,
    manifest_sha256: mirror.manifestSha256 ?? null,
    rail_receipts: mirror.changed.map((item) => item.railReceiptPath),
  },
};
receipt.proof_hash = sha256(JSON.stringify(receipt));
const receiptDir = path.join(ROOT, '10-RECEIPTS', 'orange5-build');
fs.mkdirSync(receiptDir, { recursive: true });
const receiptPath = path.join(receiptDir, `${receipt.generated_at.replace(/[:.]/g, '-')}-learning-behavior-proof.json`);
const chainedReceipt = writeChainedJsonReceipt(receiptPath, receipt);
console.log(JSON.stringify({ ...chainedReceipt, receiptPath }, null, 2));
