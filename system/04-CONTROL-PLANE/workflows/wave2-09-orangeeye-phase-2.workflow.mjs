// wave2-09-orangeeye-phase-2.workflow.mjs — OrangeEye Phase-2: PDFs, batching, queue, OpenVINO.

export const meta = { name: 'wave2-09-orangeeye-phase-2', description: 'OrangeEye Phase-2: PDF support + batching + ingest queue + OpenVINO conversion + temporal video frames', phases: [{title:'Author'},{title:'Synth'}] }
const ROOT = 'C:/AtomEons/Orange5'
const SCHEMA = { type: 'object', properties: { component: { type: 'string' }, files_written: { type: 'array', items: { type: 'string' } }, line_counts: { type: 'object', additionalProperties: { type: 'integer' } }, notes: { type: 'string' } }, required: ['component', 'files_written', 'line_counts', 'notes'], additionalProperties: false }
const SYNTH = { type: 'object', properties: { status: { enum: ['green', 'partial', 'red'] }, files_landed: { type: 'integer' }, receipt_path: { type: 'string' } }, required: ['status', 'files_landed', 'receipt_path'], additionalProperties: false }

const CTX = `OrangeEye Phase-1 scaffold landed in receipt #021. Phase-2 adds: (a) PDF ingest (Phase-1 rejected with pdf_unsupported); (b) batched ingest queue so multiple files don't OOM Codexa; (c) OpenVINO conversion path for ColQwen2.5 (CPU+NPU faster than transformers); (d) temporal video frames (extract frames every N sec, batch-ingest). Reads existing 07-VISUAL/colpali-service/ for the Phase-1 base. Quality: real code.`

phase('Author')
const components = [
  { id: 'pdf-ingest', prompt: `Author ${ROOT}/07-VISUAL/colpali-service/python/pdf_ingest.py. Uses pdf2image + ColQwen2.5 per page. Removes the pdf_unsupported guard. Handles multi-page (chains pages into a single doc_id with page= field on each Qdrant point). ${CTX}` },
  { id: 'batch-queue', prompt: `Author ${ROOT}/07-VISUAL/colpali-service/queue.mjs. Persistent SQLite-backed ingest queue at 07-VISUAL/queue.db. Stores {id, path, status: queued|running|done|error, started_at, finished_at, error_msg}. Worker drains 1-at-a-time to avoid OOM. ${CTX}` },
  { id: 'queue-server-route', prompt: `Author ${ROOT}/07-VISUAL/colpali-service/queue-routes.mjs — extends the Bun server. POST /enqueue (path), GET /queue (list), GET /queue/:id (status), DELETE /queue/:id (cancel pending). Surfaces ingest progress to the Vault lane. ${CTX}` },
  { id: 'openvino-conversion', prompt: `Author ${ROOT}/07-VISUAL/colpali-service/python/openvino_convert.py. Script that converts ColQwen2.5 from PyTorch to OpenVINO IR format for CPU+NPU acceleration on Codexa Intel Ultra 9 285H. Saves to /opt/atomeons/colqwen2-openvino/. Plus loader switch in server.mjs to prefer OpenVINO when available. ${CTX}` },
  { id: 'video-frames', prompt: `Author ${ROOT}/07-VISUAL/video/frame-extractor.mjs. Uses ffmpeg subprocess to extract a frame every N seconds (default 5s). Pipes each frame into the standard ingest path with payload.lane='video-frame'. ${CTX}` },
  { id: 'gateway-phase2-routes', prompt: `Extend ${ROOT}/06-ORANGELLM/server/routes/visual.mjs with: POST /v1/visual/ingest/batch (accepts a list of paths, enqueues all), GET /v1/visual/queue (queue status), POST /v1/visual/video/ingest. Smoke test at 07-VISUAL/smoke-test-phase2.mjs. ${CTX}` },
]
const results = await parallel(components.map(c => () => agent(c.prompt, { phase: 'Author', label: `eye2:${c.id}`, schema: SCHEMA, effort: 'high' })))

phase('Synth')
const synth = await agent(`Write receipt at ${ROOT}/10-RECEIPTS/orange5-build/2026-06-25-orangeeye-phase-2.md. Components: ${JSON.stringify(results.filter(Boolean), null, 2)}. prior_receipt + hash_chain. Honest gaps. Return via StructuredOutput.`, { phase: 'Synth', label: 'synth', schema: SYNTH, effort: 'high' })
return { status: synth?.status || 'unknown', components: results.filter(Boolean), synth }
