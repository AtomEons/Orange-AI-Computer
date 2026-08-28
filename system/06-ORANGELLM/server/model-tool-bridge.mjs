import path from 'node:path';

const ORANGE5_ROOT = path.resolve(process.env.ORANGE5_ROOT || 'C:/AtomEons/Orange5');

export const MODEL_TOOL_TURN_LIMIT = 2;
export const MODEL_TOOL_CALL_LIMIT = 8;

const FORBIDDEN_ACTIONS = Object.freeze([
  'process.run',
  'shell.exec',
  'filesystem.write',
  'filesystem.delete',
  'network.direct',
]);

const RISK_LEVELS = new Set(['read_only', 'low', 'medium', 'high', 'destructive', 'production']);
const ACTION_RX = /^[a-z][a-z0-9_.:-]{0,127}$/;

function toolSpec({ description, properties = {}, required = [], ...mapping }) {
  return Object.freeze({
    ...mapping,
    definition: Object.freeze({
      type: 'function',
      function: Object.freeze({
        name: mapping.modelName,
        description,
        parameters: Object.freeze({
          type: 'object',
          additionalProperties: false,
          properties,
          required,
        }),
      }),
    }),
  });
}

export const BRAIN_MCP_TOOL_MAP = Object.freeze({
  orange5_health: toolSpec({
    modelName: 'orange5_health',
    brainTool: 'orange5_health',
    action: 'inspect.health',
    executionMode: 'brain_mcp_read',
    description: 'Read live OrangeFive and OrangeBrain health. This is observation only.',
  }),
  orange5_receipts: toolSpec({
    modelName: 'orange5_receipts',
    brainTool: 'orange5_receipts',
    action: 'inspect.receipts',
    executionMode: 'brain_mcp_read',
    description: 'Read recent OrangeFive governed receipts.',
    properties: {
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 10 },
    },
  }),
  orange5_route: toolSpec({
    modelName: 'orange5_route',
    brainTool: 'orange5_route',
    action: null,
    executionMode: 'brain_mcp_dry_run',
    description: 'Dry-run one Orange order through the canonical spine. This never executes the proposed action.',
    properties: {
      action: { type: 'string', description: 'Bounded Orange action verb to plan.' },
      intent: { type: 'string', description: 'What the proposed order is intended to accomplish.' },
      payload: { type: 'object', description: 'Structured action input.' },
      targetProject: { type: 'string', description: 'Orange project name.' },
      riskLevel: { type: 'string', enum: [...RISK_LEVELS], default: 'read_only' },
    },
    required: ['action', 'intent'],
  }),
  orange5_filesystem_list: toolSpec({
    modelName: 'orange5_filesystem_list',
    brainTool: 'orange5_execute',
    action: 'filesystem.list',
    executionMode: 'hermes_lease',
    description: 'List a directory inside the OrangeFive root through a single-use Hermes lease.',
    properties: {
      projectRoot: { type: 'string', description: 'Project path inside the OrangeFive root.', default: '.' },
      path: { type: 'string', description: 'Directory path inside projectRoot.', default: '.' },
      limit: { type: 'integer', minimum: 1, maximum: 1000, default: 200 },
    },
  }),
  orange5_filesystem_read: toolSpec({
    modelName: 'orange5_filesystem_read',
    brainTool: 'orange5_execute',
    action: 'filesystem.read',
    executionMode: 'hermes_lease',
    description: 'Read one file inside the OrangeFive root through a single-use Hermes lease.',
    properties: {
      projectRoot: { type: 'string', description: 'Project path inside the OrangeFive root.', default: '.' },
      path: { type: 'string', description: 'File path inside projectRoot.' },
      maxBytes: { type: 'integer', minimum: 1, maximum: 1048576, default: 262144 },
    },
    required: ['path'],
  }),
});

export const MODEL_TOOL_DEFINITIONS = Object.freeze(
  Object.values(BRAIN_MCP_TOOL_MAP).map((mapping) => mapping.definition),
);

export function shouldUseGovernedModelTools({ responseMode, reflex = false, tier, body = {} } = {}) {
  return responseMode === 'conversation'
    && reflex !== true
    && tier !== 'visual'
    && body.tool_choice !== 'none';
}

export function prepareGovernedModelToolRequest(body = {}) {
  const {
    tools: _callerTools,
    tool_choice: _callerToolChoice,
    parallel_tool_calls: _parallelToolCalls,
    ...bounded
  } = body;
  return {
    ...bounded,
    tools: MODEL_TOOL_DEFINITIONS,
    tool_choice: 'auto',
    parallel_tool_calls: false,
  };
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

function rejectUnknownKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw new TypeError(`${label} contains unsupported field(s): ${unknown.join(', ')}`);
}

function boundedString(value, label, { required = false, max = 1024 } = {}) {
  if (value == null && !required) return null;
  if (typeof value !== 'string' || (required && !value.trim())) throw new TypeError(`${label} must be a non-empty string`);
  if (value.includes('\0')) throw new TypeError(`${label} contains a null byte`);
  if (value.length > max) throw new TypeError(`${label} exceeds ${max} characters`);
  return value.trim();
}

function boundedInteger(value, label, fallback, min, max) {
  if (value == null) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new TypeError(`${label} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function isPathInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function normalizeFilesystemArguments(args, modelName) {
  const isRead = modelName === 'orange5_filesystem_read';
  const allowed = isRead
    ? new Set(['projectRoot', 'path', 'maxBytes'])
    : new Set(['projectRoot', 'path', 'limit']);
  rejectUnknownKeys(args, allowed, `${modelName} arguments`);

  const requestedRoot = boundedString(args.projectRoot ?? '.', 'projectRoot', { required: true, max: 1024 });
  const resolvedRoot = path.resolve(ORANGE5_ROOT, requestedRoot);
  if (!isPathInside(ORANGE5_ROOT, resolvedRoot)) throw new TypeError('projectRoot escapes the OrangeFive root');

  const requestedPath = boundedString(args.path ?? '.', 'path', { required: isRead, max: 2048 });
  const resolvedTarget = path.resolve(resolvedRoot, requestedPath || '.');
  if (!isPathInside(resolvedRoot, resolvedTarget)) throw new TypeError('path escapes projectRoot');

  const normalized = {
    projectRoot: path.relative(ORANGE5_ROOT, resolvedRoot) || '.',
    path: path.relative(resolvedRoot, resolvedTarget) || '.',
  };
  if (isRead) normalized.maxBytes = boundedInteger(args.maxBytes, 'maxBytes', 262_144, 1, 1_048_576);
  else normalized.limit = boundedInteger(args.limit, 'limit', 200, 1, 1000);
  return normalized;
}

function validateArguments(modelName, args) {
  assertPlainObject(args, `${modelName} arguments`);
  if (modelName === 'orange5_health') {
    rejectUnknownKeys(args, new Set(), `${modelName} arguments`);
    return {};
  }
  if (modelName === 'orange5_receipts') {
    rejectUnknownKeys(args, new Set(['limit']), `${modelName} arguments`);
    return { limit: boundedInteger(args.limit, 'limit', 10, 1, 100) };
  }
  if (modelName === 'orange5_route') {
    rejectUnknownKeys(args, new Set(['action', 'intent', 'payload', 'targetProject', 'riskLevel']), `${modelName} arguments`);
    const action = boundedString(args.action, 'action', { required: true, max: 128 });
    if (!ACTION_RX.test(action)) throw new TypeError('action must be a bounded Orange action verb');
    const intent = boundedString(args.intent, 'intent', { required: true, max: 1024 });
    const payload = args.payload ?? {};
    assertPlainObject(payload, 'payload');
    if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > 32_768) throw new TypeError('payload exceeds 32768 bytes');
    const riskLevel = args.riskLevel ?? 'read_only';
    if (!RISK_LEVELS.has(riskLevel)) throw new TypeError(`unsupported riskLevel: ${riskLevel}`);
    return {
      action,
      intent,
      payload,
      targetProject: boundedString(args.targetProject ?? 'OrangeFive', 'targetProject', { required: true, max: 256 }),
      riskLevel,
    };
  }
  return normalizeFilesystemArguments(args, modelName);
}

function parseArguments(value) {
  if (value == null || value === '') return {};
  if (typeof value === 'object' && !Array.isArray(value)) return structuredClone(value);
  if (typeof value !== 'string') throw new TypeError('tool arguments must be a JSON object');
  if (Buffer.byteLength(value, 'utf8') > 65_536) throw new TypeError('tool arguments exceed 65536 bytes');
  let parsed;
  try { parsed = JSON.parse(value); }
  catch (error) { throw new TypeError(`tool arguments are not valid JSON: ${error.message}`); }
  assertPlainObject(parsed, 'tool arguments');
  return parsed;
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function callIdentity(call, index) {
  const id = typeof call?.id === 'string' && call.id.trim() ? call.id.trim() : `orange-tool-call-${index + 1}`;
  const name = typeof call?.function?.name === 'string' ? call.function.name.trim() : '';
  return { id, name };
}

export function compileModelToolCall(call, { parentOrderId = 'orangebrain-tool-loop', index = 0 } = {}) {
  const { id, name } = callIdentity(call, index);
  if (call?.type && call.type !== 'function') throw new TypeError(`unsupported tool call type: ${call.type}`);
  if (!name) throw new TypeError('tool call function.name is required');
  const mapping = BRAIN_MCP_TOOL_MAP[name];
  if (!mapping) {
    const error = new TypeError(`unsupported model tool: ${name}`);
    error.code = 'unsupported_tool';
    throw error;
  }
  const args = validateArguments(name, parseArguments(call?.function?.arguments));
  const action = mapping.action || args.action;
  const order = {
    schema: 'orange.order.v1',
    orderId: `${parentOrderId}:tool:${index + 1}`,
    action,
    intent: name === 'orange5_route' ? args.intent : `Execute ${name} through the governed Orange model-tool bridge.`,
    scope: 'OrangeFive model-tool bridge',
    payload: name === 'orange5_route' ? args.payload : args,
    allowedActions: [action],
    forbiddenActions: [...FORBIDDEN_ACTIONS].filter((item) => item !== action),
    targetProject: name === 'orange5_route' ? args.targetProject : 'OrangeFive',
    riskLevel: name === 'orange5_route' ? args.riskLevel : 'read_only',
    requiresReceipt: true,
  };
  const mcpArguments = mapping.brainTool === 'orange5_route'
    ? { order }
    : mapping.brainTool === 'orange5_execute'
      ? { ...args, action, orderId: order.orderId, actor: 'orange-model-tool-bridge' }
      : args;
  return {
    id,
    name,
    arguments: args,
    signature: stable({ name, arguments: args }),
    mapping: {
      brain_tool: mapping.brainTool,
      execution_mode: mapping.executionMode,
      hermes_action: mapping.executionMode === 'hermes_lease' ? action : null,
    },
    order,
    mcpArguments,
  };
}

export async function callBrainMcpTool(name, args, context = {}) {
  const { handleMcp } = await import('../../03-BACKEND/orange5-brain-mcp-server.mjs');
  return await handleMcp({
    jsonrpc: '2.0',
    id: context.order?.orderId || `orange-model-tool-${Date.now()}`,
    method: 'tools/call',
    params: { name, arguments: args },
  });
}

function parseMcpContent(content) {
  const textItems = Array.isArray(content)
    ? content.filter((item) => item?.type === 'text' && typeof item.text === 'string').map((item) => item.text)
    : [];
  if (textItems.length === 0) return null;
  if (textItems.length > 1) return textItems.map((text) => {
    try { return JSON.parse(text); } catch { return text; }
  });
  try { return JSON.parse(textItems[0]); } catch { return textItems[0]; }
}

function normalizeMcpResponse(response) {
  if (response?.error) {
    const error = new Error(response.error.message || 'Brain MCP tool call failed');
    error.code = response.error.code || 'brain_mcp_error';
    throw error;
  }
  if (response?.jsonrpc === '2.0') {
    return {
      ok: response.result?.isError !== true,
      output: parseMcpContent(response.result?.content),
      mcp: response.result ?? null,
    };
  }
  return { ok: response?.ok !== false, output: response, mcp: null };
}

function boundedValue(value, maxBytes = 32_768) {
  if (value == null) return value;
  let encoded;
  try { encoded = JSON.stringify(value); }
  catch { return { truncated: true, excerpt: String(value).slice(0, maxBytes) }; }
  if (Buffer.byteLength(encoded, 'utf8') <= maxBytes) return value;
  return { truncated: true, original_bytes: Buffer.byteLength(encoded, 'utf8'), excerpt: encoded.slice(0, maxBytes) };
}

function receiptPathsFrom(value) {
  const paths = new Set();
  const seen = new Set();
  const visit = (item, depth = 0) => {
    if (!item || typeof item !== 'object' || depth > 10 || seen.has(item)) return;
    seen.add(item);
    if (typeof item.receiptPath === 'string' && item.receiptPath) paths.add(item.receiptPath);
    if (typeof item.receipt_path === 'string' && item.receipt_path) paths.add(item.receipt_path);
    if (item.type === 'receipt' && typeof item.path === 'string' && item.path) paths.add(item.path);
    for (const nested of Object.values(item)) visit(nested, depth + 1);
  };
  visit(value);
  return [...paths];
}

function toolResultMessage(result) {
  return {
    role: 'tool',
    tool_call_id: result.call_id,
    name: result.name || 'orange5_tool_boundary',
    content: JSON.stringify({
      schema: 'orange.model-tool-result.v1',
      call_id: result.call_id,
      tool: result.name,
      ok: result.ok,
      status: result.status,
      execution_performed: result.execution_performed,
      execution_truth: result.execution_truth,
      receipt_paths: result.receipt_paths,
      output: result.output,
      error: result.error,
    }),
  };
}

function assistantToolMessage(message) {
  return {
    role: 'assistant',
    content: typeof message?.content === 'string' ? message.content : null,
    tool_calls: structuredClone(message?.tool_calls || []),
  };
}

function addVisibleBoundaryNotice(envelope, metadata) {
  const notices = [];
  if (metadata.unsupported_tools.length) notices.push(`unsupported tool call(s) refused: ${metadata.unsupported_tools.join(', ')}`);
  if (metadata.invalid_calls.length) notices.push(`invalid tool call(s) refused: ${metadata.invalid_calls.join(', ')}`);
  if (metadata.duplicate_calls.length) notices.push('duplicate tool call(s) refused to stop execution stasis');
  if (metadata.hard_turn_limit_reached) notices.push(`tool loop stopped at the hard ${metadata.hard_turn_limit}-turn limit; no further calls were executed`);
  if (metadata.execution_truth.unverified_execution_reported) notices.push('a tool reported execution without a receipt path, so execution is not marked proven');
  const failed = metadata.results.filter((item) => item.status === 'brain_mcp_failed').map((item) => item.name).filter(Boolean);
  if (failed.length) notices.push(`governed tool execution failed: ${[...new Set(failed)].join(', ')}; no ungoverned fallback was attempted`);
  if (!notices.length) return;

  const choice = envelope?.choices?.[0];
  if (!choice?.message) return;
  const notice = `Orange tool boundary: ${notices.join('; ')}.`;
  const content = typeof choice.message.content === 'string' ? choice.message.content.trim() : '';
  choice.message.content = content ? `${content}\n\n${notice}` : notice;
}

function metadataFrom(state) {
  const receiptPaths = [...new Set(state.results.flatMap((item) => item.receipt_paths || []))];
  const executionReported = state.results.some((item) => item.execution_reported === true);
  const executionPerformed = state.results.some((item) => item.execution_performed === true);
  const failures = state.results.some((item) => item.ok === false);
  const unverifiedExecution = executionReported && !executionPerformed;
  const status = unverifiedExecution
    ? 'execution_unverified_receipt_missing'
    : executionPerformed && failures
      ? 'partial_governed_execution'
      : executionPerformed
        ? 'governed_execution_observed'
        : failures
          ? 'no_execution_tool_failures'
          : 'no_execution';
  return {
    schema: 'orange.model-tool-loop.v1',
    enabled: true,
    allowlisted_tools: Object.keys(BRAIN_MCP_TOOL_MAP),
    model_turns_used: state.turnsUsed,
    hard_turn_limit: MODEL_TOOL_TURN_LIMIT,
    hard_turn_limit_reached: state.hardTurnLimitReached,
    call_limit: MODEL_TOOL_CALL_LIMIT,
    synthesis_follow_up: state.turnsUsed === MODEL_TOOL_TURN_LIMIT,
    calls: state.calls,
    results: state.results,
    receipt_paths: receiptPaths,
    unsupported_tools: [...state.unsupportedTools],
    invalid_calls: [...state.invalidCalls],
    duplicate_calls: [...state.duplicateCalls],
    stasis_detected: state.stasisDetected,
    execution_truth: {
      status,
      execution_reported: executionReported,
      execution_performed: executionPerformed,
      unverified_execution_reported: unverifiedExecution,
      receipt_backed: executionPerformed ? receiptPaths.length > 0 : null,
      governed_only: true,
      direct_execution: false,
      executor: 'orangefive-brain-mcp/hermes',
    },
  };
}

function blockedResult({ id, name, status, message, executionTruth = 'not_performed' }) {
  return {
    call_id: id,
    name: name || null,
    ok: false,
    status,
    execution_reported: false,
    execution_performed: false,
    execution_truth: executionTruth,
    receipt_paths: [],
    output: null,
    error: message,
  };
}

function attachMetadata(result, metadata) {
  if (!result.body || typeof result.body !== 'object') result.body = {};
  result.body.ae_tool_loop = metadata;
  return result;
}

export async function runGovernedModelToolLoop({
  initialResult,
  requestBody,
  orderId,
  invokeModel,
  executeBrainMcp = callBrainMcpTool,
} = {}) {
  if (!initialResult || typeof initialResult !== 'object') throw new TypeError('initialResult is required');
  if (typeof invokeModel !== 'function') throw new TypeError('invokeModel is required');
  if (typeof executeBrainMcp !== 'function') throw new TypeError('executeBrainMcp is required');

  const state = {
    turnsUsed: 1,
    calls: [],
    results: [],
    unsupportedTools: new Set(),
    invalidCalls: new Set(),
    duplicateCalls: new Set(),
    signatures: new Set(),
    stasisDetected: false,
    hardTurnLimitReached: false,
  };
  const firstMessage = initialResult.body?.choices?.[0]?.message;
  const initialCalls = Array.isArray(firstMessage?.tool_calls) ? firstMessage.tool_calls : [];
  if (initialResult.status !== 200 || initialCalls.length === 0) {
    return attachMetadata(initialResult, metadataFrom(state));
  }

  const toolMessages = [];
  for (let index = 0; index < initialCalls.length; index += 1) {
    const rawCall = initialCalls[index];
    const identity = callIdentity(rawCall, index);
    if (index >= MODEL_TOOL_CALL_LIMIT) {
      const result = blockedResult({
        ...identity,
        status: 'call_limit_exceeded',
        message: `tool call limit is ${MODEL_TOOL_CALL_LIMIT}`,
      });
      state.calls.push({ index, ...identity, status: result.status, order: null, mapping: null });
      state.results.push(result);
      toolMessages.push(toolResultMessage(result));
      continue;
    }

    let compiled;
    try {
      compiled = compileModelToolCall(rawCall, { parentOrderId: orderId, index });
    } catch (error) {
      const unsupported = error.code === 'unsupported_tool';
      if (unsupported) state.unsupportedTools.add(identity.name || '(missing name)');
      else state.invalidCalls.add(identity.name || identity.id);
      const result = blockedResult({
        ...identity,
        status: unsupported ? 'unsupported_tool' : 'invalid_arguments',
        message: error.message,
      });
      state.calls.push({ index, ...identity, status: result.status, order: null, mapping: null });
      state.results.push(result);
      toolMessages.push(toolResultMessage(result));
      continue;
    }

    if (state.signatures.has(compiled.signature)) {
      state.stasisDetected = true;
      state.duplicateCalls.add(compiled.name);
      const result = blockedResult({
        ...compiled,
        status: 'duplicate_call_refused',
        message: 'identical tool name and arguments already ran in this loop',
        executionTruth: 'duplicate_refused',
      });
      state.calls.push({ index, ...compiled, mcpArguments: undefined, status: result.status });
      state.results.push(result);
      toolMessages.push(toolResultMessage(result));
      continue;
    }
    state.signatures.add(compiled.signature);
    state.calls.push({ index, ...compiled, mcpArguments: undefined, status: 'dispatched_governed' });

    let result;
    try {
      const response = await executeBrainMcp(compiled.mapping.brain_tool, compiled.mcpArguments, {
        order: compiled.order,
        mapping: compiled.mapping,
        call: rawCall,
      });
      const normalized = normalizeMcpResponse(response);
      const receiptPaths = receiptPathsFrom(normalized.output);
      const executionReported = compiled.mapping.execution_mode === 'hermes_lease' && normalized.ok;
      const executionPerformed = executionReported && receiptPaths.length > 0;
      result = {
        call_id: compiled.id,
        name: compiled.name,
        ok: normalized.ok,
        status: normalized.ok ? 'brain_mcp_completed' : 'brain_mcp_failed',
        execution_reported: executionReported,
        execution_performed: executionPerformed,
        execution_truth: executionPerformed
          ? 'receipt_backed_governed_execution'
          : executionReported
            ? 'execution_reported_receipt_missing'
            : 'governed_observation_only',
        receipt_paths: receiptPaths,
        output: boundedValue(normalized.output),
        error: normalized.ok ? null : 'Brain MCP returned isError=true',
      };
    } catch (error) {
      result = blockedResult({
        ...compiled,
        status: 'brain_mcp_failed',
        message: error?.message || String(error),
        executionTruth: 'governed_executor_failed',
      });
    }
    state.results.push(result);
    toolMessages.push(toolResultMessage(result));
  }

  const synthesisBody = {
    ...requestBody,
    messages: [
      ...(requestBody?.messages || []),
      assistantToolMessage(firstMessage),
      ...toolMessages,
    ],
    tools: MODEL_TOOL_DEFINITIONS,
    tool_choice: 'none',
    parallel_tool_calls: false,
  };

  let finalResult;
  try {
    finalResult = await invokeModel(synthesisBody, { phase: 'tool_synthesis', turn: MODEL_TOOL_TURN_LIMIT });
  } catch (error) {
    finalResult = {
      status: 502,
      body: { error: { message: `tool synthesis failed: ${error?.message || String(error)}`, type: 'upstream_error', code: 'tool_synthesis_failed' } },
    };
  }
  state.turnsUsed = MODEL_TOOL_TURN_LIMIT;

  const finalChoice = finalResult.body?.choices?.[0];
  const finalCalls = Array.isArray(finalChoice?.message?.tool_calls) ? finalChoice.message.tool_calls : [];
  if (finalCalls.length) {
    state.hardTurnLimitReached = true;
    for (let index = 0; index < finalCalls.length; index += 1) {
      const rawCall = finalCalls[index];
      const identity = callIdentity(rawCall, initialCalls.length + index);
      let signature = null;
      try {
        const compiled = compileModelToolCall(rawCall, { parentOrderId: orderId, index: initialCalls.length + index });
        signature = compiled.signature;
        if (state.signatures.has(signature)) {
          state.stasisDetected = true;
          state.duplicateCalls.add(compiled.name);
        }
        state.calls.push({
          index: initialCalls.length + index,
          ...compiled,
          mcpArguments: undefined,
          status: 'hard_turn_limit_refused',
        });
      } catch (error) {
        if (error.code === 'unsupported_tool') state.unsupportedTools.add(identity.name || '(missing name)');
        else state.invalidCalls.add(identity.name || identity.id);
        state.calls.push({
          index: initialCalls.length + index,
          ...identity,
          status: 'hard_turn_limit_refused',
          order: null,
          mapping: null,
        });
      }
      const result = blockedResult({
        ...identity,
        status: 'hard_turn_limit_refused',
        message: `model requested another tool at turn ${MODEL_TOOL_TURN_LIMIT}; no third model turn is allowed`,
        executionTruth: signature && state.signatures.has(signature) ? 'stasis_refused' : 'turn_limit_refused',
      });
      state.results.push(result);
    }
    if (finalChoice?.message) delete finalChoice.message.tool_calls;
    if (finalChoice?.finish_reason === 'tool_calls') finalChoice.finish_reason = 'stop';
  }

  const metadata = metadataFrom(state);
  addVisibleBoundaryNotice(finalResult.body, metadata);
  return attachMetadata(finalResult, metadata);
}
