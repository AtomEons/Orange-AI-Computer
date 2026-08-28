import { fetch as tauriFetch } from '@tauri-apps/plugin-http'

import { ORANGE_FIVE_RUNTIME_ORIGIN } from '@/lib/orange-crossing'

export const BUILD_RUN_UPDATED_EVENT = 'atomic-orange:build-run-updated'
export const BUILD_RUN_STAGES = [
  'intake',
  'route',
  'plan',
  'approve',
  'lease',
  'execute',
  'observe',
  'verify',
  'settle',
] as const

export type AtomicOrangeBuildRunStage = (typeof BUILD_RUN_STAGES)[number]
export type AtomicOrangeBuildRunStatus =
  | 'draft'
  | 'planned'
  | 'awaiting_approval'
  | 'working'
  | 'blocked'
  | 'failed'
  | 'completed'
  | 'cancelled'

export type AtomicOrangeBuildRun = {
  schema: 'atomic-orange.build-run.v1'
  runId: string
  threadId: string | null
  goal: string
  projectRoot: string
  workspaceRoots: string[]
  mode: 'plan' | 'execute' | 'repair' | 'verify' | 'release'
  stage: AtomicOrangeBuildRunStage
  status: AtomicOrangeBuildRunStatus
  nextAction: string | null
  receipts: Array<{ id?: string; seq?: number; hash?: string; path?: string }>
  blockers: unknown[]
  createdAt: string
  updatedAt: string
}

export type BuildRunTimelineState =
  | 'complete'
  | 'active'
  | 'waiting'
  | 'blocked'
  | 'failed'
  | 'cancelled'
  | 'pending'

export type BuildRunTimelineStep = {
  stage: AtomicOrangeBuildRunStage
  state: BuildRunTimelineState
}

export function buildBuildRunTimeline(
  run: AtomicOrangeBuildRun
): BuildRunTimelineStep[] {
  const currentIndex = Math.max(0, BUILD_RUN_STAGES.indexOf(run.stage))
  return BUILD_RUN_STAGES.map((stage, index) => {
    if (index < currentIndex) return { stage, state: 'complete' }
    if (index > currentIndex) return { stage, state: 'pending' }
    if (run.status === 'completed') return { stage, state: 'complete' }
    if (run.status === 'failed') return { stage, state: 'failed' }
    if (run.status === 'blocked') return { stage, state: 'blocked' }
    if (run.status === 'cancelled') return { stage, state: 'cancelled' }
    if (run.status === 'awaiting_approval') return { stage, state: 'waiting' }
    return { stage, state: 'active' }
  })
}

export function announceBuildRunUpdated() {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(BUILD_RUN_UPDATED_EVENT))
  }
}

type BuildRunPage = {
  schema: 'atomic-orange.build-run.page.v1'
  runs: AtomicOrangeBuildRun[]
  chain: { ok: boolean; checked: number; errors: unknown[] }
}

const fetcher = () =>
  typeof IS_TAURI !== 'undefined' && IS_TAURI ? tauriFetch : fetch

export async function readActiveBuildRun(
  threadId: string | null,
  signal?: AbortSignal
): Promise<AtomicOrangeBuildRun | null> {
  if (!threadId) return null
  const url = new URL(`${ORANGE_FIVE_RUNTIME_ORIGIN}/v1/build-runs`)
  url.searchParams.set('thread', threadId)
  url.searchParams.set('limit', '1')
  const response = await fetcher()(url, {
    headers: { Accept: 'application/json' },
    signal,
  })
  if (!response.ok) throw new Error(`Build Runs returned ${response.status}`)
  const page = (await response.json()) as BuildRunPage
  if (page.chain.ok !== true) throw new Error('Build Run chain is invalid')
  return page.runs[0] ?? null
}

export function activeThreadId(pathname = window.location.pathname): string | null {
  const match = pathname.match(/^\/threads\/([^/?#]+)/)
  return match ? decodeURIComponent(match[1]) : null
}
