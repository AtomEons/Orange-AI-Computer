import { describe, expect, test } from 'bun:test';
import { buildSwarmMcpOrder, handleMcp } from '../orange5-brain-mcp-server.mjs';
import { executeOperationalAction, isDeterministicOperationalAction } from '../operational-executor.mjs';

const tasks = [
  { id: 'inspect', action: 'inspect files', reads: ['src'], model: { key: 'orange-auto', residentGb: 10, contextGb: 1 } },
  { id: 'verify', action: 'verify output', dependsOn: ['inspect'], reads: ['tests'], model: { key: 'orange-auto', residentGb: 10, contextGb: 1 } },
];

describe('Swarmgate and Swarm Sentinel Brain MCP order bridge', () => {
  test('advertises focused read-only tools to Navigator', async () => {
    const response = await handleMcp({
      jsonrpc: '2.0', id: 1, method: 'tools/list',
      params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } },
    });
    const names = response.result.tools.map((tool) => tool.name);
    expect(names).toContain('orange5_swarmgate_plan');
    expect(names).toContain('orange5_swarm_sentinel_inspect');
  });

  test('builds bounded read-only orders and rejects empty input before dispatch', () => {
    const order = buildSwarmMcpOrder('orange5_swarmgate_plan', { tasks });
    expect(order.action).toBe('plan.swarm');
    expect(order.riskLevel).toBe('read_only');
    expect(order.allowedActions).toEqual(['plan.swarm']);
    expect(order.requiresReceipt).toBe(true);
    expect(() => buildSwarmMcpOrder('orange5_swarmgate_plan', {})).toThrow('requires at least one task');
    expect(() => buildSwarmMcpOrder('orange5_swarm_sentinel_inspect', { workerReports: [] })).toThrow('canonical orange5.swarmgate-plan.v1');
  });

  test('id-less tool calls cannot dispatch an order', async () => {
    const response = await handleMcp({
      jsonrpc: '2.0', method: 'tools/call',
      params: { name: 'orange5_swarmgate_plan', arguments: { tasks } },
    });
    expect(response).toBeNull();
  });

  test('plan.swarm calls canonical Swarmgate without mutation', async () => {
    expect(isDeterministicOperationalAction('plan.swarm')).toBe(true);
    const result = await executeOperationalAction({ action: 'plan.swarm', payload: { tasks } });
    expect(result.output.schema).toBe('orange5.swarmgate-plan.v1');
    expect(result.output.status).toBe('PLANNED');
    expect(result.output.executionWaves.flatMap((wave) => wave.workers).map((worker) => worker.id)).toEqual(['inspect', 'verify']);
    expect(result.evidence).toMatchObject({
      source: 'canonical_module',
      module: '08-HERMES/product-integration/scripts/swarmgate.mjs',
      export: 'planSwarm',
      execution: 'read_only',
      mutationPerformed: false,
    });
  });

  test('inspect.swarm calls canonical Sentinel and preserves halt findings as data', async () => {
    const planned = await executeOperationalAction({ action: 'plan.swarm', payload: { tasks } });
    const result = await executeOperationalAction({
      action: 'inspect.swarm',
      payload: {
        plan: planned.output,
        workerReports: [{ workerId: 'inspect', status: 'complete', evidence: [], confidence: 1, blockers: [], nextAction: 'done' }],
      },
    });
    expect(result.ok).toBe(true);
    expect(result.status).toBe('completed');
    expect(result.output.schema).toBe('orange5.swarm-sentinel-report.v1');
    expect(result.output.status).toBe('SWARM_HALTED');
    expect(result.output.findings).toContainEqual(expect.objectContaining({ code: 'FALSE_GREEN_NO_EVIDENCE', workerId: 'inspect' }));
    expect(result.evidence.module).toBe('08-HERMES/product-integration/scripts/swarm-sentinel.mjs');
  });

  test('invalid canonical plan input rejects instead of producing an execution result', async () => {
    await expect(executeOperationalAction({ action: 'plan.swarm', payload: { tasks: [] } })).rejects.toThrow('At least one task is required');
    expect(await executeOperationalAction({ action: 'build.feature', payload: {} })).toBeNull();
  });
});
