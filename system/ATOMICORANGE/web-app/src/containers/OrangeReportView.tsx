import {
  IconAlertTriangle,
  IconArrowRight,
  IconBan,
  IconCheck,
  IconDatabase,
  IconRoute,
} from '@tabler/icons-react'
import type { OrangeTurnMetadata } from '@/lib/orange-turn-metadata'
import type { OrangeReport } from '@/lib/orange-report-view'
import { cn } from '@/lib/utils'

type Props = {
  report: OrangeReport
  metadata?: OrangeTurnMetadata | null
}

const statusPresentation = {
  completed: {
    label: 'Completed',
    icon: IconCheck,
    className: 'text-emerald-400 border-emerald-500/35 bg-emerald-500/8',
  },
  needs_action: {
    label: 'Needs action',
    icon: IconAlertTriangle,
    className: 'text-amber-400 border-amber-500/35 bg-amber-500/8',
  },
  blocked: {
    label: 'Blocked',
    icon: IconBan,
    className: 'text-red-400 border-red-500/35 bg-red-500/8',
  },
  rejected: {
    label: 'Rejected',
    icon: IconBan,
    className: 'text-red-400 border-red-500/35 bg-red-500/8',
  },
} as const

const short = (value: string | null | undefined, length = 12) =>
  value ? value.slice(0, length) : null

export function OrangeReportView({ report, metadata }: Props) {
  const presentation = statusPresentation[report.status]
  const StatusIcon = presentation.icon
  const confidence = Math.round(report.confidence * 100)

  return (
    <section
      className="w-full border-l-2 border-orange-500/70 pl-4 py-1"
      aria-label={`Orange report: ${presentation.label}`}
    >
      <header className="flex flex-wrap items-center gap-2 pb-3 border-b border-border/60">
        <span
          className={cn(
            'inline-flex h-6 items-center gap-1.5 rounded-full border px-2 text-xs font-medium',
            presentation.className
          )}
        >
          <StatusIcon size={14} aria-hidden="true" />
          {presentation.label}
        </span>
        <span className="text-xs tabular-nums text-muted-foreground">
          {confidence}% confidence
        </span>
        <span className="ml-auto font-mono text-[11px] text-muted-foreground/75">
          {short(report.orderId, 20)}
        </span>
      </header>

      {report.findings.length > 0 && (
        <div className="py-3">
          <p className="mb-1.5 text-[11px] font-semibold uppercase text-muted-foreground">
            Findings
          </p>
          <ul className="space-y-1.5 text-sm text-foreground">
            {report.findings.map((finding) => (
              <li key={finding} className="flex gap-2">
                <span className="mt-2 size-1 shrink-0 rounded-full bg-orange-500" />
                <span>{finding}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {report.actionsTaken.length > 0 && (
        <div className="py-3 border-t border-border/50">
          <p className="mb-1.5 text-[11px] font-semibold uppercase text-muted-foreground">
            Actions
          </p>
          <ul className="space-y-1 text-sm">
            {report.actionsTaken.map((action) => (
              <li key={action}>{action}</li>
            ))}
          </ul>
        </div>
      )}

      {report.blockers.length > 0 && (
        <div className="py-3 border-t border-amber-500/20 text-amber-200">
          <p className="mb-1.5 text-[11px] font-semibold uppercase text-amber-400/80">
            Blockers
          </p>
          <ul className="space-y-1 text-sm">
            {report.blockers.map((blocker) => (
              <li key={blocker}>{blocker}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex gap-2 border-t border-border/60 py-3 text-sm">
        <IconArrowRight
          size={16}
          className="mt-0.5 shrink-0 text-orange-400"
          aria-hidden="true"
        />
        <div>
          <p className="text-[11px] font-semibold uppercase text-muted-foreground">
            Next action
          </p>
          <p>{report.nextAction}</p>
        </div>
      </div>

      <footer className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border/50 pt-2 font-mono text-[10px] text-muted-foreground/80">
        {(metadata?.lane || metadata?.effectiveModel) && (
          <span className="inline-flex items-center gap-1">
            <IconRoute size={12} aria-hidden="true" />
            {[metadata.lane, metadata.effectiveModel].filter(Boolean).join(' / ')}
          </span>
        )}
        {metadata?.effectiveNode && <span>{metadata.effectiveNode}</span>}
        {metadata?.receipt && (
          <span className="inline-flex items-center gap-1">
            <IconDatabase size={12} aria-hidden="true" />
            receipt {metadata.receipt.seq ?? 'recorded'}
            {metadata.receipt.hash && ` / ${short(metadata.receipt.hash)}`}
          </span>
        )}
        {metadata?.reportRepairApplied && <span>compiler repaired</span>}
      </footer>
    </section>
  )
}
