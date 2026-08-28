import { fetch as tauriFetch } from '@tauri-apps/plugin-http'

import { ORANGE_FIVE_RUNTIME_ORIGIN } from '@/lib/orange-crossing'

export type PartyLineDetail = 'quiet' | 'normal' | 'deep' | 'wire'
export type PartyLineActorKind = 'operator' | 'model' | 'agent' | 'tool' | 'system'
export type PartyLineEventType =
  | 'message'
  | 'order'
  | 'report'
  | 'decision'
  | 'tool'
  | 'receipt'
  | 'status'
  | 'blocker'
  | 'repair'

export type PartyLineConnection = 'idle' | 'sse' | 'polling' | 'offline'

export const PARTY_LINE_EVENT_TYPES: PartyLineEventType[] = [
  'message',
  'order',
  'report',
  'decision',
  'tool',
  'receipt',
  'status',
  'blocker',
  'repair',
]

export type PartyLineEvent = {
  schema: 'orange.party-line.event.v1'
  id: string
  seq: number
  createdAt: string
  projectId: string
  topic: string
  actor: {
    id: string
    kind: PartyLineActorKind
    displayName: string
    model: string | null
    node: string | null
  }
  eventType: PartyLineEventType
  status: string | null
  summary: string
  body?: string | null
  detail?: Record<string, unknown> | null
  sourceRefs?: Array<{ uri: string; hash: string | null; label: string | null }>
  tags?: string[]
  correlationId?: string | null
  replyTo?: string | null
  sourceCount?: number
  importance: number
  prevHash?: string | null
  entryHash: string
}

export type PartyLinePage = {
  schema: 'orange.party-line.page.v1'
  events: PartyLineEvent[]
  cursor: number
  hasMore: boolean
  detail: PartyLineDetail
  diskPath: string
  chain: { ok: boolean | null; checked: number; errors: unknown[]; reason?: string }
}

export type PartyLineFilters = {
  projectId?: string
  actor?: string
  eventType?: string
  topic?: string
}

export type PartyLinePersistentState = {
  schema: 'atomic-orange.party-line.state.v1'
  cursor?: number
  detail: PartyLineDetail
  actor: string
  eventType: string
}

type PartyLineStorage = Pick<Storage, 'getItem' | 'setItem'>

export const PARTY_LINE_STATE_STORAGE_KEY =
  'atomic-orange.party-line.state.v1'

const DEFAULT_PARTY_LINE_STATE: PartyLinePersistentState = {
  schema: 'atomic-orange.party-line.state.v1',
  detail: 'normal',
  actor: '',
  eventType: '',
}

const browserStorage = (): PartyLineStorage | null => {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

const normalizeCursor = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined

export function readPartyLinePersistentState(
  storage: PartyLineStorage | null = browserStorage()
): PartyLinePersistentState {
  if (!storage) return { ...DEFAULT_PARTY_LINE_STATE }
  try {
    const value = JSON.parse(
      storage.getItem(PARTY_LINE_STATE_STORAGE_KEY) ?? '{}'
    ) as Partial<PartyLinePersistentState>
    return {
      ...DEFAULT_PARTY_LINE_STATE,
      cursor: normalizeCursor(value.cursor),
      detail: ['quiet', 'normal', 'deep', 'wire'].includes(value.detail ?? '')
        ? (value.detail as PartyLineDetail)
        : DEFAULT_PARTY_LINE_STATE.detail,
      actor: typeof value.actor === 'string' ? value.actor.slice(0, 256) : '',
      eventType:
        typeof value.eventType === 'string' &&
        (value.eventType === '' ||
          PARTY_LINE_EVENT_TYPES.includes(
            value.eventType as PartyLineEventType
          ))
          ? value.eventType
          : '',
    }
  } catch {
    return { ...DEFAULT_PARTY_LINE_STATE }
  }
}

export function writePartyLinePersistentState(
  patch: Partial<Omit<PartyLinePersistentState, 'schema'>>,
  storage: PartyLineStorage | null = browserStorage()
): PartyLinePersistentState {
  const current = readPartyLinePersistentState(storage)
  const next: PartyLinePersistentState = {
    ...current,
    ...patch,
    schema: 'atomic-orange.party-line.state.v1',
  }
  next.cursor = normalizeCursor(next.cursor)
  if (storage) {
    try {
      storage.setItem(PARTY_LINE_STATE_STORAGE_KEY, JSON.stringify(next))
    } catch {
      // A blocked webview storage area must not take down the live feed.
    }
  }
  return next
}

const fetcher = () =>
  typeof IS_TAURI !== 'undefined' && IS_TAURI ? tauriFetch : fetch

function partyLineSearchParams({
  cursor,
  limit,
  detail,
  filters,
}: {
  cursor?: number
  limit?: number
  detail: PartyLineDetail
  filters: PartyLineFilters
}) {
  const params = new URLSearchParams({ detail })
  if (limit != null) params.set('limit', String(limit))
  if (cursor != null) params.set('cursor', String(cursor))
  if (filters.projectId) params.set('project', filters.projectId)
  if (filters.actor) params.set('actor', filters.actor)
  if (filters.eventType) params.set('type', filters.eventType)
  if (filters.topic) params.set('topic', filters.topic)
  return params
}

export function buildPartyLineStreamUrl({
  cursor,
  detail = 'normal',
  filters = {},
}: {
  cursor?: number
  detail?: PartyLineDetail
  filters?: PartyLineFilters
} = {}) {
  const params = partyLineSearchParams({ cursor, detail, filters })
  return `${ORANGE_FIVE_RUNTIME_ORIGIN}/v1/party-line/stream?${params}`
}

export function parsePartyLineStreamEvent(value: string): PartyLineEvent | null {
  try {
    const event = JSON.parse(value) as Partial<PartyLineEvent>
    return event.schema === 'orange.party-line.event.v1' &&
      typeof event.id === 'string' &&
      Number.isInteger(event.seq) &&
      typeof event.createdAt === 'string' &&
      event.actor != null &&
      typeof event.actor.id === 'string' &&
      PARTY_LINE_EVENT_TYPES.includes(event.eventType as PartyLineEventType)
      ? (event as PartyLineEvent)
      : null
  } catch {
    return null
  }
}

type PartyLineEventSource = {
  addEventListener: (type: string, listener: (event: Event) => void) => void
  close: () => void
}

export function openPartyLineStream({
  cursor,
  detail = 'normal',
  filters = {},
  onEvent,
  onOpen,
  onError,
  createEventSource = (url: string) =>
    new EventSource(url) as unknown as PartyLineEventSource,
}: {
  cursor?: number
  detail?: PartyLineDetail
  filters?: PartyLineFilters
  onEvent: (event: PartyLineEvent) => void
  onOpen?: () => void
  onError?: () => void
  createEventSource?: (url: string) => PartyLineEventSource
}): { close: () => void } {
  const source = createEventSource(
    buildPartyLineStreamUrl({ cursor, detail, filters })
  )
  source.addEventListener('open', () => onOpen?.())
  source.addEventListener('party-line', (message) => {
    const event = parsePartyLineStreamEvent((message as MessageEvent<string>).data)
    if (event) onEvent(event)
  })
  source.addEventListener('error', () => onError?.())
  return { close: () => source.close() }
}

export async function readPartyLinePage({
  cursor,
  limit = 100,
  detail = 'normal',
  filters = {},
  signal,
}: {
  cursor?: number
  limit?: number
  detail?: PartyLineDetail
  filters?: PartyLineFilters
  signal?: AbortSignal
} = {}): Promise<PartyLinePage> {
  const params = partyLineSearchParams({ cursor, limit, detail, filters })
  params.set('tail', cursor == null ? 'true' : 'false')
  const response = await fetcher()(`${ORANGE_FIVE_RUNTIME_ORIGIN}/v1/party-line?${params}`, {
    headers: { Accept: 'application/json' },
    signal,
  })
  if (!response.ok) throw new Error(`Party Line returned ${response.status}`)
  return (await response.json()) as PartyLinePage
}

export async function appendPartyLineMessage({
  body,
  projectId = 'orange5',
  topic = 'operations',
}: {
  body: string
  projectId?: string
  topic?: string
}): Promise<{ event: PartyLineEvent; cursor: number }> {
  const response = await fetcher()(`${ORANGE_FIVE_RUNTIME_ORIGIN}/v1/party-line`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      projectId,
      topic,
      actor: { id: 'operator', kind: 'operator', displayName: 'Operator' },
      eventType: 'message',
      summary: body.slice(0, 300),
      body,
      tags: ['party-line', 'operator'],
      importance: 0.75,
    }),
  })
  if (!response.ok) throw new Error(`Party Line write returned ${response.status}`)
  const payload = (await response.json()) as {
    event: PartyLineEvent
    cursor: number
  }
  return { event: payload.event, cursor: payload.cursor }
}
