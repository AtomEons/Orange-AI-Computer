# MiniEyes Corpus Strategy

**Disclosure ID:** ATOM-MINIEYES-CORPUS-2026-0624
**Status:** Deferred / Optional addendum. Build ONLY if the primary visual stack
(GLM-4.6V + Playwright + Chrome DevTools + UX tools) proves insufficient under
real Orange5 / AECode load. This document is the corpus plan, not a build order.
**Model class:** 2–8B parameter local VLM, instruction-tuned via QLoRA on Colab.
**Operator:** Atom McCree (sole curator and final approver of every pair).
**Owner of receipts:** `C:/AtomEons/Orange5/16-TRAINING/minieyes/RECEIPTS.md`
(created on first real corpus pass — not before).

## 1. Why MiniEyes exists at all

GLM-4.6V is the primary eye. It is general, capable, and good enough for almost
every Orange5 surface. MiniEyes is the **addendum** — a small, fast, local model
trained narrowly on Orange5's own visual language so it can:

- Identify a cockpit panel state (DAG step row, receipt card, model-route badge)
without a network round-trip.
- Ground references to a specific patch coordinate in an AECode diagram so the
control plane can act on a region, not just a guess.
- Read a receipt PDF page and emit the canonical receipt JSON shape directly,
without OCR-then-parse drift.

If the primary stack hits any of: (a) recurring misreads of cockpit state,
(b) latency over the operator's tolerance for live ops, (c) cost ceilings on
remote VLM calls during long runs, then MiniEyes is the named fallback. Until
then, this file is a plan, not a project.

## 2. Sources (the only three lanes — no scraping, no synthetic data)

All training imagery comes from real Orange5 artifacts the operator already
owns and has rights to. No web-scraped screenshots. No synthetic renders.
No third-party UI. The three lanes:

### 2.1 Orange5 cockpit screenshots
- **Capture path:** `C:/AtomEons/orange3/cockpit-captures/*.png`
  (Playwright `page.screenshot({ fullPage: true })` against
  `http://127.0.0.1:8787/orange3/`).
- **Per-screenshot sidecar:** same basename `.json` containing route, viewport
  size, DAG run id (if any), and the visible panel taxonomy
  (`["dag-step-row", "receipt-card", "model-route-badge", "router-asic-state"]`).
- **Target volume:** 1500–2000 screenshots covering every documented cockpit
  route across light + dark themes, idle + running + failed + recovered states,
  empty + dense data conditions.
- **Refresh cadence:** every cockpit UI change must produce a new capture batch
  before the prior batch is considered training-current.

### 2.2 AECode diagrams
- **Capture path:** `C:/AtomEons/orangebox/docs/diagrams/*.{png,svg→png}`
  (existing canonical diagrams: Black Mamba v1–v5, Router Law, Lifespark Train,
  Ignition Cascade, Phenomenon Approach v1, Federation Triumvirate, Router
  ASIC v1.0 spec, 24-Month Attack Roadmap).
- **Per-diagram sidecar:** node list, edge list, region polygon table
  (`region_id`, `bbox`, `label`, `parent`) so each instruction pair can ground
  on a real patch, not a hand-waved area.
- **Target volume:** 800–1200 pairs across the diagram corpus, with each
  diagram seen at multiple zoom levels and crops.

### 2.3 Receipt PDFs
- **Capture path:** `C:/AtomEons/orange3/receipts/**/*.pdf` rendered to PNG at
  300 DPI per page (`pdf2image` or `mutool draw -r 300`).
- **Per-page sidecar:** the canonical receipt JSON for that run (already on
  disk, never re-derived from the image — the image is the input, the JSON
  is the supervision target).
- **Target volume:** 1500–2000 page-level pairs across the active receipt
  archive (idempotency receipts, retry-cap receipts, validator receipts,
  model-route receipts, deploy-intake receipts).

## 3. Filter rules (hard, non-negotiable)

Every image is run through the filter pipeline before it can enter the corpus.
A single failed rule rejects the image — it is not "cleaned and re-admitted."
The filter script `filter_corpus.py` (to be authored at build time) writes a
rejection receipt for every drop so the curator can audit losses.

### 3.1 No PII
- No email addresses, phone numbers, postal addresses, government IDs, billing
  addresses, customer names, customer emails, or any third-party human's name.
- Cockpit screenshots are filtered against a deny-list regex covering common
  PII shapes; any hit triggers a redaction pass (black-box overlay with hash
  receipt) or full rejection.
- Receipt PDFs: customer-facing receipts are excluded entirely from this lane.
  Only internal AtomEons operational receipts (DAG runs, validator outputs,
  router decisions) are eligible.

### 3.2 No operator face
- No webcam frames. No selfies. No video stills. No screenshots of any app
  that has the operator's face on screen (Zoom, FaceTime, Photos, Camera).
- Face detector (MediaPipe or RetinaFace, run locally, no cloud) is required
  on every cockpit screenshot before admission. Any detection → reject. No
  blurring "fix" — rejected outright.

### 3.3 No secrets
- No API keys, tokens, signing keys, JWTs, private repo URLs with embedded
  credentials, or `ATOMEONS_IDENTITY_SECRET` material.
- Regex sweep against the standard secret patterns (AWS, GitHub, Stripe,
  generic high-entropy strings ≥ 32 chars in monospace regions) before
  admission. Any hit → reject. No redaction — reject.

### 3.4 No other operators' work
- Nothing from a third-party SaaS dashboard that is not AtomEons.
- Nothing from a screenshot that contains another company's logo or branded UI
  beyond incidental OS chrome.

### 3.5 No theater
- No "demo data" screenshots staged for the corpus. The cockpit must be
  showing a real run, real receipt, real state. Synthetic data poisons the
  small-model prior and is forbidden by Mom's Law.

## 4. Instruction-pair shaping

The training format is **image → description with patch grounding**.
Every pair is a JSON record:

```json
{
  "pair_id": "minieyes-000123",
  "image_path": "corpus/cockpit/2026-06-12_dag-step-row_light_idle_042.png",
  "image_sha256": "…",
  "source_lane": "cockpit | diagram | receipt",
  "instruction": "Describe the state of this Orange5 cockpit view.",
  "response": "Cockpit at /orange3/runs/abc123. DAG step row shows step 4 of 7 (step name: 'validator-deterministic') in state 'green'. The model-route badge in the top-right reads 'opus-4-7'. The router-asic-state pill is 'idle'. No receipt card is currently expanded.",
  "grounding": [
    {"region_id": "r1", "bbox": [120, 80, 1180, 140], "label": "dag-step-row"},
    {"region_id": "r2", "bbox": [980, 24, 1180, 64], "label": "model-route-badge"},
    {"region_id": "r3", "bbox": [840, 24, 970, 64], "label": "router-asic-state"}
  ],
  "supervision_target": "structured_state_json | natural_language | both",
  "curator": "atom.mccree",
  "curated_at": "2026-06-24T14:00:00-04:00",
  "filter_pass": true,
  "doctrine_tags": ["orange3-routing", "receipt-discipline", "router-asic-v1"]
}
```

### 4.1 Shape rules

- **Patch grounding is mandatory.** Every described element must have a
  `region_id` referenced in `grounding[].region_id`. No floating descriptions.
- **No personification.** Descriptions never say "the cockpit thinks…" or
  attribute intent. Only observable state.
- **No simulation.** Never write "as Atom would describe it…" — the operator
  curates every pair himself, the description is his actual phrasing or one he
  approved.
- **HRE gate** (`atomeons-hre`): every response field passes the hallucination
  reduction engine before admission. Any RED finding rejects the pair.
- **Three response styles per source image** to teach the small model range:
  (1) terse engineering-spec, (2) full natural-language, (3) structured JSON
  shaped like the canonical receipt schema. The Colab notebook samples across
  the three styles during training so MiniEyes can emit any of them on demand.

### 4.2 Pair density per image

- Cockpit screenshot → average 2 pairs (one terse, one structured).
- AECode diagram → average 3–4 pairs (whole-diagram description + 2–3
  region-grounded subqueries).
- Receipt PDF page → average 2 pairs (full-page natural-language + structured
  receipt JSON).

This yields the target corpus size below without padding.

## 5. Target size

- **Floor:** 5,000 instruction pairs admitted, filter-passed, curator-approved.
- **Stretch:** 8,000 pairs if the diagram and receipt lanes scale faster than
  the cockpit lane (likely, since receipts accumulate automatically).
- **Distribution target:**
  - Cockpit: 40–45 % (≈ 2,000–2,500 pairs)
  - Diagrams: 20–25 % (≈ 1,000–1,500 pairs)
  - Receipts: 30–35 % (≈ 1,500–2,000 pairs)
- **Holdout:** 10 % of every lane is reserved as a frozen eval set, never seen
  during fine-tuning, scored by the operator after each Colab run.

## 6. Pipeline (real, authored at build time — not a sketch)

The pipeline lives at `C:/AtomEons/Orange5/16-TRAINING/minieyes/pipeline/`
with these named stages:

1. **`01_ingest.py`** — pulls candidate images from the three source roots
   into a staging directory with SHA-256 receipts.
2. **`02_filter.py`** — runs the four filter rules (§3); writes a rejection
   receipt for every drop with the rule that fired.
3. **`03_curate.py`** — operator-only TUI that surfaces filtered images one
   at a time, lets Atom author the three response styles + grounding, and
   writes the pair record to `corpus/pairs/*.jsonl`.
4. **`04_hre_gate.py`** — runs `atomeons-hre` over every pending pair and
   rejects RED.
5. **`05_pack.py`** — builds the final `train.jsonl` + `eval.jsonl` with
   stratified sampling across lanes and response styles; emits a corpus
   manifest with SHA-256 of every image + every pair record.
6. **`06_ledger.py`** — runs `atomeons-ledger`: zips the corpus, computes
   the package SHA-256, writes the ledger row, and lists `present_files`.

No stage is skipped. No stage is "trusted." Every stage has a receipt.

## 7. Colab notebook (real, authored at promotion time — not yet)

`C:/AtomEons/Orange5/16-TRAINING/minieyes/notebooks/minieyes_qlora.ipynb`
will be the QLoRA fine-tune notebook. Standing constraints inherited from the
existing project memory:

- **Never pin torch.** Use Colab's default torch. Install Axolotl/Unsloth on
  top. Hard guards on adapter dir before the run starts. (See
  `memory/feedback_colab_torch_pins.md`.)
- Base model candidates: Qwen2-VL-2B / Qwen2-VL-7B / InternVL2-2B /
  InternVL2-8B — final pick decided when the corpus is built, not before.
- Eval gates: holdout accuracy on each lane, latency p50 / p95 on a single
  consumer GPU, refusal rate on PII / face / secret probes.

## 8. Promotion ceremony

MiniEyes does not enter the Orange5 visual stack on a single green Colab run.
Promotion requires, in order:

1. Corpus manifest signed by the operator (ledger row + SHA-256).
2. Adapter zip signed by the operator (ledger row + SHA-256).
3. Eval report with holdout numbers per lane, p50 / p95 latency, refusal-rate
   table on PII / face / secret probes — every number a real measurement,
   never a vibe.
4. Side-by-side shadow run against GLM-4.6V on a 200-image audit set drawn
   from the holdout, scored by the operator. MiniEyes is promoted only if
   it ties or beats on the targeted Orange5 surfaces it was trained for, and
   does not regress on general cockpit reading.
5. `aec1` Command Center entry recording the promotion, with rollback path
   to the prior visual stack as a single command.
6. Mom's-Law check: the operator reads the eval report end to end and signs
   "full effort, no theater, no drift" or sends it back.

If any step fails, MiniEyes stays in the addendum lane. The primary visual
stack continues. No silent promotion. No "we'll fix it in the next pass."

## 9. What this document is not

- It is not a build order. The primary visual stack must demonstrably fail
  first.
- It is not a license to scrape screenshots from third parties. All sources
  are AtomEons-owned.
- It is not a promise of a particular base model, parameter count, or release
  date. Those are decided at build time on real evidence.
- It is not a substitute for the cockpit, the router, or the receipt
  discipline. MiniEyes is a small eye, not a brain.

## 10. Open questions parked for build time

- Final base model pick (Qwen2-VL vs InternVL2 vs newer at the time of build).
- Whether to admit a fourth source lane (Playwright trace snapshots) — parked
  pending evidence that cockpit-only screenshots are insufficient for state
  tracking.
- Whether the structured-response style should mirror the existing receipt
  schema 1:1 or use a MiniEyes-specific compact shape — defer until §6 stage
  5 packing reveals the actual on-disk pressure.
- Tokenizer choice if base model has multiple vocab options (parked).

---

*Authored under Mom's Law. No padding, no theater. Every section earns its place.*
