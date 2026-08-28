// wave3-23-ae-black-mamba-pretrain.workflow.mjs — custom Mamba SSM pretrain pipeline for Æ Cobra Phase-3.
export const meta = { name: 'wave3-23-ae-black-mamba-pretrain', description: 'AE Black Mamba custom Mamba 2.8B SSM pretrain — Phase-3 Æ Cobra core', phases: [{title:'Author'},{title:'Synth'}] }
const ROOT = 'C:/AtomEons/Orange5'
const A = { type:'object', properties:{component:{type:'string'},files_written:{type:'array',items:{type:'string'}},line_counts:{type:'object',additionalProperties:{type:'integer'}},notes:{type:'string'}}, required:['component','files_written','line_counts','notes'], additionalProperties:false }
const S = { type:'object', properties:{status:{enum:['green','partial','red']},files_landed:{type:'integer'},receipt_path:{type:'string'}}, required:['status','files_landed','receipt_path'], additionalProperties:false }
const CTX = `AE Cobra Night-1 uses bartowski/mamba-2.8b-hf-GGUF as surrogate. Phase-3 replaces it with AE Black Mamba — a custom Mamba 2.8B SSM pretrained on Orange5's own Flux event corpus + AgentTurn JSON corpus + receipt corpus. Per AE_COBRA_FOUNDATION_SPEC, this is full-FT (not LoRA — SSM doesn't have transformer-style LoRA mechanics). T4 sufficient for 2.8B full FT.`
phase('Author')
const C = [
  {id:'pretrain-strategy', prompt:`Author ${ROOT}/16-TRAINING/ae-black-mamba/strategy.md — sources (Flux events JSONL, AgentTurn corpus, receipt markdowns), corpus shaping (each row = one AgentTurn JSON), pretrain vs FT decision, GBNF grammar alignment target. ${CTX}`},
  {id:'corpus-pipeline', prompt:`Author ${ROOT}/16-TRAINING/ae-black-mamba/pipeline.mjs — Bun script. Reads Flux events + receipts, validates each against AgentTurn schema, normalizes, emits JSONL train.jsonl + val.jsonl. ${CTX}`},
  {id:'mamba-config', prompt:`Author ${ROOT}/16-TRAINING/configs/ae-black-mamba-v0.yaml — Mamba 2.8B config. d_model, d_state, expand factors. Per-layer LR. Cosine schedule. Q5_K_M target for deployment. ${CTX}`},
  {id:'colab-notebook', prompt:`Author ${ROOT}/16-TRAINING/configs/ae-black-mamba-v0.ipynb — Colab Free T4 nb. Uses state-spaces/mamba pip package. Pretrain 1-3 epochs. Save full weights + tokenizer. Auto-GGUF-convert at end via llama.cpp. ${CTX}`},
  {id:'gbnf-alignment', prompt:`Author ${ROOT}/16-TRAINING/ae-black-mamba/gbnf-alignment.mjs — adds the AgentTurn GBNF grammar as a soft constraint during training (logit penalty on non-grammar tokens). Improves zero-shot grammar compliance. ${CTX}`},
  {id:'promotion-ceremony', prompt:`Author ${ROOT}/16-TRAINING/ae-black-mamba/promote.mjs — replace surrogate Mamba in Æ Cobra start.sh with new GGUF. Bakeoff: lane-classification accuracy, AgentTurn JSON validity rate, latency, RSS. Promote only if better on >=2 of 4. ${CTX}`},
  {id:'workflow-orchestrator', prompt:`Author ${ROOT}/16-TRAINING/workflows/ae-black-mamba-v0.workflow.mjs — post-Colab retrieve + GGUF verify + bakeoff vs surrogate + promotion + Æ Cobra hot-swap. ${CTX}`},
  {id:'docs', prompt:`Author ${ROOT}/16-TRAINING/ae-black-mamba/README.md — full pipeline, base-vs-FT decision rationale, expected wall-clock (Free T4 4-8h), why this matters for the Phase-3 Schism Engine dual-state architecture. ${CTX}`},
]
const r = await parallel(C.map(c=>()=>agent(c.prompt,{phase:'Author',label:`bm:${c.id}`,schema:A,effort:'high'})))
phase('Synth')
const s = await agent(`Write receipt at ${ROOT}/10-RECEIPTS/orange5-build/2026-06-25-ae-black-mamba-pretrain.md. ${JSON.stringify(r.filter(Boolean),null,2)}.`, {phase:'Synth',label:'synth',schema:S,effort:'high'})
return { status: s?.status || 'unknown', components: r.filter(Boolean), synth: s }
