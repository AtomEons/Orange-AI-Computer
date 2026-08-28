// orangeeye-phase-1.workflow.mjs
// Build the OrangeEye Phase-1 scaffold: ColPali ingestion + Qdrant + visual-event Flux writer
// + gateway /v1/visual/* routes + Vault-lane UI patch + smoke test.
// Authoring only — operator runs on Codexa once Qdrant + Ollama (GLM-4.6V) are confirmed up.

export const meta = {
  name: 'orangeeye-phase-1',
  description: 'OrangeEye Phase-1 scaffold — ColPali + Qdrant MaxSim + GLM-4.6V cortex + frontier offload',
  phases: [
    { title: 'Author', detail: '6 parallel agents — service, qdrant init, event writer, gateway routes, Vault UI patch, smoke test' },
    { title: 'Synth',  detail: 'integration receipt + endpoint inventory' },
  ],
}

const ROOT = 'C:/AtomEons/Orange5'

const AUTHOR_SCHEMA = {
  type: 'object',
  properties: {
    component: { type: 'string' },
    files_written: { type: 'array', items: { type: 'string' }, minItems: 1 },
    line_counts: { type: 'object', additionalProperties: { type: 'integer' } },
    notes: { type: 'string' },
  },
  required: ['component', 'files_written', 'line_counts', 'notes'],
  additionalProperties: false,
}

const SYNTH_SCHEMA = {
  type: 'object',
  properties: {
    components_landed: { type: 'integer' },
    total_files: { type: 'integer' },
    total_lines: { type: 'integer' },
    receipt_path: { type: 'string' },
    integration_status: { enum: ['green', 'partial', 'red'] },
    open_issues: { type: 'array', items: { type: 'string' } },
  },
  required: ['components_landed', 'total_files', 'total_lines', 'receipt_path', 'integration_status', 'open_issues'],
  additionalProperties: false,
}

const COMMON_CONTEXT = `
OrangeEye Phase-1 doctrine (read AE_ORANGEEYE_FOUNDATION_SPEC.md if more depth needed):
- Eye layer: ColQwen2.5 (or ColPali-3) via OpenVINO on Codexa CPU+NPU — emits 196 patch embeddings of 128-dim Int8 per page.
- Index: Qdrant collection 'orange5-vision', multi-vector config with comparator=max_sim, datatype=uint8, dot distance.
- Edge cortex: GLM-4.6V Q4 via Ollama on Codexa — 3 ops: /v1/visual/describe, /v1/visual/extract-structure, /v1/visual/ground-ui.
- Frontier offload via gateway: triggered when local cortex confidence<0.7 OR /deep flag OR token-budget exceeded OR layout complexity high.
- Visual events land in Reality lane via Æ Cobra Flux writer with ae_visual block: {image_sha256, qdrant_doc_id, patch_grounding[], cortex_model, frontier_used}.
- Frontier-Isolation Law: external frontier model only ever called via OrangeLLM gateway at 127.0.0.1:1337/v1, never directly.
- Codeless Law: Vault UI cannot expose a code editor / file tree / repo indexer.
- Mom's Law: every file earns its place, anti-fluff applies.

Quality bar:
- Every authored file must be executable / compilable as-is (Node 20+ for .mjs, valid SQL/YAML/JSON for those formats).
- Include error handling for the obvious failure modes (Qdrant unreachable, GLM-4.6V unreachable, file not found).
- Honest README per component explaining "what this does NOT do yet" alongside what it does.
`

phase('Author')

const components = [
  {
    id: 'colpali-service',
    target_dir: '07-VISUAL/colpali-service',
    prompt: `Author the ColPali ingestion service for OrangeEye Phase-1.

Write these files under ${ROOT}/07-VISUAL/colpali-service/:
1. server.mjs — Bun HTTP server on 127.0.0.1:7440. POST /ingest accepts a multipart form (image or PDF), runs ColQwen2.5 inference to produce 196×128 Int8 patch embeddings per page, returns {doc_id, page_count, patches: [...embeddings...], image_sha256}. Implement as a Bun + Python-bridge: shell out to a Python subprocess that loads the ColQwen2.5 model via transformers + Pillow (operator will install). Server stays in Bun; Python runs per-ingest, exits after.
2. python/colqwen_ingest.py — the Python inference script. Reads image bytes from stdin, prints JSON {patches: [[...Int8 per patch...]], page_count} to stdout. Uses transformers AutoProcessor + AutoModel for "vidore/colqwen2-v1.0". Quantizes patches to Int8 by clamping float32 outputs to [-128, 127].
3. systemd/colpali.service — systemd unit. After=network-online.target, MemoryMax=10G, loopback-only.
4. README.md — what it does, how to run, what's missing for Phase-2 (batching, queue, OpenVINO conversion, ONNX runtime).

Quality bar: actual code that would compile/run. Not pseudocode. Include error handling (model load fail, image decode fail, OOM).
${COMMON_CONTEXT}`,
  },
  {
    id: 'qdrant-init',
    target_dir: '07-VISUAL/qdrant',
    prompt: `Author the Qdrant collection init + management scripts for OrangeEye.

Write these files under ${ROOT}/07-VISUAL/qdrant/:
1. init-collection.mjs — Node script. Connects to Qdrant at http://127.0.0.1:6333 (the existing aeorangebox-ai-box-qdrant-1 container per orangebox_status). Creates the 'orange5-vision' collection if it doesn't exist with: vectors_config = {size: 128, distance: Dot, multi_vector_config: {comparator: max_sim}, datatype: uint8}. Adds indexed payload fields: source (keyword), page (integer), doc_id (keyword), ingested_at (datetime), lane (keyword: doc|ui-screenshot|video-frame|chart|whiteboard). Idempotent — if collection exists with right config, no-op.
2. upsert.mjs — Helper: upsertVisualDoc({doc_id, page, patches, payload}) batches patches into a single Qdrant point with multi-vector. Returns {ok, point_id}.
3. query.mjs — Helper: queryMaxSim({queryText, topK=8, laneFilter=null}). Embeds queryText via an embedding endpoint (use nomic-embed-text via Ollama at 127.0.0.1:11434/api/embeddings as Night-1 stand-in; spec note for ColQwen2.5 query embedding at Phase-2). Returns top-K points with scores + payload.
4. README.md — collection schema, retention policy (none Night-1), backup story (volume mount in docker-compose).

${COMMON_CONTEXT}`,
  },
  {
    id: 'visual-event-writer',
    target_dir: '07-VISUAL/visual-event',
    prompt: `Author the visual event Flux writer for OrangeEye.

Write under ${ROOT}/07-VISUAL/visual-event/:
1. writer.mjs — Wraps the Æ Cobra Flux writer at 06-ORANGELLM/memory/ae-cobra/flux/writer.mjs. Provides writeVisualEvent({image_sha256, qdrant_doc_id, page, cortex_model, cortex_response, patch_grounding, frontier_used, frontier_model, fluxRoot}). Composes a body that includes a structured ae_visual block alongside the agent_turn-compatible fields {summary, entities, files, commands, risk, next_action, confidence}. Calls Æ Cobra's writeFluxRecord with origin='orangeeye', lane='reality', kind='observation'. Returns the Flux record.
2. test-fixtures.json — 3 sample visual events used by smoke test: one PDF page describe, one UI ground-element, one frontier-offload case.
3. README.md — what gets recorded for a visual event, why it lands in Reality (origin-based classifier — V1 mitigation), how to query it back via Mirage StateBrief.

Sample event shape:
{
  ae_visual: {
    image_sha256: "...",
    qdrant_doc_id: "...",
    page: 0,
    cortex_model: "glm-4.6v",
    frontier_used: false,
    patch_grounding: [{idx: 47, bbox: [120, 200, 80, 30], confidence: 0.92}]
  },
  summary: "Operator dropped Q4 deck p.3 — bar chart of revenue by region",
  entities: ["Q4 deck", "revenue chart"],
  files: ["q4-deck.pdf#page=3"],
  commands: [],
  risk: "low",
  next_action: "wait for follow-up query",
  confidence: 0.9
}
${COMMON_CONTEXT}`,
  },
  {
    id: 'gateway-visual-routes',
    target_dir: '06-ORANGELLM/server/routes',
    prompt: `Author the OrangeLLM gateway /v1/visual/* routes that the operator's app + frontier model will call.

Write under ${ROOT}/06-ORANGELLM/server/routes/:
1. visual.mjs — Node.js HTTP route handler exporting a function registerVisualRoutes(server). Adds three routes:
   - POST /v1/visual/ingest — accepts multipart {file, source_hint, lane}. Pipes to ColPali service at 127.0.0.1:7440/ingest. Upserts to Qdrant via 07-VISUAL/qdrant/upsert.mjs. Writes visual event to Reality lane via 07-VISUAL/visual-event/writer.mjs. Returns {doc_id, pages_ingested, patches_indexed}.
   - POST /v1/visual/query — accepts {query, top_k=8, lane=null}. Calls 07-VISUAL/qdrant/query.mjs. Returns {results: [{doc_id, page, score, payload, patch_grounding}]}.
   - POST /v1/visual/describe — accepts {doc_id, page} OR {image_url}. Calls local cortex (Ollama GLM-4.6V at 127.0.0.1:11434/api/generate with model="glm-4.6v"). If response.confidence < 0.7 OR explicit /deep flag set, offloads to the operator's BYO frontier through the gateway's own /v1/chat/completions path. Returns {answer, grounding, cortex_model, frontier_used}.
2. visual-boundary.mjs — Adds the new routes to the gateway's allowed-path list in boundary.mjs. The boundary middleware already rejects unknown /v1/* paths with 403; this file exports the additional allowed paths so the operator can splice into boundary.mjs at one line.
3. README.md — endpoint contracts, request/response shapes, error codes, backpressure on Qdrant unreachable.

${COMMON_CONTEXT}`,
  },
  {
    id: 'vault-ui-patch',
    target_dir: '07-VISUAL/atomic-orange-patches',
    prompt: `Author the Vault lane UI patches for OrangeEye Phase-1. These are patches the operator will apply to the atomic-orange repo manually (no commit from here).

Write under ${ROOT}/07-VISUAL/atomic-orange-patches/:
1. Vault.tsx — Full replacement React 19 component for atomic-orange/src/Vault.tsx. Features: drag-drop zone for PDFs/images that POST to /v1/visual/ingest, search bar that POSTs to /v1/visual/query, result list rendering each hit as a card showing thumbnail (when available) + page number + score + cited summary + a "describe" button that triggers /v1/visual/describe. Patch grounding bboxes rendered as orange-stroked overlays on the page thumbnail. Uses the existing Atom Standard palette via CSS vars from styles.css.
2. vault-styles.css — Additional CSS specifically for Vault visual elements: drag-zone, result-card, grounding-overlay, score-meter. Uses --orange, --stroke-hot, --panel, --text from the existing :root. ~120 lines max.
3. README.md — How to apply: copy Vault.tsx → 02-APP/src/Vault.tsx; append vault-styles.css contents to 02-APP/src/styles.css. Then npm run dev to validate.

Codeless Law: NO code-editor surface in the Vault. Drag-drop, search, results, describe — that's it.

${COMMON_CONTEXT}`,
  },
  {
    id: 'smoke-test',
    target_dir: '07-VISUAL',
    prompt: `Author the OrangeEye Phase-1 smoke test that validates the full pipeline.

Write under ${ROOT}/07-VISUAL/:
1. smoke-test.mjs — Bun script. Steps:
   a. Pre-flight: probe Qdrant at :6333, ColPali at :7440, Ollama GLM-4.6V at :11434/api/tags (assert glm-4.6v model present), Æ Cobra at :7419.
   b. Ingest: POST a small PDF (use a 1-page synthetic test PDF generated inline via pdfkit or downloaded from a public source; if neither works, use a PNG screenshot of the README) to /v1/visual/ingest. Assert {pages_ingested >= 1}.
   c. Query: POST /v1/visual/query with text from the ingested doc. Assert {results.length >= 1, results[0].score > 0}.
   d. Describe: POST /v1/visual/describe with the top hit's doc_id+page. Assert {answer.length > 20, cortex_model === "glm-4.6v"}.
   e. Mirage recall: POST 127.0.0.1:7419/state-brief with query matching the ingested content. Assert {reality.length >= 1, reality[0].kind === "observation"}.
2. test-pdf-generator.mjs — Bun script that generates the 1-page test PDF locally so smoke-test doesn't need network.
3. README.md — Run: bun smoke-test.mjs. Expected: 5/5 steps green. Failure modes documented.

${COMMON_CONTEXT}`,
  },
]

log(`Fanning out ${components.length} OrangeEye component authors in parallel.`)

const results = await parallel(
  components.map(c => () => agent(c.prompt, { phase: 'Author', label: `eye:${c.id}`, schema: AUTHOR_SCHEMA, effort: 'high' }))
)

phase('Synth')

const synth = await agent(
  `You are the OrangeEye Phase-1 synthesis agent. The 6 parallel authors have landed their files. Write the integration receipt.

Author results:
${JSON.stringify(results.filter(Boolean), null, 2)}

Write the hash-chained receipt to ${ROOT}/10-RECEIPTS/orange5-build/2026-06-24-orangeeye-phase-1-scaffold-authored.md.

Required content:
- Receipt ID, generated_at, schema (orange5.receipt.v0), actor (Claude / orangeeye-phase-1 workflow), status, confidence
- prior_receipt: read the latest receipt id from ${ROOT}/10-RECEIPTS/orange5-build/ (sort by filename); set hash_chain to that + 1
- Sovereign: Atom McCree
- Component table: 6 rows, each component name, files written, line count
- Endpoint inventory: every new HTTP endpoint authored (POST /v1/visual/ingest, /v1/visual/query, /v1/visual/describe, /ingest on :7440)
- Integration order: what operator runs on Codexa in order (Qdrant init → ColPali service systemd enable → gateway route splice → smoke test)
- Honest "what this does NOT do yet" section: no temporal video frames, no whiteboard OCR specialization, no Phase-2 ColQwen2.5 query embedding, no MiniEyes
- Mom's Law alignment statement
- Hash chain footer

Return via StructuredOutput.`,
  { phase: 'Synth', label: 'synth', schema: SYNTH_SCHEMA, effort: 'high' }
)

return { status: synth?.integration_status || 'unknown', components: results.filter(Boolean), synth }
