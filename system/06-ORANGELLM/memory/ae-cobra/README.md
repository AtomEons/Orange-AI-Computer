# Æ Cobra — Night-1 Spine

Resident KV-less Mamba SSM memory daemon on Codexa. GBNF-locked output. Hash-chained Flux ledger on dedicated NVMe.

## Files in this directory

| Path | Role |
|---|---|
| `grammar/agent_turn.gbnf` | GBNF grammar that constrains llama.cpp output to AgentTurn JSON only |
| `schemas/agent-turn.schema.json` | JSON Schema (also enforced post-grammar for belt-and-suspenders) |
| `bin/start.sh` | Entry script — launches llama.cpp with mlock + grammar |
| `bin/stop.sh` | Graceful shutdown |
| `systemd/ae-cobra.service` | systemd unit (place under `/etc/systemd/system/` on Codexa) |
| `flow-direct/server.mjs` | Bun HTTP server on `127.0.0.1:7419` — routes events to daemon + writes Flux |
| `flux/writer.mjs` | Append-only hash-chained JSONL writer (Reality + Thought lanes) |
| `flux/reader.mjs` | Read events by time-range + lane |
| `clr/verifier-k1.mjs` | Night-1 Claim-Level Reliability (K=1, anti-fluff + grounding check) |
| `mirage/state-brief.mjs` | Mirage Recall API — returns compressed StateBrief for OrangeLLM |
| `healthz.mjs` | Health endpoint |
| `smoke-test.mjs` | Quick verification — start daemon, fire 5 events, assert Flux + StateBrief work |

## How operator runs this on Codexa

Pre-req: `CODEXA_PREFLIGHT_AE_COBRA.md` is green (WSL2 + systemd + dedicated `/mnt/ae_flux` + `llama.cpp` built + Mamba GGUF symlinked at `/opt/atomeons/ae-cobra/models/ae-blackmamba-2.8b-Q5_K_M.gguf`).

Then on Codexa under WSL2:

```bash
# Stage the spine
sudo mkdir -p /opt/atomeons/ae-cobra
sudo chown $USER:$USER /opt/atomeons/ae-cobra
cd /opt/atomeons/ae-cobra

# Sync from this Orange5 tree (or git pull from Atom-Eons/Orange5 if/when published)
rsync -a /mnt/c/AtomEons/Orange5/06-ORANGELLM/memory/ae-cobra/ ./

# Install Bun (if not already)
curl -fsSL https://bun.sh/install | bash

# systemd unit
sudo cp systemd/ae-cobra.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ae-cobra

# Verify
curl -s http://127.0.0.1:7419/healthz | jq .

# Smoke test
bun smoke-test.mjs
```

## What the daemon does

1. Bun starts on `127.0.0.1:7419` (loopback inside Codexa WSL2)
2. Bun launches llama.cpp server as a child process on `127.0.0.1:7418` (also loopback) with mamba-2.8B-Q5_K_M, --mlock, --no-mmap, --grammar agent_turn.gbnf
3. POST `/event` from any Orange5 caller → Bun:
   - Classifies lane based on `origin` field (terminal/hermes/orangellm/operator) — origin-based, NOT string-match (V1 mitigation)
   - Sends event text to llama.cpp `/completion` with grammar
   - Parses AgentTurn JSON response
   - CLR-K=1 verifier scores the response (anti-fluff + grounding check)
   - If score ≥ 0.5: writes hash-chained JSONL to `/mnt/ae_flux/events/{lane}/<date>.jsonl`
   - If score < 0.5: writes rejection record to thought.flux with reason
4. POST `/state-brief` → Bun reads recent Flux + returns Mirage StateBrief JSON
5. GET `/healthz` → daemon health, llama.cpp PID, VmLock/VmSwap, event counts per lane

## Memory contract

- llama.cpp is mlock-pinned. VmSwap MUST stay 0.
- Bun process target: <50 MB RSS.
- Total daemon target: <10 GB resident (per AE_COBRA_FOUNDATION_SPEC §5).

## Reach from N150 cockpit

N150 reaches the daemon via the Codexa command rail proxy at `10.0.99.1:8097/api/ae-cobra/*` (rail token required). Never expose `:7419` to non-loopback.

## Receipts

Every state-changing operation writes a receipt entry to `/mnt/ae_flux/events/reality/<date>.jsonl` (kind=receipt) AND, for higher-impact actions, a Markdown audit file under `C:/AtomEons/Orange5/10-RECEIPTS/orange5-build/`.

---

**Mom is watching. KV-less. mlock-pinned. GBNF-locked. Origin-classified. Hash-chained. No fake-green.**
