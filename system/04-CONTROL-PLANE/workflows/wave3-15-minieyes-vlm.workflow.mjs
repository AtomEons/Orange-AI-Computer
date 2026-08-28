// wave3-15-minieyes-vlm.workflow.mjs — MiniEyes Model training pipeline. The 2-8B custom VLM addendum.
export const meta = { name: 'wave3-15-minieyes-vlm', description: 'MiniEyes Model — 2-8B custom VLM training pipeline (Phase-3 addendum, optional)', phases: [{title:'Author'},{title:'Synth'}] }
const ROOT = 'C:/AtomEons/Orange5'
const A = { type:'object', properties:{component:{type:'string'},files_written:{type:'array',items:{type:'string'}},line_counts:{type:'object',additionalProperties:{type:'integer'}},notes:{type:'string'}}, required:['component','files_written','line_counts','notes'], additionalProperties:false }
const S = { type:'object', properties:{status:{enum:['green','partial','red']},files_landed:{type:'integer'},receipt_path:{type:'string'}}, required:['status','files_landed','receipt_path'], additionalProperties:false }
const CTX = `MiniEyes is the addendum visual model — a 2-8B local VLM custom-trained on Orange5 dashboard screenshots, AECode diagrams, and receipts. Built ONLY if primary visual stack (GLM-4.6V + Playwright + Chrome DevTools + UX tools) proves insufficient under real load. Optional, deferred. Quality bar: real corpus assembly pipeline, real Colab notebook, real promotion ceremony.`
phase('Author')
const C = [
  {id:'corpus-strategy', prompt:`Author ${ROOT}/16-TRAINING/minieyes/corpus-strategy.md — sources (Orange5 cockpit screenshots, AECode diagrams, receipt PDFs), filter rules (no PII, no operator face), instruction-pair shaping (image→description with patch grounding), target size (5000+ pairs). ${CTX}`},
  {id:'corpus-assembler', prompt:`Author ${ROOT}/16-TRAINING/minieyes/assemble.mjs — Bun script that walks 10-RECEIPTS/ + scans for screenshots, runs OrangeEye GLM-4.6V to extract structured description per image, emits {image_path, description, patch_grounding} JSONL pairs. ${CTX}`},
  {id:'base-model-selector', prompt:`Author ${ROOT}/16-TRAINING/minieyes/base-selector.md — comparison of candidate bases (Qwen2.5-VL-7B, LLaVA-OneVision-7B, InternVL2-8B, MiniCPM-V-2.6) with HF SHA + license + size + quantization options. Recommend default with rationale. ${CTX}`},
  {id:'axolotl-config', prompt:`Author ${ROOT}/16-TRAINING/configs/minieyes-v0.yaml — Unsloth/Axolotl QLoRA YAML. Base: unsloth/Qwen2.5-VL-7B-Instruct-bnb-4bit. r=16, alpha=32, vision_lora_alpha=32. 3 epochs. A100/V100 sized. ${CTX}`},
  {id:'colab-notebook', prompt:`Author ${ROOT}/16-TRAINING/configs/minieyes-v0.ipynb — paste-ready Colab nb mirroring orange5-monster-v1.ipynb structure. NO-DRIVE flow (wget corpus from secret gist). Unsloth + Qwen2.5-VL. Hard guards on adapter size. files.download() at end. ${CTX}`},
  {id:'eval-harness', prompt:`Author ${ROOT}/16-TRAINING/minieyes/eval.mjs — 30-image bench across 5 categories (cockpit-screenshot description, AECode-diagram parse, receipt-image extract, ui-grounding, chart-read). Scores per-category accuracy. ${CTX}`},
  {id:'promotion-ceremony', prompt:`Author ${ROOT}/16-TRAINING/minieyes/promote.mjs — Modelfile generator + Ollama tag creator + bakeoff vs GLM-4.6V baseline. Operator approval gate. Only promotes if MiniEyes wins 4/5 dims OR matches AND uses <50% latency. ${CTX}`},
  {id:'workflow-orchestrator', prompt:`Author ${ROOT}/16-TRAINING/workflows/minieyes-v0.workflow.mjs — post-Colab retrieve + eval + promote workflow (analogous to orangellm-fatty-v0.workflow.mjs). ${CTX}`},
  {id:'docs', prompt:`Author ${ROOT}/16-TRAINING/minieyes/README.md — when to build MiniEyes (the trigger conditions), why deferred Night-1, full pipeline from corpus → Colab → bakeoff → promotion, expected wall-clock + cost. ${CTX}`},
]
const r = await parallel(C.map(c=>()=>agent(c.prompt,{phase:'Author',label:`me:${c.id}`,schema:A,effort:'high'})))
phase('Synth')
const s = await agent(`Write receipt at ${ROOT}/10-RECEIPTS/orange5-build/2026-06-25-minieyes-vlm.md. Components: ${JSON.stringify(r.filter(Boolean),null,2)}. prior_receipt + hash_chain.`, {phase:'Synth',label:'synth',schema:S,effort:'high'})
return { status: s?.status || 'unknown', components: r.filter(Boolean), synth: s }
