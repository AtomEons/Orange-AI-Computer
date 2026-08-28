# OrangeBrain Trained Adapter Promotion

This directory contains the real OrangeBrain LoRA produced in Colab. Its exact base is `unsloth/qwen2.5-32b-instruct-bnb-4bit` (Qwen2.5 32B Instruct), not the Qwen3 base recorded by the stale historical training receipt.

Promotion is deliberately two-stage:

1. `bun promotion-preflight.mjs` proves source hash, base family, architecture, LoRA shape, and completed training.
2. `codexa-convert-and-stage.ps1` converts the PEFT adapter to GGUF against the exact Qwen2.5 config and stages `orangebrain-trained:v0` on Codexa.

Staging never changes the live Navigator route. The candidate must pass the source-level report-contract bakeoff before promotion.

