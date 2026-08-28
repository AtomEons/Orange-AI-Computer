import { describe, expect, it, vi } from 'vitest'

import {
  ORANGE_AUTO_MODEL,
  ORANGE_BRAIN_PROVIDER,
  ORANGE_FIVE_CHAT_COMPLETIONS_URL,
  ORANGE_FIVE_HEALTH_URL,
  ORANGE_FIVE_MODELS_URL,
  ORANGE_FIVE_OPENAI_BASE_URL,
  parseOrangeFiveHealthProof,
  parseOrangeFiveModelsProof,
  probeOrangeFiveRuntime,
  resolveOrangeChatCrossing,
} from '../orange-crossing'

const healthPayload = {
  status: 'ok',
  service: 'orangellm-gateway',
  version: 'orange5.test',
  boundary: 'frontier_isolation_active',
  primary: { live: true },
  upstream: { reflex: { live: true } },
  routes: { allowed: ['GET /healthz', 'POST /v1/chat/completions'] },
}

describe('OrangeFive crossing contract', () => {
  it('pins every endpoint to the OrangeLLM loopback gateway', () => {
    expect(ORANGE_FIVE_OPENAI_BASE_URL).toBe('http://127.0.0.1:1337/v1')
    expect(ORANGE_FIVE_HEALTH_URL).toBe('http://127.0.0.1:1337/healthz')
    expect(ORANGE_FIVE_MODELS_URL).toBe('http://127.0.0.1:1337/v1/models')
    expect(ORANGE_FIVE_CHAT_COMPLETIONS_URL).toBe(
      'http://127.0.0.1:1337/v1/chat/completions'
    )
  })

  it('maps an unrelated selected provider back to Orange Auto', () => {
    expect(resolveOrangeChatCrossing('openai', 'gpt-5')).toEqual({
      providerId: ORANGE_BRAIN_PROVIDER,
      modelId: ORANGE_AUTO_MODEL,
    })
  })

  it('accepts only the governed OrangeLLM health identity and route', () => {
    expect(parseOrangeFiveHealthProof(healthPayload)).toEqual({
      service: 'orangellm-gateway',
      boundary: 'frontier_isolation_active',
      status: 'ok',
      version: 'orange5.test',
      primaryLive: true,
      reflexLive: true,
      chatRouteAdvertised: true,
    })

    expect(() =>
      parseOrangeFiveHealthProof({ ...healthPayload, service: 'other' })
    ).toThrow('identity mismatch')
    expect(() =>
      parseOrangeFiveHealthProof({ ...healthPayload, routes: { allowed: [] } })
    ).toThrow('chat-completions route')
  })

  it('requires every Atomic Orange lane in the OpenAI model list', () => {
    const modelIds = [
      'orange-auto',
      'orange-navigator',
      'orange-code',
      'orangellm-heavy',
    ]
    expect(
      parseOrangeFiveModelsProof({
        object: 'list',
        data: modelIds.map((id) => ({ id, object: 'model' })),
      })
    ).toEqual({ modelIds })

    expect(() =>
      parseOrangeFiveModelsProof({ object: 'list', data: [] })
    ).toThrow('missing')
  })

  it('performs a bounded first-use health handshake', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(healthPayload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    )

    await expect(probeOrangeFiveRuntime(fetcher)).resolves.toMatchObject({
      service: 'orangellm-gateway',
      primaryLive: true,
    })
    expect(fetcher).toHaveBeenCalledWith(
      ORANGE_FIVE_HEALTH_URL,
      expect.objectContaining({ method: 'GET' })
    )
  })

  it('reports the local reflex but rejects conversation while Navigator is disconnected', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ...healthPayload,
          primary: { live: false },
          upstream: { reflex: { live: true } },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }
      )
    )

    await expect(probeOrangeFiveRuntime(fetcher)).rejects.toThrow(
      'Codexa Navigator is disconnected'
    )
  })

  it('refuses the crossing when neither Navigator nor reflex is live', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ...healthPayload,
          primary: { live: false },
          upstream: { reflex: { live: false } },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }
      )
    )

    await expect(probeOrangeFiveRuntime(fetcher)).rejects.toThrow(
      'no live conversation route'
    )
  })
})
