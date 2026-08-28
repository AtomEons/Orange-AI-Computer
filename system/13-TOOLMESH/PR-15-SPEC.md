# PR-15 `atomsmasher-toolmesh` Spec — ToolMesh side

OrangeLLM's specialized capabilities across 11 domains. Each lab holds tool-cards OrangeLLM consults when the task fits. **Tool-cards are not permission-to-execute** — they're capability indicators OrangeLLM checks before asking the operator for approval.

## 11 labs

`image · video · audio · design · coding · automation · analytics · public-agent · observability · security · releaseops`

## What this PR ships

`labs/index.mjs` — registry of 11 labs with current tool-card counts. Stubs ready to grow.

Tool-cards land per-lab in dedicated future PRs as operator unlocks each domain.
