export type OrangeReportStatus =
  | 'completed'
  | 'needs_action'
  | 'blocked'
  | 'rejected'

export type OrangeReport = {
  schema: 'orange.report.v1'
  orderId: string
  status: OrangeReportStatus
  confidence: number
  actionsTaken: string[]
  evidence: string[]
  findings: string[]
  blockers: string[]
  nextAction: string
  receiptPath: string | null
}

const STATUSES = new Set<OrangeReportStatus>([
  'completed',
  'needs_action',
  'blocked',
  'rejected',
])

const stringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string')

export function parseOrangeReport(value: string): OrangeReport | null {
  try {
    const candidate = JSON.parse(value) as Record<string, unknown>
    if (
      candidate.schema !== 'orange.report.v1' ||
      typeof candidate.orderId !== 'string' ||
      !STATUSES.has(candidate.status as OrangeReportStatus) ||
      typeof candidate.confidence !== 'number' ||
      candidate.confidence < 0 ||
      candidate.confidence > 1 ||
      !stringList(candidate.actionsTaken) ||
      !stringList(candidate.evidence) ||
      !stringList(candidate.findings) ||
      !stringList(candidate.blockers) ||
      typeof candidate.nextAction !== 'string' ||
      (candidate.receiptPath !== null &&
        typeof candidate.receiptPath !== 'string')
    ) {
      return null
    }

    return candidate as OrangeReport
  } catch {
    return null
  }
}
