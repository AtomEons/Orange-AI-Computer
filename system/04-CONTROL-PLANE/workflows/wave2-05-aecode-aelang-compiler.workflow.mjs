// wave2-05-aecode-aelang-compiler.workflow.mjs — AECode mission compiler + AELang two-tier router.

export const meta = { name: 'wave2-05-aecode-aelang-compiler', description: 'AECode mission compiler + AELang router', phases: [{title:'Author'},{title:'Synth'}] }
const ROOT = 'C:/AtomEons/Orange5'
const SCHEMA = { type: 'object', properties: { component: { type: 'string' }, files_written: { type: 'array', items: { type: 'string' } }, line_counts: { type: 'object', additionalProperties: { type: 'integer' } }, notes: { type: 'string' } }, required: ['component', 'files_written', 'line_counts', 'notes'], additionalProperties: false }
const SYNTH = { type: 'object', properties: { status: { enum: ['green', 'partial', 'red'] }, files_landed: { type: 'integer' }, receipt_path: { type: 'string' } }, required: ['status', 'files_landed', 'receipt_path'], additionalProperties: false }

const CTX = `
AECode + AELang doctrine:
- AECode = canonical source contract. Pipeline: intent → AECode Source → mission contract → target plan → patch → gauntlet → receipt → approval
- AECode Source has sections: identity, product_intent, operator_laws, scope, target_matrix, artifact_contracts, data_contracts, behavior_graph, permissions, model_roles, gauntlets, receipts, rollback. Schema at 09-SCHEMAS/aecode-final-format.schema.json
- AELang v0.1 = two-tier route language. AELang-High (human-readable intent) → AELang-Core (machine-parseable) → ORANGEBOX Route Packet
- Operates under AE0-AE14 departments. Route-first, receipt-first, visual-first discipline.
Quality: real compiler code. Parser + AST + validator. Real router. Tests.
`

phase('Author')
const components = [
  { id: 'aecode-parser', prompt: `Author ${ROOT}/04-CONTROL-PLANE/aecode/parser.mjs. Parses AECode Source (Markdown-front-matter + structured sections) into an AST. Validates against aecode-final-format.schema.json. Handles all 13 required sections. ${CTX}` },
  { id: 'aecode-compiler', prompt: `Author ${ROOT}/04-CONTROL-PLANE/aecode/compiler.mjs. Compiles AECode AST → mission contract → target plan. Outputs orange.order.v1 + per-target patch plan + gauntlet steps + receipt plan + rollback plan. ${CTX}` },
  { id: 'aecode-mission-runner', prompt: `Author ${ROOT}/04-CONTROL-PLANE/aecode/mission-runner.mjs. Executes a mission contract by: running each step through Hermes /v1/hermes/action, applying patches, running gauntlet, writing receipt, looping until done or blocked. ${CTX}` },
  { id: 'aelang-high-parser', prompt: `Author ${ROOT}/04-CONTROL-PLANE/aelang/high-parser.mjs. Parses human-readable AELang-High intent strings into an intermediate IR. Examples: "ship Orange5 v1 with Æ Cobra LIVE by Friday", "compress all 12 AtomSmasher modules to LIVE". ${CTX}` },
  { id: 'aelang-core-emitter', prompt: `Author ${ROOT}/04-CONTROL-PLANE/aelang/core-emitter.mjs. Converts IR → AELang-Core (typed, machine-parseable). Each Core packet has: action_verb, target_lattice, lane_route, risk_level, deadline. ${CTX}` },
  { id: 'aelang-route-packet', prompt: `Author ${ROOT}/04-CONTROL-PLANE/aelang/route-packet.mjs. Wraps AELang-Core into ORANGEBOX Route Packet for the FATCAT dial plan (extension routing). Adds department headers, dispatch metadata. ${CTX}` },
  { id: 'fatcat-dial', prompt: `Author ${ROOT}/04-CONTROL-PLANE/fatcat/dial.mjs. Extension router: 100=AE0 Factory, 103=LIPS, 106=AE6, 107=MIRRORS, 111=AE11, 114=CHECKMATE, 200=CODEXA Heavy, 911=Operator Pause. Routes Route Packets to their destination. Also write party-line JSONL writer at 04-CONTROL-PLANE/fatcat/party-line.mjs (append-only inter-dept status stream). ${CTX}` },
  { id: 'gateway-aecode-routes', prompt: `Author ${ROOT}/06-ORANGELLM/server/routes/aecode.mjs. Gateway routes: POST /v1/aecode/compile (input: aecode source markdown → output: mission contract), POST /v1/aecode/mission/start, GET /v1/aecode/mission/:id, POST /v1/aelang/route (AELang-High → Route Packet). Smoke test at 04-CONTROL-PLANE/aecode/smoke-test.mjs. ${CTX}` },
]
const results = await parallel(components.map(c => () => agent(c.prompt, { phase: 'Author', label: `ae:${c.id}`, schema: SCHEMA, effort: 'high' })))

phase('Synth')
const synth = await agent(`Write receipt at ${ROOT}/10-RECEIPTS/orange5-build/2026-06-25-aecode-aelang-compiler.md. Components: ${JSON.stringify(results.filter(Boolean), null, 2)}. prior_receipt + hash_chain. Mom's Law. Return via StructuredOutput.`, { phase: 'Synth', label: 'synth', schema: SYNTH, effort: 'high' })
return { status: synth?.status || 'unknown', components: results.filter(Boolean), synth }
