import { describe, expect, test } from 'bun:test';
import {
  BRAIN_MCP_TOOL_MAP,
  MODEL_TOOL_CALL_LIMIT,
  MODEL_TOOL_DEFINITIONS,
  MODEL_TOOL_TURN_LIMIT,
  compileModelToolCall,
  prepareGovernedModelToolRequest,
  runGovernedModelToolLoop,
} from './model-tool-bridge.mjs';

function completion(message, finishReason = 'stop') {
  return {
    status: 200,
    body: {
      id: `chatcmpl-test-${Date.now()}`,
      object: 'chat.completion',
      model: 'orange-test',
      choices: [{ index: 0, message, finish_reason: finishReason }],
    },
    streamed: false,
  };
}

function toolCall(id, name, args = {}) {
  return {
    id,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  };
}

function mcpResult(output, isError = false) {
  return {
    jsonrpc: '2.0',
    id: 'test-mcp',
    result: {
      content: [{ type: 'text', text: JSON.stringify(output) }],
      isError,
    },
  };
}

describe('governed OrangeBrain model-tool bridge', () => {
  test('replaces caller tools with the frozen Brain MCP allowlist', () => {
    const prepared = prepareGovernedModelToolRequest({
      model: 'orange-navigator',
      messages: [{ role: 'user', content: 'inspect the runtime' }],
      tools: [{ type: 'function', function: { name: 'run_anything', parameters: {} } }],
      tool_choice: { type: 'function', function: { name: 'run_anything' } },
      parallel_tool_calls: true,
    });
    const names = prepared.tools.map((item) => item.function.name);

    expect(names).toEqual(Object.keys(BRAIN_MCP_TOOL_MAP));
    expect(names).not.toContain('run_anything');
    expect(prepared.tool_choice).toBe('auto');
    expect(prepared.parallel_tool_calls).toBe(false);
    expect(MODEL_TOOL_DEFINITIONS.every((item) => item.function.parameters.additionalProperties === false)).toBe(true);
  });

  test('compiles a filesystem read into orange.order.v1 and a fixed Hermes action', () => {
    const compiled = compileModelToolCall(toolCall('call-read', 'orange5_filesystem_read', {
      projectRoot: '06-ORANGELLM',
      path: 'server/model-tool-bridge.mjs',
      maxBytes: 4096,
    }), { parentOrderId: 'parent-order', index: 0 });

    expect(compiled.order).toMatchObject({
      schema: 'orange.order.v1',
      orderId: 'parent-order:tool:1',
      action: 'filesystem.read',
      allowedActions: ['filesystem.read'],
      targetProject: 'OrangeFive',
      riskLevel: 'read_only',
      requiresReceipt: true,
    });
    expect(compiled.order.forbiddenActions).toContain('process.run');
    expect(compiled.mapping).toEqual({
      brain_tool: 'orange5_execute',
      execution_mode: 'hermes_lease',
      hermes_action: 'filesystem.read',
    });
    expect(compiled.mcpArguments).toMatchObject({
      action: 'filesystem.read',
      orderId: 'parent-order:tool:1',
      actor: 'orange-model-tool-bridge',
      projectRoot: '06-ORANGELLM',
      maxBytes: 4096,
    });
  });

  test('rejects unsupported tools, extra arguments, and paths outside OrangeFive', () => {
    expect(() => compileModelToolCall(toolCall('x', 'process_run', { command: ['cmd'] }))).toThrow('unsupported model tool');
    expect(() => compileModelToolCall(toolCall('x', 'orange5_health', { command: ['cmd'] }))).toThrow('unsupported field');
    expect(() => compileModelToolCall(toolCall('x', 'orange5_filesystem_read', {
      projectRoot: '..', path: 'secret.txt',
    }))).toThrow('escapes the OrangeFive root');
  });

  test('executes an allowed call only through Brain MCP and returns its result as a tool message', async () => {
    const initial = completion({
      role: 'assistant',
      content: null,
      tool_calls: [toolCall('call-read', 'orange5_filesystem_read', {
        projectRoot: '06-ORANGELLM', path: 'server/README.md', maxBytes: 2048,
      })],
    }, 'tool_calls');
    const executions = [];
    let synthesisBody;
    const result = await runGovernedModelToolLoop({
      initialResult: initial,
      requestBody: { model: 'orange-navigator', messages: [{ role: 'user', content: 'Read the gateway summary.' }] },
      orderId: 'bridge-order',
      executeBrainMcp: async (name, args, context) => {
        executions.push({ name, args, context });
        return mcpResult({
          ok: true,
          status: 'ok',
          receiptPath: 'C:/AtomEons/Orange5/10-RECEIPTS/orange5-build/bridge-order-tool-1.json',
          evidence: [{ type: 'execution_result', action: 'filesystem.read', content: 'Gateway summary', result_hash: 'a'.repeat(64) }],
        });
      },
      invokeModel: async (body) => {
        synthesisBody = body;
        return completion({ role: 'assistant', content: 'The gateway summary is available from the governed read.' });
      },
    });

    expect(executions).toHaveLength(1);
    expect(executions[0].name).toBe('orange5_execute');
    expect(executions[0].args.action).toBe('filesystem.read');
    expect(executions[0].context.order.schema).toBe('orange.order.v1');
    expect(synthesisBody.tool_choice).toBe('none');
    expect(synthesisBody.parallel_tool_calls).toBe(false);
    expect(synthesisBody.messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'call-read', name: 'orange5_filesystem_read' });
    expect(JSON.parse(synthesisBody.messages.at(-1).content)).toMatchObject({
      ok: true,
      execution_performed: true,
      execution_truth: 'receipt_backed_governed_execution',
    });
    expect(result.body.ae_tool_loop).toMatchObject({
      model_turns_used: MODEL_TOOL_TURN_LIMIT,
      hard_turn_limit: MODEL_TOOL_TURN_LIMIT,
      synthesis_follow_up: true,
      unsupported_tools: [],
      execution_truth: {
        status: 'governed_execution_observed',
        execution_performed: true,
        governed_only: true,
        direct_execution: false,
      },
    });
    expect(result.body.ae_tool_loop.receipt_paths).toEqual([
      'C:/AtomEons/Orange5/10-RECEIPTS/orange5-build/bridge-order-tool-1.json',
    ]);
  });

  test('returns unsupported tools as visible failures without invoking an executor', async () => {
    const initial = completion({
      role: 'assistant',
      content: null,
      tool_calls: [toolCall('call-shell', 'run_shell', { command: 'whoami' })],
    }, 'tool_calls');
    let toolPayload;
    const result = await runGovernedModelToolLoop({
      initialResult: initial,
      requestBody: { messages: [{ role: 'user', content: 'Run a command.' }] },
      orderId: 'unsupported-order',
      executeBrainMcp: async () => { throw new Error('executor must not be called'); },
      invokeModel: async (body) => {
        toolPayload = JSON.parse(body.messages.at(-1).content);
        return completion({ role: 'assistant', content: 'I could not run that tool.' });
      },
    });

    expect(toolPayload).toMatchObject({ ok: false, status: 'unsupported_tool', execution_performed: false });
    expect(result.body.ae_tool_loop.unsupported_tools).toEqual(['run_shell']);
    expect(result.body.ae_tool_loop.execution_truth.execution_performed).toBe(false);
    expect(result.body.choices[0].message.content).toContain('unsupported tool call(s) refused: run_shell');
  });

  test('executes an identical call once and marks duplicate-call stasis', async () => {
    const duplicate = { projectRoot: '06-ORANGELLM', path: 'server', limit: 20 };
    const initial = completion({
      role: 'assistant',
      content: null,
      tool_calls: [
        toolCall('call-list-1', 'orange5_filesystem_list', duplicate),
        toolCall('call-list-2', 'orange5_filesystem_list', duplicate),
      ],
    }, 'tool_calls');
    let executions = 0;
    let toolMessages = [];
    const result = await runGovernedModelToolLoop({
      initialResult: initial,
      requestBody: { messages: [{ role: 'user', content: 'List server files.' }] },
      orderId: 'duplicate-order',
      executeBrainMcp: async () => {
        executions += 1;
        return mcpResult({ ok: true, receiptPath: 'C:/receipts/list.json', evidence: [] });
      },
      invokeModel: async (body) => {
        toolMessages = body.messages.filter((message) => message.role === 'tool').map((message) => JSON.parse(message.content));
        return completion({ role: 'assistant', content: 'The directory was listed once.' });
      },
    });

    expect(executions).toBe(1);
    expect(toolMessages).toHaveLength(2);
    expect(toolMessages[1].status).toBe('duplicate_call_refused');
    expect(result.body.ae_tool_loop.stasis_detected).toBe(true);
    expect(result.body.ae_tool_loop.duplicate_calls).toEqual(['orange5_filesystem_list']);
    expect(result.body.choices[0].message.content).toContain('duplicate tool call(s) refused');
  });

  test('refuses a synthesis-turn tool call at the hard turn limit', async () => {
    const call = toolCall('call-health-1', 'orange5_health');
    let executions = 0;
    const result = await runGovernedModelToolLoop({
      initialResult: completion({ role: 'assistant', content: null, tool_calls: [call] }, 'tool_calls'),
      requestBody: { messages: [{ role: 'user', content: 'Check health.' }] },
      orderId: 'stasis-order',
      executeBrainMcp: async () => {
        executions += 1;
        return mcpResult({ status: 'live', operational: true });
      },
      invokeModel: async () => completion({
        role: 'assistant',
        content: null,
        tool_calls: [toolCall('call-health-2', 'orange5_health')],
      }, 'tool_calls'),
    });

    expect(executions).toBe(1);
    expect(result.body.ae_tool_loop.hard_turn_limit_reached).toBe(true);
    expect(result.body.ae_tool_loop.stasis_detected).toBe(true);
    expect(result.body.ae_tool_loop.calls).toHaveLength(2);
    expect(result.body.ae_tool_loop.results.at(-1).status).toBe('hard_turn_limit_refused');
    expect(result.body.choices[0].message.tool_calls).toBeUndefined();
    expect(result.body.choices[0].finish_reason).toBe('stop');
    expect(result.body.choices[0].message.content).toContain(`hard ${MODEL_TOOL_TURN_LIMIT}-turn limit`);
  });

  test('enforces the per-turn tool call ceiling', async () => {
    const calls = Array.from({ length: MODEL_TOOL_CALL_LIMIT + 2 }, (_, index) => toolCall(
      `health-${index}`,
      'orange5_health',
      index === 0 ? {} : { extra: index },
    ));
    let executions = 0;
    const result = await runGovernedModelToolLoop({
      initialResult: completion({ role: 'assistant', content: null, tool_calls: calls }, 'tool_calls'),
      requestBody: { messages: [{ role: 'user', content: 'Probe within bounds.' }] },
      orderId: 'call-limit-order',
      executeBrainMcp: async () => {
        executions += 1;
        return mcpResult({ status: 'live' });
      },
      invokeModel: async () => completion({ role: 'assistant', content: 'Bounded.' }),
    });

    expect(executions).toBe(1);
    expect(result.body.ae_tool_loop.results.filter((item) => item.status === 'call_limit_exceeded')).toHaveLength(2);
  });

  test('v1 conversation integration exposes receipt-backed execution truth', async () => {
    const priorNodeEnv = process.env.NODE_ENV;
    const priorReceipts = process.env.ORANGE5_CHAT_RECEIPTS;
    const priorLearning = process.env.ORANGE5_CHAT_LEARNING;
    process.env.NODE_ENV = 'test';
    process.env.ORANGE5_CHAT_RECEIPTS = '0';
    process.env.ORANGE5_CHAT_LEARNING = '0';
    try {
      const { handleV1ChatCompletions, resolveRequestedModelRoute } = await import(`./routes/v1.mjs?model-tool-bridge=${Date.now()}`);
      expect(resolveRequestedModelRoute('ae-misfit:v0')).toMatchObject({
        valid: true,
        mode: 'explicit',
        tier: 'navigator',
        requestedModel: 'ae-misfit:v0',
      });
      expect(resolveRequestedModelRoute('ae-misfit:unknown')).toMatchObject({
        valid: false,
        mode: 'invalid',
        tier: null,
        requestedModel: 'ae-misfit:unknown',
      });
      let modelTurns = 0;
      const result = await handleV1ChatCompletions({
        model: 'orangellm-light',
        ae_response_mode: 'conversation',
        ae_party_line: { enabled: false },
        messages: [{ role: 'user', content: 'Read the OrangeLLM server summary.' }],
      }, {
        proxyChatCompletions: async (body) => {
          modelTurns += 1;
          if (modelTurns === 1) {
            expect(body.tools.map((item) => item.function.name)).toEqual(Object.keys(BRAIN_MCP_TOOL_MAP));
            return completion({
              role: 'assistant',
              content: null,
              tool_calls: [toolCall('route-read', 'orange5_filesystem_read', {
                projectRoot: '06-ORANGELLM', path: 'server/README.md', maxBytes: 1024,
              })],
            }, 'tool_calls');
          }
          expect(body.messages.at(-1).role).toBe('tool');
          expect(body.tool_choice).toBe('none');
          return completion({ role: 'assistant', content: 'OrangeLLM is the governed gateway.' });
        },
        executeBrainMcp: async (name, args) => {
          expect(name).toBe('orange5_execute');
          expect(args.action).toBe('filesystem.read');
          return mcpResult({
            ok: true,
            status: 'ok',
            receiptPath: 'C:/AtomEons/Orange5/10-RECEIPTS/orange5-build/route-read.json',
            evidence: [{ type: 'execution_result', action: 'filesystem.read', content: 'gateway' }],
          });
        },
      });

      expect(modelTurns).toBe(MODEL_TOOL_TURN_LIMIT);
      expect(result._ae_http_status).toBe(200);
      expect(result.choices[0].message.content).toBe('OrangeLLM is the governed gateway.');
      expect(result.ae_tool_loop.calls[0].order.schema).toBe('orange.order.v1');
      expect(result.ae_tool_loop.execution_truth.execution_performed).toBe(true);
      expect(result.ae_execution_performed).toBe(true);
      expect(result.ae_receipt_authority).toContain('brain-mcp-hermes');
    } finally {
      if (priorNodeEnv == null) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = priorNodeEnv;
      if (priorReceipts == null) delete process.env.ORANGE5_CHAT_RECEIPTS;
      else process.env.ORANGE5_CHAT_RECEIPTS = priorReceipts;
      if (priorLearning == null) delete process.env.ORANGE5_CHAT_LEARNING;
      else process.env.ORANGE5_CHAT_LEARNING = priorLearning;
    }
  });
});
