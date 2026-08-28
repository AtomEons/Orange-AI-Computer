// wave3-28-codexa-legacy-migration.workflow.mjs — formal deprecation + cutover of Codexa legacy Docker stack.
export const meta = { name: 'wave3-28-codexa-legacy-migration', description: 'Codexa legacy container migration — open-webui / n8n / orangebox-wiki kill scripts with safe cutover', phases: [{title:'Author'},{title:'Synth'}] }
const ROOT = 'C:/AtomEons/Orange5'
const A = { type:'object', properties:{component:{type:'string'},files_written:{type:'array',items:{type:'string'}},line_counts:{type:'object',additionalProperties:{type:'integer'}},notes:{type:'string'}}, required:['component','files_written','line_counts','notes'], additionalProperties:false }
const S = { type:'object', properties:{status:{enum:['green','partial','red']},files_landed:{type:'integer'},receipt_path:{type:'string'}}, required:['status','files_landed','receipt_path'], additionalProperties:false }
const CTX = `Codexa runs legacy Docker: aeorangebox-ai-box-{open-webui,n8n,wiki,postgres,redis}-1 + aeorangebox-ai-box-qdrant-1. Per receipt #013: kill open-webui at W1 close, n8n at W1 close, orangebox-wiki at W2 close, KEEP qdrant, evaluate postgres+redis. Migration must be SAFE: backup volumes first, verify replacement is up, kill + reclaim. No-Take-Down Law unless explicitly authorized.`
phase('Author')
const C = [
  {id:'pre-flight', prompt:`Author ${ROOT}/scripts/codexa-migration/preflight.ps1 — verifies state before any kill: Atomic Orange installer green (open-webui replacement); Hermes daemon LIVE (n8n replacement); Vault lane LIVE w/ Mirage StateBrief (wiki replacement); Qdrant data backed up; Postgres + Redis volumes snapshotted. Refuses to proceed if any check fails. ${CTX}`},
  {id:'open-webui-cutover', prompt:`Author ${ROOT}/scripts/codexa-migration/01-kill-open-webui.ps1 — verifies Atomic Orange is up, backs up open-webui volume (chat history) to /opt/atomeons/migrations/open-webui-<date>.tar.gz, docker stop + rm, frees memory. Includes rollback script. ${CTX}`},
  {id:'n8n-cutover', prompt:`Author ${ROOT}/scripts/codexa-migration/02-kill-n8n.ps1 — verifies Hermes :7430 healthz, exports n8n workflows to /opt/atomeons/migrations/n8n-workflows-<date>.json, docker stop + rm. ${CTX}`},
  {id:'wiki-cutover', prompt:`Author ${ROOT}/scripts/codexa-migration/03-kill-wiki.ps1 — verifies Vault lane has Mirage StateBrief flowing, exports wiki pages as Markdown to 19-ARCHIVE/orangebox-wiki-<date>/, docker stop + rm. ${CTX}`},
  {id:'pg-redis-evaluate', prompt:`Author ${ROOT}/scripts/codexa-migration/04-evaluate-pg-redis.ps1 — probes if Mirage adapters (postgres + redis) still need those backends. If unused → mark for kill + scheduled retirement. If used → flag and skip. ${CTX}`},
  {id:'reclaim-summary', prompt:`Author ${ROOT}/scripts/codexa-migration/reclaim.ps1 — final summary script: shows RAM reclaimed, disk reclaimed, containers killed, backups created. Writes the receipt. ${CTX}`},
  {id:'rollback-master', prompt:`Author ${ROOT}/scripts/codexa-migration/rollback-all.ps1 — UNDO every kill in reverse order. Restores from backup. Mom's Law: every destructive op must have a rollback. ${CTX}`},
  {id:'docs', prompt:`Author ${ROOT}/scripts/codexa-migration/README.md — migration sequence, prerequisites, what gets backed up, what gets killed, ~8-15 GB expected RAM reclaim, rollback procedure. ${CTX}`},
]
const r = await parallel(C.map(c=>()=>agent(c.prompt,{phase:'Author',label:`mig:${c.id}`,schema:A,effort:'high'})))
phase('Synth')
const s = await agent(`Write receipt at ${ROOT}/10-RECEIPTS/orange5-build/2026-06-25-codexa-legacy-migration.md. ${JSON.stringify(r.filter(Boolean),null,2)}.`, {phase:'Synth',label:'synth',schema:S,effort:'high'})
return { status: s?.status || 'unknown', components: r.filter(Boolean), synth: s }
