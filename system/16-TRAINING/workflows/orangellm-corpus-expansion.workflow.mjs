// orangellm-corpus-expansion.workflow.mjs
//
// Operator directive 2026-06-24: "USE A WORKFLOW NOW".
// Per CLAUDE.md training-only Workflow scope: corpus assembly is part of the
// training pipeline, so this workflow is in-bounds.
//
// Goal: expand the 213-pair hand-authored seed corpus to a 1000-pair training
// corpus by fanning out parallel Claude agents across the Orange5 doctrine
// corpus. Each agent reads one doctrine doc and emits a deeply-grounded set
// of instruction-tuning pairs. A final synth agent dedupes, trims to 1000,
// writes the corpus + SHA-256 receipt + stages corpus.jsonl for Colab.

export const meta = {
  name: 'orangellm-corpus-expansion',
  description: 'Expand OrangeLLM training corpus from seed-213 to 1000 via parallel doctrine agents',
  whenToUse: 'When the operator wants the training corpus assembled before a Colab Pro run',
  phases: [
    { title: 'Generate', detail: '10 parallel agents, one per doctrine doc, each emits 40-200 pairs' },
    { title: 'Synthesize', detail: 'merge + dedupe vs seed, trim to 1000, write corpus + SHA-256 receipt + stage corpus.jsonl' },
  ],
}

const ROOT = 'C:/AtomEons/Orange5'
const TMP_DIR = `${ROOT}/16-TRAINING/corpus/_tmp`
const SEED_PATH = `${ROOT}/16-TRAINING/corpus/orangellm-fatty-v0-seed-200.jsonl`
const CORPUS_PATH = `${ROOT}/16-TRAINING/corpus/orangellm-fatty-v0-corpus-1000.jsonl`
const STAGED_PATH = `${ROOT}/16-TRAINING/corpus/corpus.jsonl`
const RECEIPT_PATH = `${ROOT}/16-TRAINING/corpus/orangellm-fatty-v0-corpus-receipt.json`

const DOCS = [
  { id: 'master-plan',       path: `${ROOT}/00-CHARTER/ORANGE5_MASTER_PLAN.md`,                  target: 200 },
  { id: 'ae-cobra-spec',     path: `${ROOT}/06-ORANGELLM/memory/AE_COBRA_FOUNDATION_SPEC.md`,    target: 150 },
  { id: 'orangeeye-spec',    path: `${ROOT}/07-VISUAL/AE_ORANGEEYE_FOUNDATION_SPEC.md`,          target: 120 },
  { id: 'month-plan',        path: `${ROOT}/00-CHARTER/ORANGE5_MONTH_PLAN_2026-06-23.md`,        target: 90 },
  { id: 'codex-brief',       path: `${ROOT}/00-CHARTER/CODEX_BRIEF_STEP_01_NATIVE_TRUTH.md`,     target: 90 },
  { id: 'colab-pattern',     path: `${ROOT}/00-CHARTER/COLAB_TRAINING_PATTERN.md`,               target: 70 },
  { id: 'codexa-preflight',  path: `${ROOT}/00-CHARTER/CODEXA_PREFLIGHT_AE_COBRA.md`,            target: 60 },
  { id: 'naming-canon',      path: `${ROOT}/00-CHARTER/NAMING_CANON.md`,                         target: 50 },
  { id: 'not-green-ledger',  path: `${ROOT}/00-CHARTER/ORANGE5_NOT_GREEN_LEDGER.md`,             target: 50 },
  { id: 'receipts-chain',    path: `${ROOT}/10-RECEIPTS/orange5-build/`,                         target: 120, isDir: true },
]

const PAIRS_SCHEMA = {
  type: 'object',
  properties: {
    source_doc: { type: 'string' },
    pair_count: { type: 'integer', minimum: 1 },
    temp_path: { type: 'string' },
    sample_first_3: {
      type: 'array',
      maxItems: 3,
      items: {
        type: 'object',
        properties: {
          instruction: { type: 'string' },
          output: { type: 'string' },
        },
        required: ['instruction', 'output'],
        additionalProperties: false,
      },
    },
  },
  required: ['source_doc', 'pair_count', 'temp_path', 'sample_first_3'],
  additionalProperties: false,
}

const SYNTH_SCHEMA = {
  type: 'object',
  properties: {
    final_count: { type: 'integer' },
    seed_count: { type: 'integer' },
    generated_count: { type: 'integer' },
    deduped_count: { type: 'integer' },
    corpus_path: { type: 'string' },
    staged_path: { type: 'string' },
    receipt_path: { type: 'string' },
    corpus_sha256: { type: 'string', minLength: 64, maxLength: 64 },
    counts_by_source: { type: 'object', additionalProperties: { type: 'integer' } },
  },
  required: ['final_count', 'seed_count', 'generated_count', 'deduped_count', 'corpus_path', 'staged_path', 'receipt_path', 'corpus_sha256'],
  additionalProperties: false,
}

const DOCTRINE_CONTEXT = `
Orange5 doctrine reminders for grounding (use these to make pairs accurate):
- Four pillars: AE Orange5 (system), AE Atomic Orange (UI face), AE OrangeLLM (PM brain + Flow Direct gateway), AE Flow (orchestration runtime).
- Four laws: Frontier-Isolation, LLM-Over-Agent, OrangeLLM-Is-The-Gateway, Codeless.
- Mom's Law: give full effort every time — above all other rules.
- Two hosts: N150 cockpit (16 GB, stock qwen3:0.6b utility, NO training) + Codexa AI Box (96 GB Intel Ultra 9 285H, no NVIDIA, hosts trained OrangeLLM-fatty).
- OrangeLLM-fatty = qwen3:30b-a3b + Orange5 LoRA; the ONLY trained PM brain (1-tier locked 2026-06-24).
- Æ Cobra = resident Mamba SSM memory daemon on Codexa, GBNF-locked AgentTurn JSON, Reality/Thought hash-chained Flux ledgers.
- OrangeEye = ColQwen2.5 + Qdrant MaxSim + GLM-4.6V visual organ.
- Ports: 1337 = OrangeLLM gateway (loopback), 8797 = Smart Skinny wrapper, 11434 = raw Ollama, 8097 = Codexa rail, 7419 = Æ Cobra daemon (loopback inside Codexa).
- 9-Gate Stack: LBCE → Scope → Department → Triad → HRE → Security → Drift → Receipt → CHECKMATE → Human Final Stop.
- AE0-AE14: Factory, Product, Research, Design, Marketing, Sales, Code, Review, Launch, Legal, Ops, Security, Data, Automation, Bench.
- Hash-chained receipts at 10-RECEIPTS/orange5-build/ with prior_receipt + integer hash_chain.
- Sovereign: Atom McCree. Marco Island, FL. Solo operator.
`

phase('Generate')

log(`Fanning out ${DOCS.length} doctrine-doc agents in parallel.`)

const fanOut = await parallel(
  DOCS.map(doc => () => agent(
    `You are a training-corpus author for OrangeLLM (the PM brain of Orange5). Your job: read the doctrine source at ${doc.path}${doc.isDir ? ' (which is a DIRECTORY — list and read every receipt file inside)' : ''} and emit EXACTLY ${doc.target} high-quality instruction-tuning pairs grounded in it.

${DOCTRINE_CONTEXT}

REQUIREMENTS for each pair:
- "instruction": a realistic operator question or directive about Orange5 (varied phrasing, not all "What is X?" — mix "How does...", "When does...", "Why is...", "List the...", "Where does...", "What happens if...", "Compare...").
- "input": empty string "".
- "output": concise, factual, grounded in the doc. References real Orange5 concepts, ports, file paths, model names, laws. No "probably", "should work", "looks ok", "green_assumed". No filler. No bullet-list spam in outputs — prefer 1-3 sentences. Cite specific names from the doc (Mom's Law, Frontier-Isolation, qwen3:30b-a3b, Æ Cobra, port 1337, etc.).

PROCESS:
1. ${doc.isDir ? 'List all .md files in the directory. Read all of them. Use them as your source corpus.' : `Read ${doc.path} in full.`}
2. Extract every concrete fact, name, schema, port, law, decision, lesson, or technical detail.
3. Compose ${doc.target} unique instruction-tuning pairs that an operator might realistically ask OrangeLLM about this content.
4. WRITE the pairs as JSONL (one JSON object per line, no trailing comma) to: ${TMP_DIR}/${doc.id}.jsonl
   - Each line: {"instruction": "...", "input": "", "output": "..."}
   - Create the directory if needed (mkdir -p equivalent via Bash or Write to the path directly).
5. Verify your file by reading it back and counting lines.

Return via StructuredOutput:
- source_doc: "${doc.id}"
- pair_count: actual number of pairs written
- temp_path: "${TMP_DIR}/${doc.id}.jsonl"
- sample_first_3: array of the first 3 pairs (instruction + output only, no input)

Quality bar: Mom's Law. Every pair earns its place. No filler. No hedging. No theater.`,
    { phase: 'Generate', label: `gen:${doc.id}`, schema: PAIRS_SCHEMA, effort: 'medium' }
  ))
)

const aliveResults = fanOut.filter(Boolean)
const totalGenerated = aliveResults.reduce((sum, r) => sum + (r?.pair_count || 0), 0)
log(`Generate phase complete. ${aliveResults.length}/${DOCS.length} agents succeeded; ${totalGenerated} raw pairs written across temp files.`)

phase('Synthesize')

const tempFiles = aliveResults.map(r => r.temp_path).filter(Boolean)

const synthesis = await agent(
  `You are the corpus synthesis agent for OrangeLLM-fatty v0 training. Merge the seed corpus + generated pairs, dedupe, trim to exactly 1000, write the final corpus, compute SHA-256, write receipt, and stage for Colab.

INPUTS:
- Seed corpus: ${SEED_PATH} (213 hand-authored pairs — these are CANONICAL, never drop them)
- Generated temp files:
${tempFiles.map(p => `  - ${p}`).join('\n')}

PROCESS:
1. Read the seed corpus first. Hold its 213 pairs as the FIRST 213 entries.
2. Read each temp file. Parse line-by-line as JSON.
3. Build the merged list:
   a. Start with all 213 seed pairs (in original order).
   b. For each generated pair, compute key = instruction.trim().toLowerCase() collapsed-whitespace.
   c. If key already exists in the merged set (from seed or earlier generated), DROP the duplicate.
   d. Validate each pair: instruction non-empty, output ≥ 30 chars, output references at least one Orange5 concept (case-insensitive match: orange5, orangellm, atomic orange, ae cobra, orangeeye, hermes, mirage, atomsmasher, toolmesh, codexa, n150, mom's law, frontier-isolation, codeless, gateway, qwen3, flux, schism, mamba, colpali, qdrant). Drop if fail.
   e. Drop pairs whose output contains fake-green words: green_assumed, looks_ok, probably, should_work, fake_green (case-insensitive).
4. If merged length > 1000: keep all 213 seed pairs, then take generated pairs in their original order until exactly 1000.
5. If merged length < 1000: write what you have (it's still a corpus — log the actual count).
6. Write the final list to ${CORPUS_PATH} as JSONL (one JSON object per line, LF line endings).
7. Copy the same content to ${STAGED_PATH} (this is the file Colab will upload — same content, name expected by the notebook).
8. Compute SHA-256 of the final JSONL content (the bytes you wrote).
9. Write the receipt to ${RECEIPT_PATH}:
   {
     "schema": "orange5.corpus-receipt.v0",
     "model": "orangellm-fatty-v0",
     "corpus_path": "${CORPUS_PATH}",
     "staged_path": "${STAGED_PATH}",
     "seed_path": "${SEED_PATH}",
     "seed_count": 213,
     "generated_count": <actual count from temp files>,
     "deduped_count": <how many duplicates/invalid you dropped>,
     "final_count": <length of final corpus>,
     "target": 1000,
     "corpus_sha256": "<hex>",
     "generated_at": "<current ISO timestamp via system date or skip if unavailable>",
     "doctrine_files": [<doc.id values>],
     "method": "workflow-parallel-claude-agents"
   }
10. Verify the final file by reading it back and counting lines.

Use Bash for the SHA-256 (powershell: Get-FileHash -Algorithm SHA256 <path>).

Quality bar: Mom's Law. Every line of the final corpus is a real instruction pair grounded in Orange5 doctrine. No padding, no duplicates, no fake-green.

Return via StructuredOutput with the actual numbers — no guessing.`,
  { phase: 'Synthesize', label: 'synth', schema: SYNTH_SCHEMA, effort: 'high' }
)

return {
  status: synthesis?.final_count >= 800 ? 'green' : 'partial',
  fanOut: aliveResults.map(r => ({ source: r.source_doc, count: r.pair_count })),
  synthesis,
}
