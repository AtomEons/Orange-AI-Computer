// wave2-12-receipts-sqlite-flow-tick-daily.workflow.mjs
// Receipts SQLite (machine-format binary parallel to Markdown) + AE Flow daily-tick scheduler + weekly summary.

export const meta = { name: 'wave2-12-receipts-sqlite-flow-tick-daily', description: 'Receipts SQLite mirror + AE Flow scheduler + weekly summary', phases: [{title:'Author'},{title:'Synth'}] }
const ROOT = 'C:/AtomEons/Orange5'
const SCHEMA = { type: 'object', properties: { component: { type: 'string' }, files_written: { type: 'array', items: { type: 'string' } }, line_counts: { type: 'object', additionalProperties: { type: 'integer' } }, notes: { type: 'string' } }, required: ['component', 'files_written', 'line_counts', 'notes'], additionalProperties: false }
const SYNTH = { type: 'object', properties: { status: { enum: ['green', 'partial', 'red'] }, files_landed: { type: 'integer' }, receipt_path: { type: 'string' } }, required: ['status', 'files_landed', 'receipt_path'], additionalProperties: false }

const CTX = `
Doctrine:
- Receipts currently Markdown-only at 10-RECEIPTS/orange5-build/. Need parallel SQLite store at 06-CONTROL-PLANE/receipts/orange5.db for fast queries. Same SHA-256 across both stores. Markdown = operator audit, SQLite = machine queries.
- AE Flow currently saves JSON snapshot at 05-FLOW/state/flow.json on every tick. Need a scheduler that ticks every 1s (configurable) when there are pending currents.
- Weekly receipt: Friday 23:55 ET, auto-summarize the week's work as 10-RECEIPTS/orange5-build/<YYYY-MM-DD>-week-N-status.md.
- Endurance gates: synthetic 24h test (replay 24h of historical Flux events at 10x speed) + real 7d uptime monitor.
Quality: real Node 20+. SQLite via better-sqlite3.
`

phase('Author')
const components = [
  { id: 'receipts-sqlite-mirror', prompt: `Author ${ROOT}/06-CONTROL-PLANE/receipts/db.mjs + schema.sql + ingest.mjs. SQLite schema: receipts(receipt_id PK, generated_at, schema, status, confidence, prior_receipt, hash_chain, actor, sovereign, markdown_path, sha256, body_json). Ingest watches 10-RECEIPTS/orange5-build/ via fs.watch, parses front-matter, inserts/updates row. Backfill mode: scan all existing receipts on first run. ${CTX}` },
  { id: 'receipts-query-api', prompt: `Author ${ROOT}/06-CONTROL-PLANE/receipts/query.mjs. Exports queryReceipts({since, status, actor, has_blockers, fake_green_words, limit}). Verifies hash-chain integrity on every read. Plus gateway routes at ${ROOT}/06-ORANGELLM/server/routes/receipts.mjs (GET /v1/receipts, GET /v1/receipts/:id, GET /v1/receipts/chain-verify). ${CTX}` },
  { id: 'ae-flow-scheduler', prompt: `Author ${ROOT}/05-FLOW/scheduler.mjs. Runs AE Flow's tick() every 1s when there are pending currents, idle backoff to 10s when empty. Configurable via ${ROOT}/05-FLOW/scheduler.config.json. systemd unit at 05-FLOW/systemd/ae-flow-scheduler.service. ${CTX}` },
  { id: 'weekly-summary-cron', prompt: `Author ${ROOT}/04-CONTROL-PLANE/continuity/weekly-summary.mjs. Friday 23:55 ET cron-driven. Synthesizes the week's work: receipts grouped by day, gauntlets passed/failed, missions completed, hot blockers. Writes 10-RECEIPTS/orange5-build/<YYYY-MM-DD>-week-N-status.md. Bun script — uses node-cron or systemd timer. ${CTX}` },
  { id: 'endurance-synth-24h', prompt: `Author ${ROOT}/04-CONTROL-PLANE/endurance/synth-24h.mjs. Replays 24h of Flux events at 10x speed against a fresh AE Cobra instance. Asserts: no fake-green, no chain breaks, no memory leaks (process RSS bounded), no upstream timeouts. Bun script. ${CTX}` },
  { id: 'endurance-real-7d-monitor', prompt: `Author ${ROOT}/04-CONTROL-PLANE/endurance/real-7d-monitor.mjs. Background daemon that runs for 7 days, sampling every 10 min: /healthz from Æ Cobra + gateway + colpali + graph-weaver. Writes monitoring JSONL. Emits weekly endurance receipt at end. ${CTX}` },
  { id: 'gateway-flow-routes', prompt: `Author ${ROOT}/06-ORANGELLM/server/routes/flow.mjs. GET /v1/flow/current (highest-pressure current), GET /v1/flow/state (full state), POST /v1/flow/order (new current), GET /v1/flow/deltas (recent deltas), GET /v1/endurance/status. Smoke test. ${CTX}` },
]
const results = await parallel(components.map(c => () => agent(c.prompt, { phase: 'Author', label: `flow:${c.id}`, schema: SCHEMA, effort: 'high' })))

phase('Synth')
const synth = await agent(`Write receipt at ${ROOT}/10-RECEIPTS/orange5-build/2026-06-25-receipts-sqlite-flow-tick-daily.md. Components: ${JSON.stringify(results.filter(Boolean), null, 2)}. prior_receipt + hash_chain. Honest gaps. Return via StructuredOutput.`, { phase: 'Synth', label: 'synth', schema: SYNTH, effort: 'high' })
return { status: synth?.status || 'unknown', components: results.filter(Boolean), synth }
