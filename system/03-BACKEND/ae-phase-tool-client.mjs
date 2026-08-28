#!/usr/bin/env bun
import { callAEPhase } from './ae-phase-rpc.mjs';

export const AE_PHASE_TOOL_REQUEST_SCHEMA = 'orange.ae-phase.tool-request.v1';
export const AE_PHASE_TOOL_REPORT_SCHEMA = 'orange.ae-phase.tool-report.v1';

export const CODEXA_COMMAND_ALLOWLIST = Object.freeze([
  'hostname',
  'ops-readiness',
  'system-check',
  'health-report',
  'project-report',
  'reality-watch',
  'model-inventory',
  'trilane-doctor',
  'ipi-doctor',
  'memory-doctor',
  'mcp-doctor',
]);

const ALLOWED = new Set(CODEXA_COMMAND_ALLOWLIST);

function normalizeArgs(args) {
  if (!Array.isArray(args)) throw new TypeError('AE Phase tool args must be an array');
  if (args.length > 32) throw new RangeError('AE Phase tool args exceed 32 items');
  return args.map((value) => {
    const item = String(value ?? '');
    if (item.length > 512) throw new RangeError('AE Phase tool arg exceeds 512 characters');
    return item;
  });
}

export async function requestAEPhaseTool({ command, args = [], timeoutMs = 60_000 } = {}) {
  const normalizedCommand = String(command || '').trim();
  if (!ALLOWED.has(normalizedCommand)) throw new Error(`AE Phase tool command is not allowlisted: ${normalizedCommand || '(empty)'}`);
  const boundedTimeout = Math.max(1_000, Math.min(300_000, Number(timeoutMs || 60_000)));
  const result = await callAEPhase({
    requestKind: 'ae_tool_request',
    responseKind: 'ae_tool_report',
    timeoutMs: boundedTimeout + 5_000,
    body: {
      schema: AE_PHASE_TOOL_REQUEST_SCHEMA,
      operation: 'command',
      tool: 'codexa-command-rail',
      command: normalizedCommand,
      args: normalizeArgs(args),
      timeoutMs: boundedTimeout,
      requestedAt: new Date().toISOString(),
    },
  });
  return { ...result.body, phase: result.phase };
}
