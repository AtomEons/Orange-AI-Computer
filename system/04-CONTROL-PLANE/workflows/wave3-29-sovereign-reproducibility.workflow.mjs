// wave3-29-sovereign-reproducibility.workflow.mjs — clean-machine install → green in N min.
export const meta = { name: 'wave3-29-sovereign-reproducibility', description: 'Sovereign reproducibility test — clean Windows + WSL2 machine to GREEN Orange5 in <30 min', phases: [{title:'Author'},{title:'Synth'}] }
const ROOT = 'C:/AtomEons/Orange5'
const A = { type:'object', properties:{component:{type:'string'},files_written:{type:'array',items:{type:'string'}},line_counts:{type:'object',additionalProperties:{type:'integer'}},notes:{type:'string'}}, required:['component','files_written','line_counts','notes'], additionalProperties:false }
const S = { type:'object', properties:{status:{enum:['green','partial','red']},files_landed:{type:'integer'},receipt_path:{type:'string'}}, required:['status','files_landed','receipt_path'], additionalProperties:false }
const CTX = `Sovereign reproducibility: any operator (or future-Atom on a fresh machine) can install Orange5 backend from scratch and reach green in <30 min. Tests the install + boot path end-to-end. NOT atomic-orange (that's a separate concern). Quality: real bootstrap, real verification, real timing receipts.`
phase('Author')
const C = [
  {id:'bootstrap-script', prompt:`Author ${ROOT}/scripts/repro/bootstrap.ps1 — clean-machine bootstrap: install Node 20 + Bun + Python + Ollama + Docker + Git + gh CLI (idempotent checks). Verify each. ${CTX}`},
  {id:'unpack-and-install', prompt:`Author ${ROOT}/scripts/repro/install.ps1 — unzips Orange5 distributable (from wave3-21), runs wave12-wire-up.ps1, validates all daemons start (gateway :1337, Hermes :7430, 9-Gate :7450, Guardrails :7460). ${CTX}`},
  {id:'env-template', prompt:`Author ${ROOT}/scripts/repro/.env.template — every env var Orange5 needs: ORANGEBOX_RAIL_TOKEN, ATOMEONS_PG_URL, GOOGLE_DRIVE_*, GMAIL_REFRESH_TOKEN, SLACK_BOT_TOKEN, GITHUB_TOKEN, REDIS_URL, ATOMEONS_IDENTITY_SECRET, ATOMEONS_FOUNDER_SALARY_PER_INSTALL_CENTS. Each with comment explaining what it's for. ${CTX}`},
  {id:'verify-script', prompt:`Author ${ROOT}/scripts/repro/verify.ps1 — runs every smoke-test.mjs in the tree, runs guardrails sweep, runs red-team battery from wave3-24, runs receipts CLI chain-verify. Prints per-subsystem green/red tally. Refuses to declare green if any RED. ${CTX}`},
  {id:'timing-harness', prompt:`Author ${ROOT}/scripts/repro/timing.ps1 — wraps the whole bootstrap+install+verify in a stopwatch. Asserts <30min total. Records breakdown per step. ${CTX}`},
  {id:'failure-postmortem', prompt:`Author ${ROOT}/scripts/repro/postmortem.ps1 — runs only on failure. Collects: logs from every daemon, last 5 receipts, env state, port snapshot, npm install output, systemd status. Writes a postmortem.tar.gz the operator can ship. ${CTX}`},
  {id:'doctor', prompt:`Author ${ROOT}/scripts/repro/doctor.ps1 — diagnostic. Probes every Orange5 endpoint, surfaces what's broken vs working. Like 'kubectl get pods' for Orange5. ${CTX}`},
  {id:'docs', prompt:`Author ${ROOT}/scripts/repro/README.md — full repro test procedure, expected wall-clock, what GREEN means (every smoke green + every guardrail pass + zero RED red-team scenario), rollback (uninstall via wave3-21 uninstall.ps1). ${CTX}`},
]
const r = await parallel(C.map(c=>()=>agent(c.prompt,{phase:'Author',label:`repro:${c.id}`,schema:A,effort:'high'})))
phase('Synth')
const s = await agent(`Write receipt at ${ROOT}/10-RECEIPTS/orange5-build/2026-06-25-sovereign-reproducibility.md. ${JSON.stringify(r.filter(Boolean),null,2)}.`, {phase:'Synth',label:'synth',schema:S,effort:'high'})
return { status: s?.status || 'unknown', components: r.filter(Boolean), synth: s }
