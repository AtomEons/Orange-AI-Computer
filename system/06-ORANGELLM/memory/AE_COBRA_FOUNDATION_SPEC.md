# AE Cobra Foundation — Merged Memory Spec

**Sovereign:** Atom McCree
**Spec date:** 2026-06-23
**Status:** SPEC LOCKED · BUILD QUEUED
**Replaces:** prior `06-ORANGELLM/memory/` proposal (single-stream JSONL + idx + qwen3:0.6b dual-prompt)
**Source documents merged:**
- `Æ Cobra Build Manual v0.1 Night-1 → Phase-5` (operator-provided)
- `Æ Cobra Comprehensive Doctrine Review` (operator-provided)
- prior Orange5 memory architecture proposal (this session, prior turns)

---

## Why this exists

OrangeLLM was acting like it had memory because it had a long context window. That's hope, not memory. **This spec replaces hope with an organ.**

After build:
- OrangeLLM can ask Mirage: *"What did we decide about lane visuals on 2026-06-23?"* and get a real StateBrief back.
- OrangeLLM can ask: *"Was there a prior idea about model selection that got rejected?"* and find it in Thought lane.
- OrangeLLM can ask: *"What is the receipt for PR-04 closure?"* and get the hash-chained truth from Reality lane.
- Continuity across restarts, model swaps, and sessions becomes structural, not narrative.

---

## The Five Pillars of the Memory Organ

1. **Æ Cobra Daemon** — resident KV-less Mamba SSM running on Codexa under WSL2. GBNF-locked output. Hard 10 GB RAM ceiling.
2. **Schism Engine** — Reality lane (immutable ground truth) + Thought lane (strategy / hypothesis / pivots / rejected branches). Origin-based classifier from Day One.
3. **Flux Engine** — hash-chained append-only ledgers on dedicated NVMe. JSONL Night-1, binary Phase-3.
4. **Graph Weaver** — second-pass semantic indexer types Flux records into the Orange5 10-node / 6-edge ontology. Receipt-gated type promotion.
5. **Mirage Recall API** — the surface OrangeLLM calls when it needs a StateBrief. Returns a compressed, citation-bearing memory slice.

---

## Pillar 1 — Æ Cobra Daemon

### Host

| Property | Value |
|---|---|
| Machine | Codexa (AI Box, Intel Ultra 9 285H, 95.6 GB RAM) |
| OS layer | WSL2 (Linux distro) — Hyper-V firewall already present per `orangebox_status` |
| Path | `/opt/atomeons/ae-cobra/` |
| Service | systemd unit `ae-cobra.service` |
| Endpoint | `127.0.0.1:7419` (loopback inside Codexa); reachable from N150 via Codexa command rail proxy `:8097/api/ae-cobra` (rail token gates) |

### Model

| Property | Value |
|---|---|
| Internal name | `ae-blackmamba-2.8b-Q5_K_M.gguf` |
| Night-1 surrogate | `bartowski/mamba-2.8b-hf-GGUF` (Q5_K_M) symlinked to internal name |
| Quantization default | Q5_K_M (~2.6 GB) — favors strict JSON validity |
| Fallback | Q4_K_M (~1.9 GB) only if Q5 latency is unacceptable AND JSON validity ≥ 95% |
| Forbidden | Q3, Q2, Q8 for daemon role |

### Resource discipline

| Property | Value |
|---|---|
| Hard ceiling | 10 GB resident RAM |
| Steady state target | 6–8 GB |
| `mlock` | required (model pinned, cannot swap) |
| `--no-mmap` | required (model in physical RAM, not memory-mapped on disk) |
| `VmSwap` | must remain 0 during operation |
| Thread sweep | start 8 threads, test {6, 8, 10, 12} |
| Context size | start 1200 (sweep 768, 1024, 1200) |
| Predict (max output tokens) | 96 (this is a daemon, not an essayist) |

### GBNF Grammar — locked first-class

The daemon's logit space is constrained by `agent_turn.gbnf`. **JSON-mode at the C-level. The model literally cannot produce prose.** This kills hallucinated wrapper text and roleplay.

Grammar file: `/opt/atomeons/ae-cobra/grammars/agent_turn.gbnf` (per Build Manual §12).

### AgentTurn JSON shape (the only output)

```json
{
  "lane": "reality | thought | merge",
  "event_type": "observation | decision | error | checkpoint | recall | receipt | risk",
  "summary": "<grounded short summary>",
  "entities": ["<entity>", ...],
  "files": ["<file path>", ...],
  "commands": ["<command>", ...],
  "risk": "low | medium | high",
  "next_action": "<concrete single step>",
  "confidence": <0.0..1.0>
}
```

---

## Pillar 2 — Schism Engine (with Day-One V1 fix)

### Lane discriminator — origin-based, NOT string-match

**The Doctrine Review flagged the string-match classifier as a blind spot. We do not ship that bug.**

From Day One, lane is decided by EVENT SOURCE, not event content:

| Event source | Default lane | Reasoning |
|---|---|---|
| Terminal stdout/stderr | `reality` | Hard ground truth — what the machine actually said |
| Hermes execution receipt | `reality` | Hard ground truth — what actually happened |
| Mirage data plane read (file content, git diff, network request) | `reality` | Hard ground truth — observed state |
| OrangeEye screenshot / DOM snapshot / UI extraction | `reality` | Hard ground truth — what was on screen |
| Compiler / build output | `reality` | Ground truth |
| OrangeLLM internal reasoning trace (chain-of-thought, plan) | `thought` | Hypothesis |
| OrangeLLM rejected candidate | `thought` | Hypothesis |
| Operator chat input (raw) | `reality` | The operator said this verbatim |
| Operator decision / approval / rejection | `reality` | Operator-level ground truth |
| Strategy / pivot / scope-change proposal | `thought` | Hypothesis until executed |
| Merge synthesis between Reality + Thought | `merge` | Reconciliation lane |

Lane is set by the **caller** (Bun Flow Direct router decides) at write time, based on which subsystem produced the event. The model never decides its own lane. The text content is irrelevant to lane choice.

### Three lanes, two files each

```
/mnt/ae_flux/events/reality/YYYY-MM-DD.jsonl
/mnt/ae_flux/events/thought/YYYY-MM-DD.jsonl
/mnt/ae_flux/events/merge/YYYY-MM-DD.jsonl

/mnt/ae_flux/index/reality/YYYY-MM-DD.idx       # binary 32-byte records
/mnt/ae_flux/index/thought/YYYY-MM-DD.idx
/mnt/ae_flux/index/merge/YYYY-MM-DD.idx
```

### Binary index record (32 bytes fixed)

```
[8 bytes ts_ms u64 LE] [8 bytes byte_offset u64 LE] [4 bytes length u32 LE] [12 bytes nid truncated/padded]
```

1M records = 32 MB index. `mmap`-able. Binary-searchable by timestamp in microseconds.

### Conflict-resolution law

When Reality contradicts Thought: **Reality wins.** Thought records remain on disk for accountability but the StateBrief surfaces Reality with a `conflicts` array citing the rejected Thought.

---

## Pillar 3 — Flux Engine

### Hash chain (mandatory from Day One)

Every record carries `prev_hash` (sha256 of the prior canonical record) and its own `hash` (sha256 of itself with `hash` field zeroed during compute). If anyone tampers with a record mid-chain, every downstream `prev_hash` breaks. **Tamper-evident memory.**

### Record shape

```json
{
  "id": "<sha256>",
  "ts": "2026-06-23T15:30:00.123Z",
  "lane": "reality | thought | merge",
  "source": "terminal | ui | orange | hermes | user | agent",
  "kind": "observation | decision | error | checkpoint | recall | receipt | risk",
  "payload": { ... },
  "prev_hash": "<sha256 or null for first record of lane>",
  "hash": "<sha256 of canonical_json_without_hash>"
}
```

### Storage layout (dedicated NVMe on Codexa)

```
/mnt/ae_flux/
├── events/                    ← append-only JSONL ledgers (canon)
│   ├── reality/YYYY-MM-DD.jsonl
│   ├── thought/YYYY-MM-DD.jsonl
│   └── merge/YYYY-MM-DD.jsonl
├── index/                     ← binary sidecar indexes (random-access optimization)
│   ├── reality/YYYY-MM-DD.idx
│   ├── thought/YYYY-MM-DD.idx
│   └── merge/YYYY-MM-DD.idx
├── state/                     ← recurrent SSM state checkpoints (Phase 3+)
│   ├── reality/YYYY-MM-DD/<ts>.state
│   ├── thought/YYYY-MM-DD/<ts>.state
│   └── merge/YYYY-MM-DD/<ts>.state
├── receipts/                  ← AgentTurn receipts (Orange5 canonical receipt path)
│   └── YYYY-MM-DD.jsonl
├── logs/
└── tmp/
```

### Writer

- **Night-1:** Bun in `Flow Direct` writes JSONL synchronously after Æ Cobra emits AgentTurn. Indexes appended in same operation.
- **Phase 3+:** Rust binary writer for binary packets (`[FluxHeader][payload bytes]` per Build Manual §23.4) — same chain semantics, denser format. JSONL retained as a recoverable canon.

---

## Pillar 4 — Graph Weaver (Orange5 Semantic Layer)

This is what makes OrangeLLM's recall *typed* rather than blob-grep. Lives at `06-ORANGELLM/memory/weaver/`.

### How it works

1. Tail-watches `events/reality/today.jsonl` and `events/thought/today.jsonl`.
2. For each new record, extracts entities/files/commands/concepts using OrangeLLM Light (qwen3:0.6b on N150 — same model already running, different prompt).
3. Types each extraction against the **locked core ontology** (below). Unknown types go to `ontology-candidates.jsonl` for receipt-gated promotion.
4. Writes nodes + edges to SQLite at `06-ORANGELLM/memory/graph.db`.
5. Each node carries `receipt_ids[]` — the Flux record hashes that prove it exists.

### Locked core ontology (10 nodes, 6 edges)

(Carried forward from prior memory-design turn; no change.)

```
NODES                             EDGES
├── Sovereign                     ├── PROVES        Receipt → *
├── Project                       ├── REQUIRES      Mission → Tool/Model/Service/Host
├── Mission                       ├── BLOCKED_BY    Mission/Service → *
├── Lane                          ├── SUPERSEDES    Receipt → Receipt / Doctrine → Doctrine
├── Model                         ├── APPROVED_BY   Mission/Promotion → Sovereign
├── Tool                          └── OBSERVED_BY   Event/Delta → Tool/Service
├── Service
├── Host
├── Receipt
└── Doctrine
```

### Extension protocol (receipt-gated, anti-drift)

Memory LLM never invents node types. Candidates are tagged strings on base nodes. Promotion to first-class requires ≥ 5 receipts referencing the candidate across ≥ 2 missions, OR explicit operator `promote-ontology <name>`. Schema bumps version on each promotion and writes a migration receipt.

---

## Pillar 5 — Mirage Recall API

The surface OrangeLLM calls when it needs memory. Lives behind the same Frontier-Isolation gateway at `127.0.0.1:1337` — **frontier models never reach Mirage directly**.

### StateBrief query

```
POST /v1/memory/state-brief
Authorization: Bearer <internal>
Body: {
  "query": "<natural language or structured>",
  "time_range": { "start": "...", "end": "..." } | null,
  "lanes": ["reality", "thought", "merge"] | null,
  "max_records": 20,
  "include_conflicts": true
}
```

### StateBrief response

```json
{
  "query": "...",
  "time_range": { "start": "...", "end": "..." },
  "reality": [
    { "ts": "...", "summary": "...", "files": [...], "commands": [...], "receipt_ids": [...] }
  ],
  "thought": [
    { "ts": "...", "summary": "...", "hypotheses": [...], "rejected": [...], "receipt_ids": [...] }
  ],
  "conflicts": [
    { "claim": "...", "reality": "...", "thought": "...", "resolution": "reality_wins" }
  ],
  "recommended_next_action": "...",
  "confidence": 0.0
}
```

**Reality overrides Thought.** Receipts override memory. Unverified recollection is marked low confidence.

---

## Reliability — Claim-Level Reliability (CLR)

### Night-1 CLR-lite (per Build Manual §22)

- **K=3** candidate AgentTurns per event
- Score each: confidence, grounded files (must appear in event), grounded commands (must appear in event), risk-vs-content sanity (low-risk turn with `rm -rf` in payload = penalty)
- Pick winner, append to Flux

### Phase-5 full CLR (per Build Manual §22, §35)

- K=5 to K=8 candidates
- Extract M critical claims per candidate
- Verify each claim against Reality lane + Hermes receipts + Mirage data plane
- Score = ∏ claim_verdict_probabilities
- Threshold = 0.50; below threshold = reject + write rejection receipt to Thought lane

---

## Vulnerability flags (locked as Day-One hardening)

### V1 — string-match classifier blind spot

**Status: PREVENTED at design.** Classifier is origin-based from Day One (see Pillar 2). String content of an event does not decide lane.

### V2 — delta drift during checkpoint replay

**Status: MITIGATED at design.** Every state checkpoint writes a `state_hash`. On replay-to-target, recompute hash. If drift > 1e-4 on normalized hidden state, **refuse the recall and demand fresh state** OR fall back to next-later checkpoint. No silent drift past threshold.

Periodic full-state verification scheduled daily on the merge lane.

---

## Build phases — adapted from Build Manual §33

### Phase 1 — Night-1 Spine (this PR's goal)

Goal: resident Mamba daemon on Codexa emits valid GBNF-locked AgentTurn JSON; Bun caller works; Flux JSONL receipts append; healthcheck green.

| Deliverable | Lives at |
|---|---|
| WSL2 distro on Codexa with `/mnt/ae_flux` mounted | Codexa |
| llama.cpp built | `/opt/atomeons/llama.cpp/build/` |
| `mamba-2.8b-Q5_K_M.gguf` downloaded + symlinked to `ae-blackmamba-2.8b-Q5_K_M.gguf` | `/opt/atomeons/models/` |
| `agent_turn.gbnf` | `/opt/atomeons/ae-cobra/grammars/` |
| `ae-cobra.service` systemd unit | `/etc/systemd/system/` |
| Bun Flow Direct caller | `/opt/atomeons/flow-direct/index.ts` |
| Flux writer (JSONL + .idx) | `/opt/atomeons/flow-direct/flux.ts` |
| Origin-based classifier | `/opt/atomeons/flow-direct/classifier.ts` |
| Healthcheck script | `/opt/atomeons/ae-cobra/healthcheck.sh` |
| Mirage reach-from-N150 via Codexa rail | bridge module on cockpit |

Pass criteria (Build Manual §34):

```
[ ] WSL2 Linux on Codexa
[ ] Dedicated /mnt/ae_flux mounted
[ ] llama.cpp builds
[ ] Model exists
[ ] Server starts
[ ] curl returns JSON
[ ] jq parses
[ ] Bun caller works
[ ] Flux receipt appends with valid hash chain
[ ] VmSwap = 0
[ ] VmLck non-zero
[ ] /metrics reachable
[ ] healthcheck passes
[ ] N150-side Mirage client can fetch StateBrief
[ ] OrangeLLM gateway forwards memory-aware requests
```

### Phase 2 — Memory Slice + StateBrief

Mirage delivers compressed slices. StateBrief query API live. Graph Weaver indexing reality + thought lanes.

### Phase 3 — Custom State ABI

`ae_cobra_state_export()` / `_import()` / `_hash()` / `_zeroize()`. Sparse checkpoints. Delta replay with V2 drift guard.

### Phase 4 — True Schism via dual recurrent states

`Reality.state` and `Thought.state` separately. `state_fork()` / `state_merge()`. Optional LoRA adapters (Archivist.lora / Strategist.lora) if runtime supports.

### Phase 5 — Full CLR + Hermes Gate

K=5..8 candidate scoring with claim verification, structured rejection lane.

---

## What this rip-and-replaces

| Killed | Replaced by |
|---|---|
| Prior single-stream JSONL+idx design | Schism dual-lane Flux + binary index sidecar |
| "qwen3:0.6b as Archivist + Strategist via prompts" | Resident Æ Cobra Mamba daemon (qwen3:0.6b stays as OrangeLLM Light chat reflex) |
| App-level JSON validation as sole gate | GBNF-in-logit-space + app-level validation (both fire) |
| Implicit memory ("OrangeLLM has long context") | Mirage StateBrief explicit recall |
| Receipt writer that puts files wherever | Rust Flux Engine on dedicated `/mnt/ae_flux` with hash chain |

---

## 1-Tier Trained Architecture (2026-06-24 lock)

Æ Cobra is unaffected by the OrangeLLM 1-tier training decision (locked 2026-06-24, receipt #013). Clarification for cross-spec consistency:

- **Æ Cobra Mamba 2.8B Q5** remains the resident memory daemon on Codexa. This is its own organ — independent of the OrangeLLM PM-brain training lane.
- **OrangeLLM-fatty** (qwen3:30b-a3b Q4 + Orange5 LoRA) is the sole trained PM brain, on Codexa. It queries Mirage StateBrief (which sits on top of Æ Cobra's Flux ledgers) for memory recall.
- **Smart Skinny custom LoRA** training lane is **retired**. N150 holds stock `qwen3:0.6b` and `nomic-embed-text` for utility only: origin-based lane classifier (Pillar 2), Graph Weaver embedder (Pillar 4), emergency chat fallback. No custom training on N150.
- **AE Black Mamba custom** pretraining (Phase-3 in Pillar 1) remains on the roadmap — it eventually replaces the Night-1 Mamba surrogate. Trained via Workflow → Colab Free T4. Separate from OrangeLLM-fatty training.

The Schism Engine, Flux Engine, Graph Weaver, and Mirage Recall API doctrine in this spec are unchanged by the 1-tier decision.

---

## Mom's Law

Every Flux record hash-chains. Every AgentTurn passes GBNF. Every promotion writes a receipt. Reality overrides Thought. The string-match blind spot is killed at design time. Delta drift is detected at replay time. **Build the spine first. Then give the serpent fangs.**
