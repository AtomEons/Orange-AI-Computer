import {
  IconActivityHeartbeat,
  IconBrain,
  IconChevronUp,
  IconDatabase,
  IconRefresh,
  IconRoute,
  IconServer,
  IconShieldCheck,
} from '@tabler/icons-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { PartyLineDrawer } from '@/components/PartyLineDrawer'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import {
  EMPTY_ORANGE_RUNTIME_STATUS,
  readOrangeRuntimeStatus,
  type OrangeRuntimeStatus,
} from '@/lib/orange-runtime-status'
import {
  BUILD_RUN_UPDATED_EVENT,
  activeThreadId,
  buildBuildRunTimeline,
  readActiveBuildRun,
  type AtomicOrangeBuildRun,
} from '@/lib/orange-build-runs'

const POLL_INTERVAL_MS = 15_000

type SignalProps = {
  label: string
  live: boolean
  value?: string | number | null
}

function Signal({ label, live, value }: SignalProps) {
  return (
    <div
      className="flex h-6 min-w-0 items-center gap-1.5 border-l border-white/10 px-2 first:border-l-0"
      title={`${label}: ${live ? 'live' : 'unavailable'}`}
    >
      <span
        className={cn(
          'size-1.5 shrink-0 rounded-full',
          live
            ? 'bg-emerald-400 shadow-[0_0_7px_rgba(52,211,153,0.65)]'
            : 'bg-amber-400'
        )}
      />
      <span className="truncate font-mono text-[9px] font-semibold uppercase tracking-[0.08em] text-foreground/65">
        {label}
      </span>
      {value !== null && value !== undefined && (
        <span className="truncate font-mono text-[9px] text-foreground/90">
          {value}
        </span>
      )}
    </div>
  )
}

function TruthRow({
  icon,
  label,
  value,
  live,
}: {
  icon: React.ReactNode
  label: string
  value: string
  live: boolean
}) {
  return (
    <div className="grid min-h-10 grid-cols-[20px_112px_1fr] items-center gap-2 border-b border-white/8 py-2 last:border-b-0">
      <span className={live ? 'text-primary' : 'text-amber-400'}>{icon}</span>
      <span className="font-mono text-[9px] font-bold uppercase tracking-[0.1em] text-foreground/55">
        {label}
      </span>
      <span className="min-w-0 truncate font-mono text-[10px] text-foreground/90">
        {value}
      </span>
    </div>
  )
}

export function OrangeRuntimeDock() {
  const [status, setStatus] = useState<OrangeRuntimeStatus>(
    EMPTY_ORANGE_RUNTIME_STATUS
  )
  const [refreshing, setRefreshing] = useState(false)
  const [buildRun, setBuildRun] = useState<AtomicOrangeBuildRun | null>(null)
  const [buildRunAvailable, setBuildRunAvailable] = useState(true)
  const [threadId, setThreadId] = useState<string | null>(null)
  const buildRunThreadRef = useRef<string | null>(null)
  const refreshSequence = useRef(0)

  const refresh = useCallback(async () => {
    const sequence = ++refreshSequence.current
    const activeThread = activeThreadId()
    setRefreshing(true)
    const [runtime, runProbe] = await Promise.all([
      readOrangeRuntimeStatus(),
      activeThread
        ? readActiveBuildRun(activeThread)
            .then((run) => ({ available: true as const, run }))
            .catch(() => ({ available: false as const, run: null }))
        : Promise.resolve({ available: true as const, run: null }),
    ])
    if (sequence !== refreshSequence.current) return

    setStatus(runtime)
    setThreadId(activeThread)
    if (buildRunThreadRef.current !== activeThread) {
      buildRunThreadRef.current = activeThread
      setBuildRun(runProbe.run)
    } else if (runProbe.available) {
      setBuildRun(runProbe.run)
    }
    setBuildRunAvailable(runProbe.available)
    setRefreshing(false)
  }, [])

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => void refresh(), POLL_INTERVAL_MS)
    const onBuildRunUpdated = () => void refresh()
    window.addEventListener(BUILD_RUN_UPDATED_EVENT, onBuildRunUpdated)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener(BUILD_RUN_UPDATED_EVENT, onBuildRunUpdated)
    }
  }, [refresh])

  const coreLive = status.gateway.live && status.memory.live
  const modelPathLive = status.navigator.live
  const fullLive =
    coreLive &&
    modelPathLive &&
    status.hermes.live &&
    status.atomSmasher.live &&
    status.learning.live
  const codexaDisconnected = status.codexa.state === 'disconnected'
  const runtimeLabel = fullLive
    ? 'full live'
    : codexaDisconnected
      ? 'codexa offline'
      : coreLive
        ? 'core live'
        : 'attention'
  const timeline = buildRun ? buildBuildRunTimeline(buildRun) : []
  const checkedTime = new Date(status.checkedAt).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })

  return (
    <div
      className="relative z-40 flex h-9 shrink-0 items-center border-t border-primary/20 bg-black/85 px-2 backdrop-blur-xl"
      data-testid="orange-runtime-dock"
    >
      <Popover>
        <PopoverTrigger asChild>
          <button
            className="flex h-7 shrink-0 items-center gap-2 rounded-sm border border-primary/25 bg-primary/8 px-2 text-left transition-colors hover:bg-primary/14"
            type="button"
            title="Open live OrangeFive runtime truth"
          >
            <IconActivityHeartbeat className="size-3.5 text-primary" />
            <span className="font-mono text-[9px] font-black uppercase tracking-[0.14em] text-primary">
              OrangeFive
            </span>
            <span
              className={cn(
                'font-mono text-[9px] font-bold uppercase',
                fullLive
                  ? 'text-emerald-400'
                  : codexaDisconnected
                    ? 'text-red-400'
                    : coreLive
                    ? 'text-amber-400'
                    : 'text-red-400'
              )}
            >
              {runtimeLabel}
            </span>
            <IconChevronUp className="size-3 text-foreground/45" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          side="top"
          sideOffset={8}
          className="w-[min(620px,calc(100vw-32px))] rounded-md border-primary/25 bg-neutral-950/98 p-0 shadow-[0_18px_70px_rgba(0,0,0,0.68)]"
        >
          <div className="flex items-center justify-between border-b border-primary/15 px-4 py-3">
            <div>
              <div className="font-mono text-[11px] font-black uppercase tracking-[0.14em] text-primary">
                Live control plane
              </div>
              <div className="mt-1 font-mono text-[9px] text-foreground/45">
                Live runtime probes · checked {checkedTime}
              </div>
            </div>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => void refresh()}
              disabled={refreshing}
              title="Refresh runtime truth"
            >
              <IconRefresh
                className={cn('size-3.5', refreshing && 'animate-spin')}
              />
            </Button>
          </div>
          <div className="grid grid-cols-1 gap-x-5 px-4 py-1 sm:grid-cols-2">
            <TruthRow
              icon={<IconRoute className="size-4" />}
              label="OrangeBrain"
              value={
                status.gateway.version
                  ? `${status.gateway.version}${status.gateway.degraded ? ' · degraded' : ''}`
                  : 'No governed gateway response'
              }
              live={status.gateway.live}
            />
            <TruthRow
              icon={<IconBrain className="size-4" />}
              label="Navigator"
              value={
                status.navigator.model
                  ? `${status.navigator.model} · ${status.navigator.host ?? 'unknown host'}`
                  : 'No active Navigator reported'
              }
              live={status.navigator.live}
            />
            <TruthRow
              icon={<IconServer className="size-4" />}
              label="Codexa"
              value={
                status.codexa.state === 'connected'
                  ? `${status.codexa.nodeId ?? 'remote compute'} · ${status.codexa.host ?? 'unknown host'}`
                  : status.codexa.state === 'disconnected'
                    ? `${status.codexa.nodeId ?? 'remote compute'} disconnected`
                    : status.codexa.state === 'local'
                      ? 'One-computer mode'
                      : 'No compute-fabric evidence'
              }
              live={
                status.codexa.state === 'connected' ||
                status.codexa.state === 'local'
              }
            />
            <TruthRow
              icon={<IconDatabase className="size-4" />}
              label="AE Cobra"
              value={
                status.memory.latencyMs === null
                  ? 'Memory unavailable'
                  : `${status.memory.serving ?? 'memory'} · ${status.memory.latencyMs} ms`
              }
              live={status.memory.live}
            />
            <TruthRow
              icon={<IconShieldCheck className="size-4" />}
              label="Hermes"
              value={
                status.hermes.gates === null
                  ? 'Agent runtime unavailable'
                  : `${status.hermes.gates} gates · ${status.hermes.activeLeases ?? 0} active · Misfit ${status.hermes.misfit ? 'on' : 'off'}`
              }
              live={status.hermes.live}
            />
            <TruthRow
              icon={<IconActivityHeartbeat className="size-4" />}
              label="AtomSmasher"
              value={
                status.atomSmasher.features === null
                  ? 'Compression runtime unavailable'
                  : `${status.atomSmasher.features} features · ${status.atomSmasher.receipts ?? 0} receipts`
              }
              live={status.atomSmasher.live}
            />
            <TruthRow
              icon={<IconRefresh className="size-4" />}
              label="Learning"
              value={
                status.learning.total === null
                  ? 'Learning queue unavailable'
                  : `${status.learning.total} settled · ${status.learning.open ?? 0} open · ${status.learning.failed ?? 0} failed`
              }
              live={status.learning.live && status.learning.failed === 0}
            />
            <TruthRow
              icon={<IconRoute className="size-4" />}
              label="Build Run"
              value={
                buildRun
                  ? `${buildRunAvailable ? '' : 'last known · '}${buildRun.mode} / ${buildRun.stage} / ${buildRun.status}`
                  : !threadId
                    ? 'No active thread'
                    : buildRunAvailable
                      ? 'No run recorded'
                      : 'Build Run endpoint unavailable'
              }
              live={
                buildRunAvailable &&
                Boolean(buildRun) &&
                buildRun?.status !== 'failed' &&
                buildRun?.status !== 'blocked'
              }
            />
          </div>
          {buildRun && (
            <div className="border-t border-white/8 px-4 py-3">
              <div className="flex min-w-0 items-center justify-between gap-3">
                <span className="font-mono text-[9px] font-bold uppercase text-foreground/55">
                  Build Run timeline
                </span>
                <span
                  className="truncate font-mono text-[8px] text-foreground/35"
                  title={buildRun.runId}
                >
                  {buildRun.runId}
                </span>
              </div>
              <div className="mt-3 grid grid-cols-9 gap-1" aria-label="Build Run stages">
                {timeline.map((step) => (
                  <div key={step.stage} className="min-w-0 text-center">
                    <div
                      className={cn(
                        'mx-auto h-1.5 w-full max-w-10',
                        step.state === 'complete' && 'bg-emerald-400',
                        step.state === 'active' && 'bg-primary',
                        step.state === 'waiting' && 'bg-amber-300',
                        step.state === 'blocked' && 'bg-amber-500',
                        step.state === 'failed' && 'bg-red-400',
                        step.state === 'cancelled' && 'bg-foreground/30',
                        step.state === 'pending' && 'bg-white/10'
                      )}
                      title={`${step.stage}: ${step.state}`}
                    />
                    <div className="mt-1 truncate font-mono text-[7px] uppercase text-foreground/35">
                      {step.stage}
                    </div>
                  </div>
                ))}
              </div>
              <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[8px] text-foreground/45">
                <span>{buildRun.receipts.length} receipts</span>
                <span>{buildRun.blockers.length} blockers</span>
                <span>{new Date(buildRun.updatedAt).toLocaleTimeString()}</span>
                {buildRun.nextAction && (
                  <span className="min-w-0 basis-full break-words text-foreground/65">
                    next: {buildRun.nextAction}
                  </span>
                )}
              </div>
            </div>
          )}
        </PopoverContent>
      </Popover>

      <PartyLineDrawer />

      <div className="ml-2 flex min-w-0 flex-1 items-center overflow-hidden">
        <Signal label="Brain" live={status.gateway.live} />
        <Signal
          label="Codexa"
          live={
            status.codexa.state === 'connected' ||
            status.codexa.state === 'local'
          }
          value={
            status.codexa.state === 'disconnected'
              ? 'offline'
              : status.codexa.state === 'local'
                ? 'local'
                : status.codexa.nodeId
          }
        />
        <Signal
          label="Memory"
          live={status.memory.live}
          value={
            status.memory.latencyMs === null
              ? null
              : `${status.memory.latencyMs}ms`
          }
        />
        <Signal
          label="Hermes"
          live={status.hermes.live}
          value={status.hermes.gates}
        />
        <Signal
          label="Atom"
          live={status.atomSmasher.live}
          value={status.atomSmasher.features}
        />
        <Signal
          label="Learn"
          live={status.learning.live && status.learning.failed === 0}
          value={status.learning.open}
        />
        <Signal
          label="Run"
          live={
            buildRunAvailable &&
            Boolean(buildRun) &&
            buildRun?.status !== 'failed' &&
            buildRun?.status !== 'blocked'
          }
          value={
            !buildRunAvailable
              ? 'offline'
              : buildRun
                ? `${buildRun.stage}/${buildRun.status}`
                : null
          }
        />
      </div>

      <Button
        variant="ghost"
        size="icon-xs"
        className="ml-auto shrink-0 text-foreground/50 hover:text-primary"
        onClick={() => void refresh()}
        disabled={refreshing}
        title="Refresh OrangeFive services"
      >
        <IconRefresh className={cn('size-3.5', refreshing && 'animate-spin')} />
      </Button>
    </div>
  )
}
