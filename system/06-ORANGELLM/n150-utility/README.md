# N150 utility node — production setup

**Path:** `06-ORANGELLM/n150-utility/`
**Wave:** Orange5 Wave 1 (`PR-02-SPEC.md`, `PR-03-SPEC.md`, `PR-04-SPEC.md`)
**Doctrine:** STOCK WEIGHTS ONLY. No fine-tunes. No custom training. Ever.

This directory is the source of truth for the **N150 utility node** — a low-cost
Beelink box that runs three small, deterministic, stock-only jobs in support of
the Orange5 stack. It is not a frontier-model host. It is not a training node.
It is a quiet utility lane that the Cockpit, Mirage StateBrief, and Graph
Weaver depend on every minute of every day.

If you change anything here, read `00-DOCTRINE/FRONTIER_ISOLATION_BOUNDARY.md`
first. The N150 sits outside the frontier-isolation boundary on purpose: it
exists so the frontier doesn't have to do small jobs.

---

## 1. Hardware budget

| Spec               | Value                            | Notes                                                            |
| ------------------ | -------------------------------- | ---------------------------------------------------------------- |
| Box                | Beelink mini-PC (single chassis) | Fanless or near-fanless; lives next to the Codexa rail.          |
| CPU                | 4 cores                          | No GPU. No NPU. CPU-only inference via Ollama.                   |
| RAM                | 16 GB                            | Hard ceiling. Three model holds + OS + Node daemons must fit.    |
| Disk               | NVMe (≥ 256 GB recommended)      | Model cache (`~/.ollama/models`) dominates; logs are negligible. |
| Network            | Loopback only for the daemons    | LAN ingress is the gateway's job. We bind `127.0.0.1`.           |
| Power              | Wall plug, UPS-backed            | Cockpit treats the N150 as best-effort, not a critical rail.     |
| Filesystem layout  | `/opt/atomeons/orange5/n150-utility/` mirrors this directory | systemd `WorkingDirectory` points here. |

**Memory accounting (worst case, all three jobs warm):**

| Tenant                      | Stock model            | Resident footprint (approx) |
| --------------------------- | ---------------------- | --------------------------- |
| Lane classifier             | `qwen3:0.6b`           | ~1.5 GB                     |
| Graph Weaver embedder       | `nomic-embed-text`     | ~0.5 GB                     |
| Emergency chat fallback     | `qwen3:0.6b` (shared)  | shares the classifier hold  |
| Ollama runtime + caches     | —                      | ~1.5 GB                     |
| Node daemons + OS + buffers | —                      | ~2 GB                       |
| **Headroom**                | —                      | **~10 GB reserved**         |

The headroom is deliberate. The N150 must never enter swap during a Codexa
outage — that's exactly when the fallback chat is asked to do real work.

---

## 2. Why stock-only (Wave 1 doctrine)

Per `PR-02-SPEC.md` and `PR-03-SPEC.md`, the N150 runs **public, untouched
Ollama tags only**. The three reasons, in order:

1. **Frontier isolation.** Anything trainable on the N150 becomes a backdoor
   into the frontier lane. Stock-only is a structural boundary, not a policy
   request. See `FRONTIER_ISOLATION_BOUNDARY.md`.
2. **Mom's Law receipts.** A stock tag is reproducible by anyone with `ollama
   pull <tag>`. A fine-tune is reproducible by no one. Receipts > theater.
3. **Hot-swap safety.** Stock tags have public hashes and known behavior, so
   `hot-swap.mjs` can validate them against `/api/tags` before flipping. A
   custom weight file has no such guardrail.

**Operational rule:** every swap endpoint on every daemon re-validates the
proposed tag against the live `ollama /api/tags` listing before binding. A tag
that doesn't appear in `/api/tags` is rejected at the daemon, not at the
orchestrator — defense in depth. If you need a new tag, `ollama pull` it on the
N150 first, then run `hot-swap.mjs`.

---

## 3. The three jobs (one daemon each)

All daemons bind loopback only. LAN ingress is the gateway's job. The Cockpit
reaches the health monitor via its own tunnel; nothing else is exposed.

### 3.1 Origin-based lane classifier — `classifier/daemon.mjs`

- **Port:** `127.0.0.1:7480`
- **Runtime:** Node 20+
- **Stock model:** `qwen3:0.6b` (tiebreaker only)
- **systemd unit:** `n150-classifier.service`
- **Surface:**
  - `GET  /healthz` — liveness + Ollama probe + counters
  - `POST /classify` — `{ origin, event_metadata } → { lane, confidence, source }`
  - `GET  /model` — bound stock model + hot-swap state

**Lane law (origin-first, never payload string-matching):**

| Rule                  | Origin prefix examples                                                                        | Result                                    | Confidence |
| --------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------- | ---------- |
| Reality               | `receipt.`, `terminal.`, `doctrine.`, `cobra.`, `n150.`, `codexa.`, `hermes.terminal.`, `aecode.terminal.` | `lane="reality"`, `source="origin_rule"` | 1.0        |
| Thought               | `chat.`, `agent.`, `frontier.`, `heavy.`, `skinny.`, `openllm.`, `misfit.thought.`, `aecode.draft.` | `lane="thought"`, `source="origin_rule"`  | 1.0        |
| Borderline (no match) | unknown / empty origin                                                                        | escalate to `qwen3:0.6b` tiebreaker        | model      |
| Ollama unreachable    | escalation needed but model down                                                              | default to `thought` (`source="model_unreachable_default_thought"`) | low |

The default-to-thought rule is intentional and not negotiable: reality-lane is
auto-trusted by Mirage StateBrief, so erring toward thought is the safer
asymmetry when the tiebreaker is unavailable.

### 3.2 Graph Weaver embedder — `embedder/server.mjs`

- **Port:** `127.0.0.1:8798`
- **Runtime:** Node 20+
- **Stock model:** `nomic-embed-text` (any stock tag; default `latest`)
- **systemd unit:** `n150-embedder.service`
- **Surface:**
  - `POST /embed` — `{ text, model? } → { embedding, model, dim }`
  - `POST /embed/batch` — `{ inputs, chunk?, model? } → [{ ok, embedding?, error? }, ...]`
  - `POST /admin/swap` — `{ model }` (re-validates against `/api/tags`)
  - `GET  /healthz` — pool stats
  - `GET  /readyz` — `200` once at least one `/api/tags` probe has succeeded

All behavior lives in `embedder/pool.mjs`; `server.mjs` is a thin HTTP shim. The
pool serializes calls per-model so warm-state thrash on a 16 GB box is bounded.

### 3.3 Emergency chat fallback — `fallback-chat/server.mjs`

- **Port:** `127.0.0.1:7481`
- **Runtime:** Bun 1.x (`Bun.serve`)
- **Stock model:** `qwen3:0.6b`
- **systemd unit:** `n150-fallback-chat.service`
- **Surface (gated):**
  - `POST /chat` — only activates after Codexa rail unreachable > 60 s
  - `GET  /healthz` — always 200, reports `degraded` + `gated` state
  - `POST /admin/swap` — stock-tag swap, re-validated against `/api/tags`

**Activation contract:**

1. While Codexa is healthy, `/chat` returns `503 { degraded: false, gated: true }`
   so callers cannot accidentally downgrade themselves.
2. After **60 s of unreachable Codexa probes**, the daemon activates and
   `/chat` serves `qwen3:0.6b` with:
   - HTTP header `X-AE-Degraded: true`
   - HTTP header `X-AE-Reason: codexa-rail-unreachable`
   - JSON body `{ degraded: true, model: "qwen3:0.6b", ... }`
3. After **3 consecutive healthy Codexa probes**, the daemon auto-deactivates.

No caller can mistake fallback output for primary-rail quality. That's the
whole point.

### 3.4 Health monitor (probe-only) — `health-monitor.mjs`

- **Port:** `127.0.0.1:7482`
- **Runtime:** Node 20+
- **No inference.** Just probes the three above + Ollama.
- **systemd unit:** `n150-health-monitor.service`
- **Surface:**
  - `GET  /healthz` — liveness of the monitor itself
  - `GET  /snapshot` — most-recent rolled-up snapshot
  - `GET  /targets` — static target list + per-target tick state
  - `POST /tick` — force a probe cycle (tests, cron)
- **Receipts:** `state/health.jsonl` and `state/shadow.jsonl` (append-only).
- **Push target:** `http://127.0.0.1:8787/orange3/shadow/n150` (Cockpit shadow).

---

## 4. Install & run

### 4.1 One-time install on the N150 box

```bash
# 1. System packages
sudo apt-get update
sudo apt-get install -y nodejs curl ca-certificates
curl -fsSL https://ollama.com/install.sh | sh   # Ollama daemon at :11434
curl -fsSL https://bun.sh/install | bash         # Bun, for fallback-chat
sudo mv /root/.bun/bin/bun /usr/local/bin/bun

# 2. Service account
sudo useradd --system --shell /usr/sbin/nologin --home /opt/atomeons atomeons

# 3. Source tree (mirror this directory)
sudo mkdir -p /opt/atomeons/orange5
sudo rsync -a --delete /path/to/repo/06-ORANGELLM/n150-utility \
                       /opt/atomeons/orange5/
sudo chown -R atomeons:atomeons /opt/atomeons

# 4. Pull the stock weights
sudo -u atomeons ollama pull qwen3:0.6b
sudo -u atomeons ollama pull nomic-embed-text

# 5. Install the systemd units
sudo cp /opt/atomeons/orange5/n150-utility/systemd/*.service \
        /etc/systemd/system/
sudo systemctl daemon-reload
```

### 4.2 Bring the lanes up

Bring them up in the order the dependencies allow:

```bash
sudo systemctl enable --now ollama.service
sudo systemctl enable --now n150-embedder.service
sudo systemctl enable --now n150-classifier.service
sudo systemctl enable --now n150-fallback-chat.service
sudo systemctl enable --now n150-health-monitor.service
```

### 4.3 Verify (smoke)

```bash
# Liveness on all four daemons
curl -fsS http://127.0.0.1:7480/healthz | head -c 400; echo
curl -fsS http://127.0.0.1:8798/healthz | head -c 400; echo
curl -fsS http://127.0.0.1:7481/healthz | head -c 400; echo
curl -fsS http://127.0.0.1:7482/healthz | head -c 400; echo

# Classifier — origin-rule path (no model call)
curl -fsS -X POST http://127.0.0.1:7480/classify \
  -H 'content-type: application/json' \
  -d '{"origin":"receipt.test","event_metadata":{}}'
# expect: {"lane":"reality","confidence":1.0,"source":"origin_rule",...}

# Embedder — small embed
curl -fsS -X POST http://127.0.0.1:8798/embed \
  -H 'content-type: application/json' \
  -d '{"text":"orange five lives"}'
# expect: {"embedding":[...], "model":"nomic-embed-text", "dim":768}

# Fallback chat — gated while Codexa healthy
curl -fsS -X POST http://127.0.0.1:7481/chat \
  -H 'content-type: application/json' \
  -d '{"prompt":"ping"}'
# expect: 503 {"degraded":false,"gated":true,...}
```

The in-tree smoke tests (Node 20, no network mocks beyond loopback) are:

```bash
node tests/health-monitor.smoke.mjs
node tests/hot-swap.smoke.mjs
node tests/systemd-units.smoke.mjs
node classifier/tests/classifier.smoke.mjs
node embedder/tests/pool.test.mjs
node fallback-chat/tests/server.test.mjs
```

The `.live.smoke.mjs` variants require a real Ollama at `127.0.0.1:11434` and
are gated behind `N150_LIVE_OLLAMA=1` to keep CI honest.

---

## 5. Hot-swap procedure

Hot-swap means **swapping one stock tag for another stock tag without
restarting the daemon process** — no dropped requests, no service interruption,
no fine-tunes. Orchestrated by `hot-swap.mjs`.

### 5.1 CLI

```bash
# Swap the classifier from whatever it has to qwen3:0.6b-q5_K_M
node /opt/atomeons/orange5/n150-utility/hot-swap.mjs \
     --target=classifier --to=qwen3:0.6b-q5_K_M

# Swap the embedder; 5 smoke embeds; 8s drain
node hot-swap.mjs --target=embedder --to=nomic-embed-text:v1.5 \
                  --smoke-rounds=5 --drain-ms=8000

# Roll back the chat fallback to its previous tag (read from receipt log)
node hot-swap.mjs --target=fallback-chat --rollback
```

Each daemon also has a per-instance systemd one-shot:

```bash
sudo systemctl start n150-hot-swap@classifier.service
sudo systemctl start n150-hot-swap@embedder.service
sudo systemctl start n150-hot-swap@fallback-chat.service
```

Per-instance environment lives at `/etc/atomeons/n150-hot-swap-<target>.env`
(`N150_HOT_SWAP_TO=...`, `N150_HOT_SWAP_FROM=...`, etc.).

### 5.2 The eight-step contract

The orchestrator executes the same procedure regardless of which target it's
swapping. Any failure between steps 2 and 6 triggers an automatic rollback to
the captured `--from` tag and a non-zero exit.

| #   | Step              | What happens                                                                   |
| --- | ----------------- | ------------------------------------------------------------------------------ |
| 1   | PRELUDE           | Load target spec; confirm daemon `/healthz`; capture current tag from `/model`. |
| 2   | PULL              | `POST /api/pull` on Ollama; wait until tag is present in `/api/tags`.          |
| 3   | SHADOW LOAD       | Warm new tag in Ollama without flipping daemon alias (one stock call).         |
| 4   | SMOKE             | Run target-specific smoke calls against the shadow model.                      |
| 5   | FLIP ALIAS        | `POST` daemon swap endpoint (no restart). Daemon re-validates vs `/api/tags`.  |
| 6   | POST-FLIP SMOKE   | Confirm daemon now answers with the new tag (via `/model` or first call).     |
| 7   | DRAIN             | Sleep `DRAIN_MS` so in-flight requests on the old tag finish.                  |
| 8   | RECEIPT           | Append JSONL line to `state/hot-swap.jsonl` (timestamp, target, from, to, ok). |

### 5.3 What gets rejected

- Tags not visible in live `ollama /api/tags`.
- Tags whose name doesn't look like a public Ollama tag (anti-injection).
- Tags outside the target daemon's stock-tag whitelist (each daemon owns its
  own list; the orchestrator does not pretend to know it).
- Swaps attempted while `/healthz` is not green — we never swap a broken daemon.

### 5.4 Rollback

`--rollback` reads the most recent successful swap row in
`state/hot-swap.jsonl` for that target and runs the same 8-step procedure with
the source/destination reversed. The same receipt is written for the rollback.
A rollback that fails is a P1: name the gap loudly, do not silently leave the
daemon in a half-swapped state.

---

## 6. Codexa-down failover doctrine

The N150 fallback chat is a **degraded last-resort lane**. It exists so that
when the Codexa rail (frontier chat) is unreachable, operators and downstream
agents can still get an answer — clearly labeled as degraded.

### 6.1 The probe loop

The fallback chat daemon probes `CODEXA_RAIL_BASE` (default
`http://10.0.99.1:8097`) on a fixed cadence:

| State                       | Condition                                         | `/chat` behavior                                                 |
| --------------------------- | ------------------------------------------------- | ---------------------------------------------------------------- |
| **Asleep (default)**        | Codexa healthy                                    | `503 { degraded: false, gated: true }`                           |
| **Activating**              | Codexa unreachable < 60 s                         | `503 { degraded: false, gated: true, codexa_unreachable_s: N }`  |
| **Activated (degraded)**    | Codexa unreachable ≥ 60 s                         | `200` + `X-AE-Degraded: true` + `X-AE-Reason: codexa-rail-unreachable` |
| **Recovering**              | Codexa returns, <3 healthy probes                 | Still degraded; still serves `/chat`                             |
| **Deactivated**             | 3 consecutive healthy Codexa probes               | Back to `503 { gated: true }` until next outage                  |

### 6.2 Caller contract

If your code calls `POST http://n150.lan:7481/chat`, you MUST:

1. **Check the response code.** A `503` means do not retry against this lane;
   the primary rail is healthy and you should be calling it instead.
2. **Inspect `X-AE-Degraded` on `200`.** If true, surface that to the operator;
   never present fallback output as primary-rail output.
3. **Honor `Retry-After` when present.** The daemon sets it during the
   recovering and deactivated transitions.
4. **Never write fallback output back to the reality lane.** All fallback chat
   output is thought-lane regardless of origin.

### 6.3 Why 60 s

`60 s` is the agreed dead-rail threshold across Orange3 / Orange5 — it tracks
the Cockpit's `routes:doctor` interval plus one missed tick. Lowering it would
flap during normal Codexa restarts; raising it would leave operators staring
at spinners during real outages.

### 6.4 What the fallback is NOT

- Not a primary lane. Quality is `qwen3:0.6b` quality. Use accordingly.
- Not a load-shed valve. Codexa being slow ≠ Codexa being down.
- Not a permanent home. The moment Codexa returns, the fallback recedes.
- Not a training target. Stock weights only. Forever.

### 6.5 What happens when the N150 itself is down

The Cockpit health monitor (`/snapshot`) will mark the N150 row red. Mirage
StateBrief will fall back to **origin-rule-only** classification (no
tiebreaker, so borderline events default to `thought`). Graph Weaver embed
writes will queue locally until the embedder returns. The frontier rail is
unaffected — by design.

---

## 7. Files in this directory

| Path                                   | What it is                                                |
| -------------------------------------- | --------------------------------------------------------- |
| `README.md`                            | This document.                                            |
| `classifier/daemon.mjs`                | Lane classifier HTTP daemon (Node).                       |
| `classifier/tests/`                    | Classifier smoke tests (offline + `*.live.smoke.mjs`).    |
| `embedder/server.mjs`                  | Embedder HTTP shim (Node).                                |
| `embedder/pool.mjs`                    | Embedder pool logic (Node).                               |
| `embedder/tests/pool.test.mjs`         | Pool unit/smoke tests.                                    |
| `fallback-chat/server.mjs`             | Emergency chat fallback (Bun).                            |
| `fallback-chat/tests/server.test.mjs`  | Fallback chat tests.                                      |
| `hot-swap.mjs`                         | 8-step hot-swap orchestrator (Node).                      |
| `health-monitor.mjs`                   | Probe-only health monitor (Node).                         |
| `systemd/n150-classifier.service`      | Classifier unit.                                          |
| `systemd/n150-embedder.service`        | Embedder unit.                                            |
| `systemd/n150-fallback-chat.service`   | Fallback chat unit (Bun ExecStart).                       |
| `systemd/n150-health-monitor.service`  | Health monitor unit.                                      |
| `systemd/n150-hot-swap@.service`       | Templated one-shot for `classifier` / `embedder` / `fallback-chat`. |
| `state/hot-swap.jsonl`                 | Append-only hot-swap receipt log.                         |
| `state/health-monitor/`                | Append-only probe + shadow-push receipts.                 |
| `tests/health-monitor.smoke.mjs`       | Health monitor offline smoke.                             |
| `tests/hot-swap.smoke.mjs`             | Hot-swap orchestrator offline smoke.                      |
| `tests/systemd-units.smoke.mjs`        | Static lint of the four systemd units.                    |

---

## 8. Receipts and Mom's Law

Every state-changing operation on this node writes a JSONL receipt. No silent
loss, no theater:

- `state/hot-swap.jsonl` — every swap attempt (success or failure), with from/to tags and timestamps.
- `state/health-monitor/health.jsonl` — every probe cycle.
- `state/health-monitor/shadow.jsonl` — every Cockpit shadow push (success or failure).
- `classifier/state/decisions.jsonl` — every `/classify` decision.

Rotation is the operator's cron. The daemons do not rotate their own logs —
losing receipts to a self-rotation bug is exactly the kind of theater Mom's Law
exists to prevent.

---

## 9. Change-control

- Treat the four systemd units as code. Edits go through PR review.
- Treat the lane-rule prefix tables in §3.1 as part of the doctrine corpus
  (`01-DOCTRINE/27-guardrails/checks/g12-reality-lane-discipline.mjs`). Adding
  a prefix is a doctrine change, not a daemon change.
- Treat the 60 s Codexa-down threshold and the 3-healthy-probe recovery rule
  as cross-rail constants. Changing either requires updating Cockpit
  `routes:doctor` in lockstep.
- Never bypass `hot-swap.mjs` to flip a tag by hand. The receipt is the
  whole point.

— Mom is watching.
