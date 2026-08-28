import {
  IconBroadcast,
  IconChevronDown,
  IconFilter,
  IconRefresh,
  IconSend2,
} from '@tabler/icons-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet'
import { Textarea } from '@/components/ui/textarea'
import {
  appendPartyLineMessage,
  openPartyLineStream,
  readPartyLinePage,
  readPartyLinePersistentState,
  writePartyLinePersistentState,
  type PartyLineConnection,
  type PartyLineDetail,
  type PartyLineEvent,
} from '@/lib/orange-party-line'
import { cn } from '@/lib/utils'
import { PartyLineSignalField } from '@/components/PartyLineSignalField'

const DETAIL_LEVELS: PartyLineDetail[] = ['quiet', 'normal', 'deep', 'wire']
const POLL_FALLBACK_MS = 4_000
const SSE_RECONCILE_MS = 15_000
const EVENT_TYPES = [
  '',
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

const CONNECTION_LABEL: Record<PartyLineConnection, string> = {
  idle: 'paused',
  sse: 'SSE live',
  polling: 'polling fallback',
  offline: 'offline',
}

const connectionDot = (connection: PartyLineConnection) =>
  connection === 'sse'
    ? 'bg-emerald-400 shadow-[0_0_7px_rgba(52,211,153,0.7)]'
    : connection === 'polling'
      ? 'bg-amber-400'
      : connection === 'offline'
        ? 'bg-red-400'
        : 'bg-white/25'

const eventTone = (event: PartyLineEvent) => {
  if (event.eventType === 'blocker') return 'border-red-400/40 text-red-300'
  if (event.eventType === 'repair') return 'border-amber-400/40 text-amber-300'
  if (event.eventType === 'decision') return 'border-sky-400/40 text-sky-300'
  if (event.actor.kind === 'operator') return 'border-primary/50 text-primary'
  if (event.actor.kind === 'model') return 'border-violet-400/40 text-violet-300'
  if (event.actor.kind === 'agent') return 'border-emerald-400/40 text-emerald-300'
  return 'border-white/15 text-foreground/70'
}

const eventTime = (value: string) =>
  new Date(value).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })

function PartyLineEventRow({
  event,
  detail,
}: {
  event: PartyLineEvent
  detail: PartyLineDetail
}) {
  return (
    <article
      className="grid grid-cols-[76px_1fr] gap-3 border-b border-white/8 py-3 last:border-b-0"
      data-party-line-event={event.id}
    >
      <div className="pt-0.5 text-right font-mono text-[9px] text-foreground/35">
        <div>{eventTime(event.createdAt)}</div>
        <div className="mt-1 truncate uppercase">{event.actor.kind}</div>
      </div>
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="truncate text-[12px] font-semibold text-foreground">
            {event.actor.displayName}
          </span>
          <span
            className={cn(
              'border-l-2 pl-1.5 font-mono text-[8px] font-bold uppercase',
              eventTone(event)
            )}
          >
            {event.eventType}
          </span>
          <span className="font-mono text-[8px] uppercase text-foreground/35">
            {event.topic}
          </span>
        </div>
        <p className="mt-1 break-words text-[12px] leading-5 text-foreground/88">
          {event.summary}
        </p>
        {detail !== 'quiet' && event.body && event.body !== event.summary && (
          <p className="mt-1.5 whitespace-pre-wrap break-words text-[11px] leading-5 text-foreground/62">
            {event.body}
          </p>
        )}
        {(detail === 'deep' || detail === 'wire') && Boolean(event.sourceRefs?.length) && (
          <div className="mt-2 space-y-1 border-l border-primary/25 pl-2">
            {event.sourceRefs?.map((source) => (
              <div key={`${event.id}-${source.uri}`} className="break-all font-mono text-[8px] text-primary/75">
                {source.label ? `${source.label}: ` : ''}{source.uri}
              </div>
            ))}
          </div>
        )}
        {detail === 'wire' && (
          <pre className="mt-2 max-h-44 overflow-auto whitespace-pre-wrap break-all border border-white/8 bg-black/50 p-2 font-mono text-[8px] leading-4 text-foreground/45">
            {JSON.stringify(event, null, 2)}
          </pre>
        )}
      </div>
    </article>
  )
}

export function PartyLineDrawer() {
  const [initialState] = useState(readPartyLinePersistentState)
  const [open, setOpen] = useState(false)
  const [events, setEvents] = useState<PartyLineEvent[]>([])
  const [cursor, setCursor] = useState<number | undefined>(initialState.cursor)
  const [detail, setDetail] = useState<PartyLineDetail>(initialState.detail)
  const [actor, setActor] = useState(initialState.actor)
  const [eventType, setEventType] = useState(initialState.eventType)
  const [connection, setConnection] = useState<PartyLineConnection>('idle')
  const [message, setMessage] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [sending, setSending] = useState(false)
  const feedRef = useRef<HTMLDivElement>(null)
  const cursorRef = useRef<number | undefined>(initialState.cursor)
  const refreshingRef = useRef(false)

  const filters = useMemo(
    () => ({ actor: actor || undefined, eventType: eventType || undefined }),
    [actor, eventType]
  )

  const mergeEvents = useCallback((incoming: PartyLineEvent[], replace = false) => {
    setEvents((current) => {
      const map = new Map((replace ? [] : current).map((event) => [event.id, event]))
      incoming.forEach((event) => map.set(event.id, event))
      return [...map.values()]
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .slice(-500)
    })
  }, [])

  const persistCursor = useCallback(
    (nextCursor: number) => {
      cursorRef.current = nextCursor
      setCursor(nextCursor)
      writePartyLinePersistentState({
        cursor: nextCursor,
        detail,
        actor,
        eventType,
      })
    },
    [actor, detail, eventType]
  )

  const refresh = useCallback(
    async (replace = false, signal?: AbortSignal): Promise<number | null> => {
      if (refreshingRef.current) return 0
      refreshingRef.current = true
      setRefreshing(true)
      try {
        const page = await readPartyLinePage({
          cursor: replace ? undefined : cursorRef.current,
          detail,
          filters,
          limit: replace ? 160 : 100,
          signal,
        })
        if (signal?.aborted) return null
        mergeEvents(page.events, replace)
        persistCursor(page.cursor)
        setError(null)
        return page.events.length
      } catch (cause) {
        if (!signal?.aborted) {
          setError(
            cause instanceof Error ? cause.message : 'Party Line unavailable'
          )
        }
        return null
      } finally {
        refreshingRef.current = false
        if (!signal?.aborted) setRefreshing(false)
      }
    },
    [detail, filters, mergeEvents, persistCursor]
  )

  useEffect(() => {
    writePartyLinePersistentState({
      cursor: cursorRef.current,
      detail,
      actor,
      eventType,
    })
  }, [actor, detail, eventType])

  useEffect(() => {
    if (!open) {
      setConnection('idle')
      return
    }

    let disposed = false
    let stream: { close: () => void } | null = null
    let pollTimer: number | null = null
    let reconcileTimer: number | null = null
    const controller = new AbortController()

    const poll = async () => {
      const count = await refresh(false, controller.signal)
      if (disposed) return
      setConnection(count === null ? 'offline' : 'polling')
    }

    const startPolling = () => {
      if (disposed || pollTimer !== null) return
      stream?.close()
      stream = null
      if (reconcileTimer !== null) {
        window.clearInterval(reconcileTimer)
        reconcileTimer = null
      }
      setConnection('polling')
      void poll()
      pollTimer = window.setInterval(() => void poll(), POLL_FALLBACK_MS)
    }

    const start = async () => {
      setEvents([])
      const hadCursor = cursorRef.current != null
      const resumedCount = await refresh(!hadCursor, controller.signal)
      if (disposed) return
      if (hadCursor && resumedCount === 0) {
        await refresh(true, controller.signal)
      }
      if (disposed) return

      if (typeof EventSource === 'undefined') {
        startPolling()
        return
      }

      try {
        stream = openPartyLineStream({
          cursor: cursorRef.current,
          detail,
          filters,
          onOpen: () => {
            if (disposed) return
            setConnection('sse')
            setError(null)
          },
          onEvent: (event) => mergeEvents([event]),
          onError: startPolling,
        })
        reconcileTimer = window.setInterval(
          () => void refresh(false, controller.signal),
          SSE_RECONCILE_MS
        )
      } catch {
        startPolling()
      }
    }

    void start()
    return () => {
      disposed = true
      controller.abort()
      stream?.close()
      if (pollTimer !== null) window.clearInterval(pollTimer)
      if (reconcileTimer !== null) window.clearInterval(reconcileTimer)
      refreshingRef.current = false
    }
  }, [detail, filters, mergeEvents, open, refresh])

  useEffect(() => {
    if (!open) return
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight, behavior: 'smooth' })
  }, [events.length, open])

  const send = async () => {
    const content = message.trim()
    if (!content || sending) return
    setSending(true)
    try {
      const written = await appendPartyLineMessage({ body: content })
      mergeEvents([written.event])
      persistCursor(written.cursor)
      setMessage('')
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Party Line write failed')
    } finally {
      setSending(false)
    }
  }

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <button
          type="button"
          className="ml-1 flex h-7 shrink-0 items-center gap-1.5 border border-white/10 bg-white/3 px-2 text-foreground/65 transition-colors hover:border-primary/30 hover:bg-primary/8 hover:text-primary"
          title="Open the shared Orange operations room"
        >
          <IconBroadcast className="size-3.5" />
          <span className="hidden font-mono text-[9px] font-bold uppercase lg:inline">Party Line</span>
          <span className={cn('size-1.5 rounded-full', connectionDot(connection))} />
        </button>
      </SheetTrigger>
      <SheetContent
        side="right"
        className="w-[min(860px,94vw)] gap-0 border-l border-primary/25 bg-neutral-950/98 p-0 sm:max-w-none"
      >
        <SheetHeader className="border-b border-white/10 px-5 py-4">
          <div className="flex items-center gap-2 pr-8">
            <IconBroadcast className="size-4 text-primary" />
            <SheetTitle className="font-mono text-[12px] font-black uppercase tracking-[0.14em]">
              Orange Party Line
            </SheetTitle>
          </div>
          <SheetDescription className="font-mono text-[9px] text-foreground/45">
            Shared disk-backed operations feed. Models hydrate selected sources; history stays on disk.
          </SheetDescription>
          <div className="font-mono text-[8px] font-bold uppercase text-foreground/40">
            {CONNECTION_LABEL[connection]}
            {cursor != null ? ` · cursor ${cursor}` : ''}
          </div>
        </SheetHeader>

        <div className="flex flex-wrap items-center gap-2 border-b border-white/8 px-5 py-2.5">
          <IconFilter className="size-3.5 text-foreground/35" />
          <div className="flex h-7 items-center border border-white/10 bg-black/35 p-0.5">
            {DETAIL_LEVELS.map((level) => (
              <button
                key={level}
                type="button"
                onClick={() => setDetail(level)}
                className={cn(
                  'h-6 px-2 font-mono text-[8px] font-bold uppercase transition-colors',
                  detail === level ? 'bg-primary text-black' : 'text-foreground/45 hover:text-foreground'
                )}
              >
                {level}
              </button>
            ))}
          </div>
          <div className="relative">
            <select
              aria-label="Party Line event type"
              value={eventType}
              onChange={(event) => setEventType(event.target.value)}
              className="h-7 appearance-none border border-white/10 bg-black/35 pl-2 pr-7 font-mono text-[9px] uppercase text-foreground/65 outline-none focus:border-primary/40"
            >
              {EVENT_TYPES.map((type) => <option key={type || 'all'} value={type}>{type || 'all events'}</option>)}
            </select>
            <IconChevronDown className="pointer-events-none absolute right-2 top-2 size-3 text-foreground/35" />
          </div>
          <Input
            value={actor}
            onChange={(event) => setActor(event.target.value)}
            placeholder="actor or kind"
            aria-label="Party Line actor filter"
            className="h-7 w-36 rounded-none border-white/10 bg-black/35 font-mono text-[9px]"
          />
          <Button
            variant="ghost"
            size="icon-xs"
            className="ml-auto"
            title="Refresh Party Line"
            disabled={refreshing}
            onClick={() => void refresh(true)}
          >
            <IconRefresh className={cn('size-3.5', refreshing && 'animate-spin')} />
          </Button>
        </div>

        <PartyLineSignalField
          events={events}
          detail={detail}
          connection={connection}
        />

        <div ref={feedRef} className="min-h-0 flex-1 overflow-y-auto px-5">
          {events.length === 0 && !error && (
            <div className="grid h-full place-items-center font-mono text-[10px] uppercase text-foreground/35">
              Party Line is quiet
            </div>
          )}
          {events.map((event) => <PartyLineEventRow key={event.id} event={event} detail={detail} />)}
        </div>

        {error && (
          <div className="border-t border-red-400/20 bg-red-400/6 px-5 py-2 font-mono text-[9px] text-red-300">
            {error}
          </div>
        )}

        <div className="border-t border-primary/20 bg-black/55 p-3">
          <div className="flex items-end gap-2">
            <Textarea
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  void send()
                }
              }}
              placeholder="Broadcast to Orange models, agents, tools, and operator..."
              className="min-h-10 max-h-28 resize-none rounded-none border-white/10 bg-neutral-950 font-mono text-[10px]"
            />
            <Button
              size="icon"
              className="size-10 shrink-0 rounded-none"
              title="Send to Party Line"
              disabled={!message.trim() || sending}
              onClick={() => void send()}
            >
              <IconSend2 className="size-4" />
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}
