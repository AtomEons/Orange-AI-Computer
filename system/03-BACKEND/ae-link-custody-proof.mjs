#!/usr/bin/env bun
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Database } from 'bun:sqlite';
import { WorkCustodyJournal } from './ae-link/custody.mjs';
import { writeChainedJsonReceipt } from '../10-RECEIPTS/tools/json-receipt-chain.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELF = fileURLToPath(import.meta.url);
const RECEIPT_DIR = path.join(ROOT, '10-RECEIPTS', 'orange5-build');
const KEY = 'orange5-isolated-ae-link-custody-proof-key';
const EXPECTED_CRASH = 73;

function sha256(value) {
  return crypto.createHash('sha256').update(Buffer.isBuffer(value) ? value : String(value)).digest('hex');
}

function openJournal(input) {
  return new WorkCustodyJournal({
    filePath: input.journalPath,
    nodeId: 'ae-link-proof-node',
    integrityKey: KEY,
  });
}

function applyWriteOnce(dbPath, effectId, payload) {
  const db = new Database(dbPath, { create: true });
  try {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS effects (effect_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL);');
    const result = db.query('INSERT OR IGNORE INTO effects (effect_id, payload_json) VALUES (?, ?)').run(effectId, JSON.stringify(payload));
    const row = db.query('SELECT effect_id, payload_json FROM effects WHERE effect_id = ?').get(effectId);
    return { appliedNow: result.changes === 1, row };
  } finally {
    db.close();
  }
}

function executeAction(input) {
  const journal = openJournal(input);
  const common = { workId: input.workId, owner: input.owner, ownerEpoch: input.ownerEpoch };
  let result;
  switch (input.action) {
    case 'offer':
      result = journal.offer({ ...common, idempotencyKey: input.idempotencyKey, payload: input.payload });
      break;
    case 'persist': result = journal.persist(common); break;
    case 'start': result = journal.start(common); break;
    case 'grant': result = journal.grantEffect({ ...common, effectId: input.effectId }); break;
    case 'effect': result = applyWriteOnce(input.dbPath, input.effectId, input.payload); break;
    case 'commit': result = journal.commitEffect({ ...common, effectId: input.effectId, evidence: input.evidence }); break;
    case 'abort': result = journal.abortEffect({ ...common, effectId: input.effectId, evidence: input.evidence }); break;
    case 'cancel': result = journal.requestCancel({ ...common, reason: input.reason }); break;
    case 'terminal': result = journal.terminal({ ...common, outcome: input.outcome, evidence: input.evidence }); break;
    case 'handoff':
      result = journal.handoff({ workId: input.workId, fromOwner: input.owner, fromEpoch: input.ownerEpoch, toOwner: input.toOwner, toEpoch: input.toEpoch });
      break;
    case 'recover':
      result = journal.recover({
        workId: input.workId,
        newOwner: input.owner,
        newEpoch: input.ownerEpoch,
        reason: input.reason,
        orphanEvidence: input.orphanEvidence,
      });
      break;
    case 'status': result = { work: journal.status(input.workId), verify: journal.verify() }; break;
    default: throw new Error(`unknown custody proof action: ${input.action}`);
  }
  return result;
}

function worker(input) {
  const result = executeAction(input);
  if (input.crashAfter) process.exit(EXPECTED_CRASH);
  process.stdout.write(JSON.stringify(result));
}

function invoke(base, action, overrides = {}, { crashAfter = false, expectFailure = false } = {}) {
  const input = { ...base, ...overrides, action, crashAfter };
  if (!crashAfter) {
    try {
      const result = executeAction(input);
      if (expectFailure) throw new Error(`${action} unexpectedly succeeded`);
      return result;
    } catch (error) {
      if (!expectFailure || error.message === `${action} unexpectedly succeeded`) throw error;
      return { rejected: true, stderr: error.stack || error.message };
    }
  }
  const processResult = Bun.spawnSync([process.execPath, SELF, '--worker', JSON.stringify(input)], {
    cwd: ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stderr = processResult.stderr.toString().trim();
  if (crashAfter) {
    if (processResult.exitCode !== EXPECTED_CRASH) throw new Error(`${action} crash injection exited ${processResult.exitCode}: ${stderr}`);
    return { crashed: true };
  }
  if (processResult.exitCode !== 0) throw new Error(`${action} failed (${processResult.exitCode}): ${stderr}`);
  return JSON.parse(processResult.stdout.toString() || '{}');
}

function databaseEffectCount(dbPath) {
  if (!fs.existsSync(dbPath)) return 0;
  const db = new Database(dbPath, { readonly: true });
  try { return Number(db.query('SELECT COUNT(*) AS count FROM effects').get()?.count || 0); }
  finally { db.close(); }
}

function terminalEventCount(journalPath) {
  return fs.readFileSync(journalPath, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse)
    .filter((record) => record.toState === 'TERMINAL').length;
}

function journalLinkageValid(journalPath) {
  const records = fs.readFileSync(journalPath, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
  const workHeads = new Map();
  const workRevisions = new Map();
  return records.every((record, index) => {
    const priorWorkHash = workHeads.get(record.workId) ?? '0'.repeat(64);
    const priorWorkRevision = workRevisions.get(record.workId) ?? 0;
    const valid = record.sequence === index + 1
      && record.previousHash === (index === 0 ? '0'.repeat(64) : records[index - 1].hash)
      && record.previousWorkHash === priorWorkHash
      && record.workRevision === priorWorkRevision + 1;
    workHeads.set(record.workId, record.hash);
    workRevisions.set(record.workId, record.workRevision);
    return valid;
  });
}

function runCrashMatrix(root) {
  const operations = ['offer', 'persist', 'start', 'grant', 'effect', 'commit', 'terminal'];
  const results = [];
  for (const crashAt of operations) {
    const scenarioRoot = path.join(root, `crash-${crashAt}`);
    fs.mkdirSync(scenarioRoot, { recursive: true });
    const base = {
      journalPath: path.join(scenarioRoot, 'custody.jsonl'),
      dbPath: path.join(scenarioRoot, 'effects.db'),
      workId: `work-${crashAt}`,
      idempotencyKey: `key-${crashAt}`,
      owner: 'codexa-worker',
      ownerEpoch: 1,
      effectId: `effect-${crashAt}`,
      payload: { artifact: `artifact-${crashAt}` },
      evidence: { verifier: 'sqlite-write-once' },
      outcome: 'completed',
    };
    const crashIndex = operations.indexOf(crashAt);
    for (let index = 0; index <= crashIndex; index += 1) {
      invoke(base, operations[index], {}, { crashAfter: index === crashIndex });
    }
    for (let index = crashIndex; index < operations.length; index += 1) invoke(base, operations[index]);
    const status = invoke(base, 'status');
    results.push({
      crashAt,
      state: status.work.state,
      outcome: status.work.outcome,
      custodyValid: status.verify.ok,
      effectCount: databaseEffectCount(base.dbPath),
      terminalEvents: terminalEventCount(base.journalPath),
      journalLinkageValid: journalLinkageValid(base.journalPath),
    });
  }
  return results;
}

function runCancelAndOwnershipMatrix(root) {
  const scenario = (name) => ({
    journalPath: path.join(root, name, 'custody.jsonl'),
    dbPath: path.join(root, name, 'effects.db'),
    workId: `work-${name}`,
    idempotencyKey: `key-${name}`,
    owner: 'n150-owner', ownerEpoch: 1,
    effectId: `effect-${name}`,
    payload: { scenario: name }, evidence: { scenario: name }, outcome: 'cancelled', reason: name,
    orphanEvidence: { kind: 'lease-expired', leaseId: `lease-${name}` },
  });
  const before = scenario('cancel-before-start');
  fs.mkdirSync(path.dirname(before.journalPath), { recursive: true });
  invoke(before, 'offer'); invoke(before, 'persist'); invoke(before, 'cancel');
  const lateStart = invoke(before, 'start', {}, { expectFailure: true });

  const during = scenario('cancel-during-run');
  fs.mkdirSync(path.dirname(during.journalPath), { recursive: true });
  invoke(during, 'offer'); invoke(during, 'persist'); invoke(during, 'start'); invoke(during, 'cancel');
  const lateGrant = invoke(during, 'grant', {}, { expectFailure: true });
  invoke(during, 'terminal');

  const handoff = scenario('handoff');
  fs.mkdirSync(path.dirname(handoff.journalPath), { recursive: true });
  invoke(handoff, 'offer'); invoke(handoff, 'persist');
  invoke(handoff, 'handoff', { toOwner: 'codexa-owner', toEpoch: 2 });
  const staleOwner = invoke(handoff, 'start', {}, { expectFailure: true });
  invoke(handoff, 'start', { owner: 'codexa-owner', ownerEpoch: 2 });
  invoke(handoff, 'grant', { owner: 'codexa-owner', ownerEpoch: 2 });
  invoke(handoff, 'effect', { owner: 'codexa-owner', ownerEpoch: 2 });
  invoke(handoff, 'commit', { owner: 'codexa-owner', ownerEpoch: 2 });
  invoke(handoff, 'terminal', { owner: 'codexa-owner', ownerEpoch: 2, outcome: 'completed' });

  const recovery = scenario('orphan-recovery');
  fs.mkdirSync(path.dirname(recovery.journalPath), { recursive: true });
  invoke(recovery, 'offer'); invoke(recovery, 'persist'); invoke(recovery, 'start'); invoke(recovery, 'grant');
  invoke(recovery, 'effect', {}, { crashAfter: true });
  invoke(recovery, 'recover', { owner: 'recovery-owner', ownerEpoch: 2 });
  const oldOwner = invoke(recovery, 'start', {}, { expectFailure: true });
  invoke(recovery, 'start', { owner: 'recovery-owner', ownerEpoch: 2 });
  const resumed = invoke(recovery, 'grant', { owner: 'recovery-owner', ownerEpoch: 2 });
  const replayedEffect = invoke(recovery, 'effect', { owner: 'recovery-owner', ownerEpoch: 2 });
  invoke(recovery, 'commit', { owner: 'recovery-owner', ownerEpoch: 2 });
  invoke(recovery, 'terminal', { owner: 'recovery-owner', ownerEpoch: 2, outcome: 'completed' });

  const cancelRecovery = scenario('cancel-orphan-recovery');
  fs.mkdirSync(path.dirname(cancelRecovery.journalPath), { recursive: true });
  invoke(cancelRecovery, 'offer');
  invoke(cancelRecovery, 'persist');
  invoke(cancelRecovery, 'start');
  invoke(cancelRecovery, 'grant');
  invoke(cancelRecovery, 'cancel');
  invoke(cancelRecovery, 'recover', { owner: 'cancel-recovery-owner', ownerEpoch: 2 });
  const recoveredCancel = invoke(cancelRecovery, 'status', { owner: 'cancel-recovery-owner', ownerEpoch: 2 });
  const restartAfterCancel = invoke(cancelRecovery, 'start', {
    owner: 'cancel-recovery-owner', ownerEpoch: 2,
  }, { expectFailure: true });
  const newEffectAfterCancel = invoke(cancelRecovery, 'grant', {
    owner: 'cancel-recovery-owner', ownerEpoch: 2, effectId: 'late-effect',
  }, { expectFailure: true });
  invoke(cancelRecovery, 'abort', { owner: 'cancel-recovery-owner', ownerEpoch: 2 });
  invoke(cancelRecovery, 'terminal', { owner: 'cancel-recovery-owner', ownerEpoch: 2 });

  return {
    preStartCancelRejectedStart: lateStart.rejected,
    inFlightCancelRejectedNewEffect: lateGrant.rejected,
    handoffRejectedStaleOwner: staleOwner.rejected,
    orphanRecoveryRejectedOldOwner: oldOwner.rejected,
    orphanRecoveryReusedGrant: resumed.duplicate === true && resumed.resumeIdempotently === true,
    orphanRecoverySuppressedDuplicateEffect: replayedEffect.appliedNow === false,
    orphanRecoveryEffectCount: databaseEffectCount(recovery.dbPath),
    cancelRecoveryPreservedIntent: recoveredCancel.work.state === 'CANCEL_REQUESTED'
      && restartAfterCancel.rejected
      && newEffectAfterCancel.rejected,
    journalLinkageValid: journalLinkageValid(handoff.journalPath)
      && journalLinkageValid(recovery.journalPath)
      && journalLinkageValid(cancelRecovery.journalPath),
  };
}

export function runAELinkCustodyProof({ writeReceipt = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orange5-ae-link-custody-proof-'));
  try {
    const tests = [
      '03-BACKEND/tests/ae-link.test.mjs',
      '03-BACKEND/tests/ae-link-custody.test.mjs',
      '03-BACKEND/tests/ae-link-custody-model.test.mjs',
    ].filter((file) => fs.existsSync(path.join(ROOT, file)));
    const testRun = Bun.spawnSync([process.execPath, 'test', ...tests], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
    const output = `${testRun.stdout.toString()}\n${testRun.stderr.toString()}`.trim();
    const crashMatrix = runCrashMatrix(root);
    const raceMatrix = runCancelAndOwnershipMatrix(root);
    const checks = {
      focused_tests_passed: testRun.exitCode === 0,
      every_transition_survived_process_cut: crashMatrix.length === 7 && crashMatrix.every((item) => item.custodyValid && item.state === 'TERMINAL' && item.outcome === 'completed'),
      exactly_one_external_effect_per_cut: crashMatrix.every((item) => item.effectCount === 1),
      exactly_one_terminal_event_per_cut: crashMatrix.every((item) => item.terminalEvents === 1),
      pre_start_cancel_won: raceMatrix.preStartCancelRejectedStart,
      in_flight_cancel_blocked_new_effect: raceMatrix.inFlightCancelRejectedNewEffect,
      owner_epoch_fenced_stale_workers: raceMatrix.handoffRejectedStaleOwner && raceMatrix.orphanRecoveryRejectedOldOwner,
      orphan_recovery_reused_idempotency: raceMatrix.orphanRecoveryReusedGrant && raceMatrix.orphanRecoverySuppressedDuplicateEffect && raceMatrix.orphanRecoveryEffectCount === 1,
      cancel_survives_orphan_recovery: raceMatrix.cancelRecoveryPreservedIntent,
      deterministic_journal_linkage: raceMatrix.journalLinkageValid && crashMatrix.every((item) => item.journalLinkageValid),
    };
    const green = Object.values(checks).every(Boolean);
    const generatedAt = new Date().toISOString();
    const receipt = {
      schema: 'orange5.ae-link-custody-proof.v1',
      status: green ? 'AE_LINK_CUSTODY_ALPHA_GREEN' : 'AE_LINK_CUSTODY_ALPHA_NEEDS_WORK',
      generated_at: generatedAt,
      scope: 'isolated AE Link custody and transactional write-once effector proof; no production transport promotion',
      checks,
      crash_matrix: crashMatrix,
      race_matrix: raceMatrix,
      focused_tests: { command: [process.execPath, 'test', ...tests], exit_code: testRun.exitCode, output_sha256: sha256(output) },
      source_files: Object.fromEntries([
        '03-BACKEND/ae-link/custody.mjs',
        '03-BACKEND/ae-link/custody-interleaving-checker.mjs',
        '03-BACKEND/ae-link-custody-proof.mjs',
        ...tests,
      ].map((file) => [file, sha256(fs.readFileSync(path.join(ROOT, file)))])),
      claim_boundary: {
        isolated_custody_proven: green,
        arbitrary_external_effect_exactly_once_proven: false,
        production_ae_link_promoted: false,
        reason: 'Exactly-once behavior requires the target effector to honor the durable idempotency key; this proof uses SQLite uniqueness and full-sync transactions.',
      },
    };
    const receiptPath = path.join(RECEIPT_DIR, `${generatedAt.replace(/[:.]/g, '-')}-ae-link-custody-alpha.json`);
    if (!writeReceipt) return { ...receipt, receipt_path: null, receipt_written: false };
    const written = writeChainedJsonReceipt(receiptPath, receipt);
    return { ...written, receipt_path: receiptPath, receipt_written: true };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[2] === '--worker') {
  worker(JSON.parse(process.argv[3]));
} else if (import.meta.main) {
  const result = runAELinkCustodyProof({ writeReceipt: !process.argv.includes('--no-receipt') });
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== 'AE_LINK_CUSTODY_ALPHA_GREEN') process.exitCode = 1;
}
