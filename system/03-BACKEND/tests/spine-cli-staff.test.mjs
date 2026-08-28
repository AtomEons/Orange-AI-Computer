import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import {
  compileAeStaffCrew,
  getAeStaffHealth,
  listAeStaff,
  resolveStaffCliCommand,
  submitExplicitStaffOrder,
} from '../spine-cli.mjs';

const cli = resolve(import.meta.dir, '..', 'spine-cli.mjs');

describe('AE Staff spine CLI', () => {
  test('resolves ergonomic subcommands and flag aliases without changing ordinary orders', () => {
    expect(resolveStaffCliCommand(['staff', 'list'])).toBe('list');
    expect(resolveStaffCliCommand(['staff', 'compile'])).toBe('crew');
    expect(resolveStaffCliCommand(['--staff-health'])).toBe('health');
    expect(resolveStaffCliCommand(['--staff-order'])).toBe('order');
    expect(resolveStaffCliCommand(['--order', '{"action":"read.status"}'])).toBeNull();
    expect(() => resolveStaffCliCommand(['staff', 'unknown'])).toThrow('list, crew, health, order');
  });

  test('shows the complete 50-role AE Staff roster', async () => {
    const result = await listAeStaff();
    expect(result.schema).toBe('orange.ae-staff-list.v1');
    expect(result.ok).toBeTrue();
    expect(result.roleCount).toBe(50);
    expect(new Set(result.roles.map((role) => role.id)).size).toBe(50);
    expect(result.roles.find((role) => role.id === 'orange-hermes-navigator')?.archetype).toBe('navigator');
    expect(result.roles.find((role) => role.id === 'release-acceptance-operator')?.archetype).toBe('human-operator');
  });

  test('compiles a bounded staff crew with role contracts', async () => {
    const crew = await compileAeStaffCrew({
      action: 'build.feature',
      intent: 'Build and test a Bun MCP gateway integration',
      maxAgents: 4,
    });
    expect(crew.schema).toBe('orange.ae-staff-crew.v1');
    expect(crew.roles).toContain('integration-engineer');
    expect(crew.roles).toContain('product-systems-builder');
    expect(crew.roles.length).toBeLessThanOrEqual(4);
    expect(crew.roleContracts).toHaveLength(crew.roles.length);
    expect(crew.invariants.permanentMiddleManagers).toBe(0);
  });

  test('reports proven service health and preserves the service observation', async () => {
    const result = await getAeStaffHealth({
      url: 'http://staff.test:18643/',
      fetchFn: async (endpoint, options) => {
        expect(endpoint).toBe('http://staff.test:18643/health');
        expect(options.headers.accept).toBe('application/json');
        return Response.json({
          schema: 'orange.hermes-staff-reactor.v1',
          ok: true,
          status: 'LIVE',
          roleCount: 50,
          readyCount: 49,
          runningCount: 1,
          queuedCount: 0,
          authenticated: true,
        });
      },
    });
    expect(result).toMatchObject({
      schema: 'orange.ae-staff-health-report.v1',
      ok: true,
      status: 'LIVE',
      httpStatus: 200,
      roleCount: 50,
      readyCount: 49,
      runningCount: 1,
      authenticated: true,
      error: null,
    });
    expect(result.service.schema).toBe('orange.hermes-staff-reactor.v1');
  });

  test('reports an unreachable staff service without a false green', async () => {
    const result = await getAeStaffHealth({
      url: 'http://staff.test:18643',
      fetchFn: async () => { throw new Error('connection refused'); },
    });
    expect(result.ok).toBeFalse();
    expect(result.status).toBe('UNREACHABLE');
    expect(result.httpStatus).toBe(0);
    expect(result.roleCount).toBeNull();
    expect(result.error).toContain('AE Staff GET /health failed: connection refused');
  });

  test('requires named staff and submits through the canonical MCP staff client', async () => {
    await expect(submitExplicitStaffOrder({
      action: 'build.feature',
      intent: 'Build a focused feature',
    }, { staffClient: { order: async () => ({}) } })).rejects.toThrow('explicit staffRoles or targetRoles');

    let call;
    const order = {
      schema: 'orange.order.v1',
      orderId: 'staff-cli-test-1',
      action: 'build.feature',
      intent: 'Build and independently test a focused feature',
      requiresReceipt: true,
    };
    const result = await submitExplicitStaffOrder({
      order,
      targetRoles: ['integration-engineer', 'test-harness-engineer'],
      sourceRefs: ['receipt:test-input'],
    }, {
      staffClient: {
        order: async (args) => {
          call = args;
          return { schema: 'orange.ae-staff-mcp-dispatch.v1', ok: true, status: 'completed' };
        },
      },
    });

    expect(call.order).toEqual(order);
    expect(call.targetRoles).toEqual(['integration-engineer', 'test-harness-engineer']);
    expect(call.sourceRefs).toEqual(['receipt:test-input']);
    expect(result).toMatchObject({
      schema: 'orange.ae-staff-order-result.v1',
      ok: true,
      path: 'ae_staff_order',
      targetRoles: ['integration-engineer', 'test-harness-engineer'],
    });
  });

  test('emits command-level JSON for roster, crew, and validation failures', () => {
    const listed = Bun.spawnSync([process.execPath, cli, 'staff', 'list']);
    expect(listed.exitCode).toBe(0);
    const roster = JSON.parse(listed.stdout.toString());
    expect(roster.roleCount).toBe(50);
    expect(roster.roles).toHaveLength(50);

    const compiled = Bun.spawnSync([
      process.execPath,
      cli,
      '--staff-crew',
      '--order',
      JSON.stringify({ action: 'create.film', intent: 'Storyboard a film with sound', maxAgents: 4 }),
    ]);
    expect(compiled.exitCode).toBe(0);
    const crew = JSON.parse(compiled.stdout.toString());
    expect(crew.schema).toBe('orange.ae-staff-crew.v1');
    expect(crew.roles).toContain('storyboard-artist');

    const rejected = Bun.spawnSync([
      process.execPath,
      cli,
      'staff',
      'order',
      '--order',
      JSON.stringify({ action: 'build.feature', intent: 'Missing an explicit role' }),
    ]);
    expect(rejected.exitCode).toBe(2);
    expect(rejected.stderr.toString()).toBe('');
    expect(JSON.parse(rejected.stdout.toString())).toMatchObject({
      schema: 'orange.ae-staff-cli-error.v1',
      ok: false,
      command: 'order',
      error: 'staff order requires explicit staffRoles or targetRoles',
    });

    const nonCanonical = Bun.spawnSync([
      process.execPath,
      cli,
      '--staff-order',
      '--order',
      JSON.stringify({
        order: { schema: 'orange.order.v0', orderId: 'bad-staff-cli-order', action: 'inspect.claim' },
        targetRoles: ['false-green-hunter'],
      }),
    ]);
    expect(nonCanonical.exitCode).toBe(2);
    expect(JSON.parse(nonCanonical.stdout.toString()).error).toContain('order.schema orange.order.v1');
  });
});
