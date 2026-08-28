import { BASELINE_PROVIDERS } from '../web-app/src/constants/providers.ts'
import {
  ORANGE_AUTO_MODEL,
  ORANGE_BRAIN_PROVIDER,
  ORANGE_FIVE_CHAT_COMPLETIONS_URL,
  ORANGE_FIVE_HEALTH_URL,
  ORANGE_FIVE_MODEL_IDS,
  ORANGE_FIVE_MODELS_URL,
  ORANGE_FIVE_OPENAI_BASE_URL,
  parseOrangeFiveModelsProof,
  probeOrangeFiveRuntime,
} from '../web-app/src/lib/orange-crossing.ts'
import { parseOrangeReport } from '../web-app/src/lib/orange-report-view.ts'

const args = new Set(process.argv.slice(2))
const configOnly = args.has('--config-only')
const roundtrip = args.has('--roundtrip')
const roundtripTimeoutMs = Number(
  process.env.ATOMIC_ORANGE_ROUNDTRIP_TIMEOUT_MS ?? 300_000
)

if (configOnly && roundtrip) {
  throw new Error('--config-only and --roundtrip cannot be combined.')
}

if (!Number.isFinite(roundtripTimeoutMs) || roundtripTimeoutMs < 1_000) {
  throw new Error('ATOMIC_ORANGE_ROUNDTRIP_TIMEOUT_MS must be at least 1000.')
}

const asRecord = (value) =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : null

const requireCondition = (condition, message) => {
  if (!condition) throw new Error(message)
}

async function fetchJson(url, init = {}, timeoutMs = 10_000) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { ...init, signal: controller.signal })
    const text = await response.text()
    let body
    try {
      body = JSON.parse(text)
    } catch {
      throw new Error(`${url} did not return JSON.`)
    }
    if (!response.ok) {
      throw new Error(`${url} returned HTTP ${response.status}: ${text}`)
    }
    return { response, body }
  } finally {
    clearTimeout(timeout)
  }
}

async function main() {
  const provider = BASELINE_PROVIDERS.find(
    (candidate) => candidate.provider === ORANGE_BRAIN_PROVIDER
  )
  requireCondition(provider, 'Built-in OrangeBrain provider is missing.')
  requireCondition(
    provider.base_url === ORANGE_FIVE_OPENAI_BASE_URL,
    'Built-in OrangeBrain provider does not use the canonical OrangeFive URL.'
  )
  requireCondition(
    provider.api_key === '',
    'Loopback OrangeBrain provider must remain keyless by default.'
  )

  const configuredModels = provider.models.map((model) => model.id)
  for (const modelId of ORANGE_FIVE_MODEL_IDS) {
    requireCondition(
      configuredModels.includes(modelId),
      `Built-in OrangeBrain provider is missing model ${modelId}.`
    )
  }

  const report = {
    ok: true,
    proof: 'atomic-orange.orangefive-handshake.v1',
    config: {
      provider: provider.provider,
      openai_base_url: provider.base_url,
      health_url: ORANGE_FIVE_HEALTH_URL,
      models_url: ORANGE_FIVE_MODELS_URL,
      chat_completions_url: ORANGE_FIVE_CHAT_COMPLETIONS_URL,
      model_ids: configuredModels,
    },
    health: null,
    models: null,
    roundtrip: null,
  }

  if (!configOnly) {
    report.health = await probeOrangeFiveRuntime(fetch)
    const modelsResponse = await fetchJson(ORANGE_FIVE_MODELS_URL)
    report.models = parseOrangeFiveModelsProof(modelsResponse.body)
  }

  if (roundtrip) {
    const startedAt = Date.now()
    const { response, body } = await fetchJson(
      ORANGE_FIVE_CHAT_COMPLETIONS_URL,
      {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: ORANGE_AUTO_MODEL,
          stream: false,
          messages: [
            {
              role: 'user',
              content: 'Reply with exactly ORANGE_HANDSHAKE_OK.',
            },
          ],
        }),
      },
      roundtripTimeoutMs
    )

    const completion = asRecord(body)
    const choice = asRecord(completion?.choices?.[0])
    const message = asRecord(choice?.message)
    const turn = asRecord(completion?.ae_turn)
    const receipt = asRecord(turn?.receipt)
    const orderId = completion?.ae_order_id ?? turn?.order_id
    const orangeReport =
      typeof message?.content === 'string'
        ? parseOrangeReport(message.content)
        : null

    requireCondition(
      typeof message?.content === 'string' && message.content.length > 0,
      'Roundtrip response has no assistant content.'
    )
    requireCondition(
      typeof orderId === 'string' && orderId.length > 0,
      'Roundtrip response has no Orange order id.'
    )
    requireCondition(
      completion?.ae_response_contract === 'orange.report.v1',
      'Roundtrip response does not declare orange.report.v1.'
    )
    requireCondition(
      orangeReport,
      'Roundtrip assistant content is not a valid orange.report.v1.'
    )
    requireCondition(
      orangeReport.orderId === orderId,
      'Roundtrip report orderId does not match the gateway order id.'
    )
    requireCondition(
      typeof receipt?.id === 'string' && receipt.id.length > 0,
      'Roundtrip response has no Orange receipt id.'
    )
    requireCondition(
      Number.isInteger(receipt?.seq) && receipt.seq > 0,
      'Roundtrip response has no valid Orange receipt sequence.'
    )
    requireCondition(
      typeof receipt?.hash === 'string' && /^[a-f0-9]{64}$/i.test(receipt.hash),
      'Roundtrip response has no valid SHA-256 Orange receipt hash.'
    )
    requireCondition(
      typeof completion?.ae_lane === 'string' && completion.ae_lane.length > 0,
      'Roundtrip response has no Orange route lane.'
    )
    requireCondition(
      typeof completion?.model === 'string' && completion.model.length > 0,
      'Roundtrip response has no effective model id.'
    )
    report.roundtrip = {
      elapsed_ms: Date.now() - startedAt,
      timeout_ms: roundtripTimeoutMs,
      gateway_header: response.headers.get('x-orange-gateway'),
      order_id: orderId,
      lane: completion.ae_lane ?? turn?.route?.lane ?? null,
      model: completion.model ?? null,
      response_contract: completion.ae_response_contract ?? null,
      execution_performed: completion.ae_execution_performed === true,
      receipt: {
        id: receipt.id,
        seq: receipt.seq,
        hash: receipt.hash,
      },
      report: orangeReport,
    }
  }

  console.log(JSON.stringify(report, null, 2))
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        ok: false,
        proof: 'atomic-orange.orangefive-handshake.v1',
        error: error instanceof Error ? error.message : String(error),
      },
      null,
      2
    )
  )
  process.exitCode = 1
})
