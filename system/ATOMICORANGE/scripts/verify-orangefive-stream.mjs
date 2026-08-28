import { parseOrangeReport } from '../web-app/src/lib/orange-report-view.ts'
import {
  ORANGE_AUTO_MODEL,
  ORANGE_FIVE_CHAT_COMPLETIONS_URL,
} from '../web-app/src/lib/orange-crossing.ts'

const timeoutMs = Number(
  process.env.ATOMIC_ORANGE_STREAM_TIMEOUT_MS ?? 300_000
)
const controller = new AbortController()
const timer = setTimeout(() => controller.abort(), timeoutMs)

const fail = (message) => {
  throw new Error(message)
}

async function main() {
  const startedAt = Date.now()
  const response = await fetch(ORANGE_FIVE_CHAT_COMPLETIONS_URL, {
    method: 'POST',
    headers: {
      Accept: 'text/event-stream',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: ORANGE_AUTO_MODEL,
      stream: true,
      messages: [
        {
          role: 'user',
          content:
            'Transform this literal string to lowercase: ATOMIC-ORANGE-SSE-PROOF. Return the result as an Orange report.',
        },
      ],
    }),
    signal: controller.signal,
  })

  if (!response.ok) {
    fail(`Streaming endpoint returned HTTP ${response.status}: ${await response.text()}`)
  }
  if (!response.body) fail('Streaming endpoint returned no response body.')

  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.includes('text/event-stream')) {
    fail(`Streaming endpoint returned ${contentType || 'no content type'}.`)
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''
  let doneSeen = false
  let firstChunkMs = null
  let frames = 0
  let orderId = null
  let receipt = null
  let lane = null
  let model = null
  let responseContract = null

  const consumeLine = (line) => {
    if (!line.startsWith('data:')) return
    const data = line.slice(5).trim()
    if (data === '[DONE]') {
      doneSeen = true
      return
    }
    if (!data) return
    const frame = JSON.parse(data)
    frames += 1
    content += frame.choices?.[0]?.delta?.content ?? ''
    orderId ??= frame.ae_order_id ?? frame.ae_turn?.order_id ?? null
    receipt ??= frame.ae_turn?.receipt ?? null
    lane ??= frame.ae_lane ?? frame.ae_turn?.route?.lane ?? null
    model ??= frame.model ?? null
    responseContract ??= frame.ae_response_contract ?? null
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (firstChunkMs === null) firstChunkMs = Date.now() - startedAt
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() ?? ''
    for (const line of lines) consumeLine(line)
  }
  buffer += decoder.decode()
  for (const line of buffer.split(/\r?\n/)) consumeLine(line)

  const report = parseOrangeReport(content)
  if (!doneSeen) fail('Streaming endpoint closed without [DONE].')
  if (!report) fail('Streaming content is not a valid orange.report.v1.')
  if (report.orderId !== orderId) fail('Streaming order IDs do not match.')
  if (responseContract !== 'orange.report.v1') {
    fail('Streaming endpoint did not declare orange.report.v1.')
  }
  if (!receipt?.id || !Number.isInteger(receipt?.seq)) {
    fail('Streaming endpoint returned no sequenced receipt.')
  }
  if (!/^[a-f0-9]{64}$/i.test(receipt?.hash ?? '')) {
    fail('Streaming endpoint returned no valid receipt hash.')
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        proof: 'atomic-orange.orangefive-sse.v1',
        elapsed_ms: Date.now() - startedAt,
        first_chunk_ms: firstChunkMs,
        frames,
        lane,
        model,
        response_contract: responseContract,
        receipt,
        report,
      },
      null,
      2
    )
  )
}

main()
  .catch((error) => {
    console.error(
      JSON.stringify(
        {
          ok: false,
          proof: 'atomic-orange.orangefive-sse.v1',
          error: error instanceof Error ? error.message : String(error),
        },
        null,
        2
      )
    )
    process.exitCode = 1
  })
  .finally(() => clearTimeout(timer))
