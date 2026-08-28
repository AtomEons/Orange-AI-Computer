// wave3-02-ae-cobra-night1-activation.workflow.mjs
// Æ Cobra Night-1 activation harness — daemon comes LIVE on Codexa once preflight closes.
// Authors the activation choreography even though preflight (WSL2 + Mamba GGUF) is still operator-side.

export const meta = {
  name: 'wave3-02-ae-cobra-night1-activation',
  description: 'Æ Cobra Night-1 activation: GBNF lock, healthcheck, JSONL Flux writer, 14-point gate runner',
  phases: [
    { title: 'Author', detail: '10 parallel authors' },
    { title: 'Synth', detail: 'integration receipt' },
  ],
}

const ROOT = 'C:/AtomEons/Orange5'

const AUTHOR_SCHEMA = { type: 'object', properties: { component: { type: 'string' }, files_written: { type: 'array', items: { type: 'string' } }, line_counts: { type: 'object', additionalProperties: { type: 'integer' } }, notes: { type: 'string' } }, required: ['component', 'files_written', 'line_counts', 'notes'], additionalProperties: false }
const SYNTH_SCHEMA = { type: 'object', properties: { status: { enum: ['green', 'partial', 'red'] }, files_landed: { type: 'integer' }, receipt_path: { type: 'string' }, open_issues: { type: 'array', items: { type: 'string' } } }, required: ['status', 'files_landed', 'receipt_path', 'open_issues'], additionalProperties: false }

const CTX = `
Æ Cobra Night-1 doctrine (read 06-ORANGELLM/memory/ae-cobra/ existing scaffolding first):
- Daemon: Mamba 2.8B Q5_K_M GGUF, llama.cpp built inside WSL2 on Codexa, GBNF-locked AgentTurn JSON output.
- Reach: 127.0.0.1:9100 loopback inside WSL2; exposed to Codexa via WSL2 port-forward; reached from N150 ONLY via gateway /v1/cobra/* proxied through rail.
- Flux: JSONL hash-chain at /mnt/ae_flux/reality.jsonl (Reality lane) + /mnt/ae_flux/thought.jsonl (Thought lane). Hash chain unbroken; every write appends prior_sha256.
- 14-point activation gate (operator's checklist): GGUF integrity, ctx-size <=1024, mlock binds, RSS<=10GB, ttft<5s on N150 cold, JSON validity rate >=95% on 100-pair smoke, healthcheck green, lease-gated outbound, Hermes integration, no frontier reach, no plain HTTP (loopback only), receipt writes, prior_sha chain unbroken, 60s burn-in clean.
- Existing scaffolding: bin/start.sh + bin/stop.sh + systemd/ae-cobra.service + grammar/agent_turn.gbnf — author the rest.
Quality bar: no fake-green. Anything that can't be tested locally on N150 (because daemon runs on Codexa WSL2) is honestly named in notes.
`

phase('Author')
const components = [
  { id: 'activation-runner', prompt: `Author ${ROOT}/06-ORANGELLM/memory/ae-cobra/activation/runner.mjs — orchestrator that runs all 14 gate checks in order, short-circuits on first fail, writes activation receipt to 10-RECEIPTS/orange5-build/ae-cobra-night1-activation-attempt-{n}.md. CLI: node runner.mjs --target codexa (over SSH) or --target local-wsl. Returns {ok, gate_failed?, evidence:[{gate_id, pass, details, latency_ms}]}. ${CTX}` },
  { id: 'gate-checks', prompt: `Author all 14 individual gate-check modules at ${ROOT}/06-ORANGELLM/memory/ae-cobra/activation/gates/01..14-*.mjs. Each exports check(env, opts) → {pass, details, latency_ms}. Cover: 01-gguf-integrity (sha256 verify), 02-ctx-size-bounded, 03-mlock-bound, 04-rss-ceiling, 05-ttft-cold, 06-json-validity-100-pair, 07-healthcheck-green, 08-lease-gated-outbound, 09-hermes-integration, 10-no-frontier-reach, 11-loopback-only, 12-receipt-writes, 13-prior-sha-chain, 14-burn-in-60s. ${CTX}` },
  { id: 'flow-direct-caller', prompt: `Author ${ROOT}/06-ORANGELLM/memory/ae-cobra/flow-direct/caller.mjs — Bun HTTP client that calls Æ Cobra's llama.cpp server with GBNF grammar attached, parses JSON output, validates against the AgentTurn schema, writes the validated event to Flux. Retries with exponential backoff on validation failure (max 3); on persistent failure, writes a refusal event to Thought lane. ${CTX}` },
  { id: 'flux-writer', prompt: `Author ${ROOT}/06-ORANGELLM/memory/ae-cobra/flux/writer.mjs — JSONL appender for /mnt/ae_flux/{reality,thought}.jsonl. Each line: {ts, sha256, prior_sha256, origin, lane, event}. Computes sha256 of (prior_sha256 + canonical_json(event)). Atomic append (rename-from-tmp). Crash-safe: if mid-write crashes, next start reads tail and finds the last valid sha. ${CTX}` },
  { id: 'flux-reader', prompt: `Author ${ROOT}/06-ORANGELLM/memory/ae-cobra/flux/reader.mjs — JSONL streaming reader with hash-chain verification. Detects breaks and emits a Thought-lane warning event when chain breaks. CLI: node reader.mjs --lane reality --since 1h. Returns events. ${CTX}` },
  { id: 'healthcheck-server', prompt: `Author ${ROOT}/06-ORANGELLM/memory/ae-cobra/healthcheck.mjs — Bun HTTP server on 127.0.0.1:9101 (loopback inside WSL2). Routes: GET /healthz (basic up), GET /healthz/deep (runs all 14 gates, returns full evidence), GET /metrics (RSS, ttft, json-validity-rolling-window). Frontier-isolation: refuses any non-loopback origin. ${CTX}` },
  { id: 'agent-turn-validator', prompt: `Author ${ROOT}/06-ORANGELLM/memory/ae-cobra/grammar/validator.mjs — JSON schema validator for AgentTurn output (read existing grammar/agent_turn.gbnf for shape). Validates {intent, action, evidence, refusal_reason?, lease_id} structure. Returns {valid, errors:[]}. ${CTX}` },
  { id: 'gateway-cobra-routes', prompt: `Author ${ROOT}/06-ORANGELLM/server/routes/cobra.mjs — gateway routes proxied to Æ Cobra: POST /v1/cobra/turn (proxy to daemon /completion with GBNF), GET /v1/cobra/healthz, GET /v1/cobra/flux/tail (read-only Flux tail). All requests authenticated with rail token. Boundary-list at cobra-boundary.mjs. ${CTX}` },
  { id: 'ssh-bridge-script', prompt: `Author ${ROOT}/06-ORANGELLM/memory/ae-cobra/bin/codexa-bridge.ps1 — Powershell script run on N150 that establishes SSH tunnel to Codexa WSL2 (port-forwards 9100 + 9101 locally), used by the gateway to reach Æ Cobra when running on Codexa. Refuses on missing CODEXA_SSH_KEY env. Reaps the tunnel on Ctrl-C cleanly. ${CTX}` },
  { id: 'smoke-100-pair', prompt: `Author ${ROOT}/06-ORANGELLM/memory/ae-cobra/tests/smoke-100-pair.mjs — fires 100 representative prompts through the daemon, measures JSON validity rate against the GBNF schema. Pass threshold: 95+ / 100. Outputs JSON report to activation/last-smoke.json. ${CTX}` },
]
const results = await parallel(components.map(c => () => agent(c.prompt, { phase: 'Author', label: `cobra:${c.id}`, schema: AUTHOR_SCHEMA, effort: 'high' })))

phase('Synth')
const synth = await agent(`Write receipt at ${ROOT}/10-RECEIPTS/orange5-build/2026-06-26-wave3-02-cobra-night1-activation-harness.md. Components: ${JSON.stringify(results.filter(Boolean), null, 2)}. prior_receipt + hash_chain. Honest gaps: activation runner CANNOT be fired until operator (a) downloads the Mamba 2.8B Q5_K_M GGUF, (b) builds llama.cpp inside Codexa WSL2, (c) mounts /mnt/ae_flux. Files are AUTHORED + READY but UNFIRED. Mom's Law. Return via StructuredOutput.`, { phase: 'Synth', label: 'synth', schema: SYNTH_SCHEMA, effort: 'high' })
return { status: synth?.status || 'unknown', components: results.filter(Boolean), synth }
