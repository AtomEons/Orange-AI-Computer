// wave3-08-misfit-second-opinion-hermes-live.workflow.mjs
// AE Misfit second-opinion gate LIVE in Hermes pre-action — turns the Wave 2 #027 second-opinion.mjs from STATIC to LIVE.
// Different from Wave 3-04 (which is training+wiring); this one is the LIVE production-side enforcement integration.

export const meta = {
  name: 'wave3-08-misfit-second-opinion-hermes-live',
  description: 'Misfit second-opinion as Hermes pre-action gate: live enforcement, override audit trail, kill-switch',
  phases: [
    { title: 'Author', detail: '8 parallel authors' },
    { title: 'Synth', detail: 'integration receipt' },
  ],
}

const ROOT = 'C:/AtomEons/Orange5'

const AUTHOR_SCHEMA = { type: 'object', properties: { component: { type: 'string' }, files_written: { type: 'array', items: { type: 'string' } }, line_counts: { type: 'object', additionalProperties: { type: 'integer' } }, notes: { type: 'string' } }, required: ['component', 'files_written', 'line_counts', 'notes'], additionalProperties: false }
const SYNTH_SCHEMA = { type: 'object', properties: { status: { enum: ['green', 'partial', 'red'] }, files_landed: { type: 'integer' }, receipt_path: { type: 'string' }, open_issues: { type: 'array', items: { type: 'string' } } }, required: ['status', 'files_landed', 'receipt_path', 'open_issues'], additionalProperties: false }

const CTX = `
AE Misfit second-opinion live-enforcement doctrine:
- Wave 2 #027 authored 04-CONTROL-PLANE/misfit/second-opinion.mjs — currently STATIC (no enforcement).
- Wave 3-04 authored the Hermes pre-action middleware skeleton.
- This workflow makes it LIVE: real enforcement, real audit trail, real operator override path, real kill-switch.
- Risk-level matrix:
  - low: no second-opinion required (pass through to LOOM 8 gates)
  - medium: second-opinion advisory (logged but doesn't block)
  - high: second-opinion blocking (REFUSE blocks the action, CONFIRM proceeds)
  - critical: second-opinion + human approval BOTH required
- Override: operator can override a Misfit REFUSE only via signed approval in 08-HERMES/approvals/. Override is logged with full audit chain.
- Kill-switch: env HERMES_MISFIT_DISABLED=1 disables second-opinion entirely (falls back to LOOM 8 only). Loud warning logged.
- Available-but-unreachable path: if AE Misfit Ollama tag missing, returns {decision:'allow-with-warning'} NOT pretend-confirm. Logged loud.
Quality: real Bun HTTP middleware, real audit log, real kill-switch behavior, real override path.
`

phase('Author')
const components = [
  { id: 'preaction-router-wire', prompt: `Read ${ROOT}/08-HERMES/src/server.mjs and produce the splice that registers the pre-action middleware BEFORE the LOOM gate chain on POST /action. The middleware loads from src/pre-action/misfit-second-opinion.mjs (authored in Wave 3-04). Output the unified replacement of server.mjs. ${CTX}` },
  { id: 'risk-level-matrix', prompt: `Author ${ROOT}/08-HERMES/src/pre-action/risk-matrix.mjs — pure function that maps (action_verb, target_project, lease.risk_level, evidence_hint) → {required_second_opinion, blocking}. Cover: production_deploy=critical, schema_migration=high, destructive_write=critical, file_create=low, query_only=low. Returns deterministic verdict. Tests at tests/risk-matrix.test.mjs. ${CTX}` },
  { id: 'override-handler', prompt: `Author ${ROOT}/08-HERMES/src/pre-action/override.mjs — checks for a signed operator override at 08-HERMES/approvals/override-{action_id}.json before allowing a Misfit REFUSE to be bypassed. Signature scheme: Ed25519, public key from env ATOM_OPERATOR_PUBKEY. Override expires after 1h. Logs the override decision to Thought Flux. ${CTX}` },
  { id: 'kill-switch', prompt: `Author ${ROOT}/08-HERMES/src/pre-action/kill-switch.mjs — checks env HERMES_MISFIT_DISABLED. If true, returns {bypass:true, reason:'kill-switch-active'} and logs a Reality Flux warning every 5 min while active. Returns {bypass:false} otherwise. ${CTX}` },
  { id: 'audit-log', prompt: `Author ${ROOT}/08-HERMES/src/pre-action/audit.mjs — JSONL audit log at 08-HERMES/audit/misfit-decisions.jsonl. Each entry: {ts, action_id, risk_level, misfit_decision, misfit_reason, override?, gate_result, total_latency_ms}. Hash-chain forward. ${CTX}` },
  { id: 'aesee-misfit-stream', prompt: `Author ${ROOT}/02-APP/src/components/aesee/MisfitStream.tsx — React component that polls /v1/hermes/misfit-decisions (paged tail) and renders a vertical timeline of recent second-opinion decisions. REFUSE in red, CONFIRM in green, OVERRIDE in amber with override icon. Click → detail drawer. Honest empty state. ${CTX}` },
  { id: 'gateway-misfit-decisions', prompt: `Author ${ROOT}/06-ORANGELLM/server/routes/misfit-decisions.mjs — GET /v1/hermes/misfit-decisions?tail=N (read from JSONL audit log). Read-only, no PII leakage. Boundary update. ${CTX}` },
  { id: 'live-smoke', prompt: `Author ${ROOT}/08-HERMES/tests/misfit-live-smoke.mjs — boots Hermes, fires (a) low-risk action through (asserts bypass), (b) high-risk action with mocked Misfit REFUSE (asserts block + audit log entry), (c) high-risk action with mocked CONFIRM (asserts proceeds to LOOM), (d) critical action without operator approval (asserts double-block). Mocked Misfit via env MISFIT_MOCK_VERDICT for the test only. ${CTX}` },
]
const results = await parallel(components.map(c => () => agent(c.prompt, { phase: 'Author', label: `mflive:${c.id}`, schema: AUTHOR_SCHEMA, effort: 'high' })))

phase('Synth')
const synth = await agent(`Write receipt at ${ROOT}/10-RECEIPTS/orange5-build/2026-06-26-wave3-08-misfit-second-opinion-hermes-live.md. Components: ${JSON.stringify(results.filter(Boolean), null, 2)}. prior_receipt + hash_chain. Honest gaps: live enforcement WORKS but second-opinion model (ae-misfit:v0) still must be loaded into Ollama on Codexa for non-mock invocations. Mom's Law. Return via StructuredOutput.`, { phase: 'Synth', label: 'synth', schema: SYNTH_SCHEMA, effort: 'high' })
return { status: synth?.status || 'unknown', components: results.filter(Boolean), synth }
