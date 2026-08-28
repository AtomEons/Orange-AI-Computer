// wave3-22-hermes-mcp-adapters.workflow.mjs — Hermes adapters for Playwright + Chrome DevTools MCP.
export const meta = { name: 'wave3-22-hermes-mcp-adapters', description: 'Hermes adapter pack: Playwright + Chrome DevTools + Computer-Use MCP, all lease-gated', phases: [{title:'Author'},{title:'Synth'}] }
const ROOT = 'C:/AtomEons/Orange5'
const A = { type:'object', properties:{component:{type:'string'},files_written:{type:'array',items:{type:'string'}},line_counts:{type:'object',additionalProperties:{type:'integer'}},notes:{type:'string'}}, required:['component','files_written','line_counts','notes'], additionalProperties:false }
const S = { type:'object', properties:{status:{enum:['green','partial','red']},files_landed:{type:'integer'},receipt_path:{type:'string'}}, required:['status','files_landed','receipt_path'], additionalProperties:false }
const CTX = `Hermes already has playwright.mjs from Wave 2. This wave adds: Chrome DevTools MCP adapter, Computer-Use MCP adapter, plus a hardened policy layer that classifies every MCP tool call by risk_level + asserts the lease covers it. Every adapter dispatches via Hermes /v1/hermes/action — never raw MCP. Quality: real Node 20+, lease-gated, structured errors, tests.`
phase('Author')
const C = [
  {id:'chrome-devtools-adapter', prompt:`Author ${ROOT}/08-HERMES/adapters/chrome-devtools.mjs — wraps the chrome-devtools MCP (navigate_page, click, fill, evaluate_script, etc.) as Hermes-gated actions. Each call: createLease({actor,allowed:['cd.<op>'],riskLevel}) → checkAction → mcp call → record receipt. Test fixtures. ${CTX}`},
  {id:'computer-use-adapter', prompt:`Author ${ROOT}/08-HERMES/adapters/computer-use.mjs — wraps computer-use MCP (screenshot, left_click, type, key, etc.) as Hermes-gated. Risk levels: screenshot=low, left_click=medium, type=medium, key=medium, right_click=medium, scroll=low. Per-action lease. ${CTX}`},
  {id:'mcp-tool-policy', prompt:`Author ${ROOT}/08-HERMES/policy/mcp-tool-policy.mjs — classifies any MCP tool call by name pattern. Returns {risk_level, default_allowed, requires_approval}. Builds the allow-list automatically from the MCP tool registry. ${CTX}`},
  {id:'mcp-router', prompt:`Author ${ROOT}/08-HERMES/mcp-router.mjs — single entry point for any MCP tool call across all adapters. POST /v1/hermes/mcp/{server}/{tool} routes through policy → lease → action → receipt. ${CTX}`},
  {id:'gateway-mcp-routes', prompt:`Author ${ROOT}/06-ORANGELLM/server/routes/hermes-mcp.mjs — gateway-side MCP routes. /v1/hermes/mcp/playwright/* /chrome-devtools/* /computer-use/*. Boundary update at hermes-mcp-boundary.mjs. ${CTX}`},
  {id:'lease-policy-defaults', prompt:`Author ${ROOT}/08-HERMES/policy/defaults.json — default lease shapes per actor type. e.g. "orangellm-fatty" gets read+ui-screenshot by default; "operator-direct" gets everything-but-destructive-write. ${CTX}`},
  {id:'audit-tracer', prompt:`Author ${ROOT}/08-HERMES/audit-tracer.mjs — every MCP call's trace lands in Reality Flux via Æ Cobra writer with kind='receipt', origin='hermes_mcp', body includes lease_id + mcp_server + mcp_tool + args_hash + result_hash. ${CTX}`},
  {id:'smoke', prompt:`Author ${ROOT}/08-HERMES/mcp-smoke.mjs — 9 cases: lease creation, allowed action, forbidden action refused, approval-required action queued, expired lease refused, MCP-down honest 503, audit trace written, concurrent leases, lease revocation. ${CTX}`},
  {id:'docs', prompt:`Author ${ROOT}/08-HERMES/MCP_ADAPTERS.md — full policy doc: every MCP tool we adapt, its default risk_level, its required lease shape, examples of allowed/forbidden usage. ${CTX}`},
]
const r = await parallel(C.map(c=>()=>agent(c.prompt,{phase:'Author',label:`hmcp:${c.id}`,schema:A,effort:'high'})))
phase('Synth')
const s = await agent(`Write receipt at ${ROOT}/10-RECEIPTS/orange5-build/2026-06-25-hermes-mcp-adapters.md. ${JSON.stringify(r.filter(Boolean),null,2)}.`, {phase:'Synth',label:'synth',schema:S,effort:'high'})
return { status: s?.status || 'unknown', components: r.filter(Boolean), synth: s }
