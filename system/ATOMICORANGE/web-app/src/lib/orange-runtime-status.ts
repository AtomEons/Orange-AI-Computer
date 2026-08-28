import { ORANGE_FIVE_HEALTH_URL } from '@/lib/orange-crossing'
import { fetch as tauriFetch } from '@tauri-apps/plugin-http'

const HERMES_HEALTH_URL = 'http://127.0.0.1:7430/healthz'
const ATOMSMASHER_HEALTH_URL = 'http://127.0.0.1:8901/health'
const LEARNING_STATUS_URL = 'http://127.0.0.1:1337/v1/ops/learning'

type JsonRecord = Record<string, unknown>

const asRecord = (value: unknown): JsonRecord | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : null

const asBoolean = (value: unknown) => value === true
const asNumber = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? value : null
const asString = (value: unknown) =>
  typeof value === 'string' && value.length > 0 ? value : null

export type OrangeRuntimeStatus = {
  checkedAt: string
  gateway: {
    live: boolean
    degraded: boolean
    status: string | null
    version: string | null
    reflexLive: boolean
  }
  navigator: {
    live: boolean
    warm: boolean
    model: string | null
    host: string | null
  }
  codexa: {
    state: 'connected' | 'disconnected' | 'local' | 'unknown'
    expected: boolean
    connected: boolean
    host: string | null
    nodeId: string | null
  }
  memory: {
    live: boolean
    latencyMs: number | null
    serving: string | null
  }
  hermes: {
    live: boolean
    gates: number | null
    activeLeases: number | null
    misfit: boolean
  }
  atomSmasher: {
    live: boolean
    features: number | null
    receipts: number | null
  }
  learning: {
    live: boolean
    total: number | null
    open: number | null
    failed: number | null
  }
}

export function parseOrangeRuntimeStatus(
  gatewayPayload: unknown,
  hermesPayload: unknown,
  atomPayload: unknown,
  learningPayload: unknown,
  checkedAt = new Date().toISOString()
): OrangeRuntimeStatus {
  const gateway = asRecord(gatewayPayload)
  const primary = asRecord(gateway?.primary)
  const upstream = asRecord(gateway?.upstream)
  const reflex = asRecord(upstream?.reflex)
  const upstreamNavigator = asRecord(upstream?.navigator)
  const fabric = asRecord(gateway?.fabric)
  const memory = asRecord(gateway?.memory)
  const cobra = asRecord(memory?.cobra)

  const hermesEnvelope = asRecord(hermesPayload)
  const hermes = asRecord(hermesEnvelope?.data)
  const misfit = asRecord(hermes?.misfit)

  const atom = asRecord(atomPayload)
  const atomCounts = asRecord(atom?.counts)

  const learning = asRecord(learningPayload)
  const learningStats = asRecord(learning?.stats)
  const gatewayIdentified =
    gateway?.service === 'orangellm-gateway' &&
    gateway?.boundary === 'frontier_isolation_active'
  const reflexLive = asBoolean(reflex?.live)
  const navigatorLive =
    asBoolean(primary?.live) || asBoolean(upstreamNavigator?.live)
  const fabricMode = asString(fabric?.mode)
  const codexaExpected =
    fabricMode === 'distributed' || asBoolean(fabric?.navigatorPhysicalRemote)
  const codexaState = !fabricMode
    ? 'unknown'
    : codexaExpected
      ? navigatorLive
        ? 'connected'
        : 'disconnected'
      : 'local'

  return {
    checkedAt,
    gateway: {
      live: gatewayIdentified && (reflexLive || navigatorLive),
      degraded: gatewayIdentified && gateway?.status !== 'ok',
      status: asString(gateway?.status),
      version: asString(gateway?.version),
      reflexLive,
    },
    navigator: {
      live: navigatorLive,
      warm: asBoolean(primary?.warm),
      model: asString(primary?.model),
      host: asString(primary?.host),
    },
    codexa: {
      state: codexaState,
      expected: codexaExpected,
      connected: codexaState === 'connected',
      host: asString(fabric?.navigatorHost) ?? asString(primary?.host),
      nodeId: asString(fabric?.navigatorNodeId),
    },
    memory: {
      live: asBoolean(cobra?.live),
      latencyMs: asNumber(cobra?.latency_ms),
      serving: asString(memory?.serving),
    },
    hermes: {
      live: hermesEnvelope?.ok === true && hermes?.status === 'alive',
      gates: asNumber(hermes?.gates),
      activeLeases: asNumber(hermes?.active_leases),
      misfit: asBoolean(misfit?.enabled) && misfit?.load_error == null,
    },
    atomSmasher: {
      live: atom?.ok === true && atom?.service === 'atomsmasher2',
      features: asNumber(atomCounts?.features),
      receipts: asNumber(atomCounts?.receipts),
    },
    learning: {
      live: learning?.schema === 'orange.ops.learning.v1',
      total: asNumber(learningStats?.total),
      open: asNumber(learningStats?.open),
      failed: asNumber(learningStats?.failed),
    },
  }
}

async function fetchJson(url: string, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    // The Orange organs are loopback-only services and intentionally do not
    // expose browser CORS headers. Native Atomic Orange must cross through
    // Tauri's HTTP plugin; the browser fetch remains useful for web preview.
    const fetcher = typeof IS_TAURI !== 'undefined' && IS_TAURI ? tauriFetch : fetch
    const response = await fetcher(url, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`${url} returned ${response.status}`)
    return await response.json()
  } finally {
    clearTimeout(timeout)
  }
}

const valueOrEmpty = (result: PromiseSettledResult<unknown>) =>
  result.status === 'fulfilled' ? result.value : null

export async function readOrangeRuntimeStatus(
  timeoutMs = 5_000
): Promise<OrangeRuntimeStatus> {
  const [gateway, hermes, atom, learning] = await Promise.allSettled([
    fetchJson(ORANGE_FIVE_HEALTH_URL, timeoutMs),
    fetchJson(HERMES_HEALTH_URL, timeoutMs),
    fetchJson(ATOMSMASHER_HEALTH_URL, timeoutMs),
    fetchJson(LEARNING_STATUS_URL, timeoutMs),
  ])

  return parseOrangeRuntimeStatus(
    valueOrEmpty(gateway),
    valueOrEmpty(hermes),
    valueOrEmpty(atom),
    valueOrEmpty(learning)
  )
}

export const EMPTY_ORANGE_RUNTIME_STATUS: OrangeRuntimeStatus =
  parseOrangeRuntimeStatus(null, null, null, null)
