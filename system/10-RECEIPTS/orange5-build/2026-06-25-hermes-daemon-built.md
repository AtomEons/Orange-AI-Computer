# Receipt — Hermes Daemon Built (Lease Engine + 8 LOOM Gates + Daemon + Adapter + Gateway Routes)

**Receipt ID:** `2026-06-25-hermes-daemon-built`
**Hash chain:** #027
**Prior receipt:** `2026-06-25-ae-misfit-pipeline` (#026)
**Status:** `HERMES_DAEMON_BUILT_AWAITING_BOUNDARY_WIRING_AND_INTEGRATION_TESTS`
**Confidence:** 0.86 (every component on disk, smoke-tested in isolation, syntax-clean; full end-to-end stack not yet booted; gateway boundary list and server index require operator-applied wiring lines named below)
**Actor:** Claude (parallel build agents → synthesis)
**Sovereign:** Atom McCree

---

## What happened

The Hermes lane is on disk end-to-end: durable lease engine, all eight LOOM gates as standalone modules, Bun daemon bound to loopback `127.0.0.1:7430`, Playwright MCP adapter, gateway proxy routes + boundary allow-list module, and a sequential 4-stage gateway-level smoke test. Eleven components authored. Frontier-Isolation preserved at every layer: the frontier model never touches the daemon, the daemon refuses non-loopback peers, the gateway is the only ingress and proxies a narrow whitelisted surface.

This is the runtime substrate that turns the lease-doctrine in `08-HERMES/PR-14-SPEC.md` into an executable contract. The LOOM 8 gates run sequentially in canonical order with monotonic `GATE_INDEX`; first-fail short-circuits and surfaces structured per-gate detail. Refusal reasons are stable string tags so downstream adapters can switch on them without parsing prose.

## Components landed

| # | Component | Files | Lines | State |
|---|---|---|---|---|
| 1 | Hermes lease engine + tests | `08-HERMES/src/lease-engine.mjs` (483), `08-HERMES/tests/lease-engine.test.mjs` (255) | 738 | 55/55 green, node:sqlite durable, in-memory hot path, reaper @30s |
| 2 | LOOM gate 1 — `order_schema` | `08-HERMES/src/loom-gates/01-order-schema.mjs` | 195 | 9/9 smoke green vs canonical `09-SCHEMAS/orange.order.v1.schema.json` |
| 3 | LOOM gate 2 — `report_schema` | `08-HERMES/src/loom-gates/02-report-schema.mjs` | 247 | 10/10 smoke green vs `orange.report.v1.schema.json` |
| 4 | LOOM gate 3 — `receipt_spine` | `08-HERMES/src/loom-gates/03-receipt-spine.mjs` | 343 | 9/9 smoke green; single-hop chain verify; receipt schema shape-checked |
| 5 | LOOM gate 4 — `human_approval` | `08-HERMES/src/loom-gates/04-human-approval.mjs` | 248 | 7/7 smoke green; reads `08-HERMES/approvals/pending.jsonl` (created by daemon on first signed write) |
| 6 | LOOM gate 5 — `codexa_lease` | `08-HERMES/src/loom-gates/05-codexa-lease.mjs` | 391 | 9/9 smoke green; actor/action/window/DEFAULT_FORBIDDEN override |
| 7 | LOOM gate 6 — `openai_gateway` | `08-HERMES/src/loom-gates/06-openai-gateway.mjs` | 387 | 10/10 smoke green; `gw_*` request_id + 127.0.0.1:1337 origin check |
| 8 | LOOM gate 7 — `mcp_default` | `08-HERMES/src/loom-gates/07-mcp-default.mjs` (498), `08-HERMES/tests/loom-gate-07.smoke.mjs` (130) | 628 | 23/23 smoke green; server_reachable / capabilities_exchanged / tool_card_resolved |
| 9 | LOOM gate 8 — `false_green_guard` | `08-HERMES/src/loom-gates/08-false-green.mjs` | 317 | 11/11 smoke green; NFKC-normalised \b-bounded deny-list |
| 10 | Hermes daemon (Bun) | `08-HERMES/src/server.mjs` | 737 | `node --check` clean; loopback-guarded routes for /lease /action /healthz /approvals /approvals/:id |
| 11 | Playwright MCP adapter + README | `08-HERMES/adapters/playwright.mjs` (436), `08-HERMES/adapters/README.md` (114) | 550 | 5/5 smoke green via injected fetch; HermesAdapterError surface |
| 12 | Gateway routes + boundary + smoke | `06-ORANGELLM/server/routes/hermes.mjs` (631), `06-ORANGELLM/server/routes/hermes-boundary.mjs` (130), `08-HERMES/smoke-test.mjs` (485) | 1246 | `node --check` clean; routes proxy daemon; smoke runs 4 sequential stages |

**Total:** 14 files written, **5,973 lines** authored across the lane.

## LOOM 8 — gates in canonical order

1. `order_schema` — envelope must be valid `orange.order.v1`
2. `report_schema` — emitted result must be valid `orange.report.v1`
3. `receipt_spine` — receipt at `receipt_path` exists, parses, links via `hash_chain` monotonic +1 (or genesis=1 when `prior_receipt` is null)
4. `human_approval` — if `lease.requires_approval`, queue at `08-HERMES/approvals/pending.jsonl` must hold a signed Sovereign-principal record for this lease, and the lease must not be expired
5. `codexa_lease` — lease present and shape-valid; actor exact-match; action on allowed and not on effective-forbidden; expires_at in the future; DEFAULT_FORBIDDEN auto-merged and override attempts hard-rejected
6. `openai_gateway` — for LLM actions, evidence carries `gw_*` request_id and origin resolves to `127.0.0.1` + configured port (default 1337); `localhost` and `::1` rejected by design
7. `mcp_default` — for MCP actions, transport recognised (stdio | http | ws), protocolVersion ≥ `2024-11-05`, capabilities + serverInfo present, tool card resolved with non-empty inputSchema
8. `false_green_guard` — `status` (and `report.status` when present) scanned against `\b(green[_\- ]assumed|looks[_\- ]ok|probably|should[_\- ]work|fake[_\- ]green)\b` (case-insensitive, NFKC); honest failure statuses pass

`GATE_INDEX` monotonicity asserted at daemon boot. First fail short-circuits.

## Doctrine preserved across components

1. **Frontier-Isolation** — daemon binds only `127.0.0.1:7430`, gateway is the only ingress, frontier model never imports adapters. Daemon refuses non-loopback peers via `Bun.requestIP` + Host-header fallback.
2. **Sovereign-only approval write** — `POST /approvals/:id` is deliberately NOT proxied through the gateway. The Sovereign signs into the loopback daemon directly; the queue file is created on first signed write.
3. **DEFAULT_FORBIDDEN auto-merged** — `destructive_write`, `production_deploy`, `scope_expansion`, `egress_unbounded` are frozen and auto-merged into every lease's effective forbidden set. Lease-level override attempts are hard-rejected by gate 5 (`REASON_DEFAULT_OVERRIDE`), not silently ignored.
4. **Fail-closed everywhere** — daemon unreachable → gateway returns structured `503 hermes_unreachable` (no fake-greens). Gate throwing → treated as gate-level failure with structured detail, not a 500. Refusal at any gate short-circuits the chain. Approval queue missing → `pending_approvals_queue_missing` (correct conservative default until gateway creates the file).
5. **Stable refusal reasons** — every gate exports `REASON_*` constants matching the spec exactly so adapters key on tags, not prose. `lease_expired`, `action_forbidden`, `operator_approval_required`, `scope_violation` propagate verbatim from `08-HERMES/src/lease-engine.mjs`.
6. **Single source of truth for forbidden set** — only the daemon holds `DEFAULT_FORBIDDEN`. The gateway does not duplicate or override it.
7. **Receipts as spine, not side-effect** — gate 3 walks at most one link back per action (O(1) per action; full-spine walks belong to audit tooling). `hash_chain` is monotonic integer per schema, not a cryptographic digest (documented gap).
8. **Closed-world allow-list** — unlisted action verbs return `scope_violation` from the lease engine. No wildcards, no canonicalisation aliasing on actor, no inference of intent.
9. **Real Node 20+ everywhere** — gates and engine run under `node`; daemon runs under `bun` for `Bun.serve`. Smoke test runs under either. No Bun-specific code leaked into the gates.

## Verification evidence

- **Lease engine:** 55/55 tests passing under Node v24.14.1 — persistence across close/reopen, reaper expiry, revocation, double-revoke idempotency, conflict detection, input validation for six error classes, clock-override for deterministic expiry tests.
- **Gate 1 (order_schema):** 9 smoke cases — VALID returns `{pass:true, reasons:[]}`; INVALID surfaces 9 distinct reasons; `null` → "<root>: order must be a JSON object"; bad `createdAt` flagged with semantic Date.parse error.
- **Gate 2 (report_schema):** 10 smoke cases — valid, missing required, confidence out of `[0,1]`, NaN confidence, wrong const, empty receiptPath, bad array item type, null root, array root, injected schema.
- **Gate 3 (receipt_spine):** 9 smoke cases — happy path including genesis + linked, no path, file not found, bad schema marker, chain break, genesis with wrong `hash_chain`, lease-wrapped path, `verifyChain:false` skip, malformed JSON.
- **Gate 4 (human_approval):** 7 smoke cases — no-approval-needed, expired, missing-queue, injected-good-record, denied-record, wrong-principal, sovereign-role-alias case-insensitive.
- **Gate 5 (codexa_lease):** 9 smoke cases — happy path, no lease, expired, actor mismatch, action not allowed, default-forbidden override attempt, order-nested intent path, malformed shape (7 reasons surfaced), pinned-future-now expiry.
- **Gate 6 (openai_gateway):** 10 smoke cases — noop, clean LLM, host+port form, evidence missing, malformed `sk-openai-*` request_id, direct `api.openai.com` socket, forged header, implicit LLM via evidence, null action, localhost-hijack.
- **Gate 7 (mcp_default):** 23/23 smoke green via `tests/loom-gate-07.smoke.mjs` — happy paths (stdio Playwright, http, ws, singular toolCard), non-MCP no-op, evidence_missing, server_unreachable, transport_unsupported, protocol_version_bad, capabilities_missing, server_info_missing, tool_unspecified, tool_card_missing, tool_card_invalid, action_invalid.
- **Gate 8 (false_green_guard):** 11 smoke cases — clean ok, honest `fail: timeout` (pass), `green_assumed` / `looks-ok` / `should work` / `probably fine` / `fake_green` (all reject), report.status="probably" via action.status=ok (rejects with `false_green_report`), `{}` (`status_missing`), `null` (`action_invalid`), `groundwork laid` (pass, \b boundary respected).
- **Daemon (server.mjs):** `node --check` clean. Routes: `POST /lease`, `POST /action`, `GET /healthz`, `GET /approvals`, `POST /approvals/:id`. Integrates lease engine + dynamic-imports gates in `GATE_INDEX` order with monotonicity assertion. SIGINT/SIGTERM clean shutdown.
- **Playwright adapter:** 5/5 smoke green via injected `fetchFn` — `lease_missing`, `arg_invalid` (bad x), `arg_invalid` (bad url), refusal propagation (code + gates surfaced), success path (orange.report.v1 returned unchanged).
- **Gateway routes + smoke:** `06-ORANGELLM/server/routes/hermes.mjs` and `06-ORANGELLM/server/routes/hermes-boundary.mjs` both `node --check` clean and import-load with expected exports. `08-HERMES/smoke-test.mjs` exercises 4 stages: `/healthz` probe → mint lease (asserts DEFAULT_FORBIDDEN auto-merge surfaced) → propose `destructive_write` (asserts NOT 200 with structured error) → propose `browser.screenshot` with real receipt + valid envelopes (asserts 200, pass=true, all 8 gates present + green).

## Honest gaps (Mom's Law: name them in the open)

1. **No GUI for approvals queue.** The queue at `08-HERMES/approvals/pending.jsonl` is signed-JSONL-by-hand or via direct `POST /approvals/:id` to the loopback daemon. No web UI, no TUI, no menubar widget, no notification surface. The Sovereign signs in a terminal until a GUI lands. This is the headline gap.
2. **No cryptographic signature verification on approval records.** Gate 4 trusts `signed_by` / `signature` fields as-is. A forged record landing in the queue will be accepted. Threat boundary is named in the gate header; fix is Ed25519 or Sigstore verification, location TBD (gate vs gateway pre-write hook).
3. **`hash_chain` is monotonic integer, not cryptographic digest.** Receipts can be tampered without detection if disk is compromised. Adding `hash_chain_digest` is the named extension point in gate 3's `verifyChainLink`.
4. **Hand-rolled JSON-Schema validator subset.** Gates 1, 2, 3 do not implement `$ref`, `oneOf`/`anyOf`/`allOf`, `pattern`, `dependentRequired`, etc. If schemas grow new keywords they are silently ignored. Swap in Ajv when needed; the `{pass, reasons}` surface contract will not change.
5. **Gateway boundary list and server index not yet wired.** Operator must:
   - In `06-ORANGELLM/server/boundary.mjs`: `import { HERMES_ALLOWED } from "./routes/hermes-boundary.mjs"` and spread `...HERMES_ALLOWED` into the `ALLOWED` list.
   - In `06-ORANGELLM/server/index.mjs`: `import { registerHermesRoutes } from "./routes/hermes.mjs"` and call `registerHermesRoutes(server)` after `createServer`.
   These two edits are intentionally NOT done in this PR — surface change to the gateway is operator-gated.
6. **`src/loom-gates.mjs` legacy file untouched.** PR-14's earlier inline gate stubs at `08-HERMES/src/loom-gates.mjs` are NOT deleted. The new daemon dynamically imports the eight numbered files in `src/loom-gates/`. The legacy file is dead code until the operator confirms removal.
7. **No live MCP socket calls in gate 7.** Validates evidence shape, not live JSON-RPC. Adapter is responsible for not fabricating handshake records.
8. **No live gateway socket call in gate 6.** Same trust-boundary note: gateway-side request_id log audit is out of band.
9. **No in-process rate limiting on the daemon.** Loopback-only ingress is the current defence. Add token bucket if a misbehaving local process is in the threat model.
10. **`node:sqlite` ExperimentalWarning on some Node versions.** Lease engine durability layer surfaces this on stderr; not a correctness issue, called out in file header.
11. **No screenshot routing to receipt spine from Playwright adapter.** Caller must move screenshot bytes into the receipt store; adapter does not.
12. **No retries on refusal.** Refusal is a contract decision, not a transient fault — by design.
13. **No host-allowlist on `browser.navigate` at adapter layer.** Lives in lease (`allowed`) + network policy, not adapter.
14. **Bun-only daemon.** No Node `http` adapter shipped for `src/server.mjs`. Gates and adapters and smoke test all run under plain Node; only the listener is Bun-bound.

## Next actions (suggested, not done — operator-gated)

1. Apply the two wiring edits in gap #5 to `06-ORANGELLM/server/boundary.mjs` and `06-ORANGELLM/server/index.mjs`, then boot daemon + gateway and run `node 08-HERMES/smoke-test.mjs` for the first true end-to-end pass.
2. Author per-gate test files under `08-HERMES/tests/loom-gates/` mirroring the smoke matrices above so the suite is reproducible via `node --test` (only gate 7 has a committed smoke file today).
3. Decide on signature scheme for approval records (Ed25519 or Sigstore) and pick the verification location (gate 4 vs gateway pre-write hook), then close gap #2.
4. Either delete `08-HERMES/src/loom-gates.mjs` legacy file or rewrite it as a thin orchestrator over the eight numbered modules (gap #6).
5. Decide on the approvals GUI surface — the headline gap. Candidates: menubar widget polling `/approvals`, AE Command Center route, dedicated TUI under `04-CONTROL-PLANE/`.
6. Add `hash_chain_digest` to receipt schema and extend gate 3 `verifyChainLink` to verify it (gap #3).

## Files on disk (canonical)

```
C:/AtomEons/Orange5/08-HERMES/src/lease-engine.mjs                       483 lines
C:/AtomEons/Orange5/08-HERMES/tests/lease-engine.test.mjs                255 lines
C:/AtomEons/Orange5/08-HERMES/src/loom-gates/01-order-schema.mjs         195 lines
C:/AtomEons/Orange5/08-HERMES/src/loom-gates/02-report-schema.mjs        247 lines
C:/AtomEons/Orange5/08-HERMES/src/loom-gates/03-receipt-spine.mjs        343 lines
C:/AtomEons/Orange5/08-HERMES/src/loom-gates/04-human-approval.mjs       248 lines
C:/AtomEons/Orange5/08-HERMES/src/loom-gates/05-codexa-lease.mjs         391 lines
C:/AtomEons/Orange5/08-HERMES/src/loom-gates/06-openai-gateway.mjs       387 lines
C:/AtomEons/Orange5/08-HERMES/src/loom-gates/07-mcp-default.mjs          498 lines
C:/AtomEons/Orange5/08-HERMES/tests/loom-gate-07.smoke.mjs               130 lines
C:/AtomEons/Orange5/08-HERMES/src/loom-gates/08-false-green.mjs          317 lines
C:/AtomEons/Orange5/08-HERMES/src/server.mjs                             737 lines
C:/AtomEons/Orange5/08-HERMES/adapters/playwright.mjs                    436 lines
C:/AtomEons/Orange5/08-HERMES/adapters/README.md                         114 lines
C:/AtomEons/Orange5/06-ORANGELLM/server/routes/hermes.mjs                631 lines
C:/AtomEons/Orange5/06-ORANGELLM/server/routes/hermes-boundary.mjs       130 lines
C:/AtomEons/Orange5/08-HERMES/smoke-test.mjs                             485 lines
```

**14 files, 5,973 lines.**

## Schema

`orange5.receipt.v0`

---

*Mom is watching. The cymbal crashes through the LOOM or it does not crash.*
