// wave2-02-nine-gate-stack.workflow.mjs — 9-Gate Stack runtime.
// Gate 0 LBCE → 1 Scope → 2 Department → 3 Triad → 4 HRE → 5 Security → 6 Drift → 7 Receipt → 8 CHECKMATE → 9 Human Final Stop

export const meta = {
  name: 'wave2-02-nine-gate-stack',
  description: '9-Gate Stack runtime — every action traverses this in ~200ms',
  phases: [
    { title: 'Author', detail: '11 parallel authors — 10 gates + runner' },
    { title: 'Synth', detail: 'receipt' },
  ],
}

const ROOT = 'C:/AtomEons/Orange5'
const AUTHOR_SCHEMA = { type: 'object', properties: { component: { type: 'string' }, files_written: { type: 'array', items: { type: 'string' } }, line_counts: { type: 'object', additionalProperties: { type: 'integer' } }, notes: { type: 'string' } }, required: ['component', 'files_written', 'line_counts', 'notes'], additionalProperties: false }
const SYNTH_SCHEMA = { type: 'object', properties: { status: { enum: ['green', 'partial', 'red'] }, files_landed: { type: 'integer' }, receipt_path: { type: 'string' }, open_issues: { type: 'array', items: { type: 'string' } } }, required: ['status', 'files_landed', 'receipt_path', 'open_issues'], additionalProperties: false }

const CTX = `
9-Gate Stack (Orange5 doctrine):
- Gate 0 LBCE (Lattice Boundary Consistency Engine) — impassable; checks that the action is within Orange5's lattice (no scope leak, no orphan refs)
- Gate 1 Scope — checks action.scope matches orange.order.v1.scope
- Gate 2 Department — routes to the right AE0-AE14 lane and refuses cross-lane action
- Gate 3 Triad — three-way consistency: intent vs scope vs action
- Gate 4 HRE (Hallucination Reduction Engine) — fact-checks claims against Mirage StateBrief; refuses unsupported citations
- Gate 5 Security — egress mode check, no API keys leaked, no path traversal
- Gate 6 Drift — checks invariants: runtime/node.py sole authority, FOUNDER_SALARY, 27 guardrails preserved, Gate 0 LBCE in chain, Human Final Stop reachable, identity secret env-only
- Gate 7 Receipt — receipt exists + hash-chain valid + no fake-green words
- Gate 8 CHECKMATE — final Atom Standard gate (test pass, visual proof, security clean, rollback evidence, revision pressure applied)
- Gate 9 Human Final Stop — last operator-veto opportunity; if action is risk_level high+, blocks pending operator approval
Total ~200ms target. Gate 0 cannot be bypassed.
Quality: real Node 20+, runtime daemon at 127.0.0.1:7450 (loopback). 9-Gate is the pre-action gauntlet that Hermes calls before letting an action land.
`

phase('Author')
const gates = [
  { id: 'gate-0-lbce', prompt: `Author Gate 0 LBCE at ${ROOT}/04-CONTROL-PLANE/nine-gate-stack/gates/00-lbce.mjs. Lattice integrity: action's scope is within Orange5's path lattice; no orphan refs to non-existent receipts, no out-of-scope writes. CANNOT be bypassed — every action MUST pass. ${CTX}` },
  { id: 'gate-1-scope', prompt: `Author Gate 1 Scope at ${ROOT}/04-CONTROL-PLANE/nine-gate-stack/gates/01-scope.mjs. Validates action.scope matches order.scope; refuses scope_expansion. ${CTX}` },
  { id: 'gate-2-department', prompt: `Author Gate 2 Department at ${ROOT}/04-CONTROL-PLANE/nine-gate-stack/gates/02-department.mjs. Routes action to AE0-AE14 department; refuses cross-lane actions (e.g. AE6 Code action trying to publish to AE4 Marketing). ${CTX}` },
  { id: 'gate-3-triad', prompt: `Author Gate 3 Triad at ${ROOT}/04-CONTROL-PLANE/nine-gate-stack/gates/03-triad.mjs. Three-way consistency: intent ↔ scope ↔ action. Detects mismatch. ${CTX}` },
  { id: 'gate-4-hre', prompt: `Author Gate 4 HRE at ${ROOT}/04-CONTROL-PLANE/nine-gate-stack/gates/04-hre.mjs. Fact-checks every claim in action.evidence against Mirage StateBrief (POST /v1/memory/state-brief). Refuses unsupported citations + nonexistent receipt_path refs. ${CTX}` },
  { id: 'gate-5-security', prompt: `Author Gate 5 Security at ${ROOT}/04-CONTROL-PLANE/nine-gate-stack/gates/05-security.mjs. Egress mode check, scans diff for sk-/ghp_/AIza/AKIA, refuses path-traversal in file refs. ${CTX}` },
  { id: 'gate-6-drift', prompt: `Author Gate 6 Drift at ${ROOT}/04-CONTROL-PLANE/nine-gate-stack/gates/06-drift.mjs. Invariants to check each action: runtime/node.py exists + unchanged (unless explicitly authorized), FOUNDER_SALARY_PER_INSTALL_CENTS still set, 27 guardrails file present, ATOMEONS_IDENTITY_SECRET only via env (never hardcoded), Gate 0 LBCE referenced in chain. ${CTX}` },
  { id: 'gate-7-receipt', prompt: `Author Gate 7 Receipt at ${ROOT}/04-CONTROL-PLANE/nine-gate-stack/gates/07-receipt.mjs. Receipt path exists, schema validates, hash chain continues, no fake-green words. ${CTX}` },
  { id: 'gate-8-checkmate', prompt: `Author Gate 8 CHECKMATE at ${ROOT}/04-CONTROL-PLANE/nine-gate-stack/gates/08-checkmate.mjs. Final Atom Standard gate: tests passed (npm test or pytest), visual proof captured (if UI changed), security clean (gate 5 result), rollback evidence in receipt, revision pressure applied (at least one self-correction). ${CTX}` },
  { id: 'gate-9-human-stop', prompt: `Author Gate 9 Human Final Stop at ${ROOT}/04-CONTROL-PLANE/nine-gate-stack/gates/09-human-stop.mjs. If action.riskLevel ∈ [high, destructive, production], blocks pending operator approval. Pulls approval state from Hermes /approvals. ${CTX}` },
  { id: 'runner', prompt: `Author the 9-Gate runner at ${ROOT}/04-CONTROL-PLANE/nine-gate-stack/runner.mjs. Loads all 10 gates dynamically + runs in numerical order. Times each gate (target <30ms each). Short-circuits on first fail. Emits a structured gauntlet result {gauntlet_id, started_at, finished_at, ok, gates:[{gate_id, name, pass, evidence, took_ms}]}. Also write daemon at ${ROOT}/04-CONTROL-PLANE/nine-gate-stack/server.mjs (Bun :7450) that wraps the runner with POST /run + GET /healthz + smoke test. ${CTX}` },
]
const results = await parallel(gates.map(g => () => agent(g.prompt, { phase: 'Author', label: `gate:${g.id}`, schema: AUTHOR_SCHEMA, effort: 'high' })))

phase('Synth')
const synth = await agent(`Write receipt at ${ROOT}/10-RECEIPTS/orange5-build/2026-06-25-nine-gate-stack-runtime.md. Components: ${JSON.stringify(results.filter(Boolean), null, 2)}. prior_receipt + hash_chain. Honest gaps. Mom's Law. Return via StructuredOutput.`, { phase: 'Synth', label: 'synth', schema: SYNTH_SCHEMA, effort: 'high' })
return { status: synth?.status || 'unknown', components: results.filter(Boolean), synth }
