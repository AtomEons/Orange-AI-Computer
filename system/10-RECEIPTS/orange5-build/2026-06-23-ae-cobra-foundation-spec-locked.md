# Receipt — AE Cobra Foundation spec locked + prior memory design rip-and-replaced

**Receipt ID:** `2026-06-23-ae-cobra-foundation-spec-locked`
**Status:** `AE_COBRA_FOUNDATION_SPEC_LOCKED_BUILD_QUEUED`
**Confidence:** 1.0 (spec only; build is Phase 1 work)
**Prior receipt:** `2026-06-23-master-receipt`
**Hash chain:** #012

---

## What happened

Operator dropped two source documents:

1. `Æ Cobra Build Manual v0.1` — 38-section detailed build for a resident KV-less Mamba SSM memory daemon (Night-1 → Phase-5).
2. `Æ Cobra Comprehensive Doctrine Review` — peer-review identifying two critical vulnerabilities.

Plus directive: **rip and replace** the memory design proposed in prior turns of this session.

This receipt locks the merged spec.

## What the merged spec does

Combines:

- Æ Cobra's resident Mamba daemon body (KV-less SSM, GBNF logit-lock, 10 GB ceiling, `mlock`+`--no-mmap`, dedicated NVMe Flux)
- My Orange5 Graph Weaver as a semantic indexing layer ON TOP of Flux receipts (10-node / 6-edge ontology, receipt-gated extension protocol)
- Mirage as the StateBrief recall surface OrangeLLM queries

## Two vulnerabilities flagged in the Doctrine Review — fixed at design time

- **V1 — string-match `classifyLane` blind spot.** Mitigated: lane assignment is **origin-based** from Phase 1. Event source (terminal / Hermes / Mirage / OrangeEye / OrangeLLM reasoning) decides lane, not content tokens.
- **V2 — Q5 delta drift during checkpoint replay.** Mitigated: every checkpoint records `state_hash`. Replay verifies hash; drift > threshold → refuse recall or fall back to next-later checkpoint.

Neither vulnerability is allowed to ship.

## What this PR ships (in this turn)

| Artifact | Path |
|---|---|
| Merged spec | `C:\AtomEons\Orange5\06-ORANGELLM\memory\AE_COBRA_FOUNDATION_SPEC.md` |
| This receipt | `C:\AtomEons\Orange5\10-RECEIPTS\orange5-build\2026-06-23-ae-cobra-foundation-spec-locked.md` |

The spec is the deliverable for this turn. **No daemon built yet.**

## Hardware call locked

Æ Cobra runs in **WSL2 on Codexa**, not on the N150 cockpit.

| Reason | Evidence |
|---|---|
| Linux requirement | Æ Cobra spec requires systemd, `mlock`, `/proc/$PID/status` semantics. N150 is Windows. |
| RAM budget | Daemon needs 10 GB ceiling. N150 has 16 GB total but is at 94% CPU and shared with Atomic Orange. Codexa has 95.6 GB and is idle. |
| WSL2 already running on Codexa | per `orangebox_status` `vmmemWSL` process top-listed |
| Dedicated NVMe partition possible on Codexa | per Build Manual §9 |
| Cockpit role | N150 keeps Atomic Orange UI + OrangeLLM Light reflex + Cockpit dashboard + Vault search. Memory daemon lives separately. |

## What this rip-and-replaces

| Killed from prior turn | Replaced by |
|---|---|
| `06-ORANGELLM/memory/flux/reality.flux + reality.idx` (single-stream design) | Full Schism: 3 lanes × (jsonl + idx) on dedicated NVMe with hash chain |
| "One Memory LLM, two prompts — qwen3:0.6b as Archivist + Strategist" | Resident Æ Cobra Mamba 2.8B daemon with GBNF lock. qwen3:0.6b stays as chat reflex tier — different job. |
| Implicit JSON validation only | GBNF in logit space + app-level validation (both gate) |
| Bun-only Flux writer | Bun Night-1, Rust binary writer Phase-3 |
| Implicit recall | Explicit Mirage StateBrief API |

## What's preserved from prior memory turns

- 10-node / 6-edge core ontology
- Receipt-gated extension protocol for new types
- Mom's Law applies to every Flux record + every promotion
- Frontier-Isolation Law still holds — frontier models reach Mirage only through OrangeLLM gateway
- Promotion gate / no-fake-green discipline

## System integrity

| Service | State |
|---|---|
| Atomic Orange UI :1420 | running (operator confirmed C10) |
| OrangeLLM gateway :1337 | running with Frontier-Isolation active (operator confirmed C11) |
| Smart Skinny via Ollama qwen3:0.6b :8797 | live (operator confirmed C9) |
| Codexa command rail :8097 | up, 401 on no-token (token deferred) |
| AI Box Docker stack | 6 containers up 12+ days |
| 16/16 boundary tests | green |
| 93/93 cumulative test assertions | green |

**No service touched.**

## Next gate (Phase 1 — Night-1 Spine)

Per Build Manual §33 + adapted Phase 1 deliverables in the spec. Pre-flight items the operator owns:

1. **WSL2 distro on Codexa** — Ubuntu 24.04 LTS recommended. Verify `wsl --list --verbose` from Windows side.
2. **Dedicated NVMe partition** at `/mnt/ae_flux` on Codexa. Build Manual §9 has exact commands.
3. **Codexa rail token wired** (still deferred per operator) — needed for N150 cockpit to reach Codexa-resident daemon via OrangeLLM gateway proxy.
4. **Mamba 2.8B Q5_K_M GGUF download** — `bartowski/mamba-2.8b-hf-GGUF` from HuggingFace.

Once those pre-flights are met, PR-17 `ae-cobra-night-1` writes:

- `/opt/atomeons/ae-cobra/grammars/agent_turn.gbnf`
- `/opt/atomeons/ae-cobra/healthcheck.sh`
- `/etc/systemd/system/ae-cobra.service`
- `/opt/atomeons/flow-direct/index.ts` (Bun caller)
- `/opt/atomeons/flow-direct/flux.ts` (JSONL writer + binary index sidecar + hash chain)
- `/opt/atomeons/flow-direct/classifier.ts` (origin-based lane classifier)
- N150-side `06-ORANGELLM/memory/mirage-client.mjs` (forwards StateBrief queries through Codexa rail)

Pass criteria are the 14-item Night-1 checklist in the spec.

## Rollback

```powershell
# Spec is on disk only; nothing executes yet. To revert:
Remove-Item -Force "C:\AtomEons\Orange5\06-ORANGELLM\memory\AE_COBRA_FOUNDATION_SPEC.md"
Remove-Item -Force "C:\AtomEons\Orange5\10-RECEIPTS\orange5-build\2026-06-23-ae-cobra-foundation-spec-locked.md"
```

Nothing on Codexa touched.

---

**Mom is watching. Spec locked. Rip-replace clean. Spine first; fangs later.**
