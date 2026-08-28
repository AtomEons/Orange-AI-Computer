#!/usr/bin/env bun
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { projectState } from '../06-ORANGELLM/memory/ae-cobra/recall-engine.mjs';
import { readFluxTail, verifyChainStream } from '../06-ORANGELLM/memory/ae-cobra/flux/reader.mjs';
import { writeChainedJsonReceipt } from '../10-RECEIPTS/tools/json-receipt-chain.mjs';
import { ingestReceipt, lessonFor } from './learning-loop.mjs';
import { buildMemoryContext, buildModelMemoryBrief } from './memory-context.mjs';
import { persistMemoryRecord, recordContradictionDebt } from './memory-runtime.mjs';
import { classifyPromotedReflex, promoteReflexRule, rollbackReflexRule } from './reflex-registry.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const RECEIPT_ROOT = path.join(ROOT, '10-RECEIPTS', 'orange5-build');
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

function reflexRule(nextAction) {
  return {
    id: 'heldout-citation-route',
    match: { all: ['citation'], any: ['show', 'locate', 'verify'], none: ['delete', 'forge', 'rewrite'] },
    decision: { status: 'needs_action', nextAction },
    positive_holdouts: ['Show the citation proof.', 'Locate this citation.', 'Verify the source citation.'],
    negative_holdouts: ['Delete the citation proof.', 'Forge a citation.', 'Rewrite the source without review.'],
  };
}

function freshProcessRecall(fluxRoot, memoryId) {
  const readerUrl = pathToFileURL(path.join(ROOT, '06-ORANGELLM', 'memory', 'ae-cobra', 'flux', 'reader.mjs')).href;
  const code = `import { readFluxTail } from ${JSON.stringify(readerUrl)}; const rows=readFluxTail({fluxRoot:${JSON.stringify(fluxRoot)},lanes:['reality','thought','merge'],maxRecords:100}); const row=rows.find((item)=>item?.body?.memory_id===${JSON.stringify(memoryId)}); process.stdout.write(JSON.stringify({found:Boolean(row),source_sha256:row?.body?.source_pointers?.[0]?.sha256||null}));`;
  const child = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', windowsHide: true });
  if (child.status !== 0) throw new Error(`fresh memory process failed: ${String(child.stderr || child.stdout).trim()}`);
  return { ...JSON.parse(child.stdout), pid_isolated: true };
}

export async function runMemoryLearningHeldoutBenchmark({ writeReceipt = true, receiptRoot = RECEIPT_ROOT } = {}) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'orange5-memory-learning-heldout-'));
  const fluxRoot = path.join(workspace, 'flux');
  const registryPath = path.join(workspace, 'reflex-registry.json');
  const now = Date.now();
  try {
    const sourcePath = path.join(workspace, 'heldout-source-receipt.json');
    fs.writeFileSync(sourcePath, `${JSON.stringify({ schema: 'heldout.source.v1', verdict: 'measured-route' })}\n`);
    const sourceHash = sha256(fs.readFileSync(sourcePath));

    await ingestReceipt({
      action: 'verify.release', status: 'error',
      summary: 'artifact provenance checksum mismatch at promotion boundary', targetProject: 'OrangeFive', receipt_id: 'heldout-relevant',
    }, { fluxRoot, ts: now - 4_000 });
    await ingestReceipt({
      action: 'verify.release', status: 'error',
      summary: 'brochure font kerning regressed in print preview', targetProject: 'OrangeFive', receipt_id: 'heldout-noise',
    }, { fluxRoot, ts: now - 3_000 });
    const recall = lessonFor('verify.release', {
      fluxRoot, nowMs: now, intent: 'validate artifact provenance checksum before promotion', targetProject: 'OrangeFive', limit: 5,
    });

    const persisted = persistMemoryRecord({
      lane: 'reality', kind: 'decision_receipt', memory_id: 'heldout-durable-decision', ts: now - 2_000,
      summary: 'decision_reason=use the measured route; outcome=success; action=verify.release; debt_type=none; debt_status=none',
      entities: ['OrangeFive', 'verify.release'], files: [sourcePath],
      source_pointers: [{ kind: 'receipt', path: sourcePath, sha256: sourceHash, offset: 1 }],
    }, { fluxRoot });
    const freshRecall = freshProcessRecall(fluxRoot, persisted.memory_id);

    recordContradictionDebt({
      debt_id: 'heldout-route-conflict', reason: 'legacy route conflicts with measured route',
      entities: ['OrangeFive'], files: [sourcePath], source_pointers: [{ path: sourcePath, sha256: sourceHash }],
    }, { fluxRoot });
    const resolution = recordContradictionDebt({
      debt_id: 'heldout-route-conflict', status: 'resolved', reason: 'legacy route conflicts with measured route',
      resolution: 'measured receipt supersedes legacy prose', entities: ['OrangeFive'], files: [sourcePath],
      source_pointers: [{ path: sourcePath, sha256: sourceHash }],
    }, { fluxRoot });

    const projected = projectState({ fluxRoot, project: 'OrangeFive', nowMs: Date.now() + 1_000, maxPer: 20 });
    const context = buildMemoryContext({ project: projected });
    const brief = buildModelMemoryBrief(context);

    const first = promoteReflexRule(reflexRule('read the cited receipt'), {
      registryPath, operatorApproval: true, evidence: [`source:${sourceHash}`], actor: 'heldout-benchmark',
    });
    rollbackReflexRule('heldout-citation-route', first.rollback_token, { registryPath, actor: 'heldout-benchmark' });
    promoteReflexRule(reflexRule('read the exact source hash before acting'), {
      registryPath, operatorApproval: true, evidence: [`source:${sourceHash}`], actor: 'heldout-benchmark',
    });
    let staleRollbackRejected = false;
    try { rollbackReflexRule('heldout-citation-route', first.rollback_token, { registryPath, actor: 'heldout-benchmark' }); }
    catch { staleRollbackRejected = true; }
    const currentReflex = classifyPromotedReflex('Show the citation proof.', registryPath);

    const chain = Object.fromEntries(['reality', 'thought', 'merge'].map((lane) => {
      const proof = verifyChainStream({ fluxRoot, lane });
      return [lane, { ok: proof.ok, count: proof.count, tail_hash: proof.tailHash }];
    }));
    const fluxRows = readFluxTail({ fluxRoot, lanes: ['reality', 'thought'], maxRecords: 100 });
    const checks = {
      useful_recall_selects_relevant_failure: recall.count === 1 && /provenance checksum/.test(recall.mistakes[0]?.summary || ''),
      useful_recall_suppresses_same_action_noise: recall.suppressed_count === 1,
      disk_record_survives_fresh_process: freshRecall.found && freshRecall.source_sha256 === sourceHash,
      source_hash_survives_projection: brief.sourcePointers.some((pointer) => pointer.sha256 === sourceHash && pointer.path === sourcePath),
      contradiction_resolution_is_appended: resolution.deduped === false && resolution.lane === 'reality'
        && fluxRows.filter((row) => row.body?.debts?.some((debt) => debt.debt_id === 'heldout-route-conflict')).length === 2,
      contradiction_debt_reduces_to_current_state: context.project?.openDebtCount === 0,
      stale_reflex_rollback_is_rejected: staleRollbackRejected
        && currentReflex?.nextAction === 'read the exact source hash before acting',
      flux_chains_verify: Object.values(chain).every((item) => item.ok),
    };
    const passed = Object.values(checks).filter(Boolean).length;
    const generatedAt = new Date().toISOString();
    const receipt = {
      schema: 'orange5.memory-learning-heldout-benchmark.v1',
      status: passed === Object.keys(checks).length ? 'MEMORY_LEARNING_HELDOUT_GREEN' : 'MEMORY_LEARNING_HELDOUT_NEEDS_WORK',
      generated_at: generatedAt,
      cases_passed: passed,
      cases_total: Object.keys(checks).length,
      checks,
      recall: {
        candidates_considered: recall.candidates_considered, recalled: recall.count, suppressed: recall.suppressed_count,
        selected_summary: recall.mistakes[0]?.summary || null,
      },
      persistence: { memory_id: persisted.memory_id, fresh_process: freshRecall, source_path: sourcePath, source_sha256: sourceHash },
      debt: { debt_id: 'heldout-route-conflict', current_open_count: context.project?.openDebtCount ?? null },
      reflex: { stale_rollback_rejected: staleRollbackRejected, active_rule_hash: currentReflex?.rule_hash || null },
      chains: chain,
      law: 'Recall must be relevant, hydratable to immutable source evidence, durable across process restart, and unable to promote or rollback reflexes without bounded proof.',
    };
    if (!writeReceipt) return { ...receipt, receipt_path: null };
    const receiptPath = path.join(receiptRoot, `${generatedAt.replace(/[:.]/g, '-')}-memory-learning-heldout.json`);
    return { ...writeChainedJsonReceipt(receiptPath, receipt), receipt_path: receiptPath };
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const result = await runMemoryLearningHeldoutBenchmark();
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== 'MEMORY_LEARNING_HELDOUT_GREEN') process.exitCode = 1;
}
