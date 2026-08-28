import { describe, expect, it } from 'vitest'
import { extractOrangeTurnMetadata } from '../orange-turn-metadata'

describe('Orange turn metadata', () => {
  it('extracts route and receipt truth from a final gateway chunk', () => {
    expect(
      extractOrangeTurnMetadata({
        ae_lane: 'navigator',
        ae_requested_tier: 'navigator',
        ae_execution_tier: 'navigator',
        ae_effective_model: 'orange-navigator:7b',
        ae_effective_node: 'codexa-tunnel',
        ae_response_contract: 'orange.report.v1',
        ae_execution_performed: false,
        ae_report_repair_applied: true,
        ae_order_id: 'gw-order-1',
        ae_build_run: {
          runId: 'run-1',
          status: 'working',
          stage: 'observe',
        },
        ae_turn: {
          receipt: {
            id: 'rcpt_1',
            seq: 670,
            hash: 'abc123',
            path: 'C:\\Orange5\\spine-chain.jsonl',
          },
        },
      })
    ).toEqual({
      orderId: 'gw-order-1',
      lane: 'navigator',
      requestedTier: 'navigator',
      executionTier: 'navigator',
      effectiveModel: 'orange-navigator:7b',
      effectiveNode: 'codexa-tunnel',
      responseContract: 'orange.report.v1',
      responseMode: null,
      executionPerformed: false,
      reportRepairApplied: true,
      buildRun: {
        runId: 'run-1',
        status: 'working',
        stage: 'observe',
      },
      receipt: {
        id: 'rcpt_1',
        seq: 670,
        hash: 'abc123',
        path: 'C:\\Orange5\\spine-chain.jsonl',
      },
    })
  })

  it('rejects ordinary provider chunks without Orange proof', () => {
    expect(extractOrangeTurnMetadata({ choices: [] })).toBeNull()
  })
})
