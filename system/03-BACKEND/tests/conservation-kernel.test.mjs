import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  beginConservationState,
  commitConservationTransition,
  evaluateConservationTransition,
  verifyConservationLedger,
} from '../conservation-kernel.mjs';
import { beginSolarWave, routeSolarWave, settleSolarWave } from '../solar-wave.mjs';

const roots = [];

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orange-conservation-'));
  roots.push(root);
  return {
    root,
    ledgerPath: path.join(root, 'conservation.jsonl'),
    solarPath: path.join(root, 'solar.jsonl'),
    work: {
      workId: 'work-kernel-proof',
      objective: 'preserve scope while completing the requested artifact',
      commitments: ['produce the artifact', 'report exact evidence'],
      constraints: ['no fake green'],
      forbidden: ['silent scope reduction'],
      acceptance: ['artifact exists', 'proof is attributable'],
      project: 'orange5',
      compilationHash: 'f'.repeat(64),
    },
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('Conservation Kernel', () => {
  test('rejects manufactured authority', () => {
    const { work, ledgerPath } = fixture();
    const begun = beginConservationState({ work, orderId: 'order-1' }, { ledgerPath });
    const result = evaluateConservationTransition(begun.state, {
      phase: 'COMPILED',
      actor: 'model',
      authority: 'operator',
    });
    expect(result.ok).toBe(false);
    expect(result.decision.violations.map((item) => item.code)).toContain('AUTHORITY_ESCALATION');
  });

  test('rejects confidence inflation and uncertainty erasure without evidence', () => {
    const { work, ledgerPath } = fixture();
    const begun = beginConservationState({ work, orderId: 'order-2' }, { ledgerPath });
    const result = evaluateConservationTransition(begun.state, {
      phase: 'COMPILED',
      actor: 'orangebrain',
      confidence: 0.9,
      uncertainty: 0.1,
    });
    expect(result.ok).toBe(false);
    expect(result.decision.violations.map((item) => item.code)).toEqual(expect.arrayContaining([
      'CONFIDENCE_WITHOUT_EVIDENCE',
      'UNCERTAINTY_ERASED_WITHOUT_OBSERVATION',
    ]));
  });

  test('rejects semantic drift without an operator amendment', () => {
    const { work, ledgerPath } = fixture();
    const begun = beginConservationState({ work, orderId: 'order-3' }, { ledgerPath });
    const result = evaluateConservationTransition(begun.state, {
      phase: 'COMPILED',
      actor: 'orangebrain',
      work: { ...work, forbidden: [] },
    });
    expect(result.ok).toBe(false);
    expect(result.decision.violations.map((item) => item.code)).toContain('SEMANTIC_DRIFT');
  });

  test('requires explicit monotonic custody transfer', () => {
    const { work, ledgerPath } = fixture();
    const begun = beginConservationState({ work, orderId: 'order-4' }, { ledgerPath });
    const invalid = evaluateConservationTransition(begun.state, {
      phase: 'COMPILED', actor: 'orangebrain', owner: 'hermes',
    });
    expect(invalid.ok).toBe(false);
    expect(invalid.decision.violations.map((item) => item.code)).toContain('OWNER_CHANGED_WITHOUT_TRANSFER');

    const valid = evaluateConservationTransition(begun.state, {
      phase: 'COMPILED',
      actor: 'orangebrain',
      custodyTransfer: { from: 'orangebrain', to: 'hermes', epoch: 1, status: 'OFFERED' },
    });
    expect(valid.ok).toBe(true);
    expect(valid.state.custody).toMatchObject({ owner: 'hermes', epoch: 1 });
  });

  test('commits one terminal outcome and hash-chains decisions', () => {
    const { work, ledgerPath } = fixture();
    let current = beginConservationState({ work, orderId: 'order-5' }, { ledgerPath }).state;
    for (const phase of ['COMPILED', 'ROUTED', 'OFFERED', 'PERSISTED', 'STARTED', 'OBSERVED', 'VERIFIED']) {
      const committed = commitConservationTransition(current, {
        phase,
        actor: 'orangebrain',
        evidence: phase === 'OBSERVED' ? [{ source: 'runtime:test', hash: 'a'.repeat(64) }] : [],
        verifiedOutcome: phase === 'VERIFIED',
      }, { ledgerPath });
      expect(committed.ok).toBe(true);
      current = committed.state;
    }
    const terminal = commitConservationTransition(current, {
      phase: 'TERMINAL',
      actor: 'orangebrain',
      verifiedOutcome: true,
      evidence: [{ source: 'receipt:test', hash: 'b'.repeat(64) }],
      outcome: { status: 'completed', artifact: 'artifact:test' },
    }, { ledgerPath });
    expect(terminal.ok).toBe(true);
    expect(terminal.state.terminal.committed).toBe(true);

    const duplicate = commitConservationTransition(terminal.state, {
      phase: 'TERMINAL',
      actor: 'orangebrain',
      verifiedOutcome: true,
      evidence: [{ source: 'receipt:test-2', hash: 'c'.repeat(64) }],
      outcome: { status: 'completed' },
    }, { ledgerPath });
    expect(duplicate.ok).toBe(false);
    expect(duplicate.decision.violations.map((item) => item.code)).toContain('TERMINAL_ALREADY_COMMITTED');
    expect(verifyConservationLedger(ledgerPath)).toMatchObject({ ok: true, events: 10 });
  });

  test('guards a complete Solar Wave lifecycle', () => {
    const { solarPath } = fixture();
    const wave = beginSolarWave({
      orderId: 'order-solar',
      action: 'read.status',
      intent: 'report governed system status',
      targetProject: 'orange5',
      allowedActions: ['read.status'],
      forbiddenActions: ['mutate.system'],
      riskLevel: 'low',
    }, { ledgerPath: solarPath });
    routeSolarWave(wave, { lane: 'reflex', model: 'deterministic', latencyMs: 5 });
    const terminal = settleSolarWave(wave, {
      status: 'completed',
      lane: 'reflex',
      model: 'deterministic',
      latencyMs: 4,
      report: { status: 'completed', evidence: [{ source: 'probe:health', hash: 'd'.repeat(64) }], blockers: [] },
      receipt: { receipt_id: 'receipt-solar', hash: 'e'.repeat(64) },
    });
    expect(terminal.state).toBe('TERMINAL');
    expect(terminal.conservation.decision.accepted).toBe(true);
    expect(terminal.conservation.state.terminal.committed).toBe(true);
    expect(verifyConservationLedger(`${solarPath}.conservation.jsonl`).ok).toBe(true);
  });
});
