# AE Black Mamba Pretrain — Lane Authoring Receipt

- **Date:** 2026-06-25
- **Lane:** `16-TRAINING/ae-black-mamba`
- **Operator:** Atom McCree
- **Scope:** Author the AE Black Mamba pretraining lane — strategy, corpus pipeline, training config, Colab T4 notebook, GBNF alignment module, promotion bakeoff, post-Colab workflow, and lane README. No live training; no live model swap. Surrogate (`bartowski/mamba-2.8b-hf-GGUF`) remains the production resident at `/opt/atomeons/ae-cobra/models/ae-blackmamba-2.8b-Q5_K_M.gguf` until Phase-3 candidate clears the bakeoff.
- **Doctrinal anchors:**
  - `06-ORANGELLM/memory/ae-cobra/AE_COBRA_FOUNDATION_SPEC.md` (Pillar 1, Phase-3 swap; SSM ≠ transformer → LoRA refused)
  - `06-ORANGELLM/memory/ae-cobra/grammar/agent_turn.gbnf`
  - `06-ORANGELLM/memory/ae-cobra/schemas/agent-turn.schema.json`
  - `06-ORANGELLM/memory/ae-cobra/tests/smoke-100-pair.mjs` (single source of truth for bakeoff prompts)
  - `.claude/rules/03-build-and-receipts.md` (result / evidence / blockers / next action)
  - `.claude/rules/00-moms-law.md`

---

## 1. Components authored

| # | Component | Path | Lines |
|---|---|---|---|
| 1 | Lane strategy | `16-TRAINING/ae-black-mamba/strategy.md` | 295 |
| 2 | Corpus pipeline | `16-TRAINING/ae-black-mamba/pipeline.mjs` | 642 |
| 2a | Pipeline outputs (smoke) | `16-TRAINING/ae-black-mamba/corpus/{train.jsonl, val.jsonl, corpus-manifest.json}` | — |
| 3 | Training config | `16-TRAINING/configs/ae-black-mamba-v0.yaml` | 220 |
| 4 | Colab T4 notebook | `16-TRAINING/configs/ae-black-mamba-v0.ipynb` | 645 |
| 5 | GBNF alignment module | `16-TRAINING/ae-black-mamba/gbnf-alignment.mjs` | 1206 |
| 5a | Alignment artifacts | `16-TRAINING/ae-black-mamba/corpus/grammar-alignment/*.json` | — |
| 6 | Promotion bakeoff | `16-TRAINING/ae-black-mamba/promote.mjs` | 917 |
| 7 | Post-Colab workflow | `16-TRAINING/workflows/ae-black-mamba-v0.workflow.mjs` | 606 |
| 8 | Lane README | `16-TRAINING/ae-black-mamba/README.md` | 337 |

**Total authored: 8 components, ~5,168 lines of authored source (excluding generated JSON artifacts).**

---

## 2. Per-component notes

### (1) `strategy.md` — 295 lines
- Grounded in real Orange5 files (Foundation Spec lines 28/52-54/281/309/315/348/356/378-382, `agent_turn.gbnf`, `agent-turn.schema.json`, `corpus-manifest.json`).
- Sibling-consistent with `16-TRAINING/ae-misfit/corpus-strategy.md`.
- Nine elements: sources, corpus shaping, pretrain-vs-FT decision, GBNF alignment target, T4 feasibility math, surrogate→Black Mamba narrative, three-brain comparison, explicit out-of-scope, open items.
- Honest blockers: corpus at 48 rows (below 1,500 minimum), Flux empty, T4 OOM unverified empirically.

### (2) `pipeline.mjs` — 642 lines
- Zero-dep Bun/Node module. Walks Flux ledger (`reality.jsonl` + `thought.jsonl`) and `10-RECEIPTS/orange5-build/*.md`. Hand-written validator matches `agent-turn.schema.json` enums exactly (startup drift-check). Reuses writer's canonical-JSON algorithm bit-for-bit. Deterministic 90/10 split. Atomic tmp+rename writes.
- Refuses-to-emit-empty (exit 2). Reject histogram + first-50 locators in manifest.
- Smoke run: 48 receipts → 48 accepted → 42 train + 6 val. Deterministic SHAs. Flux empty handled cleanly.
- Env knobs: `ORANGE5_ROOT`, `AE_FLUX_ROOT`, `AE_BM_OUT`, `AE_BM_VAL_PERCENT`, `AE_BM_MIN_BYTES`, `AE_BM_INCLUDE_THOUGHT`.

### (3) `ae-black-mamba-v0.yaml` — 220 lines
- Base `state-spaces/mamba-2.8b-hf`, full-FT (LoRA refused — SSM has no transformer projection structure). T4 16GB budget worked out inline (~15.6 GB w/ ~400MB margin).
- Per-layer LR multipliers preserve state-spaces' eigenvalue init: `A_log` 0.1x, `D` 0.2x, `conv1d` 0.2x, `dt_proj` 0.5x, `x_proj` 0.5x, projections at base 5e-5.
- Cosine schedule, warmup 0.03, min_lr_ratio 0.1, fp16 forced (T4 sm_75 no bf16), `residual_in_fp32` non-negotiable.
- Fallback ladder: seq 1024 → 512 → A100. LoRA explicitly forbidden.

### (4) `ae-black-mamba-v0.ipynb` — 645 lines, 24 cells
- 12 markdown + 12 code. Faithful to the YAML spec.
- Hard guards: missing corpus (path-exact refusal), `mamba-ssm` import failure, weight total < 5 GB, fp16 GGUF < 4.5 GB, Q5_K_M < 1.5 GB.
- Auto-converts checkpoint → Q5_K_M GGUF via `llama.cpp convert_hf_to_gguf.py` + `llama-quantize`. Final receipt JSON with row counts, training metrics, weight shard SHA-256s, GGUF SHA-256.

### (5) `gbnf-alignment.mjs` — 1,206 lines
- Zero-dep module. Emits four hash-stamped artifacts: `grammar-states.json`, `token-mask.json` (skipped when tokenizer vocab unset → trainer falls back to char-level), `corpus-alignment.json`, `alignment-manifest.json` (full SHA-256 chain).
- Hand-written GBNF parser (rules, literals, char classes incl. negated, groups, `*+?{m,n}`, alternation, `#` comments). Left-recursion guard. Zero-width-loop guard.
- Soft constraint (λ=0.1) chosen over hard mask — hard masking prevents the model from learning *why* off-manifold tokens are off-manifold; strategy §6 measures **unconstrained** eval.
- **REAL FINDING SURFACED:** exit code 3 — corpus/grammar drift. 42 train + 6 val rows all failed grammar acceptance. Root cause: `pipeline.mjs canonicalJSON()` sorts keys alphabetically (`{"commands":[],"confidence":...`) but `agent_turn.gbnf` requires fixed key order (`lane, event_type, summary, ...`). Spawned `task_893c2202` with three resolution options (option C — separate grammar-ordered serialization while keeping alphabetical canonical for dedupe-hash — most likely correct). Mom's-Law-mandated non-zero exit prevents drift from silently entering Phase-3 training.

### (6) `promote.mjs` — 917 lines
- Bakeoff surrogate vs candidate. Reuses `smoke-100-pair.mjs` PROMPTS (single source of truth — bakeoff and G06 score the same surface). Sequential `llama-server` on port 7517 (separate from prod 7418). No `--mlock` during bakeoff (would lock surrogate bytes during candidate leg). No retries (production caller's 3-attempt budget would mask raw quality differences).
- Four metrics: `lane_classification_accuracy` (pre-override), `agent_turn_json_validity_rate`, `latency_mean_ms` (mean, not p95 — N=100 noisy tail), `rss_peak_mb` (sampled every 500ms via `/proc/<pid>/status`; null on non-Linux).
- Promotion rule: strict `>`, candidate must win `>=2`. `AE_BM_NO_PROMOTE=1` / `AE_BM_FORCE_PROMOTE=1` overrides honored.
- Swap mechanics: **copy not symlink** (prod uses `--mlock --no-mmap`); rename current → `<model>.surrogate.<utc>.bak`, copy candidate → `.promote.tmp.<utc>`, atomic rename. Script does **not** touch systemd — operator must `systemctl restart ae-cobra`.
- Exit codes: 0 promoted, 1 rejected, 2 setup error, 3 bakeoff aborted.
- `node --check` passed.

### (7) `ae-black-mamba-v0.workflow.mjs` — 606 lines
- Mirrors `orangellm-fatty-v0` and `minieyes-v0` workflow skeletons (same Workflow DSL: `phase`, `agent`, `parallel`, `log`, `meta.phases`).
- Six phases: **Gate → Retrieve → Bakeoff → Synthesize → HotSwap → Receipt**.
- Gate refuses unless documented Night-1 state holds (strategy.md, FOUNDATION_SPEC, grammar, schema, smoke prompts, promote.mjs, start.sh, corpus-manifest.json, surrogate present at `/opt/atomeons/ae-cobra/models/ae-blackmamba-2.8b-Q5_K_M.gguf`).
- Retrieve verifies GGUF magic `0x47475546`, `general.architecture==mamba`, Q5_K_M, load probe on port 7517.
- Bakeoff runs the four promote.mjs metrics + a separate strategy §6 alignment probe (unconstrained schema-validity ≥ 0.90).
- Synthesize applies promote.mjs gate (wins ≥ 2) **plus two Mom's-Law overrides**: hard regression block (>50% slower or >50% heavier downgrades 2-of-4 win to hold) + alignment override (unconstrained <90% → hold).
- HotSwap respects mlock+no-mmap: stop unit → atomic `ln -sfn` + `mv -T` → restart → re-run smoke at new boot → 5pp degradation triggers rollback. Records rollback target SHA-256.
- Receipt hash-chained against `10-RECEIPTS/orange5-build/`. Slug varies: `promoted` / `promoted-then-rolled-back` / `held` / `rejected`. `requires_operator_approval:true`, `risk_level: high`.

### (8) `README.md` — 337 lines
- Section 0 orientation: surrogate vs Phase-3 swap.
- Phase-3 Schism Engine dual-state relevance: reality vs thought lane, why surrogate produces shape-only dual-state and Black Mamba produces semantic.
- Base-vs-FT decision table (pretrain-from-scratch rejected, continue-pretrain chosen, SFT deferred, LoRA retired) with full T4 VRAM arithmetic (5.6 GB bf16 weights + 5.6 GB 8-bit AdamW state + grad checkpoint + batch 1 × accum 16 × seq 512).
- ASCII pipeline diagram: three sources → `pipeline.mjs` → train/val → Colab → llama.cpp Mamba GGUF Q5_K_M → `gbnf-alignment.mjs` → `promote.mjs` bakeoff → symlink flip.
- Expected T4 wall-clock 4–8h with per-phase breakdown.
- Seed-corpus snapshot from `corpus-manifest.json` with train/val SHA-256s.
- GBNF alignment target ≥ 90% unconstrained schema-validity.
- Blocker priority order, out-of-scope list, result/evidence/blockers/next-action close. Mom's Law footer.

---

## 3. Cross-component invariants verified

| Invariant | Where enforced | Status |
|---|---|---|
| LoRA refused for SSM | YAML (`adapter:null`), notebook, README, strategy.md | Consistent across 4 files |
| GBNF + schema enums match | `pipeline.mjs` validator + `gbnf-alignment.mjs` parser | Cross-check at startup |
| Bakeoff prompt source | `promote.mjs` imports `smoke-100-pair.mjs` PROMPTS | Single source of truth |
| Surrogate path | All workflow gate checks point to `/opt/atomeons/ae-cobra/models/ae-blackmamba-2.8b-Q5_K_M.gguf` | Consistent |
| Mlock+no-mmap respected | `promote.mjs` uses copy not symlink; workflow uses stop→flip→restart | Consistent |
| Hash-chained receipts | Workflow Phase 6 + this receipt | This receipt = link in chain |
| Mom's Law non-zero exits | `pipeline.mjs` exit 2 on empty, `gbnf-alignment.mjs` exit 3 on drift, `promote.mjs` exits 0/1/2/3 | All present |

---

## 4. Result / evidence / blockers / next action

### RESULT
AE Black Mamba pretraining lane authored end-to-end: strategy, corpus pipeline, training config, Colab notebook, GBNF alignment, promotion bakeoff, post-Colab workflow, and lane README. **No live training executed. No live model swap.** Surrogate remains production resident. Lane is ready for the Phase-3 Colab T4 run once corpus/grammar drift is resolved.

### EVIDENCE
- 8 components written to disk (paths and line counts in §1).
- `node --check` passed on `promote.mjs`.
- `pipeline.mjs` smoke run: 48 receipts → 42 train + 6 val, deterministic SHAs, empty-Flux handled cleanly.
- `gbnf-alignment.mjs` executed against the live grammar + 48-row seed corpus → surfaced real corpus/grammar drift (exit 3) → spawned `task_893c2202`.
- All 8 components cross-reference each other consistently (LoRA-refused, prompt source, surrogate path, mlock contract).
- Doctrinal anchors verified to exist (`AE_COBRA_FOUNDATION_SPEC.md`, `agent_turn.gbnf`, `agent-turn.schema.json`, `smoke-100-pair.mjs`, sibling `ae-misfit/corpus-strategy.md`).

### BLOCKERS
1. **Corpus/grammar drift (CRITICAL, blocks Phase-3 training start).** `pipeline.mjs canonicalJSON()` alphabetical key order ≠ `agent_turn.gbnf` fixed key order. Tracked in `task_893c2202`. Training on the current corpus would teach a JSON dialect the grammar rejects at inference.
2. **Flux empty.** Cobra not yet live on Codexa per receipt #017 preflight; reality.jsonl / thought.jsonl are empty. Pipeline handles cleanly but corpus is starved.
3. **Corpus below floor.** 48 rows vs 1,500 strategy minimum. Needs AgentTurn co-authoring session + Flux ingestion before serious training.
4. **T4 OOM not empirically verified.** Math says it fits (~400 MB margin); real Colab run will confirm.
5. **Eval prompt set not built** (separate from smoke-100-pair; needed for unconstrained-validity rate measurement against strategy §6 target).

### NEXT ACTION
1. Resolve `task_893c2202` (corpus/grammar drift). Most likely path: option C — separate grammar-ordered text serialization for training rows while keeping alphabetical canonical-JSON for dedupe hashing.
2. Re-run `pipeline.mjs` + `gbnf-alignment.mjs` — expect 48/48 grammar accept + exit 0.
3. Grow corpus toward 1,500-row floor via AgentTurn co-authoring + Flux ingestion (gated on Night-1 daemon).
4. Build the unconstrained-validity eval prompt set (separate from smoke-100-pair).
5. Execute Phase-3 Colab T4 full-FT run per `ae-black-mamba-v0.ipynb`.
6. Convert checkpoint to Q5_K_M GGUF.
7. Run `promote.mjs` bakeoff on Codexa. If exit 0, follow workflow HotSwap phase. Reserve 14-day rollback window per AE_COBRA_FOUNDATION_SPEC.

---

## 5. Doctrinal compliance

- **Mom's Law:** every component carries a hard non-zero exit on its specific failure mode; real corpus/grammar drift surfaced honestly via `gbnf-alignment.mjs` exit 3 instead of being papered over; blockers stated plainly above.
- **Completion law (`03-build-and-receipts.md`):** result, evidence, blockers, next action all present.
- **Release law:** lane is **not** release-promoted — surrogate remains resident, candidate gated behind bakeoff + workflow approval. No silent ceremony.
- **AE_COBRA_FOUNDATION_SPEC Pillar 1:** SSM full-FT chosen over LoRA across YAML / notebook / README / strategy — consistent rejection of LoRA on doctrinal grounds.
- **Workflow lane (`16-TRAINING/workflows/`):** `requires_operator_approval:true`, `risk_level: high`, hash-chained receipts.

---

## 6. Receipt chain pointers

- **Prior receipts referenced:** Night-1 spine, Foundation Spec lock, smoke-100-pair authoring (per workflow gate-phase lookup).
- **Successor receipts expected:**
  - `2026-MM-DD-ae-black-mamba-corpus-drift-resolved.md` (after `task_893c2202`)
  - `2026-MM-DD-ae-black-mamba-corpus-grown.md` (after corpus → 1,500 rows)
  - `2026-MM-DD-ae-black-mamba-colab-trained.md` (after Phase-3 Colab T4 run)
  - `2026-MM-DD-ae-black-mamba-bakeoff-{promoted|rejected}.md` (after `promote.mjs`)

---

*Authored under Mom's Law — full effort every line. No silent fall-back; the corpus/grammar drift surfaced by `gbnf-alignment.mjs` is named here at the top of the blockers list and routed to `task_893c2202` for resolution before any training byte moves.*
