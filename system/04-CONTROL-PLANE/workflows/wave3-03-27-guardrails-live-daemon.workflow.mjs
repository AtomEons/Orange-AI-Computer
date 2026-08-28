// wave3-03-27-guardrails-live-daemon.workflow.mjs
// Finishes the 27 Guardrails wire — current state has spec + 30 check files but NO live daemon smoke-tested.
// This workflow: launches the daemon, fixes any failing checks, wires gateway probe, integrates into 9-gate-stack.

export const meta = {
  name: 'wave3-03-27-guardrails-live-daemon',
  description: '27 Guardrails: launch daemon, fix red checks, wire gateway, integrate as Gate 0 input',
  phases: [
    { title: 'Author', detail: '8 parallel authors' },
    { title: 'Synth', detail: 'integration receipt' },
  ],
}

const ROOT = 'C:/AtomEons/Orange5'

const AUTHOR_SCHEMA = { type: 'object', properties: { component: { type: 'string' }, files_written: { type: 'array', items: { type: 'string' } }, line_counts: { type: 'object', additionalProperties: { type: 'integer' } }, notes: { type: 'string' } }, required: ['component', 'files_written', 'line_counts', 'notes'], additionalProperties: false }
const SYNTH_SCHEMA = { type: 'object', properties: { status: { enum: ['green', 'partial', 'red'] }, files_landed: { type: 'integer' }, receipt_path: { type: 'string' }, open_issues: { type: 'array', items: { type: 'string' } } }, required: ['status', 'files_landed', 'receipt_path', 'open_issues'], additionalProperties: false }

const CTX = `
27 Guardrails current state (read 01-DOCTRINE/27-guardrails/ first):
- spec.md, runtime.mjs, server.mjs, registry.mjs, package.json all exist
- checks/ has 27 numbered (01..27) + 3 legacy g01..g03 files
- Receipt #033 returned status=partial because runtime daemon never smoke-tested live
- Bun :7460 was specified but not booted
- Gateway routes at 06-ORANGELLM/server/routes/guardrails.mjs exist but never wired into v1.mjs splice
Goal: turn from STATIC scaffolding to LIVE daemon that runs all 27 checks on a schedule + on-demand + as input to Gate 0 LBCE.
Quality: real smoke against current Orange5 disk state. ANY check that returns red gets an honest fix or an honest note in the gap section.
`

phase('Author')
const components = [
  { id: 'daemon-launcher', prompt: `Author ${ROOT}/01-DOCTRINE/27-guardrails/launch.mjs — wrapper that boots server.mjs as a long-running Bun process, captures PID to state/guardrails.pid, registers SIGTERM clean shutdown, logs to state/guardrails.log with rotation at 10MB. CLI: node launch.mjs start|stop|status|tail. Refuses to start if PID file claims live + PID actually responds on :7460. ${CTX}` },
  { id: 'check-runner-fix', prompt: `Read ${ROOT}/01-DOCTRINE/27-guardrails/runtime.mjs and rewrite if needed to: (a) load all 27 checks dynamically from checks/01..27-*.mjs, (b) run in parallel with per-check 5s timeout, (c) return {ok, ran, passed, failed, violations:[{guardrail_id, severity, details}], elapsed_ms}, (d) on failure, write a Reality-lane Flux event tagged origin=guardrails. Keep the registry.mjs as the single source of truth for guardrail IDs. ${CTX}` },
  { id: 'red-check-triage', prompt: `Author ${ROOT}/01-DOCTRINE/27-guardrails/tools/triage-reds.mjs — runs all 27 checks, identifies any that return pass=false, opens a Thought-lane event per red with severity + suggested fix. Used during the live activation to surface real gaps. Outputs a markdown report to state/last-triage.md. ${CTX}` },
  { id: 'cron-scheduler', prompt: `Author ${ROOT}/01-DOCTRINE/27-guardrails/cron.mjs — scheduler that runs the full 27-check sweep every 15 minutes, plus on-demand via /run endpoint. Persists last_run + last_violations to SQLite at state/guardrails.db. Emits to Reality Flux on any new violation (dedupes against last_run). ${CTX}` },
  { id: 'gateway-route-splice', prompt: `Read ${ROOT}/06-ORANGELLM/server/v1.mjs and produce the splice diff (new content for the file) that wires routes/guardrails.mjs into the v1 router. Plus ensure registerGuardrailsRoutes(server) is called once. Also update guardrails-boundary.mjs to enumerate the live endpoints. ${CTX}` },
  { id: 'gate-0-input-bridge', prompt: `Author ${ROOT}/04-CONTROL-PLANE/nine-gate-stack/inputs/guardrails-state.mjs — Gate 0 LBCE consumes this. Reads GET 127.0.0.1:7460/run/cached (last 5 min cache), returns the violation list. Gate 0 blocks the action if any severity=block guardrail is currently red. Honest gap if daemon unreachable: returns {available:false, gate_decision: 'allow-but-warn'} (not 'pretend green'). ${CTX}` },
  { id: 'aesee-guardrails-widget', prompt: `Author ${ROOT}/02-APP/src/components/aesee/GuardrailsHealth.tsx — React component that polls /v1/guardrails/status every 5s, renders the 27 rails as a 9x3 grid of dots (green/yellow/red/dim-when-unreachable). Click a dot → detail drawer showing guardrail_id, last_check_ts, violation details. No fake data; if endpoint not reachable, all dots are dim with an "endpoint offline" tooltip. ${CTX}` },
  { id: 'live-smoke-script', prompt: `Author ${ROOT}/01-DOCTRINE/27-guardrails/tests/live-smoke.mjs — boots the daemon, hits /run, asserts response has all 27 guardrail_ids, verifies persistence to SQLite, kills daemon, restarts, asserts previous violations were rehydrated. CLI: node live-smoke.mjs. ${CTX}` },
]
const results = await parallel(components.map(c => () => agent(c.prompt, { phase: 'Author', label: `g27:${c.id}`, schema: AUTHOR_SCHEMA, effort: 'high' })))

phase('Synth')
const synth = await agent(`Write receipt at ${ROOT}/10-RECEIPTS/orange5-build/2026-06-26-wave3-03-27-guardrails-live-daemon.md. Components: ${JSON.stringify(results.filter(Boolean), null, 2)}. prior_receipt from latest receipt file. Hash chain forward. This workflow is the COMPLETION of the partial #033 receipt. Honest gaps: any check that still returns red must be named in open_issues. Mom's Law. Return via StructuredOutput.`, { phase: 'Synth', label: 'synth', schema: SYNTH_SCHEMA, effort: 'high' })
return { status: synth?.status || 'unknown', components: results.filter(Boolean), synth }
