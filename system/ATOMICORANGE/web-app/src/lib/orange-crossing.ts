export const ORANGE_BRAIN_PROVIDER = 'orangebrain' as const
export const ORANGE_FIVE_RUNTIME_ORIGIN = 'http://127.0.0.1:1337' as const
export const ORANGE_FIVE_OPENAI_BASE_URL =
  `${ORANGE_FIVE_RUNTIME_ORIGIN}/v1` as const
export const ORANGE_FIVE_HEALTH_URL =
  `${ORANGE_FIVE_RUNTIME_ORIGIN}/healthz` as const
export const ORANGE_FIVE_MODELS_URL =
  `${ORANGE_FIVE_OPENAI_BASE_URL}/models` as const
export const ORANGE_FIVE_CHAT_COMPLETIONS_URL =
  `${ORANGE_FIVE_OPENAI_BASE_URL}/chat/completions` as const
export const ORANGE_FIVE_MODEL_IDS = [
  'orange-auto',
  'orange-navigator',
  'orange-code',
  'orangellm-heavy',
] as const
export const ORANGE_AUTO_MODEL = ORANGE_FIVE_MODEL_IDS[0]

const ORANGE_FIVE_GATEWAY_SERVICE = 'orangellm-gateway'
const ORANGE_FIVE_BOUNDARY = 'frontier_isolation_active'
const ORANGE_FIVE_CHAT_ROUTE = 'POST /v1/chat/completions'

type JsonRecord = Record<string, unknown>

const asRecord = (value: unknown): JsonRecord | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : null

export type OrangeFiveHealthProof = {
  service: typeof ORANGE_FIVE_GATEWAY_SERVICE
  boundary: typeof ORANGE_FIVE_BOUNDARY
  status: string
  version: string | null
  primaryLive: boolean
  reflexLive: boolean
  chatRouteAdvertised: true
}

export type OrangeFiveModelsProof = {
  modelIds: string[]
}

export type OrangeFiveFetch = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>

/** Validate that a health payload came from the governed OrangeLLM gateway. */
export function parseOrangeFiveHealthProof(
  payload: unknown
): OrangeFiveHealthProof {
  const body = asRecord(payload)
  if (body?.service !== ORANGE_FIVE_GATEWAY_SERVICE) {
    throw new Error('OrangeFive health identity mismatch.')
  }
  if (body.boundary !== ORANGE_FIVE_BOUNDARY) {
    throw new Error('OrangeFive frontier-isolation boundary is not active.')
  }

  const routes = asRecord(body.routes)
  const allowedRoutes = Array.isArray(routes?.allowed)
    ? routes.allowed.filter(
        (route): route is string => typeof route === 'string'
      )
    : []
  if (!allowedRoutes.includes(ORANGE_FIVE_CHAT_ROUTE)) {
    throw new Error('OrangeFive chat-completions route is not advertised.')
  }

  const primary = asRecord(body.primary)
  const upstream = asRecord(body.upstream)
  const reflex = asRecord(upstream?.reflex)
  return {
    service: ORANGE_FIVE_GATEWAY_SERVICE,
    boundary: ORANGE_FIVE_BOUNDARY,
    status: typeof body.status === 'string' ? body.status : 'unknown',
    version: typeof body.version === 'string' ? body.version : null,
    primaryLive: primary?.live === true,
    reflexLive: reflex?.live === true,
    chatRouteAdvertised: true,
  }
}

/** Validate that OrangeLLM exposes every lane bundled into Atomic Orange. */
export function parseOrangeFiveModelsProof(
  payload: unknown
): OrangeFiveModelsProof {
  const body = asRecord(payload)
  if (body?.object !== 'list' || !Array.isArray(body.data)) {
    throw new Error(
      'OrangeFive models response is not an OpenAI-compatible list.'
    )
  }

  const modelIds = body.data
    .map((model) => asRecord(model)?.id)
    .filter((id): id is string => typeof id === 'string')
  const missing = ORANGE_FIVE_MODEL_IDS.filter((id) => !modelIds.includes(id))
  if (missing.length > 0) {
    throw new Error(
      `OrangeFive models response is missing: ${missing.join(', ')}.`
    )
  }

  return { modelIds }
}

/**
 * Perform the first-use backend handshake. Identity and the governed chat
 * route must both verify before Atomic Orange creates a language model.
 */
export async function probeOrangeFiveRuntime(
  fetcher: OrangeFiveFetch,
  timeoutMs = 10_000
): Promise<OrangeFiveHealthProof> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetcher(ORANGE_FIVE_HEALTH_URL, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    })
    if (!response.ok) {
      throw new Error(`OrangeFive health returned HTTP ${response.status}.`)
    }

    const proof = parseOrangeFiveHealthProof(await response.json())
    if (!proof.primaryLive) {
      throw new Error(
        proof.reflexLive
          ? 'Codexa Navigator is disconnected; the local OrangeFive control plane remains live.'
          : 'OrangeFive has no live conversation route.'
      )
    }
    return proof
  } finally {
    clearTimeout(timeout)
  }
}

export type OrangeChatCrossing = {
  providerId: typeof ORANGE_BRAIN_PROVIDER
  modelId: string
}

/**
 * Atomic Orange has one chat crossing. The picker may select an Orange lane,
 * but it can never select an inference provider directly.
 */
export function resolveOrangeChatCrossing(
  requestedProvider?: string,
  requestedModel?: string
): OrangeChatCrossing {
  return {
    providerId: ORANGE_BRAIN_PROVIDER,
    modelId:
      requestedProvider === ORANGE_BRAIN_PROVIDER && requestedModel
        ? requestedModel
        : ORANGE_AUTO_MODEL,
  }
}
