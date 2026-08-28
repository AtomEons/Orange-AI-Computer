// wave3-26-toolmesh-11-lab.workflow.mjs — ToolMesh 11-lab capability layer LIVE.
export const meta = { name: 'wave3-26-toolmesh-11-lab', description: 'ToolMesh: 11 capability labs with tool-cards system', phases: [{title:'Author'},{title:'Synth'}] }
const ROOT = 'C:/AtomEons/Orange5'
const A = { type:'object', properties:{component:{type:'string'},files_written:{type:'array',items:{type:'string'}},line_counts:{type:'object',additionalProperties:{type:'integer'}},notes:{type:'string'}}, required:['component','files_written','line_counts','notes'], additionalProperties:false }
const S = { type:'object', properties:{status:{enum:['green','partial','red']},files_landed:{type:'integer'},receipt_path:{type:'string'}}, required:['status','files_landed','receipt_path'], additionalProperties:false }
const CTX = `ToolMesh per Orange5 spec: 11 capability labs (image, video, audio, design, coding, automation, analytics, public-agent, observability, security, releaseops). Each lab holds tool-cards — capability indicators OrangeLLM consults before requesting operator approval. Tool-cards are NOT permission-to-execute (Hermes leases handle execution); they're capability discovery + cost/latency estimates. JSON-schema'd, hot-reloadable.`
phase('Author')
const C = [
  {id:'tool-card-schema', prompt:`Author ${ROOT}/09-SCHEMAS/tool-card.v0.schema.json — schema orange5.tool-card.v0. Required: lab, card_id, capability, cost_class (free|byo-key|metered), latency_class (sub-second|seconds|minutes), inputs, outputs, default_lease_template, risk_class, last_verified_at. ${CTX}`},
  {id:'tool-registry', prompt:`Author ${ROOT}/13-TOOLMESH/registry.mjs — loads + validates all tool-cards across the 11 labs. Hot-reload on file change. Index by lab/capability/cost. Search API. ${CTX}`},
  {id:'lab-image', prompt:`Author ${ROOT}/13-TOOLMESH/labs/image/ — 5 tool-cards: image-describe (GLM-4.6V), image-generate (frontier offload), image-edit (DALL-E via frontier), image-ground-bbox (OrangeEye), image-ocr (Tesseract). Each lab/<card>.json. ${CTX}`},
  {id:'lab-coding-automation-analytics', prompt:`Author ${ROOT}/13-TOOLMESH/labs/coding/ /automation/ /analytics/ — 5 cards each. Coding: search-code, run-tests, lint, refactor, diff-review. Automation: scheduled-task, webhook-listen, gh-action-trigger, cron-task, ifttt-bridge. Analytics: sql-query, dataframe-ops, chart-render, anomaly-detect, summarize-metric. ${CTX}`},
  {id:'lab-others', prompt:`Author ${ROOT}/13-TOOLMESH/labs/{video,audio,design,public-agent,observability,security,releaseops}/ — 3-5 cards each. Real, concrete capabilities, each tool-card valid against tool-card.v0 schema. ${CTX}`},
  {id:'gateway-routes', prompt:`Author ${ROOT}/06-ORANGELLM/server/routes/toolmesh.mjs — GET /v1/toolmesh/labs (list 11), GET /v1/toolmesh/labs/:lab/cards (per-lab cards), GET /v1/toolmesh/search?q=&risk=&cost= (cross-lab search). Boundary update. ${CTX}`},
  {id:'consult-helper', prompt:`Author ${ROOT}/06-ORANGELLM/memory/toolmesh-consult.mjs — exposed to OrangeLLM for "what capabilities can I invoke for X". Auto-injected in system role when relevant via memory-inject middleware. ${CTX}`},
  {id:'smoke', prompt:`Author ${ROOT}/13-TOOLMESH/smoke.mjs — 8 cases: registry loads all cards; schema validation rejects malformed; search by cost-class; search by risk; lab listing; gateway routes return correct shapes; consult-helper picks the cheapest capable card; hot-reload triggers re-index. ${CTX}`},
  {id:'docs', prompt:`Author ${ROOT}/13-TOOLMESH/README.md — 11 labs explained, when to add a new card, schema + hot-reload, integration with Hermes (tool-card → lease template), with Promotion Gate (card promotion requires receipt + bakeoff). ${CTX}`},
]
const r = await parallel(C.map(c=>()=>agent(c.prompt,{phase:'Author',label:`tm:${c.id}`,schema:A,effort:'high'})))
phase('Synth')
const s = await agent(`Write receipt at ${ROOT}/10-RECEIPTS/orange5-build/2026-06-25-toolmesh-11-lab.md. ${JSON.stringify(r.filter(Boolean),null,2)}.`, {phase:'Synth',label:'synth',schema:S,effort:'high'})
return { status: s?.status || 'unknown', components: r.filter(Boolean), synth: s }
