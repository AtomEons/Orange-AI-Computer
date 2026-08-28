// wave3-25-federation-triumvirate.workflow.mjs — multi-instance Orange5 coordination.
export const meta = { name: 'wave3-25-federation-triumvirate', description: 'Federation Triumvirate — multi-instance Orange5 coordination doctrine + protocol', phases: [{title:'Author'},{title:'Synth'}] }
const ROOT = 'C:/AtomEons/Orange5'
const A = { type:'object', properties:{component:{type:'string'},files_written:{type:'array',items:{type:'string'}},line_counts:{type:'object',additionalProperties:{type:'integer'}},notes:{type:'string'}}, required:['component','files_written','line_counts','notes'], additionalProperties:false }
const S = { type:'object', properties:{status:{enum:['green','partial','red']},files_landed:{type:'integer'},receipt_path:{type:'string'}}, required:['status','files_landed','receipt_path'], additionalProperties:false }
const CTX = `Federation Triumvirate Doctrine (per operator's standing law): multiple Orange5 instances can federate for coordination but each remains sovereign. No instance overrides another's Mom's Law / receipts / guardrails. Inter-instance protocol: federated state-brief, federated receipt cross-reference, federated lease delegation (rare). Read C:/AtomEons/orangebox/docs/ if a doctrine doc exists. Quality: real protocol code, real handshake, real refusal modes.`
phase('Author')
const C = [
  {id:'doctrine', prompt:`Author ${ROOT}/01-DOCTRINE/federation/triumvirate.md — full doctrine: instances peer not hierarchy; each owns Mom's Law locally; federated calls require explicit lease grant; sovereign override on any cross-instance order. ${CTX}`},
  {id:'handshake-protocol', prompt:`Author ${ROOT}/04-CONTROL-PLANE/federation/handshake.mjs — Bun :7490 daemon. Two-instance mutual TLS handshake (per-pair certs operator generates), capability exchange, time-sync, schema-version check. Refuses unrelated/untrusted peers. ${CTX}`},
  {id:'federated-state-brief', prompt:`Author ${ROOT}/04-CONTROL-PLANE/federation/state-brief.mjs — exposes /v1/federation/state-brief that returns this instance's compressed StateBrief to a paired peer. Strips sovereign-private fields (PII, API keys, raw receipts) — peer sees only doctrine-grade facts. ${CTX}`},
  {id:'federated-lease', prompt:`Author ${ROOT}/04-CONTROL-PLANE/federation/lease.mjs — federated lease grant. Instance A asks Instance B "may I act on this scope on your behalf". Operator approval required at BOTH sides. Lease is per-action, expires fast. ${CTX}`},
  {id:'cross-receipt', prompt:`Author ${ROOT}/04-CONTROL-PLANE/federation/cross-receipt.mjs — federated receipt cross-reference. Instance A's receipt can cite an Instance B receipt by URL. Each side keeps its own hash chain; cross-link is bidirectional but read-only. ${CTX}`},
  {id:'gateway-routes', prompt:`Author ${ROOT}/06-ORANGELLM/server/routes/federation.mjs — /v1/federation/handshake /state-brief /lease /cross-receipt. mTLS-gated. Boundary update. ${CTX}`},
  {id:'smoke', prompt:`Author ${ROOT}/04-CONTROL-PLANE/federation/smoke.mjs — 2-instance simulated test (uses a sibling Orange5 path as the "remote"). Asserts handshake, state-brief, lease-grant, cross-receipt. ${CTX}`},
  {id:'docs', prompt:`Author ${ROOT}/04-CONTROL-PLANE/federation/README.md — when to federate (rare; mostly for multi-machine operator setups), when NOT to (federation is not multi-tenant), security boundaries, operator's authority over both sides. ${CTX}`},
]
const r = await parallel(C.map(c=>()=>agent(c.prompt,{phase:'Author',label:`fed:${c.id}`,schema:A,effort:'high'})))
phase('Synth')
const s = await agent(`Write receipt at ${ROOT}/10-RECEIPTS/orange5-build/2026-06-25-federation-triumvirate.md. ${JSON.stringify(r.filter(Boolean),null,2)}.`, {phase:'Synth',label:'synth',schema:S,effort:'high'})
return { status: s?.status || 'unknown', components: r.filter(Boolean), synth: s }
