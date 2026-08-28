// wave3-10-operator-session-start-ritual.workflow.mjs
// Operator session-start ritual — load Soul Genome + Continuity Packet, run guardrails sweep, emit boot receipt.
// Makes "atomeons-prime" structurally real for Orange5 specifically.

export const meta = {
  name: 'wave3-10-operator-session-start-ritual',
  description: 'Session-start ritual: Soul Genome inject, Continuity Packet load, guardrails sweep, deploy grid, boot receipt',
  phases: [
    { title: 'Author', detail: '8 parallel authors' },
    { title: 'Synth', detail: 'integration receipt' },
  ],
}

const ROOT = 'C:/AtomEons/Orange5'

const AUTHOR_SCHEMA = { type: 'object', properties: { component: { type: 'string' }, files_written: { type: 'array', items: { type: 'string' } }, line_counts: { type: 'object', additionalProperties: { type: 'integer' } }, notes: { type: 'string' } }, required: ['component', 'files_written', 'line_counts', 'notes'], additionalProperties: false }
const SYNTH_SCHEMA = { type: 'object', properties: { status: { enum: ['green', 'partial', 'red'] }, files_landed: { type: 'integer' }, receipt_path: { type: 'string' }, open_issues: { type: 'array', items: { type: 'string' } } }, required: ['status', 'files_landed', 'receipt_path', 'open_issues'], additionalProperties: false }

const CTX = `
Session-start ritual doctrine:
- The CLAUDE.md operator-rule "atomeons-prime fires on first substantive turn" is currently aspirational. This workflow makes it a real callable + auditable ceremony.
- Steps in the ritual:
  1. Load Soul Genome (13-MODELS/orange-llm/soul_genome.json) + inject into Claude/OrangeLLM system role
  2. Load latest Continuity Packet via /v1/continuity/latest
  3. Trigger 27 Guardrails full sweep via /v1/guardrails/run
  4. Query recent Reality Flux (last 24h) for hot currents
  5. Read top of Not-Green Ledger to surface blocked items
  6. Emit a boot receipt to 10-RECEIPTS/orange5-build/ with the full grid
  7. Display a compact deploy grid to the operator (one-screen TUI or web view)
- Frequency: fired once per Claude/Codex/operator session start. Idempotent (multiple fires within 5 min return cached grid).
- Reach: callable as: powershell script (N150), gateway POST /v1/session/start, Atomic Orange first-launch hook.
- Mom's Law: every grid line is REAL. No fake "all green" — if guardrails sweep returns 3 reds, the grid says "3 reds: <list>".
Quality: real, real, real. Deterministic output. No model invocations for the grid itself (data only).
`

phase('Author')
const components = [
  { id: 'ritual-orchestrator', prompt: `Author ${ROOT}/04-CONTROL-PLANE/session-start/orchestrator.mjs — pure-data orchestrator. Runs all 7 steps in parallel where possible, aggregates into a single SessionStartGrid object. Caches to state/last-grid.json with TTL 5 min. CLI: node orchestrator.mjs. Returns the grid as JSON. ${CTX}` },
  { id: 'soul-genome-inject', prompt: `Author ${ROOT}/04-CONTROL-PLANE/session-start/inject-genome.mjs — loads soul_genome.json via genome-manager.mjs, formats as a system-role string, POSTs to /v1/genome/inject (or the OrangeLLM context layer). Returns {injected, injected_at, sha256}. ${CTX}` },
  { id: 'continuity-load', prompt: `Author ${ROOT}/04-CONTROL-PLANE/session-start/load-continuity.mjs — GETs /v1/continuity/latest. Surfaces tomorrow's_first_action + open_blockers + hot_currents. If no continuity packet from last 48h, emits an honest "no recent continuity packet" warning to the grid. ${CTX}` },
  { id: 'guardrails-sweep', prompt: `Author ${ROOT}/04-CONTROL-PLANE/session-start/guardrails-sweep.mjs — POSTs /v1/guardrails/run and waits for response. Returns {ok, ran, passed, failed, violations:[]}. If guardrails daemon unreachable, returns {available:false} (NOT pretend green). ${CTX}` },
  { id: 'flux-hot-currents', prompt: `Author ${ROOT}/04-CONTROL-PLANE/session-start/flux-currents.mjs — GETs /v1/atomsmasher/currents (active currents in the last 24h) + /v1/flow/events?lane=reality&from=24h. Aggregates into hot_currents:[{label, depth, last_event_ts}]. Top 5. ${CTX}` },
  { id: 'not-green-ledger-read', prompt: `Author ${ROOT}/04-CONTROL-PLANE/session-start/read-ledger.mjs — reads 00-CHARTER/ORANGE5_NOT_GREEN_LEDGER.md, parses items still flagged not-green, returns top 5 blockers. Surfaces the blocker IDs to the grid. ${CTX}` },
  { id: 'boot-receipt-writer', prompt: `Author ${ROOT}/04-CONTROL-PLANE/session-start/write-boot-receipt.mjs — writes a boot receipt to 10-RECEIPTS/orange5-build/{YYYY-MM-DD}-session-boot-{nnn}.md with the full grid + prior_receipt link + hash. Returns receipt_path. ${CTX}` },
  { id: 'grid-renderer', prompt: `Author ${ROOT}/04-CONTROL-PLANE/session-start/render-grid.mjs — pure function (grid) → compact ASCII deploy grid string. 12-line max. Format: time, location, operator, sovereign, hot_currents, guardrails_status, blockers, continuity_lookback. Also TypeScript-importable for the Atomic Orange first-launch hook. ${CTX}` },
]
const results = await parallel(components.map(c => () => agent(c.prompt, { phase: 'Author', label: `start:${c.id}`, schema: AUTHOR_SCHEMA, effort: 'high' })))

phase('Synth')
const synth = await agent(`Write receipt at ${ROOT}/10-RECEIPTS/orange5-build/2026-06-26-wave3-10-session-start-ritual.md. Components: ${JSON.stringify(results.filter(Boolean), null, 2)}. prior_receipt + hash_chain. Honest gaps: ritual requires gateway + guardrails daemon both live to be fully green; in degraded mode, returns partial grid with named unreachable endpoints. Mom's Law. Return via StructuredOutput.`, { phase: 'Synth', label: 'synth', schema: SYNTH_SCHEMA, effort: 'high' })
return { status: synth?.status || 'unknown', components: results.filter(Boolean), synth }
