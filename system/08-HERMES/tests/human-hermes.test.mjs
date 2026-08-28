import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { HUMAN_HERMES_PHASES, runHumanHermes } from '../src/human-hermes.mjs';

const temporaryRoots = [];
afterEach(() => {
  while (temporaryRoots.length) fs.rmSync(temporaryRoots.pop(), { recursive: true, force: true });
});

function order(verb = 'desktop.screenshot') {
  return {
    schema: 'orange.order.v1',
    orderId: 'human-order-1',
    intent: 'Observe the current application and report evidence',
    scope: 'orange.test',
    targetProject: 'orange.test',
    allowedActions: [verb],
    forbiddenActions: [],
    riskLevel: verb === 'desktop.screenshot' ? 'low' : 'medium',
    requiresReceipt: true,
    payload: { humanAction: { verb, args: verb === 'desktop.left_click' ? { x: 10, y: 20 } : {} } },
  };
}

function broker(log) {
  return {
    mint: async ({ action, riskLevel }) => {
      log.push(['mint', action, riskLevel]);
      return {
        id: 'lease-human-1',
        allowed: [action],
        forbidden: [],
        riskLevel,
        targetProject: 'orange.test',
        expires_at: Date.now() + 60_000,
      };
    },
    revoke: async (lease) => { log.push(['revoke', lease.id]); return true; },
  };
}

describe('Human Hermes governed machine operator', () => {
  test('proposal mode performs no lease or computer action', async () => {
    const events = [];
    const report = await runHumanHermes({ order: order(), execute: false }, {
      leaseBroker: broker(events),
      actionAdapters: { 'desktop.screenshot': async () => { throw new Error('must not execute'); } },
    });
    expect(report.status).toBe('awaiting_approval');
    expect(events).toEqual([]);
    expect(report.phaseTrace.map(({ phase }) => phase)).toEqual(HUMAN_HERMES_PHASES);
    expect(report.phaseTrace.find(({ phase }) => phase === 'ACT').status).toBe('not_started');
  });

  test('mutating action fails closed without explicit operator approval', async () => {
    let calls = 0;
    const report = await runHumanHermes({ order: order('desktop.left_click'), execute: true }, {
      leaseBroker: broker([]),
      actionAdapters: { 'desktop.left_click': async () => { calls++; return { ok: true }; } },
    });
    expect(report.status).toBe('failed');
    expect(report.blockers[0]).toContain('requires explicit operator approval');
    expect(calls).toBe(0);
    expect(report.custody.leaseId).toBeNull();
  });

  test('read-only visual action follows the full custody lifecycle and emits a receipt', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orange-human-hermes-'));
    temporaryRoots.push(root);
    const receiptPath = path.join(root, 'human-hermes-report.json');
    const events = [];
    const report = await runHumanHermes({ order: order(), execute: true, receiptPath }, {
      leaseBroker: broker(events),
      actionAdapters: {
        'desktop.screenshot': async ({ lease, actor }) => ({
          ok: true,
          status: 'completed',
          lease_id: lease.id,
          actor,
          receipt_path: 'receipt://computer-use-1',
          image_sha256: 'a'.repeat(64),
        }),
      },
    });
    expect(report.status).toBe('completed');
    expect(report.custody).toEqual({ leaseId: 'lease-human-1', leaseRevoked: true, exactlyOneTerminalOutcome: true });
    expect(events).toEqual([
      ['mint', 'desktop.screenshot', 'low'],
      ['revoke', 'lease-human-1'],
    ]);
    expect(report.phaseTrace.map(({ phase }) => phase)).toEqual(HUMAN_HERMES_PHASES);
    expect(report.phaseTrace.every(({ eventHash }) => /^[0-9a-f]{64}$/.test(eventHash))).toBe(true);
    expect(report.handoffCapsule.capsuleHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(fs.readFileSync(receiptPath, 'utf8')).reportHash).toBe(report.reportHash);
  });

  test('invalid or ungranted action is rejected before any phase begins', async () => {
    const invalid = order();
    invalid.allowedActions = [];
    await expect(runHumanHermes({ order: invalid, execute: true })).rejects.toThrow('not present in order.allowedActions');
  });
});
