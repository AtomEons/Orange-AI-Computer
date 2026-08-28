// wave2-01-hermes-daemon.workflow.mjs — Hermes bounded agentic execution layer.
// 8 LOOM gates + lease enforcement + Playwright/DevTools MCP adapters.

export const meta = {
  name: 'wave2-01-hermes-daemon',
  description: 'Hermes daemon + 8 LOOM gates + lease enforcement + MCP tool adapters',
  phases: [
    { title: 'Author', detail: '12 parallel authors' },
    { title: 'Synth', detail: 'integration receipt' },
  ],
}

const ROOT = 'C:/AtomEons/Orange5'

const AUTHOR_SCHEMA = { type: 'object', properties: { component: { type: 'string' }, files_written: { type: 'array', items: { type: 'string' } }, line_counts: { type: 'object', additionalProperties: { type: 'integer' } }, notes: { type: 'string' } }, required: ['component', 'files_written', 'line_counts', 'notes'], additionalProperties: false }
const SYNTH_SCHEMA = { type: 'object', properties: { status: { enum: ['green', 'partial', 'red'] }, files_landed: { type: 'integer' }, receipt_path: { type: 'string' }, open_issues: { type: 'array', items: { type: 'string' } } }, required: ['status', 'files_landed', 'receipt_path', 'open_issues'], additionalProperties: false }

const CTX = `
Hermes doctrine (read 08-HERMES/ existing if present):
- Replaces "OpenClaw" — bounded execution layer where every action by any LLM in the superstack goes through a lease.
- Lease shape: {id, actor, allowed (string[] action verbs), forbidden (string[] auto-merged defaults), targetProject, riskLevel, expires_at, requires_approval}
- Default forbidden auto-merged: destructive_write, production_deploy, scope_expansion, egress_unbounded
- 8 LOOM gates that must all pass before an action lands:
  1. order_schema — order matches orange.order.v1
  2. report_schema — report matches orange.report.v1
  3. receipt_spine — receipt_path exists
  4. human_approval — if lease.requires_approval, operator approved
  5. codexa_lease — lease present
  6. openai_gateway — gateway-mediated (not direct frontier socket)
  7. mcp_default — default MCP handshake
  8. false_green_guard — no fake-green words in status
- Tool adapters: Playwright MCP, Chrome DevTools MCP (these are external MCPs the operator has installed)
- Reach: gateway /v1/hermes/* routes; Hermes daemon on 127.0.0.1:7430 (loopback)
- Frontier-Isolation: Hermes is reachable only through gateway; frontier model never reaches Hermes directly.
Quality: real Node 20+, structured errors, honest gaps in README per file.
`

phase('Author')
const components = [
  { id: 'lease-engine', prompt: `Author the Hermes lease engine at ${ROOT}/08-HERMES/src/lease-engine.mjs. Exports: createLease(opts), checkAction(lease, action, ctx), revokeLease(id, reason), listActive(). In-memory map + SQLite at 08-HERMES/leases.db for durability across restarts. Lease expiry handled by background reaper. Refusal reasons: lease_expired, action_forbidden, operator_approval_required, scope_violation. Write tests at 08-HERMES/tests/lease-engine.test.mjs. ${CTX}` },
  { id: 'loom-gate-1-order-schema', prompt: `Author LOOM gate 1 (order_schema) at ${ROOT}/08-HERMES/src/loom-gates/01-order-schema.mjs. Validates orange.order.v1 against 09-SCHEMAS/orange.order.v1.schema.json. Returns {pass, reasons}. ${CTX}` },
  { id: 'loom-gate-2-report-schema', prompt: `Author LOOM gate 2 (report_schema) at ${ROOT}/08-HERMES/src/loom-gates/02-report-schema.mjs. Validates orange.report.v1 outputs. ${CTX}` },
  { id: 'loom-gate-3-receipt-spine', prompt: `Author LOOM gate 3 (receipt_spine) at ${ROOT}/08-HERMES/src/loom-gates/03-receipt-spine.mjs. Verifies receipt_path exists on disk + reads it to confirm valid orange5.receipt.v0 + hash_chain continuity (prior_receipt resolves). ${CTX}` },
  { id: 'loom-gate-4-human-approval', prompt: `Author LOOM gate 4 (human_approval) at ${ROOT}/08-HERMES/src/loom-gates/04-human-approval.mjs. Reads pending-approvals queue at 08-HERMES/approvals/pending.jsonl; pass if approved=true + signed by sovereign. Approval expires after lease.expires_at. ${CTX}` },
  { id: 'loom-gate-5-codexa-lease', prompt: `Author LOOM gate 5 (codexa_lease) at ${ROOT}/08-HERMES/src/loom-gates/05-codexa-lease.mjs. Verifies action's lease is present + active + matches the actor. ${CTX}` },
  { id: 'loom-gate-6-openai-gateway', prompt: `Author LOOM gate 6 (openai_gateway) at ${ROOT}/08-HERMES/src/loom-gates/06-openai-gateway.mjs. Verifies any LLM call went through 127.0.0.1:1337 (Frontier-Isolation). Inspects action.evidence for a gateway request_id. ${CTX}` },
  { id: 'loom-gate-7-mcp-default', prompt: `Author LOOM gate 7 (mcp_default) at ${ROOT}/08-HERMES/src/loom-gates/07-mcp-default.mjs. Validates MCP handshake — server reachable, capabilities exchanged, tool-card resolved. ${CTX}` },
  { id: 'loom-gate-8-false-green', prompt: `Author LOOM gate 8 (false_green_guard) at ${ROOT}/08-HERMES/src/loom-gates/08-false-green.mjs. Scans action's status + report.status for fake-green regex (green_assumed|looks_ok|probably|should_work|fake_green). Rejects on any hit. ${CTX}` },
  { id: 'hermes-daemon', prompt: `Author the Hermes daemon at ${ROOT}/08-HERMES/src/server.mjs. Bun HTTP server on 127.0.0.1:7430. Routes: POST /lease (create), POST /action (execute through all 8 gates), GET /healthz, GET /approvals, POST /approvals/:id (operator approves). Loopback-only. Pulls all 8 gates dynamically + runs in order; short-circuits on first fail. ${CTX}` },
  { id: 'playwright-adapter', prompt: `Author the Playwright MCP adapter at ${ROOT}/08-HERMES/adapters/playwright.mjs. Exposes click({x,y}), fill({selector,text}), screenshot(), navigate({url}) as Hermes-gated actions. Each call goes through Hermes' /action endpoint with the proper lease check. ${CTX}` },
  { id: 'gateway-hermes-routes', prompt: `Author gateway /v1/hermes/* routes at ${ROOT}/06-ORANGELLM/server/routes/hermes.mjs. Proxies to Hermes daemon at 127.0.0.1:7430. Routes: POST /v1/hermes/lease, POST /v1/hermes/action, GET /v1/hermes/approvals. Boundary-list update at hermes-boundary.mjs. Smoke test at 08-HERMES/smoke-test.mjs that creates a lease + tries a forbidden action (rejected) + tries an allowed action (passes 8 gates). ${CTX}` },
]
const results = await parallel(components.map(c => () => agent(c.prompt, { phase: 'Author', label: `hermes:${c.id}`, schema: AUTHOR_SCHEMA, effort: 'high' })))

phase('Synth')
const synth = await agent(`Write receipt at ${ROOT}/10-RECEIPTS/orange5-build/2026-06-25-hermes-daemon-built.md. Components: ${JSON.stringify(results.filter(Boolean), null, 2)}. prior_receipt from latest receipt file. Hash chain forward. Honest gaps: still no GUI for approvals queue. Mom's Law. Return via StructuredOutput.`, { phase: 'Synth', label: 'synth', schema: SYNTH_SCHEMA, effort: 'high' })
return { status: synth?.status || 'unknown', components: results.filter(Boolean), synth }
