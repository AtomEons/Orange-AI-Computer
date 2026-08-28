// orangellm-fatty-v0-preflight.workflow.mjs
//
// Operator directive 2026-06-24: "WORKFLOW TRAIN IT."
// Honest scope: the GPU pass MUST run on Colab's A100. Codexa has no NVIDIA.
// What this workflow does: full pre-flight gauntlet on the 5 training inputs
// so the operator never burns $10 of Colab compute on a corrupted file or a
// broken YAML. 4 dimensions, 3 parallel verifier agents + 1 synth.
//
// After this greens, operator opens the published gist in Colab and Runs all.
// When the adapter lands in Drive, the operator says "WORKFLOW BAKEOFF" and
// Claude fires 16-TRAINING/workflows/orangellm-fatty-v0.workflow.mjs.

export const meta = {
  name: 'orangellm-fatty-v0-preflight',
  description: 'Pre-flight gauntlet on corpus + YAML + notebook + gist before the Colab A100 run',
  whenToUse: 'Just before the operator clicks Runtime->Run all on the published Colab notebook',
  phases: [
    { title: 'Verify',     detail: '3 parallel verifier agents: integrity / quality / safety' },
    { title: 'Synthesize', detail: 'aggregate verdict + write receipt #016' },
  ],
}

const ROOT = 'C:/AtomEons/Orange5'
const CORPUS_PATH = `${ROOT}/16-TRAINING/corpus/corpus.jsonl`
const CORPUS_SHA_EXPECTED = '6646f6a4e177d3d7e5fdfe2ba1f9069d8ebb9d460e4ee6671e3e76cc337b196f'
const YAML_PATH = `${ROOT}/16-TRAINING/configs/orangellm-fatty-v0.yaml`
const NOTEBOOK_PATH = `${ROOT}/16-TRAINING/configs/orangellm-fatty-v0.ipynb`
const GIST_URL = 'https://gist.github.com/AtomEons/a1e6b4a3349b3239eb3aabcf56a789ed'
const RECEIPT_DIR = `${ROOT}/10-RECEIPTS/orange5-build`

const INTEGRITY_SCHEMA = {
  type: 'object',
  properties: {
    corpus_lines: { type: 'integer' },
    corpus_sha256_actual: { type: 'string', minLength: 64, maxLength: 64 },
    corpus_sha256_matches: { type: 'boolean' },
    malformed_lines: { type: 'integer' },
    missing_fields_count: { type: 'integer' },
    yaml_parses: { type: 'boolean' },
    yaml_base_model: { type: 'string' },
    yaml_lora_r: { type: 'integer' },
    yaml_dataset_path: { type: 'string' },
    notebook_parses: { type: 'boolean' },
    notebook_cell_count: { type: 'integer' },
    notebook_has_drive_mount: { type: 'boolean' },
    notebook_has_axolotl_install: { type: 'boolean' },
    notebook_has_train_cell: { type: 'boolean' },
    gist_url: { type: 'string' },
    gist_http_status: { type: 'integer' },
    gist_live: { type: 'boolean' },
    verdict: { enum: ['pass', 'fail'] },
    failures: { type: 'array', items: { type: 'string' } },
  },
  required: ['corpus_lines','corpus_sha256_actual','corpus_sha256_matches','malformed_lines','missing_fields_count','yaml_parses','yaml_base_model','yaml_lora_r','yaml_dataset_path','notebook_parses','notebook_cell_count','notebook_has_drive_mount','notebook_has_axolotl_install','notebook_has_train_cell','gist_url','gist_http_status','gist_live','verdict','failures'],
  additionalProperties: false,
}

const QUALITY_SCHEMA = {
  type: 'object',
  properties: {
    sampled_count: { type: 'integer' },
    avg_instruction_chars: { type: 'integer' },
    avg_output_chars: { type: 'integer' },
    fake_green_hits: { type: 'integer' },
    no_orange5_concept_hits: { type: 'integer' },
    contradictions_with_doctrine: { type: 'integer' },
    examples_of_contradiction: { type: 'array', maxItems: 5, items: { type: 'string' } },
    instruction_diversity_score: { type: 'number', minimum: 0, maximum: 1 },
    output_grounding_score: { type: 'number', minimum: 0, maximum: 1 },
    overall_quality_grade: { enum: ['A','B','C','D','F'] },
    verdict: { enum: ['pass', 'fail'] },
    notes: { type: 'string' },
  },
  required: ['sampled_count','avg_instruction_chars','avg_output_chars','fake_green_hits','no_orange5_concept_hits','contradictions_with_doctrine','examples_of_contradiction','instruction_diversity_score','output_grounding_score','overall_quality_grade','verdict','notes'],
  additionalProperties: false,
}

const SAFETY_SCHEMA = {
  type: 'object',
  properties: {
    pii_emails_found: { type: 'integer' },
    pii_phones_found: { type: 'integer' },
    api_keys_found: { type: 'integer' },
    api_keys_redacted_only: { type: 'integer' },
    private_paths_leaked: { type: 'integer' },
    private_paths_examples: { type: 'array', maxItems: 5, items: { type: 'string' } },
    secrets_strings_found: { type: 'integer' },
    operator_real_name_count: { type: 'integer' },
    operator_real_email_count: { type: 'integer' },
    verdict: { enum: ['pass', 'concern', 'fail'] },
    notes: { type: 'string' },
  },
  required: ['pii_emails_found','pii_phones_found','api_keys_found','api_keys_redacted_only','private_paths_leaked','private_paths_examples','secrets_strings_found','operator_real_name_count','operator_real_email_count','verdict','notes'],
  additionalProperties: false,
}

const SYNTH_SCHEMA = {
  type: 'object',
  properties: {
    final_verdict: { enum: ['GO', 'BLOCK', 'GO_WITH_NOTE'] },
    failures: { type: 'array', items: { type: 'string' } },
    warnings: { type: 'array', items: { type: 'string' } },
    receipt_path: { type: 'string' },
    summary: { type: 'string', minLength: 30 },
  },
  required: ['final_verdict', 'failures', 'warnings', 'receipt_path', 'summary'],
  additionalProperties: false,
}

phase('Verify')

log('Firing 3 parallel pre-flight verifiers.')

const [integrity, quality, safety] = await parallel([
  () => agent(
`Pre-flight integrity verifier for OrangeLLM-fatty v0 training inputs.

CHECKS (all must pass for verdict=pass):

1. CORPUS at ${CORPUS_PATH}
   - Use Bash: 'wc -l "${CORPUS_PATH}"' — record line count (expect 1000)
   - Use Bash: 'sha256sum "${CORPUS_PATH}" | awk "{print \\$1}"' — record actual SHA-256
   - Compare against expected: ${CORPUS_SHA_EXPECTED}
   - Read first 50 + last 50 lines. Parse each as JSON. Count malformed JSON lines AND lines missing required fields {instruction, input, output}. Output must be a string, instruction must be a non-empty string.

2. YAML at ${YAML_PATH}
   - Read the file.
   - Confirm it parses as YAML (no syntax errors).
   - Extract base_model (expect 'Qwen/Qwen3-30B-A3B-Instruct')
   - Extract lora_r (expect 16)
   - Extract datasets[0].path (record what's there)

3. NOTEBOOK at ${NOTEBOOK_PATH}
   - Read the file.
   - Confirm it parses as JSON (Jupyter format).
   - Count cells.
   - Confirm presence of: a cell containing 'drive.mount', a cell containing 'axolotl' (install line), a cell containing 'accelerate launch' (train cell).

4. GIST at ${GIST_URL}
   - Use Bash: 'curl -s -o /dev/null -w "%{http_code}" "${GIST_URL}"' to get HTTP status.
   - 200 = live. Anything else = dead.

Return all results via StructuredOutput. Set verdict=fail if ANY of: sha mismatch, malformed_lines>0, missing_fields_count>0, yaml fails to parse, notebook fails to parse, gist not live. Populate failures[] with one short string per failure.`,
    { phase: 'Verify', label: 'integrity', schema: INTEGRITY_SCHEMA, effort: 'medium' }
  ),
  () => agent(
`Pre-flight quality verifier for the OrangeLLM-fatty v0 training corpus.

CORPUS PATH: ${CORPUS_PATH} (1000 instruction-tuning pairs as JSONL)

PROCESS:
1. Read the corpus file. Parse each line.
2. Take a STRATIFIED random sample of 50 pairs (mix from the start, middle, end — not just the first 50).
3. For each sampled pair compute: instruction chars, output chars.
4. Compute averages across the 50.
5. Scan ALL 1000 pairs (not just sample) for fake-green words via regex: /\\b(green_assumed|looks_ok|probably|should_work|fake_green)\\b/i — count hits.
6. Scan ALL 1000 pairs for Orange5 concept reference in instruction OR output: /\\b(orange5|orangellm|atomic[-\\s]?orange|ae cobra|orangeeye|hermes|mirage|atomsmasher|toolmesh|codexa|n150|fatty|mom'?s law|frontier-?isolation|codeless|gateway|qwen3|axolotl|colab|hash chain|receipt|flux|schism|mamba|colpali|qdrant|qlora|lora)\\b/i — count pairs that MISS the regex (no_orange5_concept_hits).
7. From your 50-pair sample, judge for doctrine contradictions. The truth anchors:
   - Mom's Law is above all other rules.
   - Frontier-Isolation Law: frontier touches ONLY OrangeLLM gateway at 127.0.0.1:1337/v1.
   - Codeless Law: no IDE, no editor, no autocomplete in Atomic Orange.
   - LLM-Over-Agent Law: LLMs > agents.
   - OrangeLLM-fatty = qwen3:30b-a3b + Orange5 LoRA, on Codexa, only trained PM brain (1-tier locked).
   - Smart Skinny custom LoRA training is RETIRED.
   - N150 holds stock qwen3:0.6b — NO custom training there.
   - Æ Cobra = Mamba SSM memory daemon on Codexa.
   - OrangeEye = ColQwen2.5 + Qdrant MaxSim + GLM-4.6V.
   - Sovereign = Atom McCree.
   - Ports: 1337 (gateway), 8797 (smart skinny wrapper), 11434 (raw ollama), 8097 (codexa rail), 7419 (ae cobra), 6333 (qdrant).
   Flag any sampled pair whose output contradicts any of these. Record up to 5 short example strings of contradictions in examples_of_contradiction.
8. Compute instruction_diversity_score 0..1: how varied are the instruction openings? (e.g. all 'What is X' = low; mix of how/when/why/list/where = high). Just an estimate.
9. Compute output_grounding_score 0..1: how often does the output cite specific names/ports/files from the doctrine truth list above. Just an estimate.
10. Grade A-F based on the above. verdict=pass if grade in {A, B} AND fake_green_hits==0 AND contradictions <= 2; else fail.

Return via StructuredOutput.`,
    { phase: 'Verify', label: 'quality', schema: QUALITY_SCHEMA, effort: 'high' }
  ),
  () => agent(
`Pre-flight safety/secret scanner for the OrangeLLM-fatty v0 training corpus.

CORPUS PATH: ${CORPUS_PATH}

This corpus will train a model that gets published; we must NOT bake secrets or PII into the weights.

SCAN ALL 1000 PAIRS (instruction + output, both) for:

1. PII emails: regex /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}/ — count. The operator's a.mccree@gmail.com is the operator's own email; count it separately as operator_real_email_count. Other distinct emails = pii_emails_found.
2. PII phones: regex /\\b\\d{3}[-.]?\\d{3}[-.]?\\d{4}\\b/ — count pii_phones_found.
3. Operator real name 'Atom McCree' or 'Ætom ÆoNs' — count operator_real_name_count. (These appear in doctrine intentionally — note but don't necessarily fail.)
4. API keys: scan for patterns like /sk-[A-Za-z0-9]{20,}/, /ghp_[A-Za-z0-9]{36}/, /gho_[A-Za-z0-9]{36}/, /AIza[0-9A-Za-z-_]{35}/, /xoxb-[A-Za-z0-9-]+/, /AKIA[0-9A-Z]{16}/ — count api_keys_found. If any are obviously redacted (xxxxx, ****, REDACTED) count as api_keys_redacted_only.
5. Private path leaks: scan for absolute Windows paths under C:\\Users\\<somebody>\\ (the operator's path C:\\Users\\a\\ is acceptable since the model knows the system; but flag any OTHER user path leaks). Also flag any /home/<user>/ paths that aren't generic. Record up to 5 example strings in private_paths_examples.
6. Secrets strings: scan for 'BEGIN PRIVATE KEY', 'BEGIN RSA', 'password=', 'secret=', 'token=' followed by non-obvious values — count secrets_strings_found.

VERDICTS:
- 'pass' if: api_keys_found <= api_keys_redacted_only AND secrets_strings_found == 0 AND pii_emails_found == 0 (excluding operator_real_email).
- 'concern' if: minor PII leaks (e.g. one stray email) but no secrets.
- 'fail' if: real API keys, private keys, or operator credentials present.

Return via StructuredOutput with brief notes explaining.`,
    { phase: 'Verify', label: 'safety', schema: SAFETY_SCHEMA, effort: 'medium' }
  ),
])

log(`Verify phase complete. Integrity: ${integrity?.verdict}. Quality: ${quality?.verdict}. Safety: ${safety?.verdict}.`)

phase('Synthesize')

const synth = await agent(
`You are the pre-flight synthesizer for OrangeLLM-fatty v0.

THREE VERIFIER REPORTS:

INTEGRITY:
${JSON.stringify(integrity, null, 2)}

QUALITY:
${JSON.stringify(quality, null, 2)}

SAFETY:
${JSON.stringify(safety, null, 2)}

DECIDE final_verdict:
- 'GO' if all three are pass (or safety=concern with no real keys).
- 'GO_WITH_NOTE' if quality is pass but with grade C, OR safety=concern. Operator should know but it's safe to launch.
- 'BLOCK' if any verdict is fail OR safety=fail.

failures[]: list each failure as a short imperative sentence.
warnings[]: list each non-blocking concern.

WRITE A HASH-CHAINED RECEIPT to ${RECEIPT_DIR}/2026-06-24-orangellm-fatty-v0-preflight-<lower(final_verdict)>.md.

Required content in the receipt:
- Receipt ID, generated_at, schema (orange5.receipt.v0), actor (Claude / orangellm-fatty-v0-preflight workflow), status, confidence
- prior_receipt: '2026-06-24-colab-notebook-gist-published' (hash chain #015)
- hash_chain: 16
- Sovereign: Atom McCree
- Three verifier reports as tables/sections
- Final verdict with reasoning
- Failures + warnings lists
- If GO or GO_WITH_NOTE: the operator-action block (open the Colab gist URL, set A100, upload corpus.jsonl + YAML, Run all)
- If BLOCK: what specifically the operator must fix before retrying
- Rollback (delete the receipt; no other state changes)
- Mom's Law alignment statement
- Hash chain footer

Use Write (not Bash) to create the file. Return the path you wrote to.

Return via StructuredOutput.`,
  { phase: 'Synthesize', label: 'synth', schema: SYNTH_SCHEMA, effort: 'high' }
)

return {
  status: synth?.final_verdict || 'unknown',
  integrity,
  quality,
  safety,
  synth,
}
