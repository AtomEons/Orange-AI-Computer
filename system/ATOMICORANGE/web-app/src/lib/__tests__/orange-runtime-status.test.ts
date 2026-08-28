import { describe, expect, it } from 'vitest'

import { parseOrangeRuntimeStatus } from '@/lib/orange-runtime-status'

describe('parseOrangeRuntimeStatus', () => {
  it('renders only evidence-backed organs as live', () => {
    const status = parseOrangeRuntimeStatus(
      {
        status: 'ok',
        service: 'orangellm-gateway',
        boundary: 'frontier_isolation_active',
        version: 'orange5.test',
        upstream: {
          reflex: { live: true },
          navigator: { live: true },
        },
        primary: {
          live: true,
          warm: true,
          model: 'orange-navigator:test',
          host: '10.0.0.4',
        },
        memory: {
          serving: 'ae_cobra',
          cobra: { live: true, latency_ms: 42 },
        },
        fabric: {
          mode: 'distributed',
          navigatorPhysicalRemote: true,
          navigatorHost: '10.0.0.4',
          navigatorNodeId: 'codexa-direct',
        },
      },
      {
        ok: true,
        data: {
          status: 'alive',
          gates: 8,
          active_leases: 1,
          misfit: { enabled: true, load_error: null },
        },
      },
      {
        ok: true,
        service: 'atomsmasher2',
        counts: { features: 620, receipts: 1441 },
      },
      {
        schema: 'orange.ops.learning.v1',
        stats: { total: 459, open: 0, failed: 0 },
      },
      '2026-08-27T00:00:00.000Z'
    )

    expect(status.gateway.live).toBe(true)
    expect(status.gateway).toMatchObject({
      degraded: false,
      reflexLive: true,
    })
    expect(status.navigator).toMatchObject({
      live: true,
      model: 'orange-navigator:test',
      host: '10.0.0.4',
    })
    expect(status.memory).toMatchObject({ live: true, latencyMs: 42 })
    expect(status.codexa).toEqual({
      state: 'connected',
      expected: true,
      connected: true,
      host: '10.0.0.4',
      nodeId: 'codexa-direct',
    })
    expect(status.hermes).toMatchObject({ live: true, gates: 8, misfit: true })
    expect(status.atomSmasher).toMatchObject({ live: true, features: 620 })
    expect(status.learning).toMatchObject({ live: true, total: 459, open: 0 })
  })

  it('fails closed when a payload is missing or misidentified', () => {
    const status = parseOrangeRuntimeStatus(
      { status: 'ok', service: 'some-other-gateway' },
      null,
      { ok: true, service: 'not-atomsmasher' },
      { schema: 'unknown' }
    )

    expect(status.gateway.live).toBe(false)
    expect(status.navigator.live).toBe(false)
    expect(status.memory.live).toBe(false)
    expect(status.hermes.live).toBe(false)
    expect(status.atomSmasher.live).toBe(false)
    expect(status.learning.live).toBe(false)
    expect(status.codexa.state).toBe('unknown')
  })

  it('keeps local control truth separate from a Codexa disconnect', () => {
    const status = parseOrangeRuntimeStatus(
      {
        status: 'degraded',
        service: 'orangellm-gateway',
        boundary: 'frontier_isolation_active',
        version: 'orange5.test',
        upstream: {
          reflex: { live: true },
          navigator: { live: false },
        },
        primary: { live: false, host: '10.0.0.4' },
        fabric: {
          mode: 'distributed',
          navigatorPhysicalRemote: true,
          navigatorHost: '10.0.0.4',
          navigatorNodeId: 'codexa-direct',
        },
      },
      null,
      null,
      null
    )

    expect(status.gateway).toMatchObject({
      live: true,
      degraded: true,
      reflexLive: true,
    })
    expect(status.navigator.live).toBe(false)
    expect(status.codexa).toMatchObject({
      state: 'disconnected',
      expected: true,
      connected: false,
    })
  })
})
