import { describe, expect, it, vi } from 'vitest'

import {
  PARTY_LINE_STATE_STORAGE_KEY,
  buildPartyLineStreamUrl,
  openPartyLineStream,
  parsePartyLineStreamEvent,
  readPartyLinePersistentState,
  writePartyLinePersistentState,
  type PartyLineEvent,
} from '@/lib/orange-party-line'

const event: PartyLineEvent = {
  schema: 'orange.party-line.event.v1',
  id: 'pl-test',
  seq: 42,
  createdAt: '2026-08-28T00:00:00.000Z',
  projectId: 'orange5',
  topic: 'operations',
  actor: {
    id: 'operator',
    kind: 'operator',
    displayName: 'Operator',
    model: null,
    node: null,
  },
  eventType: 'message',
  status: null,
  summary: 'test event',
  importance: 0.5,
  entryHash: 'a'.repeat(64),
}

function memoryStorage(initial?: string) {
  const values = new Map<string, string>()
  if (initial != null) values.set(PARTY_LINE_STATE_STORAGE_KEY, initial)
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  }
}

describe('Party Line client contract', () => {
  it('persists a validated byte cursor and view state', () => {
    const storage = memoryStorage()

    writePartyLinePersistentState(
      { cursor: 280660, detail: 'deep', actor: 'fixer', eventType: 'repair' },
      storage
    )

    expect(readPartyLinePersistentState(storage)).toEqual({
      schema: 'atomic-orange.party-line.state.v1',
      cursor: 280660,
      detail: 'deep',
      actor: 'fixer',
      eventType: 'repair',
    })
  })

  it('fails closed to bounded defaults for malformed persisted state', () => {
    const state = readPartyLinePersistentState(
      memoryStorage(
        JSON.stringify({
          cursor: -1,
          detail: 'everything',
          actor: 42,
          eventType: 'unknown',
        })
      )
    )

    expect(state).toEqual({
      schema: 'atomic-orange.party-line.state.v1',
      cursor: undefined,
      detail: 'normal',
      actor: '',
      eventType: '',
    })
  })

  it('builds the named SSE route with cursor and filters intact', () => {
    const url = new URL(
      buildPartyLineStreamUrl({
        cursor: 1234,
        detail: 'wire',
        filters: { actor: 'codex', eventType: 'status', topic: 'chat' },
      })
    )

    expect(url.pathname).toBe('/v1/party-line/stream')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      detail: 'wire',
      cursor: '1234',
      actor: 'codex',
      type: 'status',
      topic: 'chat',
    })
  })

  it('accepts only schema-shaped Party Line stream events', () => {
    expect(parsePartyLineStreamEvent(JSON.stringify(event))).toEqual(event)
    expect(
      parsePartyLineStreamEvent(JSON.stringify({ ...event, seq: '42' }))
    ).toBeNull()
    expect(parsePartyLineStreamEvent('not-json')).toBeNull()
  })

  it('subscribes to the named Party Line event and closes the stream', () => {
    const listeners = new Map<string, (event: Event) => void>()
    const close = vi.fn()
    const onEvent = vi.fn()

    const stream = openPartyLineStream({
      cursor: 42,
      onEvent,
      createEventSource: (url) => {
        expect(url).toContain('cursor=42')
        return {
          addEventListener: (type, listener) => listeners.set(type, listener),
          close,
        }
      },
    })

    listeners.get('party-line')?.(
      new MessageEvent('party-line', { data: JSON.stringify(event) })
    )
    expect(onEvent).toHaveBeenCalledWith(event)

    stream.close()
    expect(close).toHaveBeenCalledOnce()
  })
})
