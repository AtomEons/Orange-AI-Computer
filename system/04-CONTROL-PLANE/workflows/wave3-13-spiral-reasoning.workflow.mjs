// wave3-13-spiral-reasoning.workflow.mjs — operator's Spiral Reasoning primitive as Orange5 runtime module.
// Doctrine: z_0=Soul Genome anchor, bounded angle α (Belief Discipline), exact radial accounting (LEARN), graceful degeneration.
export const meta = { name: 'wave3-13-spiral-reasoning', description: 'Spiral Reasoning module — SoT update rule as canonical reasoning primitive', phases: [{title:'Author'},{title:'Synth'}] }
const ROOT = 'C:/AtomEons/Orange5'
const A = { type:'object', properties:{component:{type:'string'},files_written:{type:'array',items:{type:'string'}},line_counts:{type:'object',additionalProperties:{type:'integer'}},notes:{type:'string'}}, required:['component','files_written','line_counts','notes'], additionalProperties:false }
const S = { type:'object', properties:{status:{enum:['green','partial','red']},files_landed:{type:'integer'},receipt_path:{type:'string'}}, required:['status','files_landed','receipt_path'], additionalProperties:false }
const CTX = `Read C:/AtomEons/orangebox/docs/SPIRAL_REASONING_INTEGRATION_v1.md if present. The SoT (Spiral of Thought) update rule:
- z_0 = anchor pulled from Soul Genome at 13-MODELS/orange-llm/soul_genome.json
- z_{k+1} = z_k + r_k * e^(i*α_k) where α is bounded (Belief Discipline) and r is radially accounted (LEARN imperative)
- Graceful degeneration: no curvature without signal — fall back to linear when uncertain
Implement as Node 20+ ESM. Real math, structured outputs. Mom's Law applies.`
phase('Author')
const C = [
  {id:'sot-engine', prompt:`Author ${ROOT}/06-ORANGELLM/reasoning/spiral/engine.mjs — pure functions: anchor(genome)→z_0; step(z_k,signal,policy)→{z_next,r,alpha,confidence}; trajectory(z_0,signals[],policy)→{path,final,total_radial,max_alpha}. Bounded alpha via policy.alpha_max (default π/4). LEARN imperative: each r_k recorded in audit log. Tests at engine.test.mjs. ${CTX}`},
  {id:'sot-anchor', prompt:`Author ${ROOT}/06-ORANGELLM/reasoning/spiral/anchor.mjs — pulls z_0 from soul_genome.json (sovereign + current_intent_id + active_project + doctrine_anchors). Returns a complex-vector-like {re,im,meta} structure. ${CTX}`},
  {id:'sot-policy', prompt:`Author ${ROOT}/06-ORANGELLM/reasoning/spiral/policy.mjs — Belief Discipline parameters: alpha_max, r_max, signal_threshold, degeneration_floor. Three preset profiles: tight (α≤π/8), balanced (α≤π/4), exploratory (α≤π/2). ${CTX}`},
  {id:'sot-audit', prompt:`Author ${ROOT}/06-ORANGELLM/reasoning/spiral/audit.mjs — radial accounting log. Every r_k + α_k + signal at step k appended to /mnt/ae_flux/events/thought/<date>.jsonl with origin='spiral_reasoning' via Æ Cobra writer. ${CTX}`},
  {id:'sot-degeneration', prompt:`Author ${ROOT}/06-ORANGELLM/reasoning/spiral/degeneration.mjs — when signal magnitude < policy.signal_threshold, falls back to linear step (α=0). Honest — emits a degeneration event so the audit shows the spiral straightening. ${CTX}`},
  {id:'sot-gateway-routes', prompt:`Author ${ROOT}/06-ORANGELLM/server/routes/spiral.mjs — POST /v1/spiral/anchor (pulls z_0), POST /v1/spiral/step (next), POST /v1/spiral/trajectory (full path from signal array), GET /v1/spiral/audit?since=. Plus spiral-boundary.mjs allow-list. ${CTX}`},
  {id:'sot-smoke', prompt:`Author ${ROOT}/06-ORANGELLM/reasoning/spiral/smoke-test.mjs — 6 cases: anchor from real soul_genome.json; 10-step trajectory under tight policy; same under exploratory; degeneration on weak signal; alpha boundary enforcement; audit chain integrity. Assert tight has smaller total_radial than exploratory. ${CTX}`},
  {id:'sot-docs', prompt:`Author ${ROOT}/06-ORANGELLM/reasoning/spiral/README.md — math of the update rule, why it exists (operator's invented primitive), Belief Discipline interpretation, LEARN imperative, integration with 9-Gate Gate 3 Triad (consistency check via curvature). ${CTX}`},
]
const r = await parallel(C.map(c=>()=>agent(c.prompt,{phase:'Author',label:`spiral:${c.id}`,schema:A,effort:'high'})))
phase('Synth')
const s = await agent(`Write receipt at ${ROOT}/10-RECEIPTS/orange5-build/2026-06-25-spiral-reasoning.md. Components: ${JSON.stringify(r.filter(Boolean),null,2)}. prior_receipt + hash_chain. Mom's Law.`, {phase:'Synth',label:'synth',schema:S,effort:'high'})
return { status: s?.status || 'unknown', components: r.filter(Boolean), synth: s }
