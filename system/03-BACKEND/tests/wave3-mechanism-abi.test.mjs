import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  WAVE3_MECHANISMS,
  WAVE3_MECHANISM_ABI,
  WAVE3_NON_NEGOTIABLE_IDS,
  compileWave3Kernel,
} from '../wave3-intelligent-kernel.mjs';
import { buildWave3KernelCoverage } from '../wave3-kernel-coverage.mjs';
import {
  createWave3HandoffCapsule,
  verifyWave3HandoffCapsule,
} from '../wave3-handoff-capsule.mjs';
import { resolveWave3Constitution } from '../wave3-mechanism-abi.mjs';
import { compileProblem } from '../problem-compiler.mjs';

describe('Wave 3 executable mechanism kernel', () => {
  test('all 100 mechanisms expose the complete executable ABI', () => {
    expect(WAVE3_MECHANISMS).toHaveLength(100);
    expect(WAVE3_MECHANISM_ABI.size).toBe(100);
    for (const mechanism of WAVE3_MECHANISMS) {
      const adapter = WAVE3_MECHANISM_ABI.get(mechanism.id);
      expect(adapter.descriptor.mechanismId).toBe(mechanism.id);
      for (const method of ['select', 'preflight', 'enforce', 'observe', 'falsify', 'settle', 'rollback']) {
        expect(typeof adapter[method]).toBe('function');
      }
    }
  });

  test('task compiler wakes a sparse coherent constellation and preserves constitutional laws', () => {
    const kernel = compileWave3Kernel({
      workId: 'work-memory-compression',
      objective: 'Build source-backed semantic memory with exact evidence compression and AtomSmasher hydration',
      constraints: ['never lose source truth'],
    });
    expect(kernel.activeMechanismIds.length).toBeGreaterThanOrEqual(WAVE3_NON_NEGOTIABLE_IDS.length);
    expect(kernel.activeMechanismIds.length).toBeLessThanOrEqual(24);
    expect(kernel.sleepingMechanismCount).toBeGreaterThan(70);
    expect(WAVE3_NON_NEGOTIABLE_IDS.every((id) => kernel.activeMechanismIds.includes(id))).toBe(true);
    expect(kernel.activeMechanismIds).toContain('W3K-008');
    expect(kernel.activeMechanismIds).toContain('W3K-080');
    expect(kernel.obligations).toHaveLength(kernel.activeMechanismIds.length);
    expect(kernel.constitution.resolutionHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('inherited active laws cannot silently disappear under a smaller workset budget', () => {
    const parent = compileWave3Kernel({ workId: 'parent', objective: 'Preserve ChatBackup and Party Line continuity' });
    const child = compileWave3Kernel(
      { workId: 'child', objective: 'format one report' },
      { inheritedKernel: parent, maxMechanisms: 12 },
    );
    expect(parent.activeMechanismIds.every((id) => child.activeMechanismIds.includes(id))).toBe(true);
    expect(child.selection.find(({ mechanismId }) => mechanismId === 'W3K-081')?.reason).toBe('inherited_active_law');
  });

  test('constitution prefers operator authority and preserves equal-tier conflict', () => {
    const resolution = resolveWave3Constitution([
      { mechanismId: 'optimization', authority: 'optimization', stage: 'route', resource: 'model', directive: 'cheap' },
      { mechanismId: 'operator', authority: 'operator_authority', stage: 'route', resource: 'model', directive: 'capable' },
      { mechanismId: 'operator-peer', authority: 'operator_authority', stage: 'route', resource: 'model', directive: 'private' },
    ]);
    expect(resolution.orderedMechanismIds[0]).toBe('operator');
    expect(resolution.conflicts).toContainEqual(expect.objectContaining({
      left: 'operator', right: 'optimization', resolution: 'prefer:operator',
    }));
    expect(resolution.conflicts).toContainEqual(expect.objectContaining({
      left: 'operator', right: 'operator-peer', resolution: 'unresolved_equal_authority',
    }));
    expect(resolution.unresolvedConflictCount).toBe(1);
  });

  test('handoff capsule is deterministic, tamper evident, and carries the kernel', () => {
    const workObject = compileProblem({
      orderId: 'order-handoff',
      intent: 'Implement memory with source evidence',
      constraints: ['no fake green'],
      acceptance: ['receipt exists'],
    }, { project: 'orange', authority: 'operator', owner: 'navigator' });
    const input = {
      workObject,
      order: { orderId: 'order-handoff', scope: 'orange', riskLevel: 'medium', requiresReceipt: true },
      route: { lane: 'local-reflex', model: 'navigator', decision_id: 'route-1' },
      evidencePointers: ['source:one'],
    };
    const first = createWave3HandoffCapsule(input);
    const second = createWave3HandoffCapsule(input);
    expect(second.capsuleHash).toBe(first.capsuleHash);
    expect(first.kernel.activeMechanismIds.length).toBeGreaterThan(0);
    expect(verifyWave3HandoffCapsule(first).ok).toBe(true);
    expect(verifyWave3HandoffCapsule({ ...first, objective: 'tampered' }).ok).toBe(false);
  });

  test('coverage refuses to call ABI presence proof', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orange-wave3-coverage-'));
    const coverage = buildWave3KernelCoverage({ projectRoot: root, ledgerPath: path.join(root, 'empty-ledger.jsonl') });
    expect(coverage.counts).toEqual({ mechanisms: 100, abiComplete: 100, provenActive: 0, notProven: 100 });
    expect(coverage.honestGreen).toBe(false);
    expect(coverage.records.every(({ proofStatus }) => proofStatus === 'NOT_PROVEN')).toBe(true);
  });
});
