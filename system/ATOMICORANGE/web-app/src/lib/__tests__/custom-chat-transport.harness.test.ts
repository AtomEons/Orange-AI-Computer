import type { UIMessage } from '@ai-sdk/react'
import { invoke } from '@tauri-apps/api/core'
import type { LanguageModel } from 'ai'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useAppState } from '@/hooks/useAppState'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useToolAvailable } from '@/hooks/useToolAvailable'
import { seedServiceHub } from '@/test/service-hub'
import { CustomChatTransport } from '../custom-chat-transport'
import { ModelFactory } from '../model-factory'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  Channel: class {
    onmessage: ((event: { data: string }) => void) | undefined
  },
}))

type ModelStreamPart =
  | { type: 'stream-start'; warnings: [] }
  | { type: 'text-start'; id: string }
  | { type: 'text-delta'; id: string; delta: string }
  | { type: 'text-end'; id: string }
  | { type: 'tool-input-start'; id: string; toolName: string }
  | { type: 'tool-input-delta'; id: string; delta: string }
  | { type: 'tool-input-end'; id: string }
  | {
      type: 'tool-call'
      toolCallId: string
      toolName: string
      input: string
    }
  | {
      type: 'finish'
      finishReason: 'stop' | 'tool-calls'
      usage: {
        inputTokens: number
        outputTokens: number
        totalTokens: number
      }
    }

const fakeStreamingModel = (parts: ModelStreamPart[]): LanguageModel =>
  ({
    specificationVersion: 'v2',
    provider: 'fixture',
    modelId: 'fixture-model',
    supportedUrls: {},
    doGenerate: vi.fn(),
    doStream: vi.fn(async () => ({
      stream: new ReadableStream({
        start(controller) {
          parts.forEach((part) => controller.enqueue(part))
          controller.close()
        },
      }),
    })),
  }) as unknown as LanguageModel

const userMessage: UIMessage = {
  id: 'user-1',
  role: 'user',
  parts: [{ type: 'text', text: 'hello' }],
}

async function readChunks(
  stream: ReadableStream<Record<string, unknown>>
): Promise<Array<Record<string, unknown>>> {
  const chunks: Array<Record<string, unknown>> = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

describe('CustomChatTransport production harness', () => {
  beforeEach(() => {
    seedServiceHub({
      rag: { getTools: vi.fn().mockResolvedValue([]) } as never,
    })
    useAppState.setState({
      tools: [],
      ragToolNames: new Set(),
      mcpToolNames: new Set(),
    })
    useToolAvailable.setState({
      disabledTools: {},
      defaultDisabledTools: [],
    })
    useModelProvider.setState({
      selectedProvider: 'orangebrain',
      selectedModel: {
        id: 'orange-auto',
        capabilities: [],
        settings: {},
      } as never,
      providers: [
        {
          provider: 'orangebrain',
          active: true,
          api_key: '',
          base_url: 'http://127.0.0.1:1337/v1',
          models: [],
          settings: [],
        },
      ] as never,
    })
  })

  it('preserves delta order while stripping leaked MLX special tokens', async () => {
    vi.spyOn(ModelFactory, 'createModel').mockResolvedValue(
      fakeStreamingModel([
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'text-1' },
        { type: 'text-delta', id: 'text-1', delta: 'Hello ' },
        { type: 'text-delta', id: 'text-1', delta: '<|eot_id|>' },
        { type: 'text-delta', id: 'text-1', delta: 'world' },
        { type: 'text-end', id: 'text-1' },
        {
          type: 'finish',
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 3, totalTokens: 4 },
        },
      ])
    )
    const transport = new CustomChatTransport()

    const chunks = await readChunks(
      (await transport.sendMessages({
        chatId: 'chat-1',
        messages: [userMessage],
        abortSignal: undefined,
        trigger: 'submit-message',
        messageId: undefined,
      })) as ReadableStream<Record<string, unknown>>
    )

    expect(
      chunks
        .filter((chunk) => chunk.type === 'text-delta')
        .map((chunk) => chunk.delta)
    ).toEqual(['Hello ', ' ', 'world'])
  })

  it('emits natural assistant conversation when every SSE frame arrives in one buffer', async () => {
    vi.mocked(ModelFactory.createModel).mockRestore()
    const mockedInvoke = vi.mocked(invoke)
    mockedInvoke.mockResolvedValueOnce(
      JSON.stringify({
        status: 'ok',
        service: 'orangellm-gateway',
        boundary: 'frontier_isolation_active',
        primary: { live: true },
        routes: {
          allowed: ['GET /healthz', 'POST /v1/chat/completions'],
        },
      })
    )
    mockedInvoke.mockImplementationOnce(async (_command, args) => {
      const channel = (args as { onChunk: { onmessage?: (event: { data: string }) => void } }).onChunk
      channel.onmessage?.({
        data: [
          {
            id: 'chatcmpl-stream-proof',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'orange-auto',
            choices: [{ index: 0, delta: { role: 'assistant', content: 'The operator ' }, finish_reason: null }],
          },
          {
            id: 'chatcmpl-stream-proof',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'orange-auto',
            choices: [{ index: 0, delta: { content: 'loop is live.' }, finish_reason: null }],
          },
          {
            id: 'chatcmpl-stream-proof',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'orange-auto',
            ae_response_mode: 'conversation',
            ae_build_run: { runId: 'run-stream-proof', stage: 'settle', status: 'completed' },
            ae_turn: { receipt: { id: 'rcpt-stream-proof', seq: 1, hash: 'a'.repeat(64) } },
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          },
        ]
          .map((frame) => `data: ${JSON.stringify(frame)}\n\n`)
          .join('') + 'data: [DONE]\n\n',
      })
      return 200
    })
    const transport = new CustomChatTransport(undefined, 'thread-1')

    const chunks = await readChunks(
      (await transport.sendMessages({
        chatId: 'chat-1',
        messages: [userMessage],
        abortSignal: undefined,
        trigger: 'submit-message',
        messageId: undefined,
      })) as ReadableStream<Record<string, unknown>>
    )
    const assistantText = chunks
      .filter((chunk) => chunk.type === 'text-delta')
      .map((chunk) => chunk.delta)
      .join('')

    expect(mockedInvoke).toHaveBeenNthCalledWith(
      2,
      'stream_local_http',
      expect.objectContaining({
        url: 'http://127.0.0.1:1337/v1/chat/completions',
        timeoutSecs: 1800,
        body: expect.stringContaining('"stream":true'),
        onChunk: expect.anything(),
      })
    )
    expect(chunks.map((chunk) => chunk.type)).toEqual([
      'start',
      'start-step',
      'text-start',
      'text-delta',
      'text-delta',
      'text-end',
      'finish-step',
      'finish',
    ])
    expect(assistantText).toBe('The operator loop is live.')
    const streamRequest = mockedInvoke.mock.calls[1]?.[1] as { body: string }
    expect(JSON.parse(streamRequest.body)).toMatchObject({
      stream: true,
      ae_response_mode: 'conversation',
      ae_thread_id: 'thread-1',
      ae_build_mode: 'plan',
    })
  })

  it('does not leak Atomic Chat tools across the OrangeBrain boundary', async () => {
    useAppState.setState({
      tools: [
        {
          name: 'search',
          server: 'fixture',
          description: 'Search',
          inputSchema: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
          },
        },
      ],
      mcpToolNames: new Set(['search']),
    })
    useModelProvider.setState((state) => ({
      selectedModel: {
        ...state.selectedModel!,
        capabilities: ['tools'],
      },
    }))
    const model = fakeStreamingModel([
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'text-1' },
        { type: 'text-delta', id: 'text-1', delta: 'governed' },
        { type: 'text-end', id: 'text-1' },
        {
          type: 'finish',
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      ])
    vi.spyOn(ModelFactory, 'createModel').mockResolvedValue(model)
    const transport = new CustomChatTransport()

    await readChunks(
      (await transport.sendMessages({
        chatId: 'chat-1',
        messages: [userMessage],
        abortSignal: undefined,
        trigger: 'submit-message',
        messageId: undefined,
      })) as ReadableStream<Record<string, unknown>>
    )

    const call = vi.mocked(model.doStream).mock.calls[0]?.[0]
    expect(call?.tools).toBeUndefined()
    expect(call?.toolChoice).toBeUndefined()
  })
})
