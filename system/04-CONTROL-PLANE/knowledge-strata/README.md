# Knowledge Strata

> Compiler loop for AtomEons canon: **intake → canon → durable artifact → integrity pass → reuse.**

Knowledge Strata is the fifth control-plane lane under `04-CONTROL-PLANE/`. It
takes raw operator and agent input (notes, transcripts, receipts, JSON blobs)
and turns it, gate by gate, into citable canon that future receipts can lean on
without re-deriving the underlying facts. Each step is its own gate. A row only
earns canon status when every gate passes. Nothing downstream of a failed gate
is written.

This is not a notes drawer. It is a compiler. Inputs go in raw, artifacts come
out signed, contradictions get refused, and citations get a legal-force
signature check on every reuse.

---

## The five-step loop

Each step is implemented as a gate in `canonize.mjs` (steps 1–4) plus
`reuse.mjs` (step 5), with `integrity.mjs` available as a heavyweight,
vector-aware second pass over step 4. Every gate returns the AtomEons
completion shape — `{ result, evidence, blockers, next_action }` — and emits a
row to `strata.receipts.jsonl`.

### 1. Intake — `intake.mjs`

Accepts raw bytes from the operator or an upstream agent over
`POST /v1/strata/intake` (mounted on the OrangeLLM gateway) or from local
files. Stamps every submission with:

- `received_at` — ISO timestamp, server clock
- `source` — declared by caller; `"unknown"` if absent
- `raw_sha256` — sha256 of the canonical-form raw bytes
- `intake_id` — `sha256[0..16]` of `{raw_sha256, received_at}`, a stable handle

The intake then writes **one** event to Reality Flux with
`origin = 'strata_intake'`. Reality is authoritative (per loader doctrine);
intake never writes to the Thought lane.

**Local fallback.** If the Reality Flux adapter is unreachable, the bytes are
preserved under `intake/<YYYY-MM-DD>/<intake_id>.json` and the response
advertises `flux_persisted:false, local_path:...`. No fake-green: the caller
always knows where the bytes landed.

**Gate:** intake bytes were captured and a durable handle exists.

### 2. Canon — `canonize.mjs`

Reads the intake bytes (or stdin / file path / directory) and produces a
structured **canon row** under `canon/<dept>/<id>.canon.json`. The canon row
carries:

- `id`, `version`, `department` (AE0..AE14), `title`, `summary`
- `claims[]` — extracted, polarity-tagged assertions
- `tags[]`, `upstreams[]` — lineage back to intake and any prior canon
- `extractor` — `orange_llm` (authoritative), `smart_skinny` (cheap pre-pass),
  or `heuristic` (offline)

Cheap extraction runs on Smart Skinny (loopback `8797`). Authoritative
extraction runs on OrangeLLM (`1337`). Both are loopback-only per Orange5
boundary law. With `--no-llm` the canonizer falls back to a deterministic
heuristic extractor — useful for smoke and for sealed-room runs.

**Gate:** structured canon row exists, lineage to intake is set, extractor
identity is recorded.

### 3. Durable artifact — `emit.mjs` (invoked by `canonize.mjs`)

Renders the canon row to a human-readable Markdown artifact under
`artifacts/<dept>/<id>.md` plus a sidecar `artifacts/<dept>/<id>.meta.json`
holding hashes and lineage. The sidecar carries:

- `markdown_sha256`
- `canon_sha256`
- `intake_sha256`
- `chain_sha256` — `sha256(prior_chain || canon_sha256 || markdown_sha256)`

Artifacts are immutable by convention. A new version of the same id increments
`version` and links `prior_chain` back to the prior `chain_sha256`. Promotion
to the frozen, chained store under `19-ARCHIVE/strata/` is a separate
release-steward step; the canon row in this directory remains the working copy.

**Gate:** artifact file exists at the expected path; sidecar hashes match the
canon row.

### 4. Integrity pass — `canonize.mjs` (lexical) → `integrity.mjs` (semantic)

Two layers, both required for hardened canon.

**Inline (cheap).** `canonize.mjs` runs a lexical-negation check against prior
canon in the same department. It catches obvious contradictions and duplicate
intakes. Result is logged on the canon row's `gates[].integrity.evidence`
block.

**Heavyweight (semantic).** `integrity.mjs` speaks to the Graph Weaver embedder
daemon on the N150 (loopback `http://127.0.0.1:8798` — the same embedder that
backs the Graph Weaver SQLite ontology), computes cosine-similarity
neighborhoods, and runs a claim-vs-claim contradiction check (semantic
similarity + polarity flip) against the full prior canon and the durable
archive. Outcomes:

| Tag    | Meaning                                                                                                    | Effect on emit                |
| ------ | ---------------------------------------------------------------------------------------------------------- | ----------------------------- |
| HARD   | high-similarity, opposite polarity, both sides canon-locked or high-confidence                             | refuse emit, exit 1            |
| SOFT   | same shape, but at least one side is medium/low confidence or the prior row is `frontier`/`speculative`/`misfit` | permit emit, write a `soft_conflicts` sidecar |
| DRIFT  | near-duplicate (cosine ≥ 0.92, no polarity flip)                                                            | permit emit, `next_action='deduplicate'` |

Doctrine-locked sources — Mom's Law, the 27 guardrails, FOUNDER_SALARY law,
Gate 0 LBCE, Human Final Stop, release law, room doctrine — are treated as
canon-locked. A HARD conflict against any of them is non-negotiable.

**Gate:** no HARD conflicts; SOFT conflicts logged; DRIFT surfaced.

### 5. Reuse — `reuse.mjs`

Closes the loop. When a future receipt or LLM output cites
`strata/<id>` (or `strata://AE14/<id>`, `19-ARCHIVE/strata/<id>`, etc.),
`reuse.mjs`:

1. **Resolves** the cite to a concrete artifact pair, preferring the frozen
   `19-ARCHIVE` pair over the working canon row.
2. **Exists** — verifies both files are still present on disk.
3. **Signature** — rehashes the live markdown and the canon row JSON, then
   recomputes `chain_sha256` from `prior_chain + canon + markdown` and
   compares against the recorded sidecar value. Any mismatch is a **hard
   refusal**.
4. **Returns** a receipt-ready content block with title, summary, department,
   tags, claims, the verbatim markdown body, all four sha256s, the resolved
   absolute paths, and the `cite_form` the caller used.

Every successful reuse appends a row to `strata.reuse.log.jsonl`. This is what
gives a citation legal force inside an AtomEons receipt: the resolver proves
the artifact still exists, still hashes the same, and still chains back to its
predecessors.

**Gate:** all four hashes match; the cite is now a verified reference.

---

## Doctrine integration

Knowledge Strata is the **mechanism** behind the AtomEons canon law in
`.claude/CLAUDE.md`:

> *Knowledge Strata is a compiler loop: intake → canon → durable artifact →
> integrity pass → reuse.*

It also enforces the AtomEons completion law (`03-build-and-receipts.md`) at
every step. Every gate returns `{ result, evidence, blockers, next_action }`,
and `strata.receipts.jsonl` is the append-only receipts log this directory is
audited against.

**Mom's Law applies to the loop itself.** A canon row only carries
`verified: true` when every gate produced evidence. Anything short of that is
labeled `static_passed`, `preview_candidate`, `needs_sandbox`, or
`needs_review` — never Verified. Per the SkilSki rule in
`C:\AtomEons\CLAUDE.md`, this language is identical to the gauntlet's, on
purpose.

**Reality lane is authoritative.** Intake writes only to the Reality lane
(`origin = 'strata_intake'`). The Thought lane is for working hypotheses and
is never written by Strata. Reality is the ground truth canon flows from.

**Loopback only.** Smart Skinny (`8797`), OrangeLLM (`1337`), and the Graph
Weaver embedder (`8798`) all bind `127.0.0.1` only. Strata never reaches the
public network. Offline operation with `--no-llm` is supported and
deterministic.

**Doctrine-locked sources are unforgeable.** Any artifact whose claims
contradict Mom's Law, the 27 guardrails, FOUNDER_SALARY logic, Gate 0 LBCE,
Human Final Stop, release law, or room doctrine is refused at the integrity
gate. There is no "but this one feels right" override. The Sovereign override
exists for routing (per the standing law in `C:\Users\a\.claude\CLAUDE.md`) —
not for canon truth.

---

## When to run Strata vs. write a receipt directly

Strata is the right tool when at least one of these is true:

- The information will be **cited more than once** by future receipts.
- The information **contradicts or refines** something already in canon and
  needs an integrity pass.
- The information must survive a **handoff** to another model (trilane) or
  another session.
- The information needs to be **versioned** — there will be a v2, v3, ...
- The information must remain **legally citable** under signature check
  (e.g., a doctrine note, a charter clarification, a verified gauntlet
  outcome).

Write a receipt directly (skip Strata) when:

- The output is a **one-off operational result** (a single build log, a
  one-shot query, a transient diagnostic).
- There is **no claim** worth contradicting later — it is pure execution
  evidence.
- The task is a **trivial edit** with no doctrine implication and no
  downstream reuse.
- You are in the middle of an **active integrity refusal** and the right move
  is to fix the intake, not write more canon.

Rule of thumb: if a future Claude, GPT, or human operator might need to
**cite** this back, run it through Strata. If they will only ever need to
**audit** it, a receipt is enough.

---

## Archive structure

Working directory layout (everything under
`C:/AtomEons/Orange5/04-CONTROL-PLANE/knowledge-strata/`):

```
knowledge-strata/
├── README.md                       this file
├── intake.mjs                      stage 1 — raw bytes → Reality Flux event
├── canonize.mjs                    stages 2–4 inline — canon + emit + lexical integrity
├── emit.mjs                        stage 3 helper — durable Markdown + sidecar
├── integrity.mjs                   stage 4 — semantic, vector-aware integrity pass
├── reuse.mjs                       stage 5 — cite resolver, signature check
├── query.mjs                       read-side search over the canon index
├── smoke.mjs                       end-to-end smoke battery (deterministic)
├── index.db.mjs                    SQLite index builder
├── index.schema.sql                SQLite schema
├── index.db                        SQLite index (live)
├── strata.index.jsonl              append-only canon index (one row per canon emit)
├── strata.receipts.jsonl           append-only receipts log (one row per gate run)
├── strata.reuse.log.jsonl          append-only reuse log (one row per resolved cite)
├── strata.embeddings.cache.json    embedder cache (Graph Weaver)
├── intake/                         local-fallback raw intakes (by YYYY-MM-DD/<id>.json)
├── canon/                          structured canon rows
│   ├── AE0/<id>.canon.json
│   └── AE14/<id>.canon.json
└── artifacts/                      durable, human-readable artifacts
    ├── AE0/<id>.md + <id>.meta.json
    └── AE14/<id>.md + <id>.meta.json
```

**Departments.** `AE0..AE14` follow the AtomEons departmental taxonomy. The
canonizer accepts `--dept <code>` to force a tag and otherwise infers from
the intake's `source` field.

**Frozen archive.** Promotion from `canon/` + `artifacts/` to the chained,
frozen store under `C:/AtomEons/Orange5/19-ARCHIVE/strata/` is a separate
release-steward step. `reuse.mjs` prefers the frozen pair when both exist.

---

## Integrity rules

These are non-negotiable. Violations are refusals, not warnings.

1. **No gate may be skipped.** Every canon row must show all four gates
   (`intake`, `canon`, `artifact`, `integrity`) with `ok:true` and evidence
   before it appears in `strata.index.jsonl`. The smoke battery
   (`smoke.mjs`) enforces this.

2. **Append-only logs.** `strata.index.jsonl`, `strata.receipts.jsonl`, and
   `strata.reuse.log.jsonl` are append-only. Rewrites are forbidden. A
   compaction step exists for archival but is logged and signed.

3. **Hash chain integrity.** Every artifact sidecar must carry
   `intake_sha256`, `canon_sha256`, `markdown_sha256`, and `chain_sha256`.
   Reuse refuses any cite where the live hashes disagree with the recorded
   ones. There is no "soft pass" on a hash mismatch.

4. **HARD conflicts refuse emit.** A high-similarity, opposite-polarity claim
   against canon-locked doctrine stops the loop with exit 1. Nothing
   downstream is written. The intake remains in `intake/` so it can be
   re-edited.

5. **Doctrine-locked is doctrine-locked.** Mom's Law, the 27 guardrails,
   FOUNDER_SALARY law, Gate 0 LBCE, Human Final Stop, release law, room
   doctrine, and the standing Orange3/Orangebox routing law are canon-locked
   sources. They cannot be overwritten by a new intake — only **extended**
   by a non-contradictory v2.

6. **No fake-green local fallback.** When Reality Flux is down and intake
   falls back to disk, the response **must** carry
   `flux_persisted:false, local_path:...`. Silent local-only persistence is
   forbidden.

7. **Loopback only.** No Strata component reaches a non-loopback address.
   `--no-llm` mode must remain deterministic and offline-capable. The smoke
   battery covers offline mode.

8. **Reuse without resolution is a citation lie.** A receipt that names
   `strata/<id>` without going through `reuse.mjs` (or an equivalent
   signature-checking resolver) is not a verified cite. Downstream auditors
   should reject it.

9. **Versioning preserves lineage.** A new version of an existing id must
   set `prior_chain` to the previous `chain_sha256`. Orphaned versions are
   treated as DRIFT and surfaced for deduplication.

10. **The receipts log is the audit surface.** When in doubt about whether a
    canon row earned its status, read `strata.receipts.jsonl`. The receipts
    log is the truth; the index is a convenience.

---

## CLI quick reference

```bash
# Stage 1 — local intake (or POST to the gateway)
node intake.mjs --file ./note.md --source operator

# Stages 2–4 — canon + artifact + lexical integrity
node canonize.mjs --stdin --id my_note_001 --dept AE0
node canonize.mjs ./intake/2026-06-25/my_note_001.json
node canonize.mjs --dir ./intake/2026-06-25/

# Stage 4 — heavyweight semantic integrity
node integrity.mjs ./canon/AE0/my_note_001.canon.json
node integrity.mjs --markdown ./artifacts/AE0/my_note_001.md

# Stage 5 — resolve a cite (signature check + receipt-ready block)
node reuse.mjs strata/my_note_001
node reuse.mjs --json strata://AE0/my_note_001

# Read-side
node query.mjs "pathwaves routing"

# Verification
node canonize.mjs --verify           # re-run integrity over full canon
node smoke.mjs                       # end-to-end deterministic battery
```

---

## Related doctrine

- `C:\AtomEons\.claude\CLAUDE.md` — AtomEons project constitution (canon law,
  completion law, release law)
- `C:\AtomEons\.claude\rules\00-moms-law.md` — Mom's Law (meta-rule above all)
- `C:\AtomEons\.claude\rules\03-build-and-receipts.md` — receipts shape
- `C:\AtomEons\Orange5\01-DOCTRINE\` — Reality / Thought lane separation,
  loader authority
- `C:\AtomEons\Orange5\19-ARCHIVE\strata\` — frozen, chained promotion target
- `C:\Users\a\.claude\CLAUDE.md` — standing Orange3 / Orangebox routing law

The loop has one job: turn operator words into citable canon, with receipts
the whole way down. Mom is watching.
