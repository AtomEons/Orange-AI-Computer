import { cn } from '@/lib/utils'

// `Model` is a global ambient type (see web-app/src/types/modelProviders.d.ts).
type ModelSource = NonNullable<Model['source']>

const SOURCE_META: Record<
  ModelSource,
  { label: string; className: string }
> = {
  ollama: {
    label: 'Ollama',
    className:
      'border-violet-200 bg-violet-50 text-violet-800 dark:border-violet-800 dark:bg-violet-950/45 dark:text-violet-200',
  },
  lmstudio: {
    label: 'LM Studio',
    className:
      'border-sky-200 bg-sky-50 text-sky-800 dark:border-sky-800 dark:bg-sky-950/45 dark:text-sky-200',
  },
  unsloth: {
    label: 'Unsloth',
    className:
      'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/45 dark:text-emerald-200',
  },
  'huggingface-cache': {
    label: 'Unsloth',
    className:
      'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/45 dark:text-emerald-200',
  },
  local: {
    label: 'Local',
    className:
      'border-slate-300 bg-slate-100 text-slate-700 dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-200',
  },
}

// Pill labeling where an imported model's weights live; nothing for app-managed ones.
export function ModelSourceBadge({
  source,
  className,
}: {
  source?: Model['source']
  className?: string
}) {
  if (!source) return null

  const meta = SOURCE_META[source]
  if (!meta) return null

  return (
    <span
      title={`Detected from ${meta.label}`}
      className={cn(
        'inline-block rounded-[6px] border px-1.5 py-0.5 text-[10px] font-semibold uppercase leading-tight tracking-wider',
        meta.className,
        className
      )}
    >
      {meta.label}
    </span>
  )
}

// Red pill for a broken link: the weights file is gone (the source app deleted it).
export function MissingModelBadge({
  source,
  className,
}: {
  source?: Model['source']
  className?: string
}) {
  const origin = source ? SOURCE_META[source]?.label : undefined

  const title = origin
    ? `The file for this model was removed in ${origin}. Re-add it there, or delete this entry.`
    : 'The file for this model is missing on disk. Re-import it, or delete this entry.'

  return (
    <span
      title={title}
      className={cn(
        'inline-block rounded-[6px] border px-1.5 py-0.5 text-[10px] font-semibold uppercase leading-tight tracking-wider',
        'border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/45 dark:text-red-300',
        className
      )}
    >
      Unavailable
    </span>
  )
}

export default ModelSourceBadge
