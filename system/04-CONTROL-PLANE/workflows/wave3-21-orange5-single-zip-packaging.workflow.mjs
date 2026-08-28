// wave3-21-orange5-single-zip-packaging.workflow.mjs — Orange5 distributable + installer/uninstaller.
export const meta = { name: 'wave3-21-orange5-single-zip-packaging', description: 'Orange5 single-zip distributable + install/uninstall scripts', phases: [{title:'Author'},{title:'Synth'}] }
const ROOT = 'C:/AtomEons/Orange5'
const A = { type:'object', properties:{component:{type:'string'},files_written:{type:'array',items:{type:'string'}},line_counts:{type:'object',additionalProperties:{type:'integer'}},notes:{type:'string'}}, required:['component','files_written','line_counts','notes'], additionalProperties:false }
const S = { type:'object', properties:{status:{enum:['green','partial','red']},files_landed:{type:'integer'},receipt_path:{type:'string'}}, required:['status','files_landed','receipt_path'], additionalProperties:false }
const CTX = `Orange5 ships as a single .zip the operator (or anyone) drops on a clean Windows + WSL2 machine. Includes: source tree, manifests, install ceremony, uninstall scripts, integrity verification. Quality: real PowerShell + Bash, idempotent, signed hash manifest, rollback-safe. AVOID atomic-orange (02-APP) packaging — operator owns that lane separately.`
phase('Author')
const C = [
  {id:'manifest', prompt:`Author ${ROOT}/dist/MANIFEST.v0.json — schema orange5.dist.manifest.v0. Lists every dir under Orange5/ (except 02-APP, .git, node_modules, target, _tmp, *-cache) with sha256 hashes computed at build time. ${CTX}`},
  {id:'pack-script', prompt:`Author ${ROOT}/dist/pack.ps1 — PowerShell that walks the tree, excludes per-MANIFEST rules, computes SHAs, zips to dist/orange5-v<NN>-<date>.zip + dist/orange5-v<NN>.sha256. Idempotent. ${CTX}`},
  {id:'install-script', prompt:`Author ${ROOT}/dist/install.ps1 — verifies zip SHA, extracts to operator-chosen dir, runs scripts/wave12-wire-up.ps1 -DryRun, prints next-steps. Refuses to overwrite existing Orange5 install without -Force. ${CTX}`},
  {id:'uninstall-script', prompt:`Author ${ROOT}/dist/uninstall.ps1 — stops all daemons via systemctl + npm scripts, removes Orange5 dir, leaves /mnt/ae_flux receipts on disk (operator owns deletion), emits uninstall receipt to operator's home dir. ${CTX}`},
  {id:'verify-script', prompt:`Author ${ROOT}/dist/verify.ps1 — post-install integrity check. Re-hashes every file in MANIFEST, reports drift. ${CTX}`},
  {id:'docs', prompt:`Author ${ROOT}/dist/README.md — install in 3 steps, uninstall in 1, integrity verification, what's NOT in the zip (02-APP separate, trained adapters separate, secrets never), honest gaps. ${CTX}`},
]
const r = await parallel(C.map(c=>()=>agent(c.prompt,{phase:'Author',label:`pack:${c.id}`,schema:A,effort:'high'})))
phase('Synth')
const s = await agent(`Write receipt at ${ROOT}/10-RECEIPTS/orange5-build/2026-06-25-orange5-single-zip-packaging.md. ${JSON.stringify(r.filter(Boolean),null,2)}.`, {phase:'Synth',label:'synth',schema:S,effort:'high'})
return { status: s?.status || 'unknown', components: r.filter(Boolean), synth: s }
