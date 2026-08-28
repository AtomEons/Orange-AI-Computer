import { describe, expect, it } from 'vitest'

import {
  activeThreadId,
  buildBuildRunTimeline,
  type AtomicOrangeBuildRun,
} from '@/lib/orange-build-runs'

const run = (
  patch: Partial<AtomicOrangeBuildRun> = {}
): AtomicOrangeBuildRun => ({
  schema: 'atomic-orange.build-run.v1',
  runId: 'run-test',
  threadId: 'thread-1',
  goal: 'Prove the operator loop',
  projectRoot: 'C:/work',
  workspaceRoots: ['C:/work'],
  mode: 'execute',
  stage: 'execute',
  status: 'working',
  nextAction: 'observe',
  receipts: [],
  blockers: [],
  createdAt: '2026-08-28T00:00:00.000Z',
  updatedAt: '2026-08-28T00:01:00.000Z',
  ...patch,
})

describe('Build Run client projection', () => {
  it('extracts the active thread without leaking query or hash text', () => {
    expect(activeThreadId('/threads/thread%201')).toBe('thread 1')
    expect(activeThreadId('/settings')).toBeNull()
  })

  it('projects completed, active, and pending stages', () => {
    const timeline = buildBuildRunTimeline(run())

    expect(timeline.find((step) => step.stage === 'lease')?.state).toBe(
      'complete'
    )
    expect(timeline.find((step) => step.stage === 'execute')?.state).toBe(
      'active'
    )
    expect(timeline.find((step) => step.stage === 'verify')?.state).toBe(
      'pending'
    )
  })

  it('shows terminal and blocked truth at the current stage', () => {
    expect(
      buildBuildRunTimeline(run({ stage: 'verify', status: 'blocked' })).find(
        (step) => step.stage === 'verify'
      )?.state
    ).toBe('blocked')
    expect(
      buildBuildRunTimeline(
        run({ stage: 'settle', status: 'completed' })
      ).every((step) => step.state === 'complete')
    ).toBe(true)
  })
})
