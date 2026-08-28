import { useEffect, useState } from 'react'
import { IconRoute, IconShieldCheck } from '@tabler/icons-react'
import { useAppState } from '@/hooks/useAppState'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  ActivityDetail,
  AgentActivity,
} from '@/components/ai-elements/agent-activity'

type PromptProgressProps = {
  orange?: boolean
}

const orangePhase = (elapsedSeconds: number) => {
  if (elapsedSeconds < 4) return 'Compiling crystal context'
  if (elapsedSeconds < 12) return 'Routing least-action path'
  if (elapsedSeconds < 45) return 'Navigator executing on Codexa'
  return 'Validating report and receipt'
}

export function PromptProgress({ orange = false }: PromptProgressProps) {
  const { t } = useTranslation('chat')
  const promptProgress = useAppState((state) => state.promptProgress)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)

  useEffect(() => {
    if (!orange) return
    const startedAt = Date.now()
    const timer = window.setInterval(
      () => setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000)),
      1_000
    )
    return () => window.clearInterval(timer)
  }, [orange])

  const percentage =
    promptProgress && promptProgress.total > 0
      ? Math.round((promptProgress.processed / promptProgress.total) * 100)
      : 0

  const showReadingProgress =
    promptProgress &&
    promptProgress.total > 0 &&
    percentage > 0 &&
    percentage < 100

  if (orange) {
    const phase = orangePhase(elapsedSeconds)
    return (
      <div
        role="status"
        aria-label={`Orange Navigator active: ${phase}`}
        className="flex h-8 min-w-0 items-center gap-2 border-l-2 border-primary/70 bg-primary/5 px-2 font-mono"
        data-testid="orange-turn-progress"
      >
        <IconRoute className="size-3.5 shrink-0 animate-pulse text-primary" />
        <span className="shrink-0 text-[9px] font-black uppercase tracking-[0.12em] text-primary">
          Navigator
        </span>
        <span className="min-w-0 truncate text-[10px] text-foreground/70">
          {phase}
        </span>
        <span className="shrink-0 text-[9px] tabular-nums text-foreground/45">
          {elapsedSeconds}s
        </span>
        <IconShieldCheck className="size-3.5 shrink-0 text-emerald-400" />
      </div>
    )
  }

  return (
    <AgentActivity
      active
      workingLabel={t('activity.working')}
      durationLabel=""
      hasDetails={Boolean(showReadingProgress)}
      // Rendered inside the indicator row, not the message flow — the default
      // mb-3 would make this row taller than the shimmer it swaps with.
      className="mb-0"
    >
      {showReadingProgress && (
        <ActivityDetail label={t('activity.reading', { count: percentage })}>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full bg-primary transition-[width]"
              style={{ width: `${percentage}%` }}
            />
          </div>
        </ActivityDetail>
      )}
    </AgentActivity>
  )
}
