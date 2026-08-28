# Receipt — Æ Cobra Night-1 Spine AUTHORED

**Receipt ID:** `2026-06-24-ae-cobra-night1-spine-authored`
**Hash chain:** #017
**Status:** `AE_COBRA_NIGHT1_SPINE_FILES_AUTHORED_AWAITING_CODEXA_PREFLIGHT`
**Confidence:** 1.0 (all files on disk; smoke-test code present; ready for Codexa rsync)
**Prior receipt:** `2026-06-24-orangellm-fatty-v0-preflight-go` (#016)
**Actor:** Claude (Orange voice)
**Sovereign:** Atom McCree

---

## What happened

Operator directive `NEXT P` → stepping off Colab loop (training will run when it runs) and authoring the Æ Cobra Night-1 spine. All 11 code/spec files now exist on disk at `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\`, ready for the operator to rsync to Codexa once `CODEXA_PREFLIGHT_AE_COBRA.md` is green.

## Files authored

| Path | Bytes | Role |
|---|--:|---|
| `README.md` | ~3 KB | Operator run guide |
| `grammar/agent_turn.gbnf` | ~1 KB | GBNF grammar — constrains llama.cpp logits to AgentTurn JSON shape only |
| `schemas/agent-turn.schema.json` | ~1.5 KB | JSON Schema (post-grammar parser validation) |
| `bin/start.sh` | ~2 KB | Entry script: llama.cpp + mlock + grammar + Bun |
| `bin/stop.sh` | ~1 KB | Graceful shutdown |
| `systemd/ae-cobra.service` | ~1 KB | systemd unit (loopback-bound, memory-capped, mlock-allowed) |
| `flow-direct/server.mjs` | ~5 KB | Bun HTTP server on `:7419` — event routing, lane classifier, CLR, Flux writer |
| `flux/writer.mjs` | ~2.5 KB | Hash-chained append-only JSONL writer with chain verifier |
| `flux/reader.mjs` | ~1.5 KB | Time-range + lane reader; event-count helper |
| `clr/verifier-k1.mjs` | ~2 KB | Night-1 CLR (K=1): anti-fluff + grounding + risk-vs-content sanity |
| `mirage/state-brief.mjs` | ~2.5 KB | Mirage Recall API — returns compressed StateBrief with reality-overrides-thought conflict resolution |
| `smoke-test.mjs` | ~3 KB | 6-step verification: healthz → reality event → thought event → CLR reject → state-brief → chain verify |

Total: ~26 KB of executable code + spec across 12 files.

## Design adherence to `AE_COBRA_FOUNDATION_SPEC.md`

| Spec requirement | Implementation |
|---|---|
| Pillar 1 — KV-less Mamba SSM, mlock-pinned, GBNF-locked | `bin/start.sh` launches llama.cpp with `--mlock --no-mmap --grammar-file agent_turn.gbnf` |
| Pillar 2 — Schism Engine (Reality / Thought / Merge) | Three lane subdirs under `/mnt/ae_flux/events/`, separate hash chains per lane |
| Pillar 2 — Origin-based classifier (V1 mitigation) | `flow-direct/server.mjs` `ORIGIN_LANE` lookup table — caller's `origin` field decides lane, NOT model output, NOT string-match |
| Pillar 3 — Flux hash chain | `flux/writer.mjs` SHA-256 of canonical JSON with `hash:""` zeroed; `prev_hash` from prior record |
| Pillar 5 — Mirage Recall API | `mirage/state-brief.mjs` returns `orange5.state-brief.v0` with reality, thought, conflicts (reality_wins), recommended_next_action |
| CLR Night-1 (K=1, threshold 0.50) | `clr/verifier-k1.mjs` returns score + accepted; rejection → Thought lane with reason |
| Memory ceiling | systemd unit sets `MemoryMax=11G`, `LimitMEMLOCK=infinity` |
| Loopback-only | systemd `IPAddressAllow=127.0.0.1`, `IPAddressDeny=any` |
| Origin-override on model output | `server.mjs` rewrites `parsed.lane = lane` AFTER model emits, so model cannot self-classify |

## V1 vulnerability — mitigated at design

- **Threat:** string-match lane classifier misroutes terminal output containing Thought-keywords (e.g. `'error: failed to load plan'` → 'plan' regex → wrong lane).
- **Mitigation in code:** `ORIGIN_LANE` map in `flow-direct/server.mjs:30-42`. Caller specifies `origin`. Map decides lane. No content inspection. Unknown origin defaults to `thought` (safe default — never accidentally promotes unverified data to Reality).

## V2 vulnerability — partially mitigated Night-1 (full mitigation Phase-3)

- **Threat:** Q5 quantization drift on SSM state replay.
- **Night-1 mitigation:** Daemon is stateless across restarts (replay is not implemented yet — events are written but the daemon doesn't reconstruct hidden state from checkpoints). No replay → no drift.
- **Phase-3 plan:** Add state checkpoints with `state_hash`; replay compares hash; mismatch → refuse or fall back to next-later checkpoint.

## Pre-flight required (NOT yet done)

Operator action gates this spine going live. From `00-CHARTER/CODEXA_PREFLIGHT_AE_COBRA.md`:

1. WSL2 with systemd enabled on Codexa
2. `/mnt/ae_flux` mounted (dedicated NVMe partition or Windows fallback)
3. `llama.cpp` built at `/opt/atomeons/llama.cpp/build/bin/llama-server`
4. Mamba 2.8B Q5_K_M GGUF at `/opt/atomeons/ae-cobra/models/ae-blackmamba-2.8b-Q5_K_M.gguf` (symlink to `bartowski/mamba-2.8b-hf-GGUF` Night-1 surrogate)
5. Bun installed system-wide
6. Run `rsync -a /mnt/c/AtomEons/Orange5/06-ORANGELLM/memory/ae-cobra/ /opt/atomeons/ae-cobra/`
7. `sudo cp systemd/ae-cobra.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now ae-cobra`
8. `bun smoke-test.mjs` → expect 6/6 green
9. Then I write receipt #018: `2026-06-XX-ae-cobra-night1-live.md`

## What this DOESN'T do (Night-1 honesty)

- No state checkpointing yet (Phase-3)
- No binary `.idx` sidecars for O(1) timestamp lookup yet (Phase-3 — linear scan adequate for ~10K events)
- No SQLite migration of Flux yet (Phase-3)
- No Graph Weaver running on top yet (separate W3 task)
- No N150 cockpit shadow cache yet (separate W2 task)
- CLR is K=1 only (Phase-5 brings K=5 with claim verification against Reality lane)
- No state_fork / state_merge primitives (Phase-4)
- No LoRA adapters (Archivist.lora / Strategist.lora — Phase-5+)

These are all spec-acknowledged Night-1 gaps. The spine is honest about what it ships.

## Mom's Law alignment

- Every file has a job. No padding.
- Origin-based classifier is in code from line 1 — V1 mitigation is structural, not a TODO.
- CLR rejects fake-green explicitly (`FAKE_GREEN` regex in `clr/verifier-k1.mjs:5`).
- Smoke test #4 explicitly verifies fake-green rejection — if Æ Cobra ever accepts a fake-green claim, the test fails.
- Server enforces loopback binding (Bun `hostname: '127.0.0.1'`) — never reachable from non-host.
- Frontier-Isolation Law preserved: Æ Cobra is reachable ONLY through OrangeLLM gateway → Mirage proxy. Never directly.

## Rollback

```bash
# Remove all spine files
rm -rf C:/AtomEons/Orange5/06-ORANGELLM/memory/ae-cobra/

# (Receipt itself can stay — it documents the attempt)
```

No state outside `06-ORANGELLM/memory/ae-cobra/` is touched. The AE_COBRA_FOUNDATION_SPEC.md (sibling) is unchanged.

## Hash chain

#017. Prior: #016 (preflight GO). Next expected: #018 (`ae-cobra-night1-live` after operator runs smoke-test green on Codexa).

---

**Mom is watching. The spine is honest about what it is and what it isn't.**
