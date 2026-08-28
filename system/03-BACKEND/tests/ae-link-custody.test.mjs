import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AELinkCustodyError,
  AELinkCustodyIntegrityError,
  CUSTODY_STATES,
  WorkCustodyJournal,
} from '../ae-link/custody.mjs';
import { canonicalJson, hmacHex } from '../ae-link/protocol.mjs';

const roots = [];

function fixture(name = 'custody') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `orange5-${name}-`));
  roots.push(root);
  return {
    root,
    filePath: path.join(root, 'custody.jsonl'),
    create: () => new WorkCustodyJournal({
      filePath: path.join(root, 'custody.jsonl'),
      nodeId: 'n150-control',
      integrityKey: 'test-only-custody-key',
      clock: () => 1_788_000_000_000,
    }),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('AE Link durable work custody', () => {
  test('persists before start and closes exactly once', () => {
    const { create } = fixture();
    const journal = create();
    journal.offer({ workId: 'w1', idempotencyKey: 'i1', owner: 'codexa', payload: { action: 'build' } });
    expect(journal.status('w1').state).toBe(CUSTODY_STATES.OFFERED);
    journal.persist({ workId: 'w1', owner: 'codexa', ownerEpoch: 1 });
    journal.start({ workId: 'w1', owner: 'codexa', ownerEpoch: 1 });
    const grant = journal.grantEffect({ workId: 'w1', owner: 'codexa', ownerEpoch: 1, effectId: 'write:artifact-a' });
    expect(grant.granted).toBe(true);
    expect(journal.grantEffect({ workId: 'w1', owner: 'codexa', ownerEpoch: 1, effectId: 'write:artifact-a' })).toMatchObject({ duplicate: true, granted: true, resumeIdempotently: true });
    expect(() => journal.terminal({ workId: 'w1', owner: 'codexa', ownerEpoch: 1, outcome: 'completed' })).toThrow('unresolved effects');
    journal.commitEffect({ workId: 'w1', owner: 'codexa', ownerEpoch: 1, effectId: 'write:artifact-a', evidence: { sha256: 'abc' } });
    journal.terminal({ workId: 'w1', owner: 'codexa', ownerEpoch: 1, outcome: 'completed', evidence: { sha256: 'abc' } });
    expect(journal.terminal({ workId: 'w1', owner: 'codexa', ownerEpoch: 1, outcome: 'completed' })).toMatchObject({ duplicate: true });
    expect(() => journal.terminal({ workId: 'w1', owner: 'codexa', ownerEpoch: 1, outcome: 'failed' })).toThrow('already ended as completed');
    expect(journal.verify()).toMatchObject({ ok: true, workItems: 1, terminal: 1 });
  });

  test('pre-start cancellation permanently denies start and effects', () => {
    const { create } = fixture('cancel-before');
    const journal = create();
    journal.offer({ workId: 'w2', idempotencyKey: 'i2', owner: 'n150' });
    journal.persist({ workId: 'w2', owner: 'n150', ownerEpoch: 1 });
    journal.requestCancel({ workId: 'w2', owner: 'n150', ownerEpoch: 1, reason: 'operator-cancel' });
    expect(journal.status('w2')).toMatchObject({ state: CUSTODY_STATES.TERMINAL, outcome: 'cancelled', effects: {} });
    expect(() => journal.start({ workId: 'w2', owner: 'n150', ownerEpoch: 1 })).toThrow(AELinkCustodyError);
    expect(() => journal.grantEffect({ workId: 'w2', owner: 'n150', ownerEpoch: 1, effectId: 'forbidden' })).toThrow('denied');
  });

  test('in-flight cancellation blocks new effects until cancelled terminal', () => {
    const { create } = fixture('cancel-running');
    const journal = create();
    journal.offer({ workId: 'w3', idempotencyKey: 'i3', owner: 'codexa' });
    journal.persist({ workId: 'w3', owner: 'codexa', ownerEpoch: 1 });
    journal.start({ workId: 'w3', owner: 'codexa', ownerEpoch: 1 });
    journal.requestCancel({ workId: 'w3', owner: 'codexa', ownerEpoch: 1 });
    expect(() => journal.grantEffect({ workId: 'w3', owner: 'codexa', ownerEpoch: 1, effectId: 'late-effect' })).toThrow('denied');
    expect(() => journal.terminal({ workId: 'w3', owner: 'codexa', ownerEpoch: 1, outcome: 'completed' })).toThrow('must close as cancelled');
    journal.terminal({ workId: 'w3', owner: 'codexa', ownerEpoch: 1, outcome: 'cancelled' });
    expect(journal.status('w3')).toMatchObject({ state: CUSTODY_STATES.TERMINAL, outcome: 'cancelled' });
  });

  test('handoff and recovery revoke stale owners by increasing epoch', () => {
    const { create } = fixture('epochs');
    const journal = create();
    journal.offer({ workId: 'w4', idempotencyKey: 'i4', owner: 'n150' });
    journal.persist({ workId: 'w4', owner: 'n150', ownerEpoch: 1 });
    journal.handoff({ workId: 'w4', fromOwner: 'n150', fromEpoch: 1, toOwner: 'codexa', toEpoch: 2 });
    expect(() => journal.start({ workId: 'w4', owner: 'n150', ownerEpoch: 1 })).toThrow('stale owner');
    journal.start({ workId: 'w4', owner: 'codexa', ownerEpoch: 2 });
    journal.grantEffect({ workId: 'w4', owner: 'codexa', ownerEpoch: 2, effectId: 'immutable-effect' });
    journal.recover({
      workId: 'w4',
      newOwner: 'codexa-restart',
      newEpoch: 3,
      orphanEvidence: { kind: 'lease-expired', leaseId: 'lease-w4' },
    });
    expect(() => journal.grantEffect({ workId: 'w4', owner: 'codexa', ownerEpoch: 2, effectId: 'late-old-owner' })).toThrow('stale owner');
    journal.start({ workId: 'w4', owner: 'codexa-restart', ownerEpoch: 3 });
    expect(journal.grantEffect({ workId: 'w4', owner: 'codexa-restart', ownerEpoch: 3, effectId: 'immutable-effect' })).toMatchObject({ duplicate: true, granted: true, resumeIdempotently: true });
    journal.commitEffect({ workId: 'w4', owner: 'codexa-restart', ownerEpoch: 3, effectId: 'immutable-effect', evidence: { result: 'same-idempotent-effect' } });
  });

  test('reopens from disk with effects and terminal truth intact', () => {
    const { create } = fixture('reopen');
    let journal = create();
    journal.offer({ workId: 'w5', idempotencyKey: 'i5', owner: 'codexa' });
    journal.persist({ workId: 'w5', owner: 'codexa', ownerEpoch: 1 });
    journal.start({ workId: 'w5', owner: 'codexa', ownerEpoch: 1 });
    journal.grantEffect({ workId: 'w5', owner: 'codexa', ownerEpoch: 1, effectId: 'publish:sha' });
    journal.commitEffect({ workId: 'w5', owner: 'codexa', ownerEpoch: 1, effectId: 'publish:sha', evidence: { sha256: '123' } });
    journal.terminal({ workId: 'w5', owner: 'codexa', ownerEpoch: 1, outcome: 'completed' });
    journal = create();
    expect(journal.status('w5')).toMatchObject({
      state: CUSTODY_STATES.TERMINAL,
      outcome: 'completed',
      effects: { 'publish:sha': { status: 'committed', evidence: { sha256: '123' } } },
    });
    expect(journal.verify().records).toBe(6);
  });

  test('fails closed when a durable transition is tampered', () => {
    const { create, filePath } = fixture('tamper');
    const journal = create();
    journal.offer({ workId: 'w6', idempotencyKey: 'i6', owner: 'n150', payload: { approved: false } });
    const record = JSON.parse(fs.readFileSync(filePath, 'utf8').trim());
    record.payload.approved = true;
    fs.writeFileSync(filePath, `${JSON.stringify(record)}\n`, 'utf8');
    expect(() => create()).toThrow(AELinkCustodyIntegrityError);
  });

  test('binds one idempotency key to one durable work item across restart', () => {
    const { create } = fixture('idempotency');
    let journal = create();
    const first = journal.offer({ workId: 'w7', idempotencyKey: 'shared-key', owner: 'n150' });
    expect(first.duplicate).toBe(false);
    journal = create();
    expect(journal.offer({ workId: 'w7', idempotencyKey: 'shared-key', owner: 'n150' })).toMatchObject({
      duplicate: true,
      work: { workId: 'w7', state: CUSTODY_STATES.OFFERED },
    });
    expect(() => journal.offer({
      workId: 'w7-conflict',
      idempotencyKey: 'shared-key',
      owner: 'n150',
    })).toThrow('already belongs to work w7');
  });

  test('restart recovery preserves cancellation and permits only effect drain', () => {
    const { create } = fixture('cancel-recovery');
    let journal = create();
    journal.offer({ workId: 'w8', idempotencyKey: 'i8', owner: 'codexa' });
    journal.persist({ workId: 'w8', owner: 'codexa', ownerEpoch: 1 });
    journal.start({ workId: 'w8', owner: 'codexa', ownerEpoch: 1 });
    journal.grantEffect({ workId: 'w8', owner: 'codexa', ownerEpoch: 1, effectId: 'write:in-flight' });
    journal.requestCancel({ workId: 'w8', owner: 'codexa', ownerEpoch: 1, reason: 'operator-stop' });

    journal = create();
    expect(() => journal.recover({
      workId: 'w8', newOwner: 'recovery', newEpoch: 2,
    })).toThrow('orphanEvidence is required');
    const recovered = journal.recover({
      workId: 'w8',
      newOwner: 'recovery',
      newEpoch: 2,
      orphanEvidence: { kind: 'lease-expired', leaseId: 'lease-w8' },
    });
    expect(recovered.work).toMatchObject({
      state: CUSTODY_STATES.CANCEL_REQUESTED,
      owner: 'recovery',
      ownerEpoch: 2,
      cancelReason: 'operator-stop',
    });
    expect(journal.recover({
      workId: 'w8',
      newOwner: 'recovery',
      newEpoch: 2,
      orphanEvidence: { kind: 'lease-expired', leaseId: 'lease-w8' },
    })).toMatchObject({ duplicate: true });
    expect(() => journal.start({ workId: 'w8', owner: 'recovery', ownerEpoch: 2 })).toThrow('cannot start');
    expect(() => journal.grantEffect({
      workId: 'w8', owner: 'recovery', ownerEpoch: 2, effectId: 'write:new',
    })).toThrow('denied');
    journal.abortEffect({
      workId: 'w8',
      owner: 'recovery',
      ownerEpoch: 2,
      effectId: 'write:in-flight',
      evidence: { reason: 'cancel-drain' },
    });
    journal.terminal({ workId: 'w8', owner: 'recovery', ownerEpoch: 2, outcome: 'cancelled' });
    expect(create().status('w8')).toMatchObject({
      state: CUSTODY_STATES.TERMINAL,
      outcome: 'cancelled',
      terminalResult: { outcome: 'cancelled' },
    });
  });

  test('serializes stale journal instances to exactly one terminal outcome', () => {
    const { create, filePath } = fixture('terminal-race');
    const winner = create();
    const stale = create();
    winner.offer({ workId: 'w9', idempotencyKey: 'i9', owner: 'codexa' });
    winner.persist({ workId: 'w9', owner: 'codexa', ownerEpoch: 1 });
    winner.start({ workId: 'w9', owner: 'codexa', ownerEpoch: 1 });

    winner.terminal({ workId: 'w9', owner: 'codexa', ownerEpoch: 1, outcome: 'completed' });
    expect(() => stale.terminal({
      workId: 'w9', owner: 'codexa', ownerEpoch: 1, outcome: 'failed',
    })).toThrow('already ended as completed');
    expect(stale.terminal({
      workId: 'w9', owner: 'codexa', ownerEpoch: 1, outcome: 'completed',
    })).toMatchObject({ duplicate: true });

    const records = fs.readFileSync(filePath, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
    expect(records.filter(({ toState }) => toState === CUSTODY_STATES.TERMINAL)).toHaveLength(1);
    expect(create().verify()).toMatchObject({ ok: true, terminal: 1 });
  });

  test('serializes cancel and start races against the durable head', () => {
    const cancelled = fixture('cancel-wins');
    const cancelWinner = cancelled.create();
    const staleStarter = cancelled.create();
    cancelWinner.offer({ workId: 'w11', idempotencyKey: 'i11', owner: 'codexa' });
    cancelWinner.persist({ workId: 'w11', owner: 'codexa', ownerEpoch: 1 });
    cancelWinner.requestCancel({ workId: 'w11', owner: 'codexa', ownerEpoch: 1 });
    expect(() => staleStarter.start({ workId: 'w11', owner: 'codexa', ownerEpoch: 1 })).toThrow('cannot start');
    expect(cancelled.create().status('w11')).toMatchObject({
      state: CUSTODY_STATES.TERMINAL,
      outcome: 'cancelled',
    });

    const started = fixture('start-wins');
    const startWinner = started.create();
    const staleCanceller = started.create();
    startWinner.offer({ workId: 'w12', idempotencyKey: 'i12', owner: 'codexa' });
    startWinner.persist({ workId: 'w12', owner: 'codexa', ownerEpoch: 1 });
    startWinner.start({ workId: 'w12', owner: 'codexa', ownerEpoch: 1 });
    staleCanceller.requestCancel({ workId: 'w12', owner: 'codexa', ownerEpoch: 1 });
    expect(started.create().status('w12')).toMatchObject({ state: CUSTODY_STATES.CANCEL_REQUESTED });
  });

  test('persists deterministic global and per-work journal linkage', () => {
    const { create, filePath } = fixture('linkage');
    const journal = create();
    journal.offer({ workId: 'w10', idempotencyKey: 'i10', owner: 'n150' });
    journal.persist({ workId: 'w10', owner: 'n150', ownerEpoch: 1 });
    journal.start({ workId: 'w10', owner: 'n150', ownerEpoch: 1 });
    journal.terminal({ workId: 'w10', owner: 'n150', ownerEpoch: 1, outcome: 'completed' });

    const records = fs.readFileSync(filePath, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
    records.forEach((record, index) => {
      expect(record.sequence).toBe(index + 1);
      expect(record.workRevision).toBe(index + 1);
      expect(record.previousHash).toBe(index === 0 ? '0'.repeat(64) : records[index - 1].hash);
      expect(record.previousWorkHash).toBe(index === 0 ? '0'.repeat(64) : records[index - 1].hash);
    });
    const verified = create().verify();
    expect(verified.workRoots.w10).toBe(records.at(-1).hash);
  });

  test('replays legacy v1 records and links new transitions onto their hashes', () => {
    const { create, filePath } = fixture('legacy-v1');
    const journal = create();
    journal.offer({ workId: 'w13', idempotencyKey: 'i13', owner: 'n150' });
    journal.persist({ workId: 'w13', owner: 'n150', ownerEpoch: 1 });

    const records = fs.readFileSync(filePath, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
    let previousHash = '0'.repeat(64);
    const legacy = records.map((record) => {
      const { hash: _hash, mac: _mac, workRevision: _workRevision, previousWorkHash: _previousWorkHash, ...body } = record;
      body.previousHash = previousHash;
      const hash = createHash('sha256').update(canonicalJson(body)).digest('hex');
      const migrated = { ...body, hash, mac: hmacHex({ ...body, hash }, 'test-only-custody-key') };
      previousHash = hash;
      return migrated;
    });
    fs.writeFileSync(filePath, `${legacy.map(canonicalJson).join('\n')}\n`, 'utf8');

    const reopened = create();
    expect(reopened.status('w13')).toMatchObject({ state: CUSTODY_STATES.PERSISTED, revision: 2 });
    const started = reopened.start({ workId: 'w13', owner: 'n150', ownerEpoch: 1 });
    expect(started.record).toMatchObject({
      workRevision: 3,
      previousWorkHash: legacy.at(-1).hash,
    });
    expect(reopened.verify().ok).toBe(true);
  });
});
