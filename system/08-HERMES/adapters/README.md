# 08-HERMES / adapters

Hermes-gated tool adapters. Each file in this directory wraps an external MCP
server (or other host capability) and routes every verb call through the
Hermes daemon (`127.0.0.1:7430`) so all 8 LOOM gates run before the action
lands on the host.

> Hermes replaces the older "OpenClaw" concept. Bounded execution layer:
> every action by any LLM in the Orange5 superstack must hold a lease.

## Reach diagram

```
frontier model
      │   (tool-use turn — NEVER opens a socket to Hermes directly)
      ▼
06-ORANGELLM gateway  ──(POST /v1/hermes/action)──▶  Hermes daemon (127.0.0.1:7430)
      ▲                                                   │
      │                                                   │  runs 8 LOOM gates
adapter (this dir)  ─────────────────────────────────────┘  then calls the MCP tool
```

The adapters in this folder are invoked **inside trusted Orange5 processes**
(gateway, mission-runner, codexa). They are not part of the frontier model's
direct surface.

## Files

| File                  | MCP server wrapped              | Verbs                                                                                       |
|-----------------------|---------------------------------|---------------------------------------------------------------------------------------------|
| `playwright.mjs`      | `playwright-mcp`                | `click`, `fill`, `screenshot`, `navigate`                                                   |
| `computer-use.mjs`    | `computer-use-mcp`              | `screenshot` (low), `left_click` (medium), `right_click` (medium), `type` (medium), `key` (medium), `scroll` (low) |

(Chrome DevTools MCP adapter lives separately when added.)

### Hardened policy layer

`computer-use.mjs` adds a deterministic per-verb risk classifier
(`classifyVerb`, `RISK_BY_VERB`) and a local enforcement function
(`enforceLocalPolicy`) that runs **before** any Hermes round-trip. It
asserts:

- the verb is known to this adapter,
- the lease is well-formed and not expired,
- the verb is in `lease.allowed[]`,
- the verb is not in `lease.forbidden[]`,
- the wide forbidden tokens (`production_deploy`, `destructive_write`) do
  not block this verb's risk level,
- `lease.riskLevel` is at least as permissive as the verb's risk_level on
  the ladder `read_only < low < medium < high < destructive < production`.

Any failure throws `HermesAdapterError` with a stable `.code` and a
`.policy` field describing the verdict. Hermes re-checks all of this
server-side (Gate 5, `codexa_lease`); the adapter's local enforcement is
fail-fast and exists so refusals surface with the exact verb that failed
without burning a Hermes round-trip.

## Lease contract (recap)

Every verb requires a `lease` argument shaped like:

```js
{
  id: "lease_…",
  actor: "orangellm" | "codexa" | "mission-runner" | …,
  allowed: ["browser.click", "browser.fill", …],
  forbidden: [/* defaults auto-merged */],
  targetProject: "Orange5",
  riskLevel: "read_only" | "low" | "medium" | "high" | "destructive" | "production",
  expires_at: <epoch_ms>,
  requires_approval: boolean,
}
```

Defaults auto-merged into `forbidden`:

- `destructive_write`
- `production_deploy`
- `scope_expansion`
- `egress_unbounded`

## 8 LOOM gates (must all pass)

1. `order_schema` — order matches `orange.order.v1`
2. `report_schema` — report matches `orange.report.v1`
3. `receipt_spine` — `receipt_path` exists
4. `human_approval` — if `lease.requires_approval`, operator approved
5. `codexa_lease` — lease present and not expired
6. `openai_gateway` — call arrived via gateway, not raw frontier socket
7. `mcp_default` — adapter handshook with the MCP server
8. `false_green_guard` — status string has no fake-green words

## Error shape

Every verb throws `HermesAdapterError` on refusal or transport failure:

```js
class HermesAdapterError extends Error {
  code: string;            // stable refusal code, e.g. "operator_approval_required"
  status?: number;         // HTTP status from Hermes if applicable
  gates?: Array<{gate, pass, reason?}>;  // gate trace if Hermes returned one
  verb?: string;           // the verb that was being attempted
  cause?: unknown;         // underlying transport / parse error if any
}
```

Callers should branch on `.code` and surface `.gates` to the operator. Do
**not** silently retry — a refusal is a contract decision.

## Honest gaps

These are gaps in the **current adapter layer**, not in Hermes itself:

- **No implicit lease creation.** The adapter does not call `/v1/hermes/lease`
  on your behalf. You must mint a lease first and pass it in.
- **No browser context owned here.** This file talks to the Playwright MCP
  server through Hermes. If the MCP server is not running or not registered
  with the gateway, Gate 7 (`mcp_default`) fails and the adapter throws with
  `code: "mcp_default_failed"`.
- **No egress allowlist enforced here.** `navigate({ url })` accepts any
  well-formed absolute URL at the adapter layer. Egress restriction lives
  in the lease (`forbidden: ["egress_unbounded"]` by default) and in the
  network layer; do not assume the adapter rejects arbitrary hosts.
- **No screenshot routing to the receipt spine.** `screenshot()` returns
  whatever the MCP server produced (base64 inline or on-disk path) under
  `mcp_response`. If you need the image archived as a receipt, the caller
  must move it to the receipt spine.
- **Coordinate clicks are fragile.** `click({ x, y })` is page-relative
  pixels. If the page scrolled or resized between the actor's measurement
  and Hermes landing the action, the click may land on a different element.
  Prefer `fill({ selector, text })` and selector-based clicks when the MCP
  server supports them.
- **Node 20+ only.** Uses global `fetch` and `AbortController`. No external
  npm deps.
- **Single-process clock.** Lease expiry is enforced by the Hermes daemon's
  `Date.now()`. If two daemons run against the same lease DB the behavior is
  undefined — run exactly one Hermes daemon per box.
