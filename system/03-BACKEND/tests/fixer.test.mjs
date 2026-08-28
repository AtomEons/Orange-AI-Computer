import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';

setDefaultTimeout(30_000);
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FixerStore } from '../fixer.mjs';
import { readPartyLine } from '../../04-CONTROL-PLANE/party-line/ledger.mjs';

const roots = [];
const fixture = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orange5-fixer-'));
  roots.push(root);
  return {
    root,
    dbPath: path.join(root, 'fixer.sqlite'),
    partyLinePath: path.join(root, 'party-line.jsonl'),
  };
};

const writeRegressionArtifact = (root, name = 'regression-result.json') => {
  const artifactPath = path.join(root, name);
  fs.writeFileSync(artifactPath, `${JSON.stringify({ schema: 'orange.regression.result.v1', passed: true })}\n`);
  return artifactPath;
};

const writeReceipt = (root, { name = 'receipt.json', status = 'ok', evidence = [{ type: 'verification', ok: true }], blockers = [] } = {}) => {
  const receiptPath = path.join(root, name);
  fs.writeFileSync(receiptPath, `${JSON.stringify({
    schema: 'orange5.receipt.v0',
    receipt_id: path.basename(name, '.json'),
    generated_at: new Date().toISOString(),
    actor: 'fixer-test',
    status,
    confidence: 1,
    hash_chain: 1,
    prior_receipt: null,
    evidence,
    blockers,
  })}\n`);
  return receiptPath;
};

afterEach(async () => {
  while (roots.length) {
    const root = roots.pop();
    let lastError = null;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        fs.rmSync(root, { recursive: true, force: true });
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        Bun.gc(true);
        await Bun.sleep(50);
      }
    }
    if (lastError) throw lastError;
  }
});

async function advanceToLeased(store, defectId) {
  await store.transition(defectId, 'reproduced', { reproducer: { command: ['probe'], observed: 'down' } });
  await store.transition(defectId, 'isolated', { suspectedBoundary: 'brain-mcp owned service' });
  await store.transition(defectId, 'repair_planned', {
    repairOrder: { schema: 'orange.order.v1', action: 'process.run' },
    rollback: { command: ['runtime-services', 'stop', 'brain-mcp'] },
  });
  await store.transition(defectId, 'leased', { hermesLease: { id: 'lease-test', gates: 8 } });
}

async function advanceToExactPathVerified(store, defectId) {
  await advanceToLeased(store, defectId);
  await store.transition(defectId, 'patched', { evidence: [{ type: 'execution', ok: true }] });
  await store.transition(defectId, 'exact_path_verified', { evidence: [{ type: 'exact_path_verification', ok: true }] });
}

async function advanceToRegressionEncoded(store, defectId, regressionPath) {
  await advanceToExactPathVerified(store, defectId);
  await store.transition(defectId, 'regression_encoded', { regression: { path: regressionPath, passed: true } });
}

async function advanceToClose(store, defectId, regressionPath, receiptPath) {
  await advanceToRegressionEncoded(store, defectId, regressionPath);
  return store.transition(defectId, 'closed', { receiptPath });
}

describe('OrangeFive Fixer', () => {
  test('persists the exact lifecycle with a verifiable event hash chain and Party Line events', async () => {
    const { root, dbPath, partyLinePath } = fixture();
    const store = new FixerStore(dbPath, { partyLinePath });
    const created = await store.createCase({
      defectId: 'fix-001', runId: 'run-001', source: 'live-health', severity: 'high',
      evidence: [{ type: 'health', ok: false }],
    });
    expect(created.state).toBe('detected');
    const regressionPath = writeRegressionArtifact(root);
    const receiptPath = writeReceipt(root);
    const closed = await advanceToClose(store, 'fix-001', regressionPath, receiptPath);
    expect(closed.state).toBe('closed');
    expect(store.verifyCase('fix-001')).toMatchObject({ ok: true, state: 'closed', events: 9 });
    store.close();

    const reopened = new FixerStore(dbPath, { partyLinePath, publish: false });
    expect(reopened.getCase('fix-001')).toMatchObject({ state: 'closed', receiptPath });
    expect(reopened.verifyCase('fix-001').ok).toBe(true);
    reopened.close();
    const party = await readPartyLine({ filePath: partyLinePath, detail: 'wire', limit: 20, tail: false });
    expect(party.events).toHaveLength(9);
    expect(party.chain.ok).toBe(true);
    expect(party.events.at(-1)).toMatchObject({ actor: { id: 'orange-fixer' }, eventType: 'receipt', status: 'closed' });
  });

  test('refuses state skipping and closure without exact proof fields', async () => {
    const { dbPath, partyLinePath } = fixture();
    const store = new FixerStore(dbPath, { partyLinePath });
    await store.createCase({ defectId: 'fix-002', runId: 'run-002', source: 'test', severity: 'medium' });
    await expect(store.transition('fix-002', 'isolated', { suspectedBoundary: 'x' })).rejects.toThrow('invalid Fixer transition');
    await expect(store.transition('fix-002', 'reproduced')).rejects.toThrow('requires a reproducer');
    store.close();
  });

  test('patched rejects stale, failed, and non-repair evidence', async () => {
    const { dbPath } = fixture();
    const store = new FixerStore(dbPath, { publish: false });
    await store.createCase({
      defectId: 'fix-patched-guard', runId: 'run-patched-guard', source: 'test', severity: 'high',
      evidence: [{ type: 'execution', ok: true }],
    });
    await advanceToLeased(store, 'fix-patched-guard');

    await expect(store.transition('fix-patched-guard', 'patched')).rejects.toThrow('successful fresh repair evidence');
    await expect(store.transition('fix-patched-guard', 'patched', {
      evidence: [{ type: 'governed_repair_execution', ok: false }],
    })).rejects.toThrow('successful fresh repair evidence');
    await expect(store.transition('fix-patched-guard', 'patched', {
      evidence: [{ type: 'note', ok: true }],
    })).rejects.toThrow('successful fresh repair evidence');
    expect(store.getCase('fix-patched-guard').state).toBe('leased');
    store.close();
  });

  test('regression_encoded rejects missing or failed regression artifacts', async () => {
    const { root, dbPath } = fixture();
    const store = new FixerStore(dbPath, { publish: false });
    await store.createCase({ defectId: 'fix-regression-guard', runId: 'run-regression-guard', source: 'test', severity: 'high' });
    await advanceToExactPathVerified(store, 'fix-regression-guard');

    await expect(store.transition('fix-regression-guard', 'regression_encoded', {
      regression: { path: path.join(root, 'missing-result.json'), passed: true },
    })).rejects.toThrow('existing nonempty regression artifact');
    const artifactPath = writeRegressionArtifact(root);
    await expect(store.transition('fix-regression-guard', 'regression_encoded', {
      regression: { path: artifactPath, passed: false },
    })).rejects.toThrow('passed=true');
    expect(store.getCase('fix-regression-guard').state).toBe('exact_path_verified');
    store.close();
  });

  test('closed rejects missing, malformed, and unsuccessful receipts', async () => {
    const { root, dbPath } = fixture();
    const store = new FixerStore(dbPath, { publish: false });
    await store.createCase({ defectId: 'fix-closure-guard', runId: 'run-closure-guard', source: 'test', severity: 'critical' });
    await advanceToRegressionEncoded(store, 'fix-closure-guard', writeRegressionArtifact(root));

    await expect(store.transition('fix-closure-guard', 'closed', {
      receiptPath: path.join(root, 'missing-receipt.json'),
    })).rejects.toThrow('existing valid receipt with success evidence');
    const malformedPath = path.join(root, 'malformed-receipt.json');
    fs.writeFileSync(malformedPath, '{not-json}\n');
    await expect(store.transition('fix-closure-guard', 'closed', { receiptPath: malformedPath }))
      .rejects.toThrow('existing valid receipt with success evidence');
    const failedReceiptPath = writeReceipt(root, {
      name: 'failed-receipt.json',
      status: 'failed',
      evidence: [{ type: 'verification', ok: false }],
    });
    await expect(store.transition('fix-closure-guard', 'closed', { receiptPath: failedReceiptPath }))
      .rejects.toThrow('existing valid receipt with success evidence');
    const emptyEvidencePath = writeReceipt(root, { name: 'empty-evidence-receipt.json', evidence: [] });
    await expect(store.transition('fix-closure-guard', 'closed', { receiptPath: emptyEvidencePath }))
      .rejects.toThrow('existing valid receipt with success evidence');
    expect(store.getCase('fix-closure-guard').state).toBe('regression_encoded');
    store.close();
  });

  test('two same-method failures force a changed repair method', async () => {
    const { dbPath } = fixture();
    const store = new FixerStore(dbPath, { publish: false });
    await store.createCase({ defectId: 'fix-003', runId: 'run-003', source: 'test', severity: 'low' });
    expect(store.recordAttempt('fix-003', { cause: 'port-down', method: 'restart', succeeded: false }).changedMethodRequired).toBe(false);
    expect(store.recordAttempt('fix-003', { cause: 'port-down', method: 'restart', succeeded: false }).changedMethodRequired).toBe(true);
    expect(() => store.recordAttempt('fix-003', { cause: 'port-down', method: 'restart', succeeded: false })).toThrow('blind retry refused');
    expect(store.recordAttempt('fix-003', { cause: 'port-down', method: 'rebind', succeeded: true }).attempts).toBe(3);
    expect(store.getCase('fix-003').attempts).toBe(3);
    expect(store.verifyCase('fix-003').ok).toBe(true);
    store.close();
  });

  test('ranks unresolved critical cases ahead of low severity cases', async () => {
    const { dbPath } = fixture();
    const store = new FixerStore(dbPath, { publish: false });
    await store.createCase({ defectId: 'fix-low', runId: 'run-low', source: 'test', severity: 'low' });
    await store.createCase({ defectId: 'fix-critical', runId: 'run-critical', source: 'test', severity: 'critical' });
    expect(store.listCases().map((item) => item.defectId)).toEqual(['fix-critical', 'fix-low']);
    store.close();
  });
});
