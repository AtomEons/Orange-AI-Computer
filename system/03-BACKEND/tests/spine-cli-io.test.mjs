import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { compileCliGovernance } from '../spine-cli.mjs';

const temp = mkdtempSync(join(tmpdir(), 'orange5-spine-cli-'));
const cli = resolve(import.meta.dir, '..', 'spine-cli.mjs');
const order = JSON.stringify({ action: 'read.status', payload: { target: 'all' } });

afterAll(() => rmSync(temp, { recursive: true, force: true }));

describe('OrangeFive spine CLI input', () => {
  test('compiles the exact orange.order.v1 policy into the spine lease', () => {
    const governance = compileCliGovernance({
      action: 'deploy.release',
      allowedActions: ['deploy.release', 'read.status'],
      forbiddenActions: ['filesystem.delete', 'scope.expand'],
      targetProject: 'OrangeFive',
      riskLevel: 'production',
      requiresApproval: false,
      requiresHumanApproval: false,
      operatorApproved: true,
    }, 'lease-policy-proof');

    expect(governance).toEqual({
      lease: {
        id: 'lease-policy-proof',
        allowed: ['deploy.release', 'read.status'],
        forbidden: ['filesystem.delete', 'scope.expand'],
        targetProject: 'OrangeFive',
        riskLevel: 'production',
        requires_approval: true,
      },
      hasHumanApproval: true,
    });
  });

  test('fails closed when allowed and forbidden actions intersect', () => {
    expect(() => compileCliGovernance({
      action: 'system.delete',
      allowedActions: ['system.delete'],
      forbiddenActions: ['system.delete'],
      riskLevel: 'destructive',
    })).toThrow('lease conflict');
  });

  test('accepts an order file without shell quoting', () => {
    const orderFile = join(temp, 'order.json');
    writeFileSync(orderFile, order);
    const result = Bun.spawnSync([process.execPath, cli, '--order-file', orderFile, '--dry-run']);
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout.toString());
    expect(output.status).toBe('planned');
    expect(output.plan.lane).toBe('reflex');
    expect(output.plan.would_execute).toBe(true);
    expect(output.receipt).toBeNull();
  });

  test('accepts piped JSON for PowerShell-safe operation', () => {
    const result = Bun.spawnSync([process.execPath, cli, '--dry-run'], {
      stdin: Buffer.from(order),
    });
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout.toString());
    expect(output.status).toBe('planned');
    expect(output.plan.lane).toBe('reflex');
    expect(output.plan.would_execute).toBe(true);
    expect(output.receipt).toBeNull();
  });

  test('CLI rejects a conflicting lease before planning or writing', () => {
    const conflictingOrder = JSON.stringify({
      schema: 'orange.order.v1',
      orderId: 'cli-conflict-proof',
      action: 'system.delete',
      intent: 'prove conflict refusal',
      scope: 'orange5.runtime',
      allowedActions: ['system.delete'],
      forbiddenActions: ['system.delete'],
      targetProject: 'OrangeFive',
      riskLevel: 'destructive',
      requiresReceipt: true,
      operatorApproved: true,
    });
    const result = Bun.spawnSync([process.execPath, cli, '--dry-run'], {
      stdin: Buffer.from(conflictingOrder),
    });
    expect(result.exitCode).toBe(2);
    expect(result.stdout.toString()).toBe('');
    expect(result.stderr.toString()).toContain('lease conflict');
  });

  test('CLI forwards risk and operator approval into the spine crossing', () => {
    const highRiskOrder = {
      schema: 'orange.order.v1',
      orderId: 'cli-approval-proof',
      action: 'read.status',
      intent: 'prove approval propagation',
      scope: 'orange5.runtime',
      allowedActions: ['read.status'],
      forbiddenActions: ['system.delete'],
      targetProject: 'OrangeFive',
      riskLevel: 'high',
      requiresReceipt: false,
    };
    const unapproved = Bun.spawnSync([process.execPath, cli, '--dry-run'], {
      stdin: Buffer.from(JSON.stringify(highRiskOrder)),
    });
    const approved = Bun.spawnSync([process.execPath, cli, '--dry-run'], {
      stdin: Buffer.from(JSON.stringify({ ...highRiskOrder, operatorApproved: true })),
    });

    expect(unapproved.exitCode).toBe(0);
    expect(approved.exitCode).toBe(0);
    const unapprovedPlan = JSON.parse(unapproved.stdout.toString()).plan;
    const approvedPlan = JSON.parse(approved.stdout.toString()).plan;
    expect(unapprovedPlan.procedural_gates_pass).toBe(false);
    expect(unapprovedPlan.gate_first_fail).toBe('human_approval');
    expect(unapprovedPlan.would_execute).toBe(false);
    expect(approvedPlan.procedural_gates_pass).toBe(true);
    expect(approvedPlan.gate_first_fail).not.toBe('human_approval');
  });
});
