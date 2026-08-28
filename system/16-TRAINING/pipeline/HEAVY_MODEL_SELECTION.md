# Heavy Model Selection — OrangeLLM Fatty

**Decision date:** 2026-06-23
**Sovereign:** Atom McCree
**Default heavy model:** **`qwen3:30b-a3b`**
**Upgrade target:** Custom 70B LoRA fine-tuned on Orange5 system corpus (cloud GPU)

---

## Why `qwen3:30b-a3b` is the default

| Reason | Detail |
|---|---|
| Already warm on Codexa | `active_council` pulse confirms it stays warm. Zero cold-start cost. |
| 30B A3B = mixture-of-experts | ~3B active params per token while having 30B total — fast inference on CPU. |
| Fits comfortably in 95.6 GB RAM | ~17 GB at Q4_0, leaves 70+ GB for Docker stack + browser workers + heavy queries. |
| Strong instruction following | Tested at AEC2 + Orange4 levels; passes mission-style prompts cleanly. |
| Tool-use friendly | Returns clean JSON when prompted with schema (matches `orange.order.v1`). |
| No GPU required for inference | Codexa has no NVIDIA. CPU inference via Ollama is the practical default. |

## Models considered + rejected (with reason)

| Model | Verdict | Reason |
|---|---|---|
| `dolphin3:8b` | Wildcard, not PM | Personality model; great for Misfit lane, wrong for PM. |
| `qwen3:4b` | Reflex only | Too small for sustained PM reasoning. Already in `light` tier role. |
| `mistral-small:24b` | Event-armed alternate | Solid; loses to qwen3:30b-a3b on tool-use eval. Kept as fallback. |
| `deepseek-r1:32b` | Reasoning specialist | Strong but slow; better as on-demand judge in TriLane. |
| `llama3.1:8b-abliterated` | Wildcard | Smaller, less filter — Misfit territory. |
| `llama3.3:70b` | Warrant-only | Powerful but 42 GB RAM footprint cuts into headroom. Use only on explicit operator warrant. |
| `deepseek-r1:70b` | Warrant-only | Same — RAM cost too high for always-hot PM duty. |

## Promotion path

1. **Today** — `qwen3:30b-a3b` serves as the heavy default. Tagged `orangellm-fatty-codexa-default-2026-06-23`.
2. **After PR-15 (training infra)** — operator triggers training pass on the 2,200-row Orange5 corpus.
3. **LoRA target** — fine-tune onto a 32B-70B base on cloud GPU lane (RunPod / Modal / Vast.ai — operator picks).
4. **Eval gate** — bakeoff vs `qwen3:30b-a3b` on:
   - Mission-shape compliance (orange.order.v1 in, orange.report.v1 out)
   - Doctrine recall (27 Guardrails, AE0-AE14, 9-Gate)
   - Topology recall (ports, hosts, configs)
   - Receipt grounding (does it cite real receipts?)
   - Refusal of out-of-scope requests
5. **Promotion** — only if new LoRA beats default on ≥4 of 5 dimensions, AND operator approves.
6. **Demotion** — if eval regression appears on any dimension, fall back to `qwen3:30b-a3b`. No silent promotion.

## Gateway config

In `06-ORANGELLM/server/upstream.mjs`:

```js
heavy: {
  name: "fatty-codexa",
  base_url: "http://10.0.99.1:11434",       // direct Ollama
  fallback: { base_url: "http://10.0.99.1:8097" },  // Codexa command rail
  model: "qwen3:30b-a3b",
  timeout_ms: 120_000,
}
```

Gateway probes both paths. Direct Ollama wins if reachable. Command rail is fallback. If neither is live, gateway returns 502 `heavy_unreachable` and operator sees it in `/healthz`.

## Cost

| Item | Cost |
|---|---|
| Today (inference) | Already paid (Ollama on Codexa, no per-query cost). |
| First LoRA pass | Cloud GPU rental — operator picks vendor; expect $5-50 depending on base + corpus size. |
| Ongoing | Inference free on Codexa; only retraining costs cloud GPU. |

## What this is NOT

- Not a paid subscription model.
- Not a frontier model (frontier is BYO in Atomic Orange, isolated by PR-02 boundary).
- Not Smart Skinny (that's the light reflex tier on N150).
- Not the Misfit Model (separate project, separate corpus, separate trainer).

---

**Mom is watching. Default named. Upgrade path defined. Bakeoff gated.**
