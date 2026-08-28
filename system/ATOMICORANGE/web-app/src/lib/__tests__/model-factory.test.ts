import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ModelFactory } from '../model-factory'
import type { ProviderObject } from '@janhq/core'
import { invoke } from '@tauri-apps/api/core'
import { fetch as httpFetch } from '@tauri-apps/plugin-http'
import { OpenAICompatibleChatLanguageModel } from '@ai-sdk/openai-compatible'
import type { ModelsService } from '@/services/models/types'
import { seedServiceHub } from '@/test/service-hub'
import {
  ORANGE_FIVE_CHAT_COMPLETIONS_URL,
  ORANGE_FIVE_HEALTH_URL,
} from '../orange-crossing'

// Mock the Tauri invoke function
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  Channel: class {
    onmessage: ((event: { data: string }) => void) | undefined
  },
}))

// Mock the Tauri HTTP plugin
vi.mock('@tauri-apps/plugin-http', () => ({
  fetch: vi.fn(),
}))

// Mock the AI SDK providers
vi.mock('@ai-sdk/openai-compatible', () => {
  const MockChatModel = vi.fn().mockImplementation(() => ({
    type: 'foundation-models',
    modelId: 'apple/on-device',
  }))
  return {
    createOpenAICompatible: vi.fn(() => ({
      languageModel: vi.fn(() => ({ type: 'openai-compatible' })),
    })),
    OpenAICompatibleChatLanguageModel: MockChatModel,
    MetadataExtractor: vi.fn(),
  }
})

vi.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: vi.fn(() => vi.fn(() => ({ type: 'anthropic' }))),
}))

vi.mock('ai', () => ({
  wrapLanguageModel: vi.fn(({ model }) => model),
  extractReasoningMiddleware: vi.fn(() => ({})),
}))

const mockStartModel = vi.fn().mockResolvedValue(undefined)

const mockedInvoke = vi.mocked(invoke)
const mockedHttpFetch = vi.mocked(httpFetch)
const mockedOpenAICompatibleModel = vi.mocked(OpenAICompatibleChatLanguageModel)

describe('ModelFactory', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockStartModel.mockResolvedValue(undefined)
    seedServiceHub({
      models: {
        startModel: mockStartModel,
      } as ModelsService,
    })
    ModelFactory.invalidateFoundationModelsAvailabilityCache()
  })

  describe('createModel', () => {
    it('should create an Anthropic model for anthropic provider', async () => {
      const provider: ProviderObject = {
        provider: 'anthropic',
        api_key: 'test-api-key',
        base_url: 'https://api.anthropic.com/v1',
        models: [],
        settings: [],
        active: true,
        custom_header: [{ header: 'anthropic-version', value: '2023-06-01' }],
      }

      const model = await ModelFactory.createModel('claude-3-opus', provider)
      expect(model).toBeDefined()
      expect(model.type).toBe('anthropic')
    })

    it('should create a Google model for google provider', async () => {
      const provider: ProviderObject = {
        provider: 'google',
        api_key: 'test-api-key',
        base_url: 'https://generativelanguage.googleapis.com/v1',
        models: [],
        settings: [],
        active: true,
      }

      const model = await ModelFactory.createModel('gemini-pro', provider)
      expect(model).toBeDefined()
      expect(model.type).toBe('openai-compatible')
    })

    it('should create a Google model for gemini provider', async () => {
      const provider: ProviderObject = {
        provider: 'gemini',
        api_key: 'test-api-key',
        base_url: 'https://generativelanguage.googleapis.com/v1',
        models: [],
        settings: [],
        active: true,
      }

      const model = await ModelFactory.createModel('gemini-pro', provider)
      expect(model).toBeDefined()
      expect(model.type).toBe('openai-compatible')
    })

    it('should create an OpenAI-compatible model for openai provider', async () => {
      const provider: ProviderObject = {
        provider: 'openai',
        api_key: 'test-api-key',
        base_url: 'https://api.openai.com/v1',
        models: [],
        settings: [],
        active: true,
      }

      const model = await ModelFactory.createModel('gpt-4', provider)
      expect(model).toBeDefined()
    })

    it('should create an OpenAI-compatible model for groq provider', async () => {
      const provider: ProviderObject = {
        provider: 'groq',
        api_key: 'test-api-key',
        base_url: 'https://api.groq.com/openai/v1',
        models: [],
        settings: [],
        active: true,
      }

      const model = await ModelFactory.createModel('llama-3', provider)
      expect(model).toBeDefined()
      expect(model.type).toBe('openai-compatible')
    })

    it('should create an OpenAI-compatible model for minimax provider', async () => {
      const provider: ProviderObject = {
        provider: 'minimax',
        api_key: 'test-api-key',
        base_url: 'https://api.minimax.io/v1',
        models: [],
        settings: [],
        active: true,
      }

      const model = await ModelFactory.createModel('MiniMax-M2.7', provider)
      expect(model).toBeDefined()
      expect(model.type).toBe('openai-compatible')
    })

    it('should handle custom headers for OpenAI-compatible providers', async () => {
      const provider: ProviderObject = {
        provider: 'custom',
        api_key: 'test-api-key',
        base_url: 'https://custom.api.com/v1',
        models: [],
        settings: [],
        active: true,
        custom_header: [{ header: 'X-Custom-Header', value: 'custom-value' }],
      }

      const model = await ModelFactory.createModel('custom-model', provider)
      expect(model).toBeDefined()
      expect(model.type).toBe('openai-compatible')
    })

    it('handshakes with and streams conversation through the OrangeFive gateway', async () => {
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
      const provider: ProviderObject = {
        provider: 'orangebrain',
        api_key: '',
        base_url: 'https://bypass.invalid/v1',
        models: [],
        settings: [],
        active: true,
      }

      await ModelFactory.createModel('orange-auto', provider)

      expect(mockedInvoke).toHaveBeenCalledWith(
        'get_local_http',
        expect.objectContaining({
          url: ORANGE_FIVE_HEALTH_URL,
          timeoutSecs: 10,
        })
      )
      expect(mockedHttpFetch).not.toHaveBeenCalled()
      const config = mockedOpenAICompatibleModel.mock.calls.at(-1)?.[1] as {
        provider: string
        url: (options: { path: string }) => string
        fetch: typeof fetch
        metadataExtractor: {
          extractMetadata: (args: { parsedBody: unknown }) => Promise<{
            providerMetadata: Record<string, Record<string, unknown>>
          } | undefined>
        }
      }
      expect(config.provider).toBe('orangebrain')
      expect(config.url({ path: '/chat/completions' })).toBe(
        ORANGE_FIVE_CHAT_COMPLETIONS_URL
      )

      const measuredMetadata = await config.metadataExtractor.extractMetadata({
        parsedBody: {
          usage: { completion_tokens: 20 },
          ae_native_ollama: { eval_duration_ns: 2_000_000_000 },
          ae_response_contract: 'orange.report.v1',
          ae_turn: {
            receipt: { id: 'rcpt-metrics', seq: 2, hash: 'b'.repeat(64) },
          },
        },
      })
      expect(
        measuredMetadata?.providerMetadata.tokensPerSecond
      ).toBe(10)

      mockedInvoke.mockImplementationOnce(async (_command, args) => {
        const channel = (args as { onChunk: { onmessage?: (event: { data: string }) => void } }).onChunk
        channel.onmessage?.({
          data: `data: ${JSON.stringify({
            id: 'chatcmpl-proof',
            object: 'chat.completion.chunk',
            model: 'orange-navigator:q8',
            choices: [{ index: 0, delta: { role: 'assistant', content: 'Orange ' }, finish_reason: null }],
          })}\n\n`,
        })
        channel.onmessage?.({
          data: `data: ${JSON.stringify({
            id: 'chatcmpl-proof',
            object: 'chat.completion.chunk',
            model: 'orange-navigator:q8',
            choices: [{ index: 0, delta: { content: 'is answering live.' }, finish_reason: null }],
          })}\n\n`,
        })
        channel.onmessage?.({
          data: `data: ${JSON.stringify({
            id: 'chatcmpl-proof',
            object: 'chat.completion.chunk',
            model: 'orange-navigator:q8',
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            ae_turn: {
              receipt: { id: 'rcpt-proof', seq: 1, hash: 'a'.repeat(64) },
            },
          })}\n\ndata: [DONE]\n\n`,
        })
        return 200
      })
      const streamResponse = await config.fetch(
        ORANGE_FIVE_CHAT_COMPLETIONS_URL,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'orange-auto',
            stream: true,
            messages: [{ role: 'user', content: 'prove it' }],
          }),
        }
      )
      const streamBody = await streamResponse.text()

      expect(streamResponse.headers.get('content-type')).toContain(
        'text/event-stream'
      )
      const firstFrame = JSON.parse(
        streamBody
          .split(/\r?\n/)
          .find((line) => line.startsWith('data: {'))!
          .slice(5)
          .trim()
      )
      expect(firstFrame.choices[0].delta.content).toBe('Orange ')
      const assembledContent = streamBody
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data: {'))
        .map((line) => JSON.parse(line.slice(5).trim()))
        .map((frame) => frame.choices?.[0]?.delta?.content ?? '')
        .join('')
      expect(assembledContent).toBe('Orange is answering live.')
      expect(streamBody).toContain('"id":"rcpt-proof"')
      expect(streamBody).toContain('data: [DONE]')
      expect(mockedInvoke).toHaveBeenLastCalledWith(
        'stream_local_http',
        expect.objectContaining({
          url: ORANGE_FIVE_CHAT_COMPLETIONS_URL,
          timeoutSecs: 1800,
          body: expect.stringContaining('"stream":true'),
          onChunk: expect.anything(),
        })
      )
      const streamRequest = mockedInvoke.mock.calls.at(-1)?.[1] as {
        body: string
      }
      const streamRequestBody = JSON.parse(streamRequest.body) as Record<
        string,
        unknown
      >
      expect(streamRequestBody).toMatchObject({
        stream: true,
        ae_response_mode: 'conversation',
      })
      expect(streamRequestBody).not.toHaveProperty('ae_response_contract')
      expect(streamRequestBody).not.toHaveProperty('ae_evidence_policy')
    })
  })

  describe('foundation-models provider', () => {
    const foundationModelsProvider: ProviderObject = {
      provider: 'foundation-models',
      models: [],
      settings: [],
      active: true,
    }

    it('should throw with notEligible message when device is not eligible', async () => {
      mockedInvoke.mockResolvedValueOnce('notEligible')

      await expect(
        ModelFactory.createModel('apple/on-device', foundationModelsProvider)
      ).rejects.toThrow(
        'Apple Intelligence is not supported on this device. An Apple Silicon Mac (M1 or later) with macOS 26+ is required.'
      )

      expect(mockedInvoke).toHaveBeenCalledWith(
        'plugin:foundation-models|check_foundation_models_availability',
        {}
      )
    })

    it('should throw when Apple Intelligence is not enabled', async () => {
      mockedInvoke.mockResolvedValueOnce('appleIntelligenceNotEnabled')

      await expect(
        ModelFactory.createModel('apple/on-device', foundationModelsProvider)
      ).rejects.toThrow(
        'Apple Intelligence is not enabled. Please enable it in System Settings > Apple Intelligence & Siri.'
      )
    })

    it('should throw when the model is not ready', async () => {
      mockedInvoke.mockResolvedValueOnce('modelNotReady')

      await expect(
        ModelFactory.createModel('apple/on-device', foundationModelsProvider)
      ).rejects.toThrow(
        'The Apple on-device model is still preparing. Please wait and try again shortly.'
      )
    })

    it('should throw when the server binary is missing', async () => {
      mockedInvoke.mockResolvedValueOnce('binaryNotFound')

      await expect(
        ModelFactory.createModel('apple/on-device', foundationModelsProvider)
      ).rejects.toThrow(
        'The Foundation Models server binary is missing. Please reinstall the app.'
      )
    })

    it('should throw with generic unavailable message for unknown status', async () => {
      mockedInvoke.mockResolvedValueOnce('unavailable')

      await expect(
        ModelFactory.createModel('apple/on-device', foundationModelsProvider)
      ).rejects.toThrow(
        'Apple Foundation Models are currently unavailable on this device.'
      )
    })

    it('should throw when available but no session is found after start', async () => {
      mockedInvoke
        .mockResolvedValueOnce('available') // check_foundation_models_availability
        .mockResolvedValueOnce(null) // find_foundation_models_session

      await expect(
        ModelFactory.createModel('apple/on-device', foundationModelsProvider)
      ).rejects.toThrow(
        'No running Foundation Models session. The server may have failed to start'
      )
    })

    it('should create a model when available and session exists', async () => {
      mockedInvoke
        .mockResolvedValueOnce('available') // check_foundation_models_availability
        .mockResolvedValueOnce({
          // find_foundation_models_session
          pid: 12345,
          port: 9876,
          model_id: 'apple/on-device',
          api_key: 'test-session-key',
        })

      const model = await ModelFactory.createModel(
        'apple/on-device',
        foundationModelsProvider
      )

      expect(model).toBeDefined()
      expect(mockedInvoke).toHaveBeenCalledWith(
        'plugin:foundation-models|check_foundation_models_availability',
        {}
      )
      expect(mockedInvoke).toHaveBeenCalledWith(
        'plugin:foundation-models|find_foundation_models_session',
        {}
      )
    })
  })
})
