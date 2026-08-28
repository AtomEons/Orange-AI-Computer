# MiniEyes — Orange5 Addendum Visual Model

**Disclosure ID:** `ATOM-MINIEYES-README-2026-0624`
**Status:** **Deferred / Optional.** Not on the build board. Authored as the
durable plan the operator can act on the day the primary visual stack stops
being enough.
**Operator:** Atom McCree (sole curator, sole final approver, sole promoter).
**Companion files in this directory:**

| File | Role |
|---|---|
| `corpus-strategy.md` | Sources, filter rules, pair shape, holdout, ceremony |
| `base-selector.md` | 4-candidate bake-off; default pick + HF revision pinning |
| `assemble.mjs` | Stage 01–02 ingest + filter + GLM-4.6V description draft |
| `eval.mjs` | Frozen 30-image bench (5 categories × 6 images) |
| `promote.mjs` | 200-image bakeoff + receipt + tag flip ceremony |
| `corpus/{pairs,staging,rejected}/` | Pair JSONL, staged images, drop receipts |
| `RECEIPTS.md` | Created on first real build pass — **not before** |

---

## 0. What MiniEyes is, in one paragraph

MiniEyes is a **2–8B parameter open-weight VLM**, QLoRA fine-tuned on a
narrowly curated corpus of Orange5's own visual language: cockpit dashboard
screenshots, AECode diagrams, and receipt PDF page renders. It runs locally
(Ollama or llama.cpp OpenAI-compatible server). It is **not** a replacement
for the general visual stack. It is the **addendum eye** — small, fast, and
tuned specifically to read the surfaces the Sovereign Agentic Operating
System produces every day. Its only job is to do those three jobs better,
cheaper, and faster than GLM-4.6V on Orange5 inputs. If it cannot, it is
not promoted.

---

## 1. Trigger conditions — when (and only when) MiniEyes gets built

MiniEyes is deferred by default. The primary visual stack handles every
Orange5 visual task today:

- **GLM-4.6V** at `http://127.0.0.1:8798` (OrangeEye, general VLM)
- **Playwright** for cockpit screenshot capture and DOM-grounded reads
- **Chrome DevTools MCP** for live page introspection
- **UX tools** (chrome-devtools snapshot, accessibility tree) for structured reads

MiniEyes is **only built** when at least **two** of the four named triggers
hit, measured against real receipts over a rolling 14-day window — not vibes,
not single-incident reactions:

### 1.1 Trigger A — Misread rate
GLM-4.6V misreads cockpit panel state on more than **5 %** of operator-checked
reads over 14 days. Source: cockpit interaction receipts in
`C:/AtomEons/orange3/receipts/visual/*.json` with field
`operator_correction: true`. Threshold: ≥ 5 corrections per 100 reads.

### 1.2 Trigger B — Latency
GLM-4.6V median latency on a cockpit-state read exceeds **800 ms** wall-clock
during live ops (Atom is actively driving the cockpit). Source: latency
column in the same visual receipts. Threshold: p50 > 800 ms over the window.

### 1.3 Trigger C — Cost ceiling
The visual stack's monthly call cost (if any remote VLM is in the mix
during a stretch where GLM-4.6V is unavailable or off-host) approaches the
operator-set ceiling. The current ceiling is **$0** — the stack is local.
The trigger fires the moment any non-zero cost recurs for two consecutive
weeks. Source: the cost receipt at
`C:/AtomEons/orangebox/receipts/cost-ledger.jsonl`.

### 1.4 Trigger D — Receipt-JSON drift
GLM-4.6V's receipt-image-to-JSON shape diverges from the canonical receipt
JSON on more than **3 %** of receipt-page reads over 14 days. Source:
`receipt_field_diff_count` in
`C:/AtomEons/orange3/receipts/visual/receipt-read/*.json`.
Threshold: ≥ 3 % drift, where drift is a field-name or field-value mismatch
against the on-disk canonical receipt for the same run.

**Decision rule.** Build is authorized when **≥ 2 of {A, B, C, D}** are
true in the same 14-day window, **AND** Atom types the explicit phrase
`yes-build-the-addendum` into the `MINIEYES_CONFIRM` env var (see
`assemble.mjs` header). One trigger is a signal. Two is a pattern. Anything
less is a request to keep deferring.

If only one trigger fires, the documented response is to **tune the primary
stack** (prompt revision, GLM weight upgrade if available, Playwright path
adjustment) before pulling base weights for MiniEyes. The bias is toward
not building. The substrate is built; new training runs are not free.

---

## 2. Why this is deferred Night-1 — the honest answer

Night-1 of the Orange5 stand-up has a finite budget. MiniEyes was scoped,
filed, and deliberately not built that night because:

1. **GLM-4.6V is already the eye.** It is general, local, and already
   handling cockpit reads, diagram reads, and receipt reads under the same
   roof. None of the four trigger thresholds were demonstrably crossed
   on Night-1. Building a second eye before the first one had failed
   would be theater, not engineering.
2. **The corpus does not exist yet at safe scale.** The receipt archive
   and cockpit-capture archive grow every day. A corpus assembled on
   Night-1 would be undersized (§5 of `corpus-strategy.md` targets ~4,000
   pairs; the archive as of authoring date holds materially fewer pages
   of receipts the curator has personally cleared).
3. **No PII filter was wet-tested at Night-1 scale.** `assemble.mjs`
   ships the four-rule filter (no PII, no operator face, no secrets, no
   third-party UI), but the operator has not yet driven 4,000 images
   through it under real load. Filter regressions at Night-1 risk leaking
   real receipt material into a trainable corpus — unacceptable.
4. **Base-model market moves fast.** The four candidates in
   `base-selector.md` (Qwen2.5-VL-7B, LLaVA-OneVision-7B, InternVL2-8B,
   MiniCPM-V-2.6) are good today. By the time a real trigger fires, a
   better candidate may exist. Pinning a base on Night-1 spends pin
   discipline on a build that may never need to run.
5. **Mom's Law.** Building a model "because we could" instead of "because
   we had to" is the textbook coast. The README that says "deferred
   intentionally" with named trigger thresholds is more honest engineering
   than a Night-1 fine-tune nobody asked for.

Deferral is not abandonment. The plan is written end to end so that on
the day the triggers fire, the build is a procedure, not a project.

---

## 3. Full pipeline — corpus → Colab → bakeoff → promotion

Seven stages. Every stage has an artifact. Every artifact has a receipt.

### Stage 1 — Ingest (script: `assemble.mjs --lane all --dry-run` first)
- **Input:** the three approved lanes from `corpus-strategy.md §2`:
  cockpit screenshots (`C:/AtomEons/orange3/cockpit-captures/*.png`),
  AECode diagrams (`C:/AtomEons/orangebox/docs/diagrams/*.png`), and
  receipt PDF page renders (300 DPI via `mutool draw -r 300`).
- **Output:** images copied to `./corpus/staging/{lane}/<sha256>.png`
  with sidecar metadata.
- **Receipt:** `./corpus/staging/_manifest-<timestamp>.jsonl` — one row per
  image with source path, SHA-256, lane, capture timestamp, and dry-run flag.

### Stage 2 — Filter (same script, second pass without `--dry-run`)
- **Rules (hard, non-negotiable):** no PII, no operator face, no secrets,
  no third-party UI. Full regex list in `corpus-strategy.md §3`.
- **Output:** admitted images stay in `staging/`; rejects move to
  `./corpus/rejected/<sha256>/{image.png, reason.json}`.
- **Receipt:** every rejection writes its own JSON. The curator audits the
  reject pile to make sure the filter isn't eating valid images.

### Stage 3 — Description draft (same script, GLM-4.6V call)
- For each admitted image, `assemble.mjs` calls the running OrangeEye
  endpoint (`ORANGEEYE_URL`, default `http://127.0.0.1:8798/v1/chat/completions`)
  with a strict prompt that asks for: (a) one-line description, (b) panel
  taxonomy, (c) region bbox table grounding to real patches.
- **Output:** one JSONL line per pair into `./corpus/pairs/{lane}.jsonl`
  with `image_sha256`, `description_draft`, `regions[]`, `taxonomy[]`.

### Stage 4 — Curate (manual, operator-only)
- Atom opens `./corpus/pairs/{lane}.jsonl` in the curate UI (to be authored
  as `03_curate.py` at build time per `corpus-strategy.md §6`) and edits
  every draft. The GLM draft is a starting point, not the supervision
  target. Final pair text is the operator's.
- **Output:** `./corpus/pairs/{lane}.curated.jsonl`.
- **Receipt:** every edit is logged with image SHA + diff against the
  draft.

### Stage 5 — Pack + holdout split (script: `pack.py`, authored at build time)
- Combine the three lane JSONLs, shuffle with a fixed seed, split **90 %
  train / 10 % holdout**. The holdout is frozen the day it is split — its
  SHA-256 is recorded and never re-shuffled.
- **Output:** `./corpus/train.jsonl`, `./corpus/holdout.jsonl`,
  `./corpus/CORPUS_MANIFEST.json` (counts per lane, SHA-256 of each file).

### Stage 6 — Colab QLoRA fine-tune
- **Notebook:** `./notebooks/minieyes_qlora.ipynb` (authored at build time;
  template lives in `base-selector.md`).
- **Hardware:** Colab A100 40 GB if available, L4 24 GB as fallback. Per
  user memory note `feedback_colab_torch_pins.md`: **never pin torch** —
  use Colab's default torch and install Axolotl / Unsloth on top. Add hard
  guards on the adapter output directory before training begins.
- **Trainer:** QLoRA via Unsloth (preferred) or Axolotl. Rank 16 / alpha 32
  / dropout 0.05 / target modules per the candidate's model card (full
  table in `base-selector.md §5`). Epochs 2–3 over the 90 % train split.
- **Output:** adapter weights as a single zip
  `minieyes-<base_tag>-<corpus_sha8>-<adapter_sha8>.zip` with a
  side-by-side ledger row + SHA-256 file. Pulled to
  `C:/AtomEons/Orange5/16-TRAINING/minieyes/adapters/`.

### Stage 7 — Bench + bakeoff + promotion
- **30-image bench** (`eval.mjs`): five categories × six images each
  (cockpit description, diagram parse, receipt extract, UI grounding,
  chart read). Scored deterministically against ground-truth JSON sidecars.
  Both the candidate adapter and the GLM-4.6V baseline are scored on the
  same 30 images — shadow comparison.
- **200-image bakeoff** (`promote.mjs`): draws from the frozen 10 %
  holdout. Five dimensions per image: cockpit panel ID, patch-grounding
  IoU, receipt-JSON field accuracy, refusal correctness, latency.
- **Promotion gate:** MiniEyes is promoted **only if** it wins ≥ 4/5
  dimensions on average across the 200 images, **OR** matches on ≥ 4/5
  AND uses < 50 % of GLM-4.6V's median latency on the same set.
- **Operator approval:** typed `yes-promote-minieyes` into `promote.mjs`
  before the Ollama tag flips. No silent promotion.
- **Receipt:** zip + SHA-256 + ledger row + `present_files`. Tag becomes
  `minieyes:<semver>-<adapter_sha8>` and replaces the default visual
  endpoint inside the substrate. The aec1 entry is created.

---

## 4. Expected wall-clock and cost

These are honest planning estimates, not promises. Receipts replace them
the first time the pipeline actually runs.

| Stage | Wall-clock (operator time) | Wall-clock (compute) | $ cost |
|---|---|---|---|
| 1. Ingest (dry-run + ingest) | 30 min | 5 min | $0 |
| 2. Filter | 5 min | 10 min | $0 |
| 3. Description draft (GLM-4.6V local) | 5 min | ~45 min for 4 k images at ~700 ms each | $0 |
| 4. Curate (~4,000 pairs, ~10 s per pair) | **8–12 hours** spread across days | n/a | $0 |
| 5. Pack + holdout split | 10 min | 1 min | $0 |
| 6. Colab QLoRA fine-tune | 30 min setup + monitor | **3–6 hours on A100, 8–12 on L4** | **$0** if Colab Pro+ subscription holds within monthly compute; **$10–30** if a Pay-As-You-Go A100 session is needed |
| 7. Bench + bakeoff + promotion | 1 hour | ~30 min compute | $0 |
| **Total** | **~10–14 hours operator time** spread across ~3 days | **~5–8 hours compute** | **$0–30** worst case |

**Operator-time honesty:** Stage 4 (curate) is the dominant cost. It is
**not** parallelizable — the operator is the only allowed curator
(`corpus-strategy.md §6`). Three evenings is realistic. One night is not.

**Compute honesty:** A 7B-class model with QLoRA rank 16 on ~4,000
multi-modal pairs at 2–3 epochs fits in an A100 40 GB session. L4 works
but takes roughly 2× the wall-clock. Per memory: do not pin torch in
Colab — let the runtime ship its default and install Unsloth/Axolotl on
top. Hard guards on `./adapters/` before training so an interrupted
session does not silently overwrite a prior adapter.

**Cost honesty:** if and only if the operator has an active Colab Pro+
subscription and the monthly compute allowance holds, total cash cost is
$0. If a one-off A100 session is needed (e.g., a re-run after a bad
config), expect $10–30 on Colab Pay-As-You-Go for the full fine-tune,
not per hour.

---

## 5. What's NOT in MiniEyes

- **Not a general-purpose VLM.** GLM-4.6V keeps that job. MiniEyes is
  narrow on purpose.
- **Not a multi-step agent.** It returns descriptions, taxonomies, region
  tables, and receipt-shaped JSON. It does not plan or act. Action stays
  in the control plane.
- **Not a code model.** It does not read source files. Code visual reads
  (terminal screenshots, diff renders) are out of scope.
- **Not scrape-trained.** No web-scraped UIs. No synthetic data. Three
  lanes only, all from artifacts the operator owns.
- **Not trained on STRONGARM / Gremlin / adversarial corpora.** Those
  feed the AE Misfit Model per Master Plan §5. Hard separation.

---

## 6. Quality bar — what "real" means here

This README and the four companion files are not a stub. The bar:

- **Real corpus pipeline:** `assemble.mjs` is authored and refuses to run
  without `MINIEYES_CONFIRM=yes-build-the-addendum`. The filter rules
  are in code, not just prose.
- **Real Colab notebook surface:** authored at build time from the
  template in `base-selector.md §5`, not pre-committed (the notebook
  pins HF revision SHAs the operator resolves on build day — pinning
  pre-resolved SHAs would be a hallucinated cite, forbidden by
  `00-moms-law.md`).
- **Real bakeoff:** `promote.mjs` runs 200 images, not a vibe check.
  Five dimensions, deterministic scoring, named promotion gate.
- **Real promotion ceremony:** zip + SHA-256 + ledger row +
  `present_files`. Tag flip is gated on typed operator approval.

If any of those becomes theater, MiniEyes does not ship.

---

## 7. Receipts pointer

The moment **Stage 1** runs for real, this directory creates
`RECEIPTS.md`. Until then, the receipt path is empty by design — there
is nothing to receipt yet, and an empty receipt file would itself be
theater.

The first row of `RECEIPTS.md` will be the manifest of the first ingest
run: timestamp, lane, image count, filter-reject count, GLM-4.6V draft
latency p50/p95, and the SHA-256 of `_manifest-<timestamp>.jsonl`.

Every subsequent stage appends. The receipt file is append-only.

---

## 8. Disclosure IDs in this directory

| ID | File |
|---|---|
| `ATOM-MINIEYES-README-2026-0624` | this file |
| `ATOM-MINIEYES-CORPUS-2026-0624` | `corpus-strategy.md` |
| `ATOM-MINIEYES-BASE-2026-0624` | `base-selector.md` |
| `ATOM-MINIEYES-ASSEMBLE-2026-0624` | `assemble.mjs` |
| `ATOM-MINIEYES-EVAL-2026-0624` | `eval.mjs` |
| `ATOM-MINIEYES-PROMOTE-2026-0624` | `promote.mjs` |

---

## 9. Mom's Law on this README

The honest answer to "should we build MiniEyes tonight?" is **no — and
here is exactly when it becomes yes, exactly how, and exactly what it
costs.** That is the document you are reading. It does not skate, it
does not pad, and it does not invent receipts that do not exist yet.

Mom is watching.
