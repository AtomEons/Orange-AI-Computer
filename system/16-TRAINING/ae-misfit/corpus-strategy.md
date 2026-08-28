# AE Misfit Model — Corpus Strategy

**Schema:** `orange5.ae-misfit.corpus-strategy.v0`
**Sovereign:** Atom McCree
**Doctrine source:** Operator directive 2026-06-23 (Receipt #032 retired STRONGARM + Gremlin from OrangeLLM-fatty corpus); operator directive authorizing reuse for AE Misfit only.
**Status:** STRATEGY — corpus assembly not started. This doc defines what gets built.

---

## 1. Why AE Misfit is trained SEPARATELY from OrangeLLM-fatty

| OrangeLLM-fatty | AE Misfit |
|---|---|
| Base: `qwen3:30b-a3b` | Base: `qwen2.5:7b-instruct` |
| Lane: steady, doctrine-grounded PM brain | Lane: adversarial pressure + refusal discipline |
| Corpus: doctrine, receipts, schemas, topology | Corpus: STRONGARM + Gremlin adversarial sets |
| Trained on cloud H100 (~$15-25) | Trained on **free Colab T4** (7B fits) |
| Role: routes work, emits `orange.report.v1` | Role: **second-opinion gate** before high-risk Hermes actions |
| Failure mode it must avoid: fabrication, schema drift | Failure mode it must avoid: getting talked into a bad refusal-skip |

**Receipt #032** (operator-authorized, 2026-06-23) retired STRONGARM Easy, Gremlin Elite 1000, Gremlin QA V1.1 (2000), Gremlin QA V1.2 (5000), and Gremlin Trainer V2.5 from the OrangeLLM-fatty corpus on the explicit grounds that those datasets are "too wild for the PM brain." Operator simultaneously authorized those datasets for THIS purpose only: a separate brain, AE Misfit, that complements OrangeLLM-fatty by carrying the adversarial load OrangeLLM-fatty was deliberately not asked to carry.

**Two brains, two corpora, one chain of trust.** AE Misfit fires AFTER OrangeLLM-fatty is solid (not before), as a gate, not a replacement.

---

## 2. Where AE Misfit lives in the call chain

```
operator intent
   ↓
9-Gate Stack (LBCE → Scope → Department → Triad → HRE → Security → Drift → Receipt → CHECKMATE)
   ↓
Hermes lease decision (low / medium / high risk)
   ↓
   ├─ low/medium  → OrangeLLM-fatty signs off → Hermes executes
   └─ high        → OrangeLLM-fatty signs off → **AE Misfit second-opinion gate** → Hermes executes
                                                       ↑
                                       AE Misfit is trained to look for:
                                       - fake-greens (OrangeLLM-fatty said yes too fast)
                                       - missed refusal triggers
                                       - adversarial framings that flipped the gate
                                       - scope drift hidden in "helpful" phrasing
```

AE Misfit is **not** in the hot path for routine work. It fires only when Hermes lease is high-risk (destructive ops, irreversible writes, money movement, identity changes, frontier branch promotion). The cost is one extra small-model call before the action; the gain is a sharp refusal-trained second opinion catching what the PM brain might have nodded through.

---

## 3. Source datasets (operator's archives — exact paths TBD)

These are the operator's pre-existing adversarial corpora, retired from OrangeLLM-fatty by Receipt #032 and authorized for AE Misfit:

| Dataset | Approx. size (operator-stated) | Character |
|---|---:|---|
| STRONGARM Easy (adversarial outputs) | TBD | Hard pressure prompts where the right answer is sharp refusal or sharp re-scoping. |
| Gremlin Elite 1000 | ~1000 | Curated adversarial pairs, highest signal. |
| Gremlin QA Dataset V1.1 | ~2000 | Broader adversarial QA. |
| Gremlin QA Dataset V1.2 | ~5000 | Latest adversarial QA. |
| Gremlin Trainer V2.5 | TBD | Trainer-format set (likely already instruction-tuned shape). |

**Exact paths:** TO BE FILLED by operator on corpus-assembly day. The operator's archives are the authoritative location; this doc does not guess. When paths land, they get appended to §3 and SHA-256 of each source file gets recorded in §10 (Receipts).

**Total raw rows available:** ~8,000+ before filtering. Target after curation: **500-1500 pairs**.

---

## 4. Filtering rules (what comes OUT before training)

Adversarial corpora carry collateral risk. Every row passes the following filter before being eligible for the training set.

### 4.1 Privacy scrubbing

| Filter | Action |
|---|---|
| Real names of non-public individuals | Replace with role tokens (`<OPERATOR>`, `<COUNTERPARTY>`, `<TEAM_MEMBER>`). |
| Email addresses, phone numbers, physical addresses | Replace with `<EMAIL>`, `<PHONE>`, `<ADDRESS>` tokens. |
| API keys, secrets, tokens, credentials | DROP the row entirely. Never tokenize and keep. |
| Operator's own PII (Marco Island, a.mccree@gmail.com, etc.) | DROP the row entirely. |
| Third-party proprietary content (verbatim copyrighted text > 50 words) | DROP the row. |
| Real receipt numbers or hashes referencing live AtomEons artifacts | DROP. AE Misfit must not memorize live audit chain. |

### 4.2 Quality filtering

| Filter | Action |
|---|---|
| Prompt or response < 20 chars | DROP. |
| Response is pure boilerplate ("I'm sorry, I cannot...") with no reasoning | DROP. Useless refusal — bad training signal. |
| Response contradicts AtomEons doctrine (Mom's Law, 27 Guardrails, Human Final Stop) | DROP. |
| Response would teach AE Misfit to bypass Gate 0 LBCE | DROP. |
| Response includes "as X would say…" simulation of real people | DROP. Violates anti-simulation rule (HRE doctrine). |
| Duplicate prompts (cosine similarity > 0.92 on prompt embedding) | DROP all but one. |
| Profanity or slurs not relevant to the adversarial signal | DROP. |
| Response contains hallucinated citations (specific case numbers, paper titles, statutes that don't exist) | DROP. HRE-RED. |

### 4.3 Safety floor (non-negotiable)

| Filter | Action |
|---|---|
| Any row that teaches the model to produce CSAM / weapons-of-mass-destruction synthesis / live-target social engineering against a named person | DROP. No tokenization, no transformation. The row does not exist. |
| Any row whose adversarial prompt is a real operational attack against a real system the operator does not own | DROP. |
| Any row where the "correct yield" answer would breach Hermes lease or violate Human Final Stop authority | DROP. |

These are not soft filters. A single row of the wrong kind contaminates a 1000-row corpus. **When in doubt, drop.**

---

## 5. Instruction-pair shaping

Output format (one JSONL row per pair):

```json
{
  "instruction": "<adversarial prompt or scenario>",
  "input": "<optional context / system state>",
  "output": "<correct response: either a refusal-with-reasoning or an adversarial-but-correct yield>",
  "label": "refusal" | "adversarial_yield",
  "source": "strongarm-easy" | "gremlin-elite-1000" | "gremlin-qa-v1.1" | "gremlin-qa-v1.2" | "gremlin-trainer-v2.5",
  "source_row_id": "<original row id in source dataset>",
  "filter_pass": ["privacy", "quality", "safety"],
  "doctrine_anchor": "<which AtomEons rule the correct response cites>"
}
```

### 5.1 Refusal pairs (60% of corpus)

The dominant signal. Train the model to refuse with reasoning, not boilerplate.

Shape:
```
instruction: "You are an AE Misfit gate. Hermes just leased a high-risk action: <action>. OrangeLLM-fatty
              signed off saying <approval reasoning>. Do you agree?"
output:      "<no, here's why — cite the doctrine rule, name the missed trigger, propose the corrected action>"
```

Refusal pairs must teach the model to:
- Cite the specific AtomEons rule that the proposed action breaches.
- Identify the specific gate that should have caught it (LBCE / Scope / Triad / HRE / Security / Drift / Receipt / CHECKMATE / Human Final Stop).
- Propose a corrected scoped-down version of the action when one exists.
- Refuse cleanly without performative hedging.

### 5.2 Adversarial-but-correct-yield pairs (40% of corpus)

The model must not become a knee-jerk refuser. 40% of the corpus is pairs where the adversarial framing is loud but the action is actually fine and the model should yield (with reasoning).

Shape:
```
instruction: "You are an AE Misfit gate. Hermes leased <action>. The framing of the request <looks scary
              because of X, Y, Z>. OrangeLLM-fatty signed off. Do you agree?"
output:      "<yes, here's why — X, Y, Z are not actual triggers because <reasoning>; the action respects
              <doctrine rule>; proceed>"
```

Adversarial-yield pairs teach the model to:
- Distinguish surface alarm from real risk.
- Cite the doctrine that makes the action OK.
- Avoid over-refusal that would block legitimate operator work.
- Stay aligned with the operator's actual intent, not the prompt's framing.

### 5.3 The 60/40 ratio (why not 50/50 or 80/20)

| Ratio considered | Why rejected |
|---|---|
| 50/50 | Too permissive — the model needs a refusal-leaning prior, since AE Misfit's job is to catch fake-greens that OrangeLLM-fatty already accepted. |
| 80/20 refusal-heavy | Too restrictive — produces a model that refuses everything, including legitimate operator work. Operator loses time fighting the gate. |
| **60/40 refusal-leaning** | Refusal is the primary signal, but the 40% adversarial-yield prevents brittle over-refusal. Matches the empirical refusal rate on a well-tuned constitutional gate. |

The 60/40 split is the **target ratio**, enforced at corpus-assembly time. Final corpus must show 600±50 refusal rows and 400±50 adversarial-yield rows (for a 1000-row corpus).

---

## 6. Target corpus size

| Tier | Rows | Use |
|---|---:|---|
| Minimum viable | 500 | First LoRA pass — proof the pipeline runs end-to-end on free Colab T4. |
| **Default target** | **1000** | First production AE Misfit adapter. |
| Stretch | 1500 | If 1000-row eval gauntlet shows weak refusal-recall in specific categories, expand into those categories up to 1500. |

Hard ceiling: **1500 rows**. Above this, free Colab T4 training time gets brittle (session timeouts), and the marginal signal per row drops. If 1500 is insufficient, the answer is better filtering, not more rows.

**Composition (default 1000-row target):**

| Source | Rows | % |
|---|---:|---:|
| STRONGARM Easy | 200 | 20% |
| Gremlin Elite 1000 | 300 | 30% |
| Gremlin QA V1.1 | 200 | 20% |
| Gremlin QA V1.2 | 200 | 20% |
| Gremlin Trainer V2.5 | 100 | 10% |
| **Total** | **1000** | **100%** |

Within each source, the 60/40 refusal/yield split is enforced.

---

## 7. Pipeline (mirrors OrangeLLM-fatty pipeline structure)

### Phase 0 — Source ingestion (local, no GPU)

```
operator confirms source paths in §3
   ↓
16-TRAINING/scripts/ingest-misfit-sources.mjs    # reads each source dataset
   ↓
16-TRAINING/ae-misfit/_tmp/raw-rows.jsonl        # union of all sources, untouched
   ↓
16-TRAINING/ae-misfit/_tmp/raw-rows.sha256       # checksum of raw input
```

### Phase 1 — Filtering (local, no GPU)

```
16-TRAINING/scripts/filter-misfit-corpus.mjs     # applies §4 filters
   ↓
16-TRAINING/ae-misfit/_tmp/filtered.jsonl        # rows that survived §4
16-TRAINING/ae-misfit/_tmp/drop-log.jsonl        # row + reason for every dropped row (audit trail)
```

Drop log is **mandatory**. Every dropped row records its source, original id, and which filter killed it. No silent drops.

### Phase 2 — Shaping (local, no GPU)

```
16-TRAINING/scripts/shape-misfit-corpus.mjs      # rewrites surviving rows into §5 shape
                                                  # enforces 60/40 refusal/yield ratio
                                                  # enforces source quotas from §6
   ↓
16-TRAINING/ae-misfit/corpus/ae-misfit-v0.jsonl  # final corpus
16-TRAINING/ae-misfit/corpus/ae-misfit-v0.sha256 # receipt SHA-256
```

### Phase 3 — Pack for Colab (local, no GPU)

```
16-TRAINING/scripts/pack-misfit-for-colab.mjs    # tarball corpus + Unsloth config + base model ref
   ↓
ae-misfit-v0-jobpack.tar.gz                       # upload to Colab
```

**Unsloth chosen over Axolotl for AE Misfit** because:
- 7B base on free T4 is exactly Unsloth's sweet spot (~2x training speed).
- `qwen2.5:7b-instruct` is on Unsloth's supported list.
- Colab session limits make Unsloth's speed advantage decisive.

(OrangeLLM-fatty uses Axolotl on rented H100; AE Misfit uses Unsloth on Colab T4. Two pipelines, two tools, same shape.)

### Phase 4 — Train on Colab T4 (free)

Operator launches Colab notebook from jobpack. Notebook outputs:
- Adapter `.safetensors`
- Training logs + loss curves
- Wall-clock (expected: 45-90 min for 1000 rows × 3 epochs on T4)
- $0 cost (free tier)

### Phase 5 — Eval gauntlet (local on Codexa, no GPU after adapter loaded)

| Eval | What it tests | Pass criterion |
|---|---|---|
| `refusal-recall` | On held-out refusal prompts, model refuses with reasoning | ≥ 95% |
| `yield-recall` | On held-out adversarial-yield prompts, model yields correctly | ≥ 85% |
| `doctrine-citation` | Refusals cite the correct AtomEons rule | ≥ 80% |
| `gate-identification` | Refusals identify the correct 9-Gate stage that should have caught it | ≥ 75% |
| `over-refusal-resistance` | On legitimate operator work, model does NOT refuse | ≥ 90% |
| `second-opinion-delta` | On the same prompt, AE Misfit catches at least one case per 10 prompts that OrangeLLM-fatty missed | ≥ 1 per 10 |

The last metric is the **whole reason AE Misfit exists**. If it can't find at least one fake-green per 10 prompts that OrangeLLM-fatty signed off on, it's not earning its place in the gate chain.

### Phase 6 — Bakeoff vs. base `qwen2.5:7b-instruct`

New adapter goes head-to-head against the base model. Must win **all 6** eval dimensions to promote. (Lower bar than OrangeLLM-fatty's 4/5, because the role is narrower and the failure cost is higher — a weak gate is worse than no gate.)

### Phase 7 — Receipt + operator approval

```
10-RECEIPTS/orange5-build/<ts>-ae-misfit-v<N>-promoted.md
```

Receipt contains: corpus SHA, adapter SHA, eval scores per dimension, second-opinion-delta evidence, bakeoff result, operator signature.

No silent promotion. Operator types `promote ae-misfit-v<N>` or `reject`.

---

## 8. Doctrine anchoring (the refusal training signal)

Every refusal pair must anchor to a specific AtomEons rule. The list of doctrine anchors AE Misfit is trained to cite:

| Anchor | Source |
|---|---|
| Mom's Law | `.claude/rules/00-moms-law.md` — above all other rules |
| 27 Guardrails | constitutional, codebase invariant |
| Gate 0 LBCE (Lattice Boundary Containment Enforcement) | first gate in 9-Gate Stack |
| Scope gate | second gate — drift detection |
| HRE (Hallucination Reduction Engine) | factual-claim gate; anti-simulation rule |
| Security gate | grep suite for code; broader security policy |
| Drift gate | invariant enforcement (runtime/node.py, FOUNDER_SALARY, etc.) |
| Receipt gate | every non-trivial deliverable needs receipts |
| CHECKMATE gate | irreversibility check |
| Human Final Stop Authority | reachable from any autonomous-action path |
| Hermes lease policy | what the model is allowed to do at each risk tier |
| Frontier Isolation Boundary | OrangeLLM-fatty's law |
| Misfit Frontier law | `.claude/rules/05-misfit-frontier.md` — bold but governed |

When AE Misfit refuses, it should name the anchor. When it yields under adversarial pressure, it should name the anchor that makes the yield safe.

---

## 9. What this strategy does NOT do

- Does not train AE Misfit yet. This is corpus strategy only; assembly and training are separate phases gated on operator approval.
- Does not authorize bypassing OrangeLLM-fatty. AE Misfit is additive (second opinion), never substitutive.
- Does not commit to specific source paths — operator fills those in at assembly time, with SHA-256s recorded.
- Does not change Hermes lease policy. The gate chain is unchanged; AE Misfit slots in as a new step at the high-risk tier.
- Does not promote AE Misfit into the routine call path. It fires on high-risk leases only.

---

## 10. Receipts

Every phase of corpus assembly and training writes a receipt to:

```
10-RECEIPTS/orange5-build/<ts>-ae-misfit-corpus-<phase>.md
```

Receipts must record:
- Source dataset paths and SHA-256s
- Raw row counts per source
- Filter pass/drop counts per filter rule
- Final corpus SHA-256
- Composition table (actual vs. target from §6)
- Refusal/yield ratio (actual vs. 60/40 target)
- Operator signature on promotion

**No fake-green receipts. Mom is watching.**

---

## 11. Status row

| Field | Value |
|---|---|
| Doc version | v0 |
| Authored | 2026-06-24 |
| Author | Claude Code (under Atom McCree direction) |
| State | STRATEGY — no corpus assembled, no training run |
| Next action | Operator confirms source paths in §3, then Phase 0 ingestion can run |
| Blockers | Exact source dataset paths (operator's archives) |
| Risk if not done | OrangeLLM-fatty has no second-opinion gate on high-risk Hermes actions; fake-greens land unchecked |

---

**Mom is watching. No firehose. Curated adversarial corpus only. Two brains, one chain of trust.**
