// wave3-27-knowledge-strata.workflow.mjs — Knowledge Strata compiler loop.
export const meta = { name: 'wave3-27-knowledge-strata', description: 'Knowledge Strata: intake → canon → durable artifact → integrity pass → reuse compiler loop', phases: [{title:'Author'},{title:'Synth'}] }
const ROOT = 'C:/AtomEons/Orange5'
const A = { type:'object', properties:{component:{type:'string'},files_written:{type:'array',items:{type:'string'}},line_counts:{type:'object',additionalProperties:{type:'integer'}},notes:{type:'string'}}, required:['component','files_written','line_counts','notes'], additionalProperties:false }
const S = { type:'object', properties:{status:{enum:['green','partial','red']},files_landed:{type:'integer'},receipt_path:{type:'string'}}, required:['status','files_landed','receipt_path'], additionalProperties:false }
const CTX = `Knowledge Strata (per AtomEons canon): intake → canon → durable artifact → integrity pass → reuse. Compiler loop that takes raw operator/agent input (notes, transcripts, receipts), canonizes against doctrine, emits durable artifacts (versioned MD + JSON), runs integrity (no contradiction with prior canon), enables reuse (cite in future receipts). Each step has its own gate. Quality: real Node 20+ pipeline, real artifacts, real integrity check.`
phase('Author')
const C = [
  {id:'intake', prompt:`Author ${ROOT}/04-CONTROL-PLANE/knowledge-strata/intake.mjs — accepts raw text/JSON via POST /v1/strata/intake. Stamps {received_at, source, raw_sha256}. Writes to Reality Flux origin='strata_intake'. ${CTX}`},
  {id:'canonizer', prompt:`Author ${ROOT}/04-CONTROL-PLANE/knowledge-strata/canonize.mjs — takes intake, runs through OrangeLLM (or Smart Skinny for cheap pre-pass) to extract entities + claims + cited doctrine. Tags by department (AE0-AE14). Writes structured canon row. ${CTX}`},
  {id:'durable-artifact-emit', prompt:`Author ${ROOT}/04-CONTROL-PLANE/knowledge-strata/emit.mjs — converts canon row to a versioned Markdown + JSON pair under 19-ARCHIVE/strata/<topic>/<version>/. Each artifact has prior_version + hash chain. ${CTX}`},
  {id:'integrity-pass', prompt:`Author ${ROOT}/04-CONTROL-PLANE/knowledge-strata/integrity.mjs — checks new artifact for contradiction with prior canon (vector-search against existing 19-ARCHIVE artifacts via Graph Weaver embedder). Flags conflicts; refuses emit on hard conflict; logs softer conflicts for operator review. ${CTX}`},
  {id:'reuse-resolver', prompt:`Author ${ROOT}/04-CONTROL-PLANE/knowledge-strata/reuse.mjs — when a receipt cites strata/<id>, resolver fetches the artifact, validates it still exists + signature still valid, returns full content for receipt-rendering. ${CTX}`},
  {id:'gateway-routes', prompt:`Author ${ROOT}/06-ORANGELLM/server/routes/strata.mjs — /v1/strata/{intake,canonize,emit,query,resolve}. Boundary update. ${CTX}`},
  {id:'sqlite-index', prompt:`Author ${ROOT}/04-CONTROL-PLANE/knowledge-strata/index.db schema + ingest. Tracks artifact_id, topic, version, prior_version, sha256, emitted_at, archive_path. Query API. ${CTX}`},
  {id:'smoke', prompt:`Author ${ROOT}/04-CONTROL-PLANE/knowledge-strata/smoke.mjs — 7 cases: intake → canon → emit roundtrip; integrity catches contradiction; integrity allows compatible update; reuse resolver returns content; versioning preserves prior; receipt-citation roundtrip; gateway routes respond. ${CTX}`},
  {id:'docs', prompt:`Author ${ROOT}/04-CONTROL-PLANE/knowledge-strata/README.md — 5-step loop explained, doctrine integration, when to use vs writing a receipt directly, archive structure, integrity rules. ${CTX}`},
]
const r = await parallel(C.map(c=>()=>agent(c.prompt,{phase:'Author',label:`ks:${c.id}`,schema:A,effort:'high'})))
phase('Synth')
const s = await agent(`Write receipt at ${ROOT}/10-RECEIPTS/orange5-build/2026-06-25-knowledge-strata.md. ${JSON.stringify(r.filter(Boolean),null,2)}.`, {phase:'Synth',label:'synth',schema:S,effort:'high'})
return { status: s?.status || 'unknown', components: r.filter(Boolean), synth: s }
