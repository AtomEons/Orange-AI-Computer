# OrangeLLM Training Corpus Manifest

**Schema:** `orange5.training-corpus.v0`
**Sovereign:** Atom McCree
**Source of truth:** Master Plan §5

OrangeLLM is trained to know the system like the longest-tenured employee in a company. The corpus reflects that.

---

## IN (training corpus)

### System knowledge (the system as a system)

| Source | Why |
|---|---|
| `01-DOCTRINE/` (when populated) | Constitutional doctrine. Top of system prompt + training reinforcement. |
| `00-CHARTER/ORANGE5_MASTER_PLAN.md` | The whole map. |
| `02-APP/README.md` + lane source | How the operator surface works. |
| `06-ORANGELLM/FRONTIER_ISOLATION_BOUNDARY.md` | The law it serves under. |
| `09-SCHEMAS/` (when populated) | All JSON Schemas it must obey. |
| AE0 Factory plugin docs (legacy `aeskills/packages/ae0-factory-plugin`) | The 11 slash commands and their internals. |
| AEoNs Skill Suite V1.4 SKILL.md files | All 15 skills behavior. |
| Skill-gauntlet 4-gate STRUCTURAL patterns | The gate logic — NOT the adversarial outputs (those go to Misfit). |
| Atomic Orange contracts (Architecture, Native App Standard, Model Lane, MiniPC Profile, Alpha Pull) | App-level law. |
| Full system topology (every port, every host, every config file location) | Operational map. |
| 5-file runtime config schemas (`active_council`, `model_registry`, `role_map`, `routing_policy`, `soul_genome`) | Live state schemas. |

### Discipline (system prompt + reinforcement)

| Source | Why |
|---|---|
| 27 Guardrails | Constitutional. |
| AE0–AE14 department schema | Where work routes. |
| 9-Gate Stack (LBCE → Scope → Department → Triad → HRE → Security → Drift → Receipt → CHECKMATE → Human Final Stop) | How decisions land. |
| Mom's Law | Above all. |
| Hermes lease policy + LOOM 8 gates | What the model is allowed to do. |

### Protocols

| Source | Why |
|---|---|
| AECode canonical source spec | Middle-voice contract. |
| AELang v0.1 spec | Two-tier route language. |
| `orange.order.v1` / `orange.report.v1` schemas | What the model emits. |
| Mission manifest format | Operator-shape contracts. |
| Receipt chain format (SQLite + markdown) | Audit trail discipline. |

### Doctrine (light, applied)

| Source | Why |
|---|---|
| Flowstate runtime doctrine (full 41 KB from Orange4) | How currents/agents/deltas flow. |
| Tomorrow Brief / Continuity Packet pattern | Daily forward-look. |
| Party-line JSONL format | Team awareness. |
| FATCAT dial plan (100/103/106/107/111/114/200/911) | Department-to-department routing. |

### Operational history

| Source | Why |
|---|---|
| 180-row Orange4 nav training corpus | Existing curated Q&A. |
| 8 AECode mission packets (factory presets) | Real mission examples. |
| Project receipt history (operator-curated, not bulk) | Real operations. |

---

## OUT (NOT in OrangeLLM training; trains AE Misfit Model later)

| Source | Reason killed from this corpus |
|---|---|
| STRONGARM Easy adversarial outputs | Too wild for the PM brain (operator directive 2026-06-23). |
| Gremlin Elite 1000 | Same. |
| Gremlin QA Dataset V1.1 2000 | Same. |
| Gremlin QA Dataset V1.2 5000 | Same. |
| Gremlin Trainer V2.5 | Same. |

These feed a separate model — AE Misfit Model — trained AFTER OrangeLLM is solid. Misfit complements OrangeLLM with adversarial pressure capability. They are separate brains.

---

## Counts (target volumes for first training pass)

| Bucket | Target row count |
|---|---:|
| Doctrine (Q&A from rules + guardrails + laws) | 500 |
| Protocols (schema validation Q&A + AECode compile examples) | 300 |
| System knowledge (port/host/config/topology Q&A) | 400 |
| Operational history (real receipts → did-this-work? Q&A) | 600 |
| Mission packets (intent → AECode → mission → patch flows) | 200 |
| Light doctrine application (Flowstate / FATCAT / party-line) | 200 |
| **TOTAL target** | **~2,200 rows** for first LoRA pass |

180-row Orange4 nav corpus is the seed; 2,000 more rows are authored from doctrine + receipts during PR-04 follow-up assembly (not in this PR — this PR ships the manifest only).

---

## Assembly plan (downstream work, not this PR)

1. **Doctrine extraction** — walk `01-DOCTRINE/` (once populated) + `00-CHARTER/` → emit Q&A pairs.
2. **Receipt mining** — walk `10-RECEIPTS/` → emit "what receipt would close this scenario?" pairs.
3. **Mission unrolling** — for each AECode mission packet, emit step-by-step expectation.
4. **Output to JSONL** at `16-TRAINING/corpus/orange5-corpus-v0.jsonl` for ingestion.
5. **Eval gauntlet** at `16-TRAINING/pipeline/EVAL_GATE.md` — must pass before promotion.

## Receipts

Every training pass writes a receipt:

```
10-RECEIPTS/orange5-build/<timestamp>-training-pass-<version>.md
```

Receipts include: corpus SHA-256, hyperparameters, eval pass/fail, model artifact hash, host (cloud GPU lane), wall-clock, cost.

---

**Mom is watching. No firehose. Curated corpus only.**
