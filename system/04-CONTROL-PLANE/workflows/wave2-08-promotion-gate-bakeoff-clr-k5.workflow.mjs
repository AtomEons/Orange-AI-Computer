// wave2-08-promotion-gate-bakeoff-clr-k5.workflow.mjs
// Promotion Gate runtime + Bakeoff harness + CLR-K=5 Phase-5 upgrade.

export const meta = { name: 'wave2-08-promotion-gate-bakeoff-clr-k5', description: 'Promotion Gate + Bakeoff + CLR-K5', phases: [{title:'Author'},{title:'Synth'}] }
const ROOT = 'C:/AtomEons/Orange5'
const SCHEMA = { type: 'object', properties: { component: { type: 'string' }, files_written: { type: 'array', items: { type: 'string' } }, line_counts: { type: 'object', additionalProperties: { type: 'integer' } }, notes: { type: 'string' } }, required: ['component', 'files_written', 'line_counts', 'notes'], additionalProperties: false }
const SYNTH = { type: 'object', properties: { status: { enum: ['green', 'partial', 'red'] }, files_landed: { type: 'integer' }, receipt_path: { type: 'string' } }, required: ['status', 'files_landed', 'receipt_path'], additionalProperties: false }

const CTX = `
Doctrine:
- Promotion Gate: decides promote/hold/reject for any candidate change. Required inputs: receipt_path, bakeoff result, status, risk_level. Auto-rejects on fake-green words; auto-holds on missing receipt or bakeoff; requires operator_approved=true for risk_level in [high, destructive, production]. Lives at 04-CONTROL-PLANE/promotion-gate/.
- Bakeoff harness: 5-dimension head-to-head eval. Mission-shape, doctrine-recall, topology-recall, receipt-grounding, refusal-discipline. Each dim 0-1, candidate must win >=4 of 5 to promote.
- CLR-K5: Claim-Level Reliability Phase-5 — K=5 candidates per turn, claim verification against Reality lane + Hermes receipts. Threshold 0.50. Replaces Night-1's K=1 in Æ Cobra.
Quality: real Node 20+. Tests.
`

phase('Author')
const components = [
  { id: 'promotion-gate-engine', prompt: `Author ${ROOT}/04-CONTROL-PLANE/promotion-gate/engine.mjs. Exports decide(opts) → 'promote'|'hold'|'reject' with reason. Reads bakeoff + receipt + status + risk_level. ${CTX}` },
  { id: 'promotion-gate-cli', prompt: `Author CLI ${ROOT}/04-CONTROL-PLANE/promotion-gate/promote.mjs. Usage: node promote.mjs --receipt <path> --bakeoff <path> --status <s> --risk <r> [--operator-approved]. ${CTX}` },
  { id: 'bakeoff-harness', prompt: `Author the bakeoff harness at ${ROOT}/04-CONTROL-PLANE/bakeoff/harness.mjs. Exports runBakeoff({baselineModel, challengerModel, dimensions}). Probes both with the same 10-15 prompts per dimension, scores 0-1 per probe, aggregates per-dim averages, declares per-dim winner + overall verdict. ${CTX}` },
  { id: 'bakeoff-dimensions', prompt: `Author the 5 dimension probe sets at ${ROOT}/04-CONTROL-PLANE/bakeoff/dimensions/{mission-shape,doctrine-recall,topology-recall,receipt-grounding,refusal-discipline}.mjs. Each is a JSON of 10-15 prompts + scoring rubric (regex or LLM-judged via gateway). ${CTX}` },
  { id: 'clr-k5-verifier', prompt: `Author the CLR-K5 verifier at ${ROOT}/06-ORANGELLM/memory/ae-cobra/clr/verifier-k5.mjs. K=5 candidates generated per event (caller batches), each scored on: anti-fluff, grounding, risk-vs-content, claim-verification-against-reality. Median 3-of-5 must pass threshold. Threshold 0.50. Returns {scores:[5], median, accepted, reasons[]}. ${CTX}` },
  { id: 'clr-bridge', prompt: `Author the CLR bridge at ${ROOT}/06-ORANGELLM/memory/ae-cobra/clr/bridge.mjs. Selects K=1 (Night-1) vs K=5 (Phase-5) based on event risk_level + operator config. Exports verify(turn, opts). Tests at clr/tests/bridge.test.mjs. ${CTX}` },
  { id: 'gateway-promotion-routes', prompt: `Author gateway routes at ${ROOT}/06-ORANGELLM/server/routes/promotion.mjs. POST /v1/promotion/decide, POST /v1/bakeoff/run, GET /v1/bakeoff/:id, POST /v1/clr/verify. Boundary update. Smoke test. ${CTX}` },
]
const results = await parallel(components.map(c => () => agent(c.prompt, { phase: 'Author', label: `pg:${c.id}`, schema: SCHEMA, effort: 'high' })))

phase('Synth')
const synth = await agent(`Write receipt at ${ROOT}/10-RECEIPTS/orange5-build/2026-06-25-promotion-gate-bakeoff-clr-k5.md. Components: ${JSON.stringify(results.filter(Boolean), null, 2)}. prior_receipt + hash_chain. Mom's Law. Return via StructuredOutput.`, { phase: 'Synth', label: 'synth', schema: SYNTH, effort: 'high' })
return { status: synth?.status || 'unknown', components: results.filter(Boolean), synth }
