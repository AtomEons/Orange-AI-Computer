// wave3-14-n150-utility-hardening.workflow.mjs — production-harden the N150 stock-model lane.
export const meta = { name: 'wave3-14-n150-utility-hardening', description: 'N150 utility model lane: classifier + embedder + fallback chat with hot-swap', phases: [{title:'Author'},{title:'Synth'}] }
const ROOT = 'C:/AtomEons/Orange5'
const A = { type:'object', properties:{component:{type:'string'},files_written:{type:'array',items:{type:'string'}},line_counts:{type:'object',additionalProperties:{type:'integer'}},notes:{type:'string'}}, required:['component','files_written','line_counts','notes'], additionalProperties:false }
const S = { type:'object', properties:{status:{enum:['green','partial','red']},files_landed:{type:'integer'},receipt_path:{type:'string'}}, required:['status','files_landed','receipt_path'], additionalProperties:false }
const CTX = `N150 (Beelink, 4 cores, 16 GB) hosts stock-only utility models. Per Wave 1 doctrine: NO custom training, only stock weights. Three jobs: origin-based lane classifier (qwen3:0.6b), Graph Weaver embedder (nomic-embed-text), emergency chat fallback when Codexa unreachable. Hot-swap means swapping stock model versions without service interruption. Quality bar: real Node 20+ daemon code, real systemd unit, real smoke tests.`
phase('Author')
const C = [
  {id:'classifier-daemon', prompt:`Author ${ROOT}/06-ORANGELLM/n150-utility/classifier/daemon.mjs — Bun :7480. POST /classify with {origin, event_metadata} → returns {lane:reality|thought|merge, confidence}. Origin-based per V1 mitigation, not string-match. Backed by qwen3:0.6b via Ollama for borderline cases. Tests. ${CTX}`},
  {id:'embedder-pool', prompt:`Author ${ROOT}/06-ORANGELLM/n150-utility/embedder/pool.mjs — manages a connection pool to Ollama /api/embeddings for nomic-embed-text. 5 concurrent slots, 30s queue timeout, embed-batch helper. Tests. ${CTX}`},
  {id:'fallback-chat', prompt:`Author ${ROOT}/06-ORANGELLM/n150-utility/fallback-chat/server.mjs — Bun :7481. Activates ONLY when Codexa rail unreachable for >60s. Serves degraded chat via qwen3:0.6b with clear "degraded" header on every response. Auto-deactivates when Codexa returns. ${CTX}`},
  {id:'hot-swap', prompt:`Author ${ROOT}/06-ORANGELLM/n150-utility/hot-swap.mjs — swap stock model versions without restart. Procedure: pull new tag → load in shadow → smoke test → flip alias → drain old. Per-model rollback. ${CTX}`},
  {id:'health-monitor', prompt:`Author ${ROOT}/06-ORANGELLM/n150-utility/health-monitor.mjs — daemon at :7482 monitoring classifier + embedder + fallback uptime, latency, error rate. Emits to Cockpit shadow cache. ${CTX}`},
  {id:'systemd-units', prompt:`Author 4 systemd units at ${ROOT}/06-ORANGELLM/n150-utility/systemd/ for classifier / embedder / fallback / health-monitor. MemoryMax bounded (1G classifier, 2G embedder, 4G fallback, 256M monitor). Loopback only. ${CTX}`},
  {id:'gateway-routes', prompt:`Author ${ROOT}/06-ORANGELLM/server/routes/n150-utility.mjs — proxies /v1/n150/{classify,embed,fallback-chat,health} to local daemons. Boundary update. ${CTX}`},
  {id:'smoke', prompt:`Author ${ROOT}/06-ORANGELLM/n150-utility/smoke-test.mjs — 8 cases: classifier origin map; embedder produces 768-dim; fallback activates on rail-down; deactivates on rail-up; hot-swap with rollback; concurrent embedder slots; health monitor reports correctly; 60fps SLA verified. ${CTX}`},
  {id:'docs', prompt:`Author ${ROOT}/06-ORANGELLM/n150-utility/README.md — N150 production setup, hardware budget, why stock-only, hot-swap procedure, Codexa-down failover doctrine. ${CTX}`},
]
const r = await parallel(C.map(c=>()=>agent(c.prompt,{phase:'Author',label:`n150:${c.id}`,schema:A,effort:'high'})))
phase('Synth')
const s = await agent(`Write receipt at ${ROOT}/10-RECEIPTS/orange5-build/2026-06-25-n150-utility-hardening.md. Components: ${JSON.stringify(r.filter(Boolean),null,2)}. prior_receipt + hash_chain.`, {phase:'Synth',label:'synth',schema:S,effort:'high'})
return { status: s?.status || 'unknown', components: r.filter(Boolean), synth: s }
