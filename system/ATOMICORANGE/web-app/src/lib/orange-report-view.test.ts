import { describe, expect, it } from 'vitest'
import { parseOrangeReport } from './orange-report-view'

const report = {
  schema: 'orange.report.v1',
  orderId: 'gw-order-1',
  status: 'completed',
  confidence: 0.96,
  actionsTaken: [],
  evidence: ['receipt:683'],
  findings: ['OrangeFive route verified'],
  blockers: [],
  nextAction: 'continue',
  receiptPath: null,
}

describe('Orange report view parser', () => {
  it('accepts the governed report contract', () => {
    expect(parseOrangeReport(JSON.stringify(report))).toEqual(report)
  })

  it('leaves ordinary assistant text untouched', () => {
    expect(parseOrangeReport('ordinary answer')).toBeNull()
  })

  it('rejects lookalike JSON without contract fields', () => {
    expect(parseOrangeReport('{"schema":"orange.report.v1"}')).toBeNull()
  })
})
