import { createHash } from 'node:crypto'
import { mkdir, readFile, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeChainedJsonReceipt } from '../../10-RECEIPTS/tools/json-receipt-chain.mjs'
import { parseOrangeReport } from '../web-app/src/lib/orange-report-view.ts'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const port = Number(process.env.ATOMIC_ORANGE_CDP_PORT ?? 9229)
const timeoutMs = Number(process.env.ATOMIC_ORANGE_NATIVE_TIMEOUT_MS ?? 420_000)
const prompt =
  process.env.ATOMIC_ORANGE_NATIVE_PROMPT ??
  'In one conversational sentence, explain why OrangeFive separates model output from real execution, and end with this exact inert conversation marker: ATOMIC-ORANGE-CONVERSATION-OK. Do not claim you executed anything.'
const expectedToken =
  process.env.ATOMIC_ORANGE_EXPECTED_TOKEN ?? 'ATOMIC-ORANGE-CONVERSATION-OK'
const screenshotPath = resolve(
  process.env.ATOMIC_ORANGE_SCREENSHOT ?? 'atomic-orange-native-proof.png'
)
const receiptRoot = resolve(
  process.env.ATOMIC_ORANGE_RECEIPT_ROOT ?? resolve(
    scriptDir,
    '../../10-RECEIPTS/orange5-build'
  )
)
const nativePid = Number(process.env.ATOMIC_ORANGE_NATIVE_PID ?? 0)
const nativeExecutable = process.env.ATOMIC_ORANGE_NATIVE_EXE
  ? resolve(process.env.ATOMIC_ORANGE_NATIVE_EXE)
  : null
const inspectOnly = process.env.ATOMIC_ORANGE_INSPECT_ONLY === '1'
const stopActive = process.env.ATOMIC_ORANGE_STOP_ACTIVE === '1'
const probeBuffered = process.env.ATOMIC_ORANGE_PROBE_BUFFERED === '1'
const freshThread = process.env.ATOMIC_ORANGE_FRESH_THREAD !== '0'

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error('ATOMIC_ORANGE_CDP_PORT must be a valid TCP port.')
}

if (!Number.isFinite(timeoutMs) || timeoutMs < 10_000) {
  throw new Error('ATOMIC_ORANGE_NATIVE_TIMEOUT_MS must be at least 10000.')
}

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
const sha256 = (value) => createHash('sha256').update(value).digest('hex')
let lastDiagnostics = {}

function processIsLive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitForTarget() {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    try {
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(
        (response) => response.json()
      )
      const target = targets.find(
        (candidate) =>
          candidate.type === 'page' &&
          typeof candidate.webSocketDebuggerUrl === 'string'
      )
      if (target) return target
    } catch {
      // The native shell may still be starting.
    }
    await sleep(500)
  }
  throw new Error(`No Atomic Orange WebView2 target appeared on CDP port ${port}.`)
}

async function openCdp(url) {
  const socket = new WebSocket(url)
  const pending = new Map()
  const errors = []
  const network = []
  const orangeRequestIds = new Set()
  let nextId = 0

  await new Promise((resolveOpen, rejectOpen) => {
    const timer = setTimeout(
      () => rejectOpen(new Error('Timed out opening the WebView2 CDP socket.')),
      15_000
    )
    socket.onopen = () => {
      clearTimeout(timer)
      resolveOpen()
    }
    socket.onerror = () => {
      clearTimeout(timer)
      rejectOpen(new Error('WebView2 CDP socket failed to open.'))
    }
  })

  socket.onmessage = (event) => {
    const message = JSON.parse(event.data)
    if (message.id && pending.has(message.id)) {
      const waiter = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) waiter.reject(new Error(message.error.message))
      else waiter.resolve(message.result)
      return
    }
    if (message.method === 'Runtime.exceptionThrown') {
      errors.push(message.params?.exceptionDetails?.text ?? 'Runtime exception')
    }
    if (
      message.method === 'Log.entryAdded' &&
      ['error', 'warning'].includes(message.params?.entry?.level)
    ) {
      errors.push(message.params.entry.text)
    }
    if (
      message.method === 'Network.requestWillBeSent' &&
      message.params?.request?.url?.startsWith('http://127.0.0.1:1337/')
    ) {
      orangeRequestIds.add(message.params.requestId)
      network.push({
        event: 'request',
        requestId: message.params.requestId,
        method: message.params.request.method,
        url: message.params.request.url,
      })
    }
    if (
      message.method === 'Network.responseReceived' &&
      orangeRequestIds.has(message.params?.requestId)
    ) {
      network.push({
        event: 'response',
        requestId: message.params.requestId,
        status: message.params.response?.status,
        mimeType: message.params.response?.mimeType,
      })
    }
    if (
      message.method === 'Network.loadingFailed' &&
      orangeRequestIds.has(message.params?.requestId)
    ) {
      network.push({
        event: 'failed',
        requestId: message.params.requestId,
        errorText: message.params.errorText,
        canceled: message.params.canceled === true,
      })
    }
  }

  const send = (method, params = {}) =>
    new Promise((resolveSend, rejectSend) => {
      const id = ++nextId
      pending.set(id, { resolve: resolveSend, reject: rejectSend })
      socket.send(JSON.stringify({ id, method, params }))
    })

  return { socket, send, errors, network }
}

async function main() {
  const startedAt = Date.now()
  const target = await waitForTarget()
  const cdp = await openCdp(target.webSocketDebuggerUrl)
  lastDiagnostics = { runtime_errors: cdp.errors, network: cdp.network }
  await cdp.send('Runtime.enable')
  await cdp.send('Log.enable')
  await cdp.send('Page.enable')
  await cdp.send('Network.enable')

  const evaluate = async (expression) => {
    const result = await cdp.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (result.exceptionDetails) {
      const detail =
        result.exceptionDetails.exception?.description ??
        result.exceptionDetails.exception?.value ??
        result.exceptionDetails.text ??
        'WebView evaluation failed.'
      throw new Error(
        `${detail} at ${result.exceptionDetails.lineNumber ?? '?'}:${result.exceptionDetails.columnNumber ?? '?'}`
      )
    }
    return result.result?.value
  }

  const waitFor = async (expression, label, budgetMs = timeoutMs) => {
    const deadline = Date.now() + budgetMs
    while (Date.now() < deadline) {
      if (await evaluate(expression)) return
      await sleep(500)
    }
    throw new Error(`Timed out waiting for ${label}.`)
  }

  await waitFor(
    `Boolean(document.querySelector('[data-testid="chat-input"]'))`,
    'the native chat input',
    90_000
  )

  if (freshThread) {
    const freshThreadState = await evaluate(`(() => {
      const button = [...document.querySelectorAll('button')].find((candidate) => {
        const label = candidate.innerText?.trim().toLowerCase()
        return label === 'new chat' || label === 'new task'
      })
      if (button) {
        button.click()
        return { clicked: true, path: location.pathname }
      }
      if (location.pathname === '/') return { clicked: false, path: location.pathname }
      history.pushState({}, '', '/')
      window.dispatchEvent(new PopStateEvent('popstate'))
      return { clicked: false, navigated: true, path: location.pathname }
    })()`)
    await waitFor(
      `location.pathname === '/' && Boolean(document.querySelector('[data-testid="chat-input"]'))`,
      'a fresh native chat',
      30_000
    )
    if (!freshThreadState?.clicked && !freshThreadState?.navigated && freshThreadState?.path !== '/') {
      throw new Error('Atomic Orange could not open a fresh chat.')
    }
  }

  const threadStateBefore = await evaluate(`(async () => {
    const match = location.pathname.match(/^\\/threads\\/([^/]+)$/)
    const threadId = match?.[1] ?? null
    const messages = threadId && window.__TAURI_INTERNALS__?.invoke
      ? await window.__TAURI_INTERNALS__.invoke('list_messages', { threadId })
      : []
    return {
      threadId,
      messageIds: Array.isArray(messages) ? messages.map((message) => message.id) : [],
    }
  })()`)

  if (probeBuffered) {
    const raw = await evaluate(`window.__TAURI_INTERNALS__.invoke('post_local_http', {
      url: 'http://127.0.0.1:1337/v1/chat/completions',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'orange-auto',
        stream: false,
        messages: [{ role: 'user', content: ${JSON.stringify(prompt)} }],
      }),
      timeoutSecs: Math.max(300, Math.ceil(${timeoutMs} / 1000)),
    })`)
    const response = JSON.parse(String(raw))
    const content = response.choices?.[0]?.message?.content ?? ''
    const receipt = response.ae_turn?.receipt ?? null
    const responseContract = response.ae_response_contract ?? null
    const report = parseOrangeReport(content)
    const proof = {
      ok:
        responseContract === 'orange.report.v1' &&
        Boolean(report) &&
        Boolean(receipt?.id) &&
        Number.isInteger(receipt?.seq) &&
        /^[a-f0-9]{64}$/i.test(receipt?.hash ?? ''),
      proof: 'atomic-orange.native-buffered-ipc.v1',
      elapsed_ms: Date.now() - startedAt,
      responseContract,
      receipt,
      report,
    }
    cdp.socket.close()
    console.log(JSON.stringify(proof, null, 2))
    if (!proof.ok) process.exitCode = 1
    return
  }

  if (stopActive) {
    const stopped = await evaluate(`(() => {
      const button = document.querySelector('button.bg-destructive')
      if (!button) return false
      button.click()
      return true
    })()`)
    cdp.socket.close()
    console.log(
      JSON.stringify(
        { ok: stopped, proof: 'atomic-orange.native-stop.v1', stopped },
        null,
        2
      )
    )
    if (!stopped) process.exitCode = 1
    return
  }

  if (inspectOnly) {
    const inspection = await evaluate(`(async () => {
      const threadId = location.pathname.split('/').filter(Boolean).at(-1) ?? null
      let persistedMessages = null
      let persistedMessagesError = null
      if (threadId && window.__TAURI_INTERNALS__?.invoke) {
        try {
          persistedMessages = await window.__TAURI_INTERNALS__.invoke('list_messages', { threadId })
        } catch (error) {
          persistedMessagesError = String(error)
        }
      }
      return {
        title: document.title,
        url: location.href,
        bodyText: document.body.innerText.slice(-6000),
        chatInputValue: document.querySelector('[data-testid="chat-input"]')?.value ?? null,
        sendButtonPresent: Boolean(document.querySelector('[data-test-id="send-message-button"]')),
        sendButtonDisabled: document.querySelector('[data-test-id="send-message-button"]')?.disabled ?? null,
        stopButtonPresent: Boolean(document.querySelector('button.bg-destructive')),
        orangeReportCount: document.querySelectorAll('section[aria-label^="Orange report:"]').length,
        persistedMessages,
        persistedMessagesError,
      }
    })()`)
    cdp.socket.close()
    console.log(
      JSON.stringify(
        { ok: true, proof: 'atomic-orange.native-inspection.v1', inspection },
        null,
        2
      )
    )
    return
  }

  await evaluate(`(() => {
    const input = document.querySelector('[data-testid="chat-input"]')
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value'
    ).set
    setter.call(input, ${JSON.stringify(prompt)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.focus()
    return input.value
  })()`)

  await waitFor(
    `Boolean(document.querySelector('[data-test-id="send-message-button"]:not([disabled])'))`,
    'the enabled native send button',
    30_000
  )

  await evaluate(
    `document.querySelector('[data-test-id="send-message-button"]').click()`
  )

  const priorMessageIds = JSON.stringify(threadStateBefore.messageIds ?? [])
  await waitFor(
    `(async () => {
      const match = location.pathname.match(/^\\/threads\\/([^/]+)$/)
      const threadId = match?.[1] ?? ${JSON.stringify(threadStateBefore.threadId)}
      if (!threadId || !window.__TAURI_INTERNALS__?.invoke) return false
      const priorIds = new Set(${priorMessageIds})
      const messages = await window.__TAURI_INTERNALS__.invoke('list_messages', { threadId })
      if (!Array.isArray(messages)) return false
      const userIndex = messages.findLastIndex((message) =>
        !priorIds.has(message.id) &&
        message.role === 'user' &&
        message.content?.some?.((part) => part?.text?.value === ${JSON.stringify(prompt)})
      )
      if (userIndex < 0) return false
      return messages.slice(userIndex + 1).some((message) =>
        !priorIds.has(message.id) &&
        message.role === 'assistant' &&
        message.status === 'ready' &&
        message.content?.some?.((part) =>
          typeof part?.text?.value === 'string' && part.text.value.trim().length > 0
        )
      )
    })()`,
    'a newly persisted governed assistant response'
  )

  const appState = await evaluate(`(async () => {
    const reports = [...document.querySelectorAll('section[aria-label^="Orange report:"]')]
    const report = reports.at(-1)
    const body = document.body.innerText
    const match = location.pathname.match(/^\\/threads\\/([^/]+)$/)
    const threadId = match?.[1] ?? ${JSON.stringify(threadStateBefore.threadId)}
    const priorIds = new Set(${priorMessageIds})
    const messages = await window.__TAURI_INTERNALS__.invoke('list_messages', { threadId })
    const userIndex = messages.findLastIndex((message) =>
      !priorIds.has(message.id) &&
      message.role === 'user' &&
      message.content?.some?.((part) => part?.text?.value === ${JSON.stringify(prompt)})
    )
    const userMessage = messages[userIndex] ?? null
    const assistantMessage = messages.slice(userIndex + 1).find((message) =>
      !priorIds.has(message.id) && message.role === 'assistant'
    ) ?? null
    const assistantText = assistantMessage?.content
      ?.filter?.((part) => typeof part?.text?.value === 'string')
      .map((part) => part.text.value)
      .join(String.fromCharCode(10)) ?? ''
    return {
      title: document.title,
      url: location.href,
      reportAriaLabel: report?.getAttribute('aria-label') ?? null,
      reportText: report?.innerText ?? null,
      assistantText,
      assistantMetadata: assistantMessage?.metadata ?? null,
      assistantStatus: assistantMessage?.status ?? null,
      userMessageId: userMessage?.id ?? null,
      assistantMessageId: assistantMessage?.id ?? null,
      promptVisible: body.includes(${JSON.stringify(prompt)}),
      assistantVisible: assistantText.length > 0 && body.includes(assistantText.slice(0, 120)),
      orangeBrandVisible: body.includes('ATOMIC ORANGE'),
      modelVisible: body.includes('Orange Auto'),
    }
  })()`)

  const screenshot = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
  })
  await mkdir(dirname(screenshotPath), { recursive: true })
  await Bun.write(screenshotPath, Buffer.from(screenshot.data, 'base64'))

  cdp.socket.close()
  const ignoredLogPatterns = [
    /favicon/i,
    /ResizeObserver loop/i,
  ]
  const runtimeErrors = cdp.errors.filter(
    (message) => !ignoredLogPatterns.some((pattern) => pattern.test(message))
  )

  const strictReport = parseOrangeReport(appState.assistantText)
  const orangeMetadata = appState.assistantMetadata?.orange ?? null
  const providerId = appState.assistantMetadata?.providerId ?? null
  const turnReceipt = orangeMetadata?.receipt ?? null
  const receiptValid =
    Boolean(turnReceipt?.id) &&
    Number.isInteger(turnReceipt?.seq) &&
    /^[a-f0-9]{64}$/i.test(turnReceipt?.hash ?? '')
  const expectedResultVisible = appState.assistantText.includes(expectedToken)
  const refusalPatterns = [
    /\bi (?:cannot|can't|won't|will not|refuse to)\b/i,
    /\bdo not recognize (?:this|that|it) as (?:a )?(?:legitimate|valid)\b/i,
    /\bnot authorized to (?:answer|respond|proceed)\b/i,
  ]
  const harmlessRequestNotRefused = !refusalPatterns.some((pattern) =>
    pattern.test(appState.assistantText)
  )
  const governedOutputVisible = strictReport
    ? Boolean(appState.reportAriaLabel)
    : appState.assistantVisible
  const nativeProcessLive = processIsLive(nativePid)
  const executableEvidence = nativeExecutable
    ? await stat(nativeExecutable)
        .then(async (entry) => ({
          path: nativeExecutable,
          bytes: entry.size,
          sha256: sha256(await readFile(nativeExecutable)),
        }))
        .catch(() => null)
    : null
  const screenshotEvidence = await stat(screenshotPath)
    .then(async (entry) => ({
      path: screenshotPath,
      bytes: entry.size,
      sha256: sha256(await readFile(screenshotPath)),
    }))
    .catch(() => null)

  const checks = {
    native_process_live: nativeProcessLive && Boolean(executableEvidence),
    orange_roundtrip:
      appState.assistantStatus === 'ready' &&
      governedOutputVisible &&
      providerId === 'orangebrain' &&
      receiptValid &&
      expectedResultVisible &&
      harmlessRequestNotRefused,
    screenshot_persisted: Boolean(screenshotEvidence?.bytes),
    new_message_pair_persisted:
      Boolean(appState.userMessageId) && Boolean(appState.assistantMessageId),
    governed_provider_proven: providerId === 'orangebrain',
    receipt_proven: receiptValid,
    expected_result_rendered: expectedResultVisible,
    harmless_request_not_refused: harmlessRequestNotRefused,
    runtime_errors_zero: runtimeErrors.length === 0,
  }
  const green = Object.values(checks).every(Boolean)

  const proof = {
    ok: green,
    schema: 'atomic-orange.native-live-proof.v1',
    status: green
      ? 'ATOMIC_ORANGE_NATIVE_LIVE_GREEN'
      : 'ATOMIC_ORANGE_NATIVE_LIVE_NEEDS_WORK',
    proof: 'atomic-orange.native-roundtrip.v1',
    generated_at: new Date().toISOString(),
    elapsed_ms: Date.now() - startedAt,
    checks,
    target: {
      title: target.title,
      url: target.url,
    },
    native: {
      pid: nativePid || null,
      ...executableEvidence,
    },
    app: appState,
    strict_report_rendered: Boolean(strictReport),
    strict_report: strictReport,
    turn: {
      provider: providerId,
      model: orangeMetadata?.effectiveModel ?? null,
      node: orangeMetadata?.effectiveNode ?? null,
      lane: orangeMetadata?.lane ?? null,
      response_mode: orangeMetadata?.responseMode ?? null,
      response_contract: orangeMetadata?.responseContract ?? null,
      receipt: turnReceipt,
    },
    runtime_errors: runtimeErrors,
    network: cdp.network,
    screenshot: screenshotEvidence,
  }

  const stamp = proof.generated_at.replace(/[:.]/g, '-')
  const receiptPath = resolve(
    receiptRoot,
    `${stamp}-atomic-orange-native-live-proof.json`
  )
  const written = writeChainedJsonReceipt(receiptPath, proof)

  console.log(
    JSON.stringify(
      { ...proof, receiptPath, receipt_sha256: written.receipt_sha256 },
      null,
      2
    )
  )
  if (!proof.ok) process.exitCode = 1
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        ok: false,
        proof: 'atomic-orange.native-roundtrip.v1',
        error: error instanceof Error ? error.message : String(error),
        diagnostics: lastDiagnostics,
      },
      null,
      2
    )
  )
  process.exitCode = 1
})
