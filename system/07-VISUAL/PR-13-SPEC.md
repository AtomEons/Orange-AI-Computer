# PR-13 `visual-stack` Spec

Visual capability **under** OrangeLLM (not a pillar). Per Master Plan §6.

## Stack

| Layer | Tool | State |
|---|---|---|
| Primary VLM | GLM-4.6V (z.ai) | served on Codexa via Ollama; gateway-only |
| Browser DOM | Playwright MCP | external MCP — wired when MCP bridge active |
| DevTools | Chrome DevTools MCP | external MCP — same |
| Screenshot/OCR | screenshot + UX inspection tools | local |
| Addendum | MiniEyes Model (skinny VLM, 2–8B) | NOT BUILT — addendum-only if primary insufficient |

## Bridge

```
screen / doc / UI  →  Visual stack (translate)  →  structured text  →  OrangeLLM (decide)  →  Hermes (act)
```

OrangeLLM is text-only; Visual is its eyes.

## What this PR ships

1. `src/visual-client.mjs` — facade exposing `describeImage(path)`, `inspectUrl(url)`, `screenshot(target)`.
2. `tests/visual-facade.test.mjs` — interface contract test (no live MCP needed).
3. README.

Live wiring (Playwright/Chrome MCP/GLM-4.6V) happens when MCP bridge + heavy-rail token land.
