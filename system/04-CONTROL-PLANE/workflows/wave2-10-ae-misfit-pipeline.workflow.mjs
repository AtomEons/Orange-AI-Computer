// wave2-10-ae-misfit-pipeline.workflow.mjs — AE Misfit Model training pipeline + STRONGARM+Gremlin corpus assembly.

export const meta = { name: 'wave2-10-ae-misfit-pipeline', description: 'AE Misfit Model corpus assembler + Colab notebook + bakeoff harness', phases: [{title:'Author'},{title:'Synth'}] }
const ROOT = 'C:/AtomEons/Orange5'
const SCHEMA = { type: 'object', properties: { component: { type: 'string' }, files_written: { type: 'array', items: { type: 'string' } }, line_counts: { type: 'object', additionalProperties: { type: 'integer' } }, notes: { type: 'string' } }, required: ['component', 'files_written', 'line_counts', 'notes'], additionalProperties: false }
const SYNTH = { type: 'object', properties: { status: { enum: ['green', 'partial', 'red'] }, files_landed: { type: 'integer' }, receipt_path: { type: 'string' } }, required: ['status', 'files_landed', 'receipt_path'], additionalProperties: false }

const CTX = `
AE Misfit Model doctrine (per operator):
- Trained SEPARATELY from OrangeLLM-fatty. OrangeLLM gets steady doctrine-grounded behavior; AE Misfit gets adversarial pressure + refusal training.
- Corpus comes from STRONGARM + Gremlin datasets (the operator's archives — they authorized using them for THIS specifically; receipt #032 retired them from OrangeLLM-fatty corpus).
- Base: qwen2.5:7b-instruct (smaller; complements OrangeLLM-fatty). Free Colab T4 sufficient.
- AE Misfit fires as a second-opinion gate before high-risk Hermes actions; catches fake-greens OrangeLLM-fatty might miss.
- Refusal-discipline is the primary training signal.
Quality: real code. Pipeline mirror OrangeLLM-fatty's structure.
`

phase('Author')
const components = [
  { id: 'corpus-strategy', prompt: `Author ${ROOT}/16-TRAINING/ae-misfit/corpus-strategy.md. Strategy doc for STRONGARM + Gremlin corpus assembly: source of each dataset (operator's archives — exact paths TBD), filtering rules (privacy scrubbing), instruction-pair shaping for adversarial training, balance ratio (60% refusal, 40% adversarial-but-correct-yield), target corpus size (500-1500 pairs). ${CTX}` },
  { id: 'corpus-seed', prompt: `Author ${ROOT}/16-TRAINING/ae-misfit/seed/seed-100.jsonl — 100 hand-authored seed pairs for AE Misfit. Each pair models a scenario where an adversarial / hedging / fake-green response would be tempting; the OUTPUT shows the correct refusal or hard truth. Cover: fake-green refusal ("this looks ok" → refuse + cite Mom's Law), out-of-scope refusal, missing-receipt refusal, identity-spoofing refusal, scope-expansion refusal, social-pressure-to-comply refusal. ${CTX}` },
  { id: 'axolotl-yaml', prompt: `Author ${ROOT}/16-TRAINING/configs/ae-misfit-v0.yaml. Unsloth/Axolotl-compatible QLoRA config. base_model: unsloth/Qwen2.5-7B-Instruct-bnb-4bit. LoRA r=16, alpha=32, dropout=0.05. 3 epochs. Free T4-sized batches. ${CTX}` },
  { id: 'colab-notebook', prompt: `Author ${ROOT}/16-TRAINING/configs/ae-misfit-v0.ipynb. Paste-ready Colab Free notebook mirroring orangellm-fatty-v0.ipynb structure: GPU check → workdir → wget corpus from secret gist → install Unsloth → train via TRL SFTTrainer → guarded verify → zip + files.download(). Same Drive-free flow. ${CTX}` },
  { id: 'misfit-second-opinion', prompt: `Author ${ROOT}/04-CONTROL-PLANE/misfit/second-opinion.mjs. Before any Hermes action with risk_level≥high, sends the action description to AE Misfit (via gateway /v1/chat/completions with model='ae-misfit:v0') asking for a refusal-or-confirm verdict. If Misfit says refuse, blocks the action + writes a Thought-lane receipt. ${CTX}` },
  { id: 'gateway-misfit-routes', prompt: `Author ${ROOT}/06-ORANGELLM/server/routes/misfit.mjs. POST /v1/misfit/second-opinion (body: action description, risk_level → Misfit verdict). Boundary update. Smoke test. ${CTX}` },
]
const results = await parallel(components.map(c => () => agent(c.prompt, { phase: 'Author', label: `mf:${c.id}`, schema: SCHEMA, effort: 'high' })))

phase('Synth')
const synth = await agent(`Write receipt at ${ROOT}/10-RECEIPTS/orange5-build/2026-06-25-ae-misfit-pipeline.md. Components: ${JSON.stringify(results.filter(Boolean), null, 2)}. prior_receipt + hash_chain. Honest gaps: actual STRONGARM/Gremlin corpus paths on operator's machine still need linking; base corpus assembly waits on operator pointing me at the archives. Return via StructuredOutput.`, { phase: 'Synth', label: 'synth', schema: SYNTH, effort: 'high' })
return { status: synth?.status || 'unknown', components: results.filter(Boolean), synth }
