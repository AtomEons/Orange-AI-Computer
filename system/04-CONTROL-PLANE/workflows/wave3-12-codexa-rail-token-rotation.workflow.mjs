// wave3-12-codexa-rail-token-rotation.workflow.mjs
// Codexa rail token automated rotation + secure storage.
// Wave 2 noted ORANGEBOX_RAIL_TOKEN missing was a blocker. This wave builds the rotation + storage ceremony.

export const meta = {
  name: 'wave3-12-codexa-rail-token-rotation',
  description: 'Codexa rail token rotation: scheduled rotation, Windows DPAPI storage, gateway hot-reload, audit',
  phases: [
    { title: 'Author', detail: '9 parallel authors' },
    { title: 'Synth', detail: 'integration receipt' },
  ],
}

const ROOT = 'C:/AtomEons/Orange5'

const AUTHOR_SCHEMA = { type: 'object', properties: { component: { type: 'string' }, files_written: { type: 'array', items: { type: 'string' } }, line_counts: { type: 'object', additionalProperties: { type: 'integer' } }, notes: { type: 'string' } }, required: ['component', 'files_written', 'line_counts', 'notes'], additionalProperties: false }
const SYNTH_SCHEMA = { type: 'object', properties: { status: { enum: ['green', 'partial', 'red'] }, files_landed: { type: 'integer' }, receipt_path: { type: 'string' }, open_issues: { type: 'array', items: { type: 'string' } } }, required: ['status', 'files_landed', 'receipt_path', 'open_issues'], additionalProperties: false }

const CTX = `
Codexa rail token rotation doctrine:
- The rail token (env ORANGEBOX_RAIL_TOKEN) currently lives in a single env var on the N150. If it's missing or stale, all Codexa-side calls 401.
- The Wave 2 close receipt named this as a blocker (orangebox bridge 8787 down + rail token not set).
- This workflow builds a real rotation + storage + propagation flow:
  1. Rotation: generate a new HS256 256-bit token, encode base64url, store in:
     - N150 Windows Credential Manager via DPAPI (for the operator)
     - Codexa /opt/atomeons/.rail-token (chmod 600) via rsync ceremony
     - Atomic Orange Tauri tauri-plugin-stronghold encrypted store (for the app)
  2. Scheduled rotation: every 7 days via Windows Task Scheduler + Codexa systemd timer
  3. Gateway hot-reload: gateway re-reads the token without restart (file-watch on .rail-token)
  4. Audit: every rotation logged to Reality Flux with prior/new sha256 (NOT the tokens themselves)
- Kill-switch: env ORANGEBOX_RAIL_DISABLED=1 — gateway refuses all Codexa-side calls.
- Mom's Law: tokens never appear in logs. Receipts log only sha256 fingerprints. Storage is encrypted at rest.
Quality: real DPAPI usage, real SSH rsync, real systemd timer, real audit, real refusal-on-leak.
`

phase('Author')
const components = [
  { id: 'token-generator', prompt: `Author ${ROOT}/04-CONTROL-PLANE/rail-token/generate.mjs — generates a 256-bit token via Node crypto.randomBytes, encodes base64url. Returns {token, sha256, generated_at}. The actual token value is returned ONCE (for the rotation script to consume); subsequent reads return only the sha256. ${CTX}` },
  { id: 'n150-dpapi-storage', prompt: `Author ${ROOT}/04-CONTROL-PLANE/rail-token/store-n150.ps1 — Powershell script that takes a token from stdin and stores it via Windows Credential Manager (using New-StoredCredential or cmdkey wrapper). Also writes the sha256 to a non-secret state file for verification. ${CTX}` },
  { id: 'codexa-deploy', prompt: `Author ${ROOT}/04-CONTROL-PLANE/rail-token/deploy-codexa.ps1 — Powershell that SCPs the new token to Codexa /opt/atomeons/.rail-token (mode 0600). Verifies sha256 after transfer. Triggers a remote systemctl reload-or-restart orangebox-bridge. ${CTX}` },
  { id: 'atomic-orange-storage', prompt: `Author ${ROOT}/02-APP/src-tauri/src/rail_token.rs — Rust module using tauri-plugin-stronghold to encrypt-at-rest the rail token in the app. Commands: set_rail_token(token), get_rail_token_for_request() (returns the token to the Tauri command handler, never to the WebView/React side directly). ${CTX}` },
  { id: 'gateway-hot-reload', prompt: `Author ${ROOT}/06-ORANGELLM/server/middleware/rail-token-watcher.mjs — chokidar-based file watcher on .rail-token. On change: re-reads token, swaps in-memory reference, logs Reality-lane event with old/new sha256. Without restart. ${CTX}` },
  { id: 'rotation-orchestrator', prompt: `Author ${ROOT}/04-CONTROL-PLANE/rail-token/rotate.ps1 — Powershell orchestrator. Steps: (1) generate new token, (2) deploy to Codexa, (3) deploy to N150 DPAPI, (4) deploy to Atomic Orange via Tauri IPC, (5) wait for all sites to confirm, (6) write audit receipt. Refuses to proceed if any storage site is unreachable (DO NOT leave a partial rotation). ${CTX}` },
  { id: 'scheduled-task-installer', prompt: `Author ${ROOT}/04-CONTROL-PLANE/rail-token/install-schedule.ps1 — installs a Windows Task Scheduler entry "AtomEons-Rail-Rotation" that runs rotate.ps1 every 7 days at 03:00 ET. Idempotent (replaces if exists). Also outputs a sister Codexa systemd timer unit file for the bridge-side rotation hook. ${CTX}` },
  { id: 'audit-log', prompt: `Author ${ROOT}/04-CONTROL-PLANE/rail-token/audit.mjs — append-only JSONL log at state/rail-token-audit.jsonl. Each entry: {ts, action:'rotate'|'leak-detected'|'kill-switch', prior_sha, new_sha, sites_updated:[]}. Hash-chain forward. ${CTX}` },
  { id: 'rotation-smoke', prompt: `Author ${ROOT}/04-CONTROL-PLANE/rail-token/tests/rotation-smoke.ps1 — dry-run smoke: generates token, simulates deploy to all 3 sites with mocked endpoints, asserts hot-reload watcher fires, asserts audit entry written. DOES NOT touch real DPAPI / Codexa / Atomic Orange — those are mocked. ${CTX}` },
]
const results = await parallel(components.map(c => () => agent(c.prompt, { phase: 'Author', label: `rail:${c.id}`, schema: AUTHOR_SCHEMA, effort: 'high' })))

phase('Synth')
const synth = await agent(`Write receipt at ${ROOT}/10-RECEIPTS/orange5-build/2026-06-26-wave3-12-rail-token-rotation.md. Components: ${JSON.stringify(results.filter(Boolean), null, 2)}. prior_receipt + hash_chain. Honest gaps: rotation orchestrator cannot fire until operator confirms (a) Codexa SSH key in env, (b) initial token bootstrap completed manually (cold start), (c) Atomic Orange Tauri stronghold plugin installed. Mom's Law. Return via StructuredOutput.`, { phase: 'Synth', label: 'synth', schema: SYNTH_SCHEMA, effort: 'high' })
return { status: synth?.status || 'unknown', components: results.filter(Boolean), synth }
