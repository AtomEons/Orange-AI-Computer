export type OrangeTurnMetadata = {
  orderId: string | null
  lane: string | null
  requestedTier: string | null
  executionTier: string | null
  effectiveModel: string | null
  effectiveNode: string | null
  responseContract: string | null
  responseMode: string | null
  executionPerformed: boolean
  reportRepairApplied: boolean
  buildRun: {
    runId: string | null
    status: string | null
    stage: string | null
  } | null
  receipt: {
    id: string | null
    seq: number | null
    hash: string | null
    path: string | null
  } | null
}

type UnknownRecord = Record<string, unknown>

const record = (value: unknown): UnknownRecord | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null

const stringOrNull = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null

const numberOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

/** Extract the proof-bearing Orange fields from the final OpenAI chunk. */
export function extractOrangeTurnMetadata(
  value: unknown
): OrangeTurnMetadata | null {
  const body = record(value)
  if (!body) return null
  const turn = record(body.ae_turn)
  const route = record(turn?.route)
  const receipt = record(turn?.receipt)
  const buildRun = record(body.ae_build_run)
  const orderId = stringOrNull(body.ae_order_id) ?? stringOrNull(turn?.order_id)

  if (!orderId && !receipt && !body.ae_response_contract) return null

  return {
    orderId,
    lane:
      stringOrNull(body.ae_lane) ?? stringOrNull(route?.lane),
    requestedTier:
      stringOrNull(body.ae_requested_tier) ??
      stringOrNull(route?.requested_tier),
    executionTier:
      stringOrNull(body.ae_execution_tier) ??
      stringOrNull(route?.execution_tier),
    effectiveModel:
      stringOrNull(body.ae_effective_model) ??
      stringOrNull(route?.effective_model),
    effectiveNode:
      stringOrNull(body.ae_effective_node) ??
      stringOrNull(route?.effective_node),
    responseContract: stringOrNull(body.ae_response_contract),
    responseMode: stringOrNull(body.ae_response_mode),
    executionPerformed: body.ae_execution_performed === true,
    reportRepairApplied: body.ae_report_repair_applied === true,
    buildRun: buildRun
      ? {
          runId: stringOrNull(buildRun.runId),
          status: stringOrNull(buildRun.status),
          stage: stringOrNull(buildRun.stage),
        }
      : null,
    receipt: receipt
      ? {
          id: stringOrNull(receipt.id),
          seq: numberOrNull(receipt.seq),
          hash: stringOrNull(receipt.hash),
          path: stringOrNull(receipt.path),
        }
      : null,
  }
}
