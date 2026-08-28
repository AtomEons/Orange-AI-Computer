// wave2-07-guardrails-soul-genome-continuity.workflow.mjs
// 27 Constitutional Guardrails runtime + Soul Genome + Continuity Packet.

export const meta = { name: 'wave2-07-guardrails-soul-genome-continuity', description: '27 Guardrails runtime + Soul Genome + Continuity Packet daily generator', phases: [{title:'Author'},{title:'Synth'}] }
const ROOT = 'C:/AtomEons/Orange5'
const SCHEMA = { type: 'object', properties: { component: { type: 'string' }, files_written: { type: 'array', items: { type: 'string' } }, line_counts: { type: 'object', additionalProperties: { type: 'integer' } }, notes: { type: 'string' } }, required: ['component', 'files_written', 'line_counts', 'notes'], additionalProperties: false }
const SYNTH = { type: 'object', properties: { status: { enum: ['green', 'partial', 'red'] }, files_landed: { type: 'integer' }, receipt_path: { type: 'string' } }, required: ['status', 'files_landed', 'receipt_path'], additionalProperties: false }

const CTX = `
Doctrine:
- 27 Constitutional Guardrails: enumerated invariants the system MUST preserve. Examples (incomplete; agent designs the full list informed by doctrine): runtime/node.py sole authority, FOUNDER_SALARY_PER_INSTALL_CENTS env-bound, Gate 0 LBCE first in every gate chain, Human Final Stop reachable from any autonomous-action path, ATOMEONS_IDENTITY_SECRET env-only-never-hardcoded, frontier-only-via-gateway, no code editor in operator surface, 4 lanes immutable, Mom's Law above all, receipts hash-chained, no fake-green words in commits, etc.
- Soul Genome: operator continuity config that survives model swaps. Identity facts, preferences, project state pointers, current intent anchors.
- Continuity Packet: forward-looking JSON record emitted at end of each day summarizing today's progress + open blockers + tomorrow's first action. Auto-loaded at next session start as first context injection.
Quality: real Node 20+. SQLite for guardrail status. JSON for Soul Genome (file-based, single source). Continuity Packet via cron-driven daily auto-write.
`

phase('Author')
const components = [
  { id: 'guardrails-spec', prompt: `Author the 27 Guardrails specification at ${ROOT}/01-DOCTRINE/27-guardrails/spec.md. Enumerate all 27 invariants with: name, why it exists, runtime check approach, severity (warn|block), receipt-trigger when violated. ${CTX}` },
  { id: 'guardrails-runtime', prompt: `Author the runtime guardrails checker at ${ROOT}/01-DOCTRINE/27-guardrails/runtime.mjs. Exports runGuardrails() — runs all 27 checks in parallel, returns {ok, violations:[{guardrail_id, severity, details}], elapsed_ms}. Each guardrail is a function in checks/ that returns {pass, details}. Daemon mode at server.mjs (Bun :7460) with GET /healthz + /run + writes violations to Reality Flux. ${CTX}` },
  { id: 'guardrails-checks', prompt: `Author the 27 individual check functions at ${ROOT}/01-DOCTRINE/27-guardrails/checks/01..27-*.mjs. Each is a small module exporting check(state, opts) → {pass, details}. Cover: runtime-node-py exists + sha unchanged, FOUNDER_SALARY env set, Gate-0 in chain, Human-Final-Stop reachable, identity-secret env-only, frontier-via-gateway, no-code-editor-in-app, 4-lanes-immutable, Mom's Law above, receipts-hash-chained, no-fake-green-recent-commits, atomic-orange-build-green, AE-Cobra-runtime-state-bounded, MaxSim-eval-stable, doctrine-files-present, etc. ${CTX}` },
  { id: 'soul-genome', prompt: `Author Soul Genome at ${ROOT}/13-MODELS/orange-llm/soul_genome.json + manager at ${ROOT}/13-MODELS/orange-llm/genome-manager.mjs. Fields: sovereign (Atom McCree), location, preferences (response_register, tight_responses, fake_green_intolerance), current_intent_id, active_project (Orange5), hardware (N150 + Codexa specs), runtime_pointers (gateway URL, Æ Cobra URL, etc.), updated_at. Manager: load(), update(), inject_into_chat_system_role(). Used by gateway memory-inject middleware as first turn context. ${CTX}` },
  { id: 'continuity-packet-generator', prompt: `Author Continuity Packet auto-writer at ${ROOT}/04-CONTROL-PLANE/continuity/generator.mjs. Reads today's Reality Flux events + open AE Flow currents + recent receipts. Synthesizes JSON {date, progress_summary, open_blockers, tomorrows_first_action, hot_currents, fresh_receipts}. Writes to Reality Flux origin=continuity. Cron: 23:50 ET daily. Also CLI: node generator.mjs (manual). ${CTX}` },
  { id: 'continuity-packet-loader', prompt: `Author Continuity Packet loader at ${ROOT}/04-CONTROL-PLANE/continuity/loader.mjs. On session start, pulls the most recent continuity packet from Reality Flux. Returns the JSON. Exposed via gateway GET /v1/continuity/latest. ${CTX}` },
  { id: 'gateway-guardrails-routes', prompt: `Author gateway routes at ${ROOT}/06-ORANGELLM/server/routes/guardrails.mjs. Routes: GET /v1/guardrails/status (last run + violations), POST /v1/guardrails/run (kick a fresh check, gated), GET /v1/genome (return Soul Genome), POST /v1/genome (update — operator-gated). Plus boundary update. Smoke test: end-to-end runs guardrails, asserts at least one check pass, validates Soul Genome load + update + reload roundtrip. ${CTX}` },
]
const results = await parallel(components.map(c => () => agent(c.prompt, { phase: 'Author', label: `g:${c.id}`, schema: SCHEMA, effort: 'high' })))

phase('Synth')
const synth = await agent(`Write receipt at ${ROOT}/10-RECEIPTS/orange5-build/2026-06-25-guardrails-soul-genome-continuity.md. Components: ${JSON.stringify(results.filter(Boolean), null, 2)}. prior_receipt + hash_chain. Mom's Law. Honest gaps. Return via StructuredOutput.`, { phase: 'Synth', label: 'synth', schema: SYNTH, effort: 'high' })
return { status: synth?.status || 'unknown', components: results.filter(Boolean), synth }
