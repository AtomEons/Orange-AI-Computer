import { afterEach, describe, expect, test } from 'bun:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runFailureLongitudinalRecurrenceExperiment } from '../failure-longitudinal-recurrence-experiment.mjs';

const roots = [];

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true });
});

describe('Failure Memory longitudinal recurrence experiment', () => {
  test('proves causal recurrence suppression across fresh processes and writes chained evidence', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orange5-lane7-test-'));
    roots.push(root);
    const result = runFailureLongitudinalRecurrenceExperiment({
      cohorts: 1,
      sessionsPerArm: 4,
      childTimeoutMs: 10_000,
      writeReceipt: true,
      receiptDir: root,
    });

    expect(result.status).toBe('LONGITUDINAL_RECURRENCE_SUPPRESSION_PROVEN');
    expect(Object.values(result.checks).every(Boolean)).toBe(true);
    expect(result.measures).toMatchObject({
      control_repeat_mistakes: 3,
      memory_repeat_mistakes: 0,
      repeat_opportunities: 3,
      prevented_repeat_mistakes: 3,
      recurrence_suppression_rate: 1,
    });
    expect(result.process_isolation).toMatchObject({
      unique_worker_pids: 8,
      unique_boot_ids: 8,
      fresh_processes_proven: true,
    });

    const cohort = result.cohorts[0];
    expect(cohort.memory.sessions.map((session) => session.decision)).toEqual([
      'repeat_unverified_route',
      'repair_then_verify',
      'reuse_proven_resolution',
      'reuse_proven_resolution',
    ]);
    expect(cohort.memory.sessions.slice(2).every((session) => (
      session.memory_before.resolved_failures > 0 && session.outcome.mistake === false
    ))).toBe(true);
    expect(cohort.control.flux_chain).toMatchObject({ ok: true, count: 4 });
    expect(cohort.memory.flux_chain).toMatchObject({ ok: true, count: 4 });

    expect(fs.existsSync(result.receipt_path)).toBe(true);
    const persisted = JSON.parse(fs.readFileSync(result.receipt_path, 'utf8'));
    const { receipt_sha256: persistedHash, ...hashedBody } = persisted;
    expect(persistedHash).toBe(crypto.createHash('sha256').update(JSON.stringify(hashedBody)).digest('hex'));
    const indexRows = fs.readFileSync(path.join(root, 'json-receipt-chain.jsonl'), 'utf8')
      .trim().split(/\r?\n/).map(JSON.parse);
    expect(indexRows.at(-1).file).toBe(path.basename(result.receipt_path));
    expect(indexRows.at(-1).file_sha256).toBe(
      crypto.createHash('sha256').update(fs.readFileSync(result.receipt_path)).digest('hex'),
    );
  }, 60_000);
});
