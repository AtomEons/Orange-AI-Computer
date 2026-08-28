# AE OrangeEye Foundation — Merged Visual Stack Spec

**Locked:** 2026-06-23
**Sovereign:** Atom McCree
**Status:** SPEC LOCKED · BUILD QUEUED (Visual lane, Week 3 of month plan)
**Replaces:** prior `07-VISUAL/PR-13-SPEC.md` (facade-only)
**Source documents merged:**
- Operator's "2026 Sovereign Vision Stack" architecture (this turn)
- Prior `07-VISUAL/PR-13-SPEC.md` (facade scaffold)
- Master Plan §6 (Visual capability under OrangeLLM)
- Æ Cobra Foundation Spec (Visual events feed Reality lane)

---

## 0. North Star

OCR flattens spatial context. Tables become word soup. Charts become noise. UI screenshots lose their layout grammar. **AE OrangeEye replaces OCR with multi-vector visual-patch embeddings and late-interaction retrieval** — the engine "sees" documents and UIs natively, preserving exact spatial coordinates of every answer.

OrangeEye is **the sight organ** of Orange5. It is to vision what Æ Cobra is to memory: a specialized small-model sub-system under OrangeLLM, logit-locked where applicable, that translates pixels to structured text that the PM brain can act on. **Composition-AGI doctrine** (per Master Plan §1) continues.

---

## 1. The Five Layers

| Layer | Operator-spec component | What we ship on Codexa (Phase-1) | Phase-2 horizon |
|---|---|---|---|
| **Eye — Ingestion** | ColQwen2.5 / ColPali-3 (128-dim Int8 visual patches, ~100 KB/page, no OCR) | **ColQwen2.5 on Codexa CPU** (~500ms–2s per page; fits in ~5 GB RAM at Q4) | ColPali-3 if available; NPU/iGPU acceleration via OpenVINO |
| **Memory — DB** | Qdrant multi-vector store with ColBERT-style MaxSim | **Qdrant in Docker on Codexa** (existing Docker stack already has redis, postgres, qdrant — actually `aeorangebox-ai-box-qdrant-1` is up 12+ days per `orangebox_status`. We're 90% of the way there.) | Tune index types (HNSW vs flat), scale to >1 M pages |
| **Edge Cortex — VLM** | Qwen3-VL 72B / GLM-5V Turbo | **GLM-4.6V on Codexa via Ollama** (~8 GB Q4 RAM, ~3–10s/query CPU+iGPU) | Qwen3-VL 72B Q4 on Codexa CPU is workable (~38 GB peak, ~30–90s/query) — slow but possible. Real promotion needs a GPU. |
| **Inference Engine** | SGLang v0.4+ (Context Parallelism + Token-level Sequence Sharding + Persistent Visual Cache) | **Ollama for VLMs + Python transformers for ColPali** (no GPU = SGLang's GPU optimizations don't apply) | SGLang activates when Codexa adds discrete GPU OR cloud-GPU offload lane is operational |
| **Orchestrator** | Go / Rust (Orange5 core) | **Bun TypeScript** (Flow Direct) for orchestration on Codexa, **Rust binary writer** for Flux lane only — matches existing Æ Cobra spine; no new language family | Rust orchestrator full migration if Bun proves too slow for concurrent embed jobs at scale |
| **Frontier Offload** | Gemini 3.1 Pro (1M+ token video + deep semantic) | **BYO key via OrangeLLM gateway** — Opus 4.7 OR GPT-5.5 OR Gemini whatever-version operator has; Frontier-Isolation Law preserves boundary | Any frontier model the operator picks; the gateway abstraction is constant |

---

## 2. Late-Interaction Retrieval (MaxSim)

The scoring equation is exactly as operator wrote it:

$$S(q, d) = \sum_{i=1}^{|q|} \max_{j=1}^{|d|} \left( E_q(i) \cdot E_d(j) \right)$$

Where:
- $E_q(i)$ = query token $i$'s embedding
- $E_d(j)$ = visual patch $j$'s embedding in document $d$
- $|q|$ = number of query tokens
- $|d|$ = number of visual patches in document (typically 196 per page for ColQwen2.5)

**Qdrant supports this natively** since v1.10 via the multi-vector index type. Each document = list of 196 patch vectors. Query = list of N token vectors. MaxSim is the configured similarity function.

**What this gives Orange5:** The retrieval result isn't just "the page that matches" — it's the page **plus the patch coordinates** where the match landed. OrangeLLM can ask GLM-4.6V "describe the region at patch coordinates X,Y" and get a grounded answer about the actual visual content at that location.

This is the spatial-coordinate preservation OCR can never give us.

---

## 3. Codexa hardware reality check (honest)

The operator's spec assumes GPU. **Codexa has no NVIDIA GPU.** It has:

| Component | Spec | What it can do |
|---|---|---|
| CPU | Intel Core Ultra 9 285H, 16 cores | General compute; runs Ollama LLMs slowly |
| iGPU | Intel Arc graphics | Vulkan offload for some Ollama models; ~50 TOPS theoretical |
| NPU | Intel AI Boost | ~38 TOPS via OpenVINO; runs small models (ColPali fits here) |
| RAM | 96 GB DDR5 | Big enough for any LLM ≤70B at Q4 |
| Storage | Dual NVMe | Fast enough for Qdrant index + Flux |

**What this means for the operator's stack:**

| Component | Phase-1 on Codexa | Honest assessment |
|---|---|---|
| ColPali / ColQwen2.5 | ✅ Runs at ~500ms–2s per page on CPU; ~150ms via OpenVINO NPU if we wire it | Phase-1 ready |
| Qdrant MaxSim | ✅ Already running in Docker stack; very fast for multi-vector retrieval | Phase-1 ready |
| GLM-4.6V edge cortex | ✅ Runs via Ollama, ~3-10s/query CPU+Vulkan iGPU | Phase-1 ready; this is the realistic local VLM |
| Qwen3-VL 72B local | 🟡 Q4 fits in ~38 GB; inference ~30-90s/query CPU only | Possible but interactive UX is broken; Phase-2 needs GPU |
| SGLang persistent visual cache | ❌ Needs CUDA | Not Phase-1; activates when GPU lands |
| SGLang context parallelism | ❌ Needs multi-GPU | Phase-2+ |
| 1M+ token video temporal reasoning | ❌ Local impossible | Frontier offload to Gemini/Opus only |
| Frontier offload via gateway (BYO key) | ✅ Already works via existing `:1337/v1/chat/completions` path | Phase-1 ready |

**Verdict:** The architecture is correct. We ship ~70% of it on Codexa Phase-1. The remaining 30% (heavy VLM local + SGLang GPU stack + huge-context video) waits for a GPU procurement decision.

---

## 4. The five organs — Phase-1 build map

### 4.1 The Eye — ColQwen2.5 ingestion

**Location:** Codexa, WSL2, `/opt/atomeons/ae-orangeeye/eye/`
**Runtime:** Python 3.11 venv + PyTorch + transformers + ColPali-engine package
**Model:** `vidore/colqwen2.5-v0.2` (Q4 quantized for CPU)
**Output:** For each input image/PDF page, emit:
- 196 visual patch embeddings, each 128-dim Int8 (≈25 KB raw, ~100 KB with metadata)
- Patch coordinate grid (14×14 = 196 patches, each with bbox)
- Page-level metadata (source doc, page #, timestamp, sha256)

**API:** Internal HTTP at `127.0.0.1:7420` (one port up from Æ Cobra's 7419).
```
POST /eye/encode
Body: { "source": "file:///path/to/doc.pdf", "page": 0 }
Returns: { "doc_id": "...", "page": 0, "patches": [[...128 Int8...], ...196], "coords": [...], "sha256": "..." }
```

### 4.2 The DB — Qdrant multi-vector store

**Location:** Codexa, existing Docker `aeorangebox-ai-box-qdrant-1` (up 12+ days)
**Endpoint:** `http://10.0.99.1:6333` (Qdrant default, internal Codexa)
**Collection name:** `orange5-vision`
**Vector config:**
```yaml
vectors:
  patches:
    size: 128
    distance: Dot          # required for MaxSim
    multivector_config:
      comparator: max_sim  # ColBERT-style late interaction
    datatype: uint8        # Int8 quantized
```

**Storage budget:** 100 KB × 10K pages = ~1 GB. 100 KB × 1M pages = 100 GB. Operator-managed retention policy.

**Indexed payload fields:**
- `source` (file path or URL)
- `page` (int)
- `doc_id` (sha256 of source content)
- `ingested_at` (ISO timestamp)
- `lane` (one of: `doc` / `ui-screenshot` / `video-frame` / `chart` / `whiteboard`)

### 4.3 The Edge Cortex — GLM-4.6V via Ollama (Phase-1)

**Location:** Codexa, Ollama
**Model:** `glm-4.6v:7b` or `glm-4.6v:9b` (the operator's already-pulled GLM-4.6V per Orange4 docs)
**Endpoint:** Proxied through OrangeLLM gateway at `:1337/v1/visual/*` (NEW endpoint family, Frontier-Isolation preserved)

**Three operations:**

```
POST /v1/visual/describe
Body: { "image_path": "...", "question": "..." }
Returns: { "answer": "...", "grounding": [{"patch_idx": N, "confidence": 0.0..1.0}] }

POST /v1/visual/extract-structure
Body: { "image_path": "...", "schema": "table|chart|form|ui-mock" }
Returns: { "structure": {...}, "confidence": ... }

POST /v1/visual/ground-ui
Body: { "screenshot_path": "...", "click_intent": "..." }
Returns: { "target_bbox": [...], "confidence": ..., "alternatives": [...] }
```

**Phase-2 upgrade path:** Swap `glm-4.6v` for `qwen3-vl:72b` once GPU lands. API stays the same.

### 4.4 The Inference Engine — Ollama (Phase-1) → SGLang (Phase-2)

**Phase-1 reality:** Ollama on Codexa CPU + Vulkan iGPU offload. Latency 3-10s/VLM query, acceptable for non-interactive use cases.

**Phase-2 GPU plan:** When a discrete GPU lands on Codexa (or cloud GPU lane goes live):
- SGLang serves the VLM
- Token-level sequence sharding for video
- Persistent visual cache (`--keep-mm-feature-on-device`)
- Latency drops to sub-second

**Phase-1 mitigations for slowness:**
1. **Aggressive caching** — every visual query result cached by (image_sha256, question_hash). Re-asks of the same question on same image return in <50ms.
2. **Smart batching** — operator can fire 10 visual queries; Ollama processes serially but UI shows progress
3. **Frontier offload for hard cases** — if local VLM is uncertain (confidence < 0.7) or operator marks "deep" mode, query goes to frontier via the gateway

### 4.5 The Orchestrator — Bun + Rust

**Location:** Codexa, WSL2, `/opt/atomeons/ae-orangeeye/orchestrator/`
**Stack:** Bun TypeScript (consistent with Æ Cobra's Flow Direct) for control flow; Rust binary writer for high-throughput Qdrant inserts (Phase-2)
**Job:** Coordinate ingest → embed → upsert → retrieve → cortex → frontier-offload pipeline

**The chain:**
```
operator gives image/PDF
  ↓
orchestrator → /eye/encode → 196 patches per page
  ↓
orchestrator → Qdrant upsert into orange5-vision collection
  ↓
operator asks question
  ↓
orchestrator → embed question via ColQwen2.5
  ↓
orchestrator → Qdrant search (MaxSim) → top-K pages + patch coords
  ↓
if low complexity:
  orchestrator → GLM-4.6V via gateway → answer + grounding
else (high complexity or video / 1M+ context):
  orchestrator → frontier via gateway (BYO key, Frontier-Isolation enforced)
  ↓
orchestrator returns to OrangeLLM → operator sees answer with citations
  ↓
the visual event is written to Æ Cobra Reality lane (source: 'ui' or 'doc')
```

### 4.6 The Frontier Offload — BYO via gateway

**Location:** Gateway at `:1337/v1/chat/completions` (existing)
**Models:** Whatever operator BYO-keys — Opus 4.7, GPT-5.5, Gemini 3.1 Pro (when available), GLM-5.2, MiniMax M3
**Trigger conditions:**
- Edge VLM confidence < 0.7
- Operator explicit `/deep` flag in query
- Image/video > token budget the local model can handle
- Layout complexity exceeds patch-grid resolution (e.g., very small text on dense forms)
**Boundary preserved:** Frontier model sees ONLY the OrangeLLM-mediated payload, never raw Qdrant or Æ Cobra internals. Frontier-Isolation Law from Master Plan §2.1 holds.

---

## 5. Use cases — what OrangeEye unlocks

| Use case | Stack involved | Latency Phase-1 | Latency Phase-2 |
|---|---|---|---|
| "Find the page where we discussed pricing in this 200-page PDF" | Eye + DB | ~30s ingest, <1s query | <30s ingest, <100ms query |
| "What's the value in row 5 column 'Q4 actual'?" | Eye + DB + Cortex | ~5–15s | <1s |
| "Click the OK button in this UI screenshot" | Cortex (UI ground) | ~3-10s | <1s |
| "Summarize the chart on page 17 of this report" | Eye + DB + Cortex | ~10–20s | <2s |
| "What does this whiteboard photo say to do next?" | Cortex (with handwriting tolerance) | ~5-15s | <2s |
| "Describe what happened in this 5-minute screencast" | Frontier (video temporal — too big for local) | ~30-90s (frontier round trip) | same |
| "Compare these two design mocks for differences" | Eye + DB + Cortex | ~15-30s | <3s |
| "Read this receipt PDF and tell me total + tax" | Eye + DB + Cortex | ~5-10s | <2s |

---

## 6. Build phases

### Phase 1 — OrangeEye Night-1 (Week 3 of month plan, slots in alongside heavy lane)

| Deliverable | Where |
|---|---|
| ColQwen2.5 service at `127.0.0.1:7420/eye/encode` | Codexa WSL2 |
| Qdrant collection `orange5-vision` created with multi-vector + max_sim | Codexa Docker |
| GLM-4.6V proxied through `:1337/v1/visual/*` endpoint family | OrangeLLM gateway code |
| Frontier offload path through same gateway (existing) | gateway routing logic |
| Bun orchestrator with the 7-step chain above | Codexa WSL2 |
| Visual event writer — every cortex query writes a Reality-lane Flux record via Æ Cobra | Bun orchestrator → Flow Direct → Æ Cobra |
| Atomic Orange Vault lane: drag-drop a PDF or image, see retrieval + grounding inline | 02-APP/src/lanes/Vault.tsx (Codex brief) |
| Tests: 16-fixture boundary still holds, 10-fixture visual roundtrip suite | tests/ |

Pass criteria (12-point):
- [ ] ColPali encodes a known test PDF (e.g., a tax form) without error
- [ ] Qdrant collection holds the patches with correct schema
- [ ] MaxSim query returns top-K with patch coordinates
- [ ] GLM-4.6V describes a known image accurately (>0.8 confidence)
- [ ] UI grounding finds a button in a known screenshot
- [ ] Frontier offload returns a real response from BYO model
- [ ] Visual event lands in Æ Cobra Reality lane with hash chain
- [ ] Atomic Orange Vault lane renders the result with patch overlay
- [ ] No new npm dep added to 02-APP
- [ ] Codexa VRAM/RAM steady (no swap)
- [ ] Gateway boundary fixtures still 16/16 green
- [ ] Receipt written and hash-chained

### Phase 2 — Heavy VLM + SGLang (post-GPU procurement OR cloud GPU lane mature)

- Swap GLM-4.6V → Qwen3-VL 72B on the edge cortex endpoint
- Enable SGLang persistent visual cache
- Wire 1M+ token video temporal reasoning local (requires GPU)
- Latency targets drop to sub-second

### Phase 3 — Custom AE MiniEyes Model

If operator wants a smaller, faster, Orange5-specific VLM trained on **dashboard/UI screenshots + AECode mission diagrams + receipt screenshots**:
- 2-8B class VLM, LoRA fine-tuned via Workflow tool
- Specifically tuned for Orange5 surface comprehension
- Trained from Reality.flux UI events + curated Q&A corpus
- Optional addendum, not required for ship

---

## 7. Integration with Æ Cobra (memory ↔ vision loop)

**Every cortex query produces a Reality-lane Flux event:**

```json
{
  "lane": "reality",
  "event_type": "observation",
  "summary": "<the cortex answer, compressed>",
  "entities": [...recognized entities...],
  "files": ["<image path>"],
  "commands": [],
  "risk": "low",
  "next_action": "<if applicable>",
  "confidence": 0.0..1.0,
  "ae_visual": {
    "image_sha256": "...",
    "qdrant_doc_id": "...",
    "patch_grounding": [{"idx": 47, "bbox": [...], "conf": 0.92}],
    "cortex_model": "glm-4.6v",
    "frontier_used": false
  }
}
```

This means **OrangeLLM can ask Æ Cobra later: "What did we see in the design mock on Tuesday?"** and get a typed, citation-backed StateBrief with the patch-grounded retrieval still intact. **Vision history becomes searchable, time-locked, hash-chained — same as text events.**

This is why OrangeEye sits **under** OrangeLLM (per Master Plan §1), not as a fifth pillar. It's the sight; OrangeLLM is the thought; Æ Cobra is the memory of both.

---

## 8. What's locked vs what's open

### Locked

- ColQwen2.5 as the Eye (Phase-1)
- Qdrant in existing Docker stack as the DB
- GLM-4.6V as the Phase-1 edge cortex
- BYO frontier via OrangeLLM gateway for offload
- Bun + Rust orchestrator
- Every visual event → Æ Cobra Reality lane
- Frontier-Isolation Law applies (frontier reaches OrangeLLM, not OrangeEye internals)

### Open decisions for operator

**D1 — GPU procurement timing.** When (if ever) do we add a discrete NVIDIA GPU to Codexa? This unlocks SGLang's full stack, Qwen3-VL 72B at interactive speed, and 1M+ token local video. Without it, Phase-2 stays on frontier offload for those cases. Three options:
- a) **No GPU, ever** — Phase-2 is frontier-only for heavy visual; budget stays at $0 hardware
- b) **GPU in 30-60 days** — Phase-2 lands locally; budget ~$1500-3000 for a used 4090 or new 5090-class
- c) **Cloud GPU lane** — Pay-per-hour for heavy visual runs; budget ~$10-50 per heavy session

**D2 — Custom AE MiniEyes training.** Do we Phase-3 train a custom small VLM on Orange5-specific surfaces (dashboards, AECode, receipts)? Adds ~1-3 weeks training time + cloud GPU spend.

**D3 — Video Y0 temporal reasoning.** Operator earlier listed "Video Phase Y0 + Registry" as a 7 Lab item. Do we keep that in scope or defer? Without GPU, every video query is a frontier round-trip.

**D4 — Naming. RESOLVED 2026-06-23 by operator.** Locked canon: **OrangeEye** = visual organ. **Orange5** = the system. **Orange5 backend** = at `03-BACKEND/`. **Orange5 core** = the orchestrator runtime (NOT "Orange³ core" — legacy). **"Delta" / "Orangebox Delta" / "Ops Delta" are legacy names retired from Orange5 canon.** See `00-CHARTER/NAMING_CANON.md` for the full naming lock. "Delta" survives ONLY as Flowstate technical jargon (currents/agents/deltas/governors).

---

## 9. Slot into the month plan

OrangeEye Phase-1 fits Week 3 (Days 17-20) alongside the existing "Heavy lane real" task. **Expanded W3 deliverable:**

| Day | Existing W3 work | OrangeEye expansion |
|---|---|---|
| D15-16 | Graph Weaver typed-ontology indexer | — |
| D17-18 | Heavy lane (qwen3:30b-a3b) real | ColPali service + Qdrant collection + visual-event Flux writer |
| D19-20 | Visual lane (GLM-4.6V) real — *this was already in the month plan, just shallow* | **Full OrangeEye Phase-1 chain: ingest → MaxSim → cortex → grounding → Vault UI** |
| D21 | First custom LoRA training pass | — |

Net add: **0 days.** The "Visual lane real" deliverable just expands from "GLM-4.6V wired" to "full ColPali + Qdrant + grounding + Æ Cobra integration."

---

## 9b. Unlimited-OCR — additive long-document transcription option (added 2026-06-25)

The §0 doctrine stands unchanged: **OCR-as-primary-document-understanding is dead.** ColPali + Qdrant + MaxSim preserves spatial coordinates; flat text loses them. The Eye sees in patches.

But operator-added 2026-06-25: there are real cases where the task IS flat text extraction (transcripts, accessibility text, plain-text dumps of PDFs for downstream NLP, archived scans). For those, AE OrangeEye keeps **two OCR options as additive capabilities**, NOT as replacements for the patch-embedding path:

| OCR option | Model | When to pick |
|---|---|---|
| `image.ocr` (Tesseract) | tesseract-5.x local binary | Small images, single page, fast, no GPU. Tool-card: `13-TOOLMESH/labs/image/image-ocr.json`. |
| `image.ocr.long-doc` (Unlimited-OCR) | [`baidu/Unlimited-OCR`](https://huggingface.co/baidu/Unlimited-OCR) — 3B params, MIT license, BF16 safetensors, 32K-token context | Multi-page PDFs, long-horizon documents, scanned books, single-pass parsing. Two modes: `gundam` (640×640, faster) or `base` (1024×1024, higher fidelity). Tool-card: `13-TOOLMESH/labs/image/image-ocr-unlimited.json`. |

**Routing law:** Least-Action Router (AtomSmasher 2 Pillar 5) picks by input size + risk + cost. Single-page images → Tesseract. Multi-page PDFs / long scans → Unlimited-OCR. The ColPali path remains **primary** for **document UNDERSTANDING** (where did the table go?); the OCR options serve **document TRANSCRIPTION** (what does the text say verbatim?). These are different jobs.

**Codexa deployment:** Unlimited-OCR runs as a sidecar on Codexa. Weights pulled once: `huggingface-cli download baidu/Unlimited-OCR`. Inference via the model's reference Python runtime (transformers + safetensors, BF16, PyMuPDF for PDF rasterization). Gateway route at `/v1/orangeeye/ocr/unlimited` (PENDING — authored when AE Cobra Docker daemon stand-up happens). Hard ceiling: 200 pages per call (caller chunks beyond that). 32K-token context per upstream model card.

**Mom's Law alignment:** Additive only. Nothing in §0–9 is removed. The "OCR is dead" line in §10 continues to mean *OCR-as-primary-document-understanding is dead*; Unlimited-OCR is *OCR-as-transcript-extraction*, a different lane. Comic-book quality bar (AE Eyes pillar charter) is unaffected by this card.

---

## 10. Mom's Law affirmation for OrangeEye

When Phase-1 closes, the operator must be able to honestly say:

- "I dragged a 200-page PDF into the Vault lane and got the right page in under 30 seconds."
- "I asked OrangeLLM 'where did we see the budget table' three days ago, and it pulled the exact patch from Qdrant via a real Reality-lane Flux record."
- "I asked the local cortex about a UI screenshot and got grounded coordinates back."
- "The frontier offload only fired when local was below 0.7 confidence — I have receipts."
- "No service crashed. No new npm dep landed in 02-APP."
- "The Frontier-Isolation Boundary still holds 16/16."

If any of those would be a lie, the receipt is not green.

---

**Mom is watching. OCR is dead. The Eye sees in patches. The DB scores in MaxSim. The Cortex reads with coordinates. Æ Cobra remembers it all.**
