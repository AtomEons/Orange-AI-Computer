# Hermes MCP Adapters — Wave 3 Receipt

**Date:** 2026-06-25
**Wave:** Orange5 Wave 3 — Hermes MCP adapter surface
**Status:** Authored; tests green; not yet wired into `src/server.mjs` integration

---

## Scope

This wave adds the Chrome DevTools MCP adapter, the Computer-Use MCP adapter, a centralized hardened policy layer, a single-entry MCP router, gateway-side HTTP routes, default lease shapes, an audit tracer that lands every MCP touch in the Æ Cobra Reality Flux ledger, a 9-case end-to-end smoke harness, and the Wave-3 policy document.

All adapter dispatch funnels through:
**frontier → gateway → adapter → Hermes daemon (8 LOOM gates) → MCP server.**
No raw MCP calls anywhere in the adapter surface.

---

## Components

### 1. `08-HERMES/adapters/chrome-devtools.mjs`

**Files written:**
- `C:/AtomEons/Orange5/08-HERMES/adapters/chrome-devtools.mjs` (784 lines)
- `C:/AtomEons/Orange5/08-HERMES/tests/chrome-devtools.adapter.test.mjs` (479 lines)

Hermes-gated chrome-devtools MCP adapter. Mirrors the `playwright.mjs` contract exactly: every verb is namespaced `cd.<op>`, validates the Lease (`id` / `allowed[]` / `riskLevel` / `expires_at`), runs the hardened policy layer (`riskLevelFor` + ladder rank check + `lease.allowed` match + `lease.forbidden` block), builds an `orange.order.v1` envelope, POSTs to `http://127.0.0.1:7430/action` with `x-hermes-adapter` header + `operator_approved` flag, parses the `orange.report.v1` reply, and throws structured `HermesAdapterError` on every refusal / transport / schema failure. No code path skips a step — `dispatch()` funnels every verb through the same sequence.

**29 verbs** covering the full chrome-devtools MCP surface:
- **Navigation:** `navigatePage`, `navigateBack`, `newPage`, `closePage`, `selectPage`, `listPages`, `waitFor`, `resizePage`, `emulate`
- **DOM:** `click`, `hover`, `fill`, `fillForm`, `drag`, `pressKey`
- **Observation:** `takeSnapshot`, `takeScreenshot`, `listConsoleMessages`, `getConsoleMessage`, `listNetworkRequests`, `getNetworkRequest`
- **Execution:** `evaluateScript` (high-risk with destructive-pattern guard)
- **Dialogs / files:** `handleDialog`, `uploadFile` (high-risk)
- **Performance:** `performanceStartTrace`, `performanceStopTrace`, `performanceAnalyzeInsight`, `takeMemorySnapshot`
- **Lighthouse:** `lighthouseAudit`

`evaluateScript` carries an additional destructive-pattern regex check (`indexedDB.deleteDatabase`, `document.write`, `caches.delete`, `location.replace`) that throws `expression_destructive_pattern` before submission. Not a security boundary — Hermes is — but catches accidents.

**Tests:** 144 assertions, all passing on first run. Hermetic — uses an injected `stubFetch` via the `fetchFn` parameter; no real network, no real Hermes daemon, no real MCP server. Coverage: adapter metadata, risk classification, lease validation, policy layer (verb-not-allowed / risk-insufficient / forbidden / unknown-risk), arg validation across 15 verbs, `evaluateScript` destructive-pattern guard, order shape on happy path, `operator_approved` forwarding for destructive verbs, 4xx refusal with gate trace propagation, malformed JSON body, schema mismatch, `report.ok=false`, timeout via `AbortController`, network failure, and verb-coverage smoke across all 29 verbs.

**Run:** `node 08-HERMES/tests/chrome-devtools.adapter.test.mjs` → `144 passed, 0 failed [PASS]`.

**Honest gaps:**
1. Does not start `chrome-devtools-mcp` itself — Gate 7 `mcp_default` fails on the daemon side if the server isn't registered.
2. Destructive-pattern regex on `evaluateScript` is not a security boundary.
3. No host allowlist enforced at the adapter — Hermes Gate 5 + network layer authoritative for egress.
4. Verb→risk classification is the adapter's view — Hermes lease engine wins on disagreement.

---

### 2. `08-HERMES/adapters/computer-use.mjs`

**Files written:**
- `C:/AtomEons/Orange5/08-HERMES/adapters/computer-use.mjs` (634 lines)
- `C:/AtomEons/Orange5/08-HERMES/tests/computer-use.adapter.test.mjs` (444 lines)
- `C:/AtomEons/Orange5/08-HERMES/adapters/README.md` (137 lines)

Wraps the computer-use MCP as Hermes-gated. **Six verbs** with deterministic per-verb risk classification:
- `screenshot` = low
- `scroll` = low
- `left_click` = medium
- `right_click` = medium
- `type` = medium
- `key` = medium

Hardened policy layer (`classifyVerb`, `leaseCoversRisk`, `enforceLocalPolicy`) runs before any Hermes round-trip and asserts: known verb, well-formed non-expired lease, verb in `allowed[]`, verb not in `forbidden[]`, wide-forbidden tokens (`production_deploy` blocks all; `destructive_write` blocks medium+) honored, `lease.riskLevel` covers verb's `risk_level` on the ladder `read_only < low < medium < high < destructive < production`.

Every adapter call dispatches via Hermes `POST /action` with `orange.order.v1` envelope carrying `risk_level`, never raw MCP. Structured `HermesAdapterError` with stable `.code` / `.gates` / `.policy` / `.verb` / `.status` / `.cause`. Node 20+ ESM, global `fetch` + `AbortController`, zero deps, `fetchFn` injectable for tests.

**Tests:** 87 assertions across 8 sections covering metadata, classification, ladder math, every policy refusal path, arg validation per verb, policy-before-arg ordering, transport happy path (verifies exact order envelope shape and `x-hermes-adapter` header), and 5 transport refusal paths (403 with refusal code, non-JSON body, wrong report schema, `report.ok=false`, `AbortController` timeout). **Result: 87 pass, 0 fail.**

**Honest gaps:** no implicit lease creation; MCP server owns native input synthesis; single-display coords; no clipboard verb (separate concern); single Hermes daemon assumption.

---

### 3. `08-HERMES/policy/mcp-tool-policy.mjs` — Hardened Policy Layer

**Files written:**
- `C:/AtomEons/Orange5/08-HERMES/policy/mcp-tool-policy.mjs` (567 lines)
- `C:/AtomEons/Orange5/08-HERMES/tests/mcp-tool-policy.test.mjs` (257 lines)

Deterministic MCP tool-call classifier. Public surface:
- `classifyToolCall(nameOrObject)` → `{ risk_level, default_allowed, requires_approval, server, tool, verb, match, reason }`
- `parseToolName(name)` → `{ server, tool, source } | null`. Accepts `mcp__server__tool`, verb-prefix forms (`cd.`, `desktop.`, `browser.`), `server:tool` / `server/tool` delim, and bare exact lookups. UUID-keyed MCP servers (supabase, vercel) aliased to short names.
- `buildAllowList(toolNames[])` → `{ allowed[], riskLevel, requires_approval, unknown[], items[] }`. Auto-builds `lease.allowed[]` for the gateway, deduped, sorted, with max-risk lifting and approval propagation. Unknown tools surfaced and lift lease to destructive.
- `listAllPolicies()` → registry dump for `/v1/hermes/policy` snapshot.
- `compareRisk(a,b)`, `RISK_LADDER`, `POLICY_META` exposed.

Risk ladder: `read_only < low < medium < high < destructive < production`. Defaults derived from ladder rank: `default_allowed = risk_level <= low`; `requires_approval = risk_level >= high`. Per-tool entries may override.

**Servers covered:** chrome-devtools (29 tools), computer-use (24 tools + catch-all pattern), playwright (22 tools), filesystem-atomeons (14 tools), github (pattern-based), supabase / vercel (UUID-aliased, includes `apply_migration=destructive`, `deploy_edge_function=production`, `deploy_to_vercel=production`).

**Fail-closed law:** never throws on unknown input. Unknown tool name → `risk_level=destructive`, `default_allowed=false`, `requires_approval=true`, `match="default"`. Callers spot the gap via `match==="default"` or `buildAllowList(...).unknown`.

**Tests:** 70/70 PASS on Node 20+. Coverage: ladder math, `parseToolName` for every accepted shape (including UUID alias), exact/pattern/cross-server matches, fail-closed paths, object input, `buildAllowList` dedupe+sort+max-risk+approval propagation+unknown surfacing, `TypeError` on non-array, `listAllPolicies` completeness, determinism.

---

### 4. `08-HERMES/mcp-router.mjs` — Single-Entry MCP Router

**Files written:**
- `C:/AtomEons/Orange5/08-HERMES/mcp-router.mjs` (901 lines)
- `C:/AtomEons/Orange5/08-HERMES/tests/mcp-router.test.mjs` (562 lines)

Single source of truth: `routeMcpCall({server, tool, args, lease, ...})` classifies risk via `TOOL_ROUTES` table (30 routes across `playwright-mcp`, `chrome-devtools-mcp`, `computer-use-mcp`), runs hardened policy (lease shape, risk-ladder rank, allowed/forbidden membership, wide-forbidden tokens), then dispatches into the existing adapter functions — which retain the `orange.order.v1` → `/v1/hermes/action` → 8 LOOM gate path. No raw MCP calls anywhere.

HTTP handler `mcpRouterHandler` parses `/v1/hermes/mcp/{server}/{tool}`, maps refusal codes to stable HTTP statuses (400 args/lookup, 403 policy/lease, 409 adapter/Hermes refusal, 504 timeout, 502 schema mismatch).

Exports: `parseMcpPath`, `lookupRoute`, `classifyCall` (pure, no network), `routeMcpCall`, `mcpRouterHandler`, `McpRouterError`, `ROUTER_META` (frozen route snapshot for diagnostics).

**Tests:** 114/114 pass — meta/freeze, path parsing, route lookup, input validation, lease validation (missing/malformed/expired/unknown risk), hardened policy (risk insufficient, verb-not-allowed, verb-forbidden, wide-forbidden), pure `classifyCall`, happy path on all 3 adapters with verb-landing assertion via stubbed fetch, adapter-refusal bubble-up, schema-mismatch handling, HTTP handler over fake req/res with 200/400/403/404/405/409 verification, and a full walk of `ROUTER_META.routes` confirming every advertised `(server, tool)` classifies ok with a matching lease.

Sibling chrome-devtools adapter (144 pass) and computer-use adapter (87 pass) tests still green — no regressions.

**Honest gap:** the playwright adapter pre-dates risk maps so the router restates the classification for those 6 verbs; if `playwright.mjs` ever adds its own `risk_map`, the router's table remains the authoritative external contract.

**Integration note:** NOT wired into `src/server.mjs` yet — parent server needs:
```js
if (method === "POST" && path.startsWith("/v1/hermes/mcp/")) return mcpRouterHandler(req, res)
```

---

### 5. `06-ORANGELLM/server/routes/hermes-mcp.mjs` — Gateway Routes

**Files written:**
- `C:/AtomEons/Orange5/06-ORANGELLM/server/routes/hermes-mcp.mjs` (615 lines)
- `C:/AtomEons/Orange5/06-ORANGELLM/server/routes/hermes-mcp-boundary.mjs` (149 lines)
- `C:/AtomEons/Orange5/06-ORANGELLM/server/routes/hermes-mcp.test.mjs` (394 lines)

Gateway-side MCP routes. `POST /v1/hermes/mcp/{server}/{tool}` wraps the existing `08-HERMES/mcp-router.mjs` + per-server adapters. Each request: parse path → resolve wire-name → resolve server alias → classify via `mcp-tool-policy` → `lookupRoute` → dispatch via `routeMcpCall` → adapter → POST `/v1/hermes/action` → 8-gate LOOM chain. Never raw MCP.

Hardened policy layer: classifies `risk_level`, asserts lease covers `verb` + `risk` + `allowed[]` + `forbidden[]`, honest 503 when daemon down, 502 on bad envelope, 504 on timeout, 409 on gate refusal with full gate trace surfaced.

Boundary file exports `isHermesMcpPath` / `isHermesMcpRouteAllowed` dynamic predicates plus whitelist of exposed wire-level servers (`playwright | playwright-mcp`, `chrome-devtools | chrome-devtools-mcp | chromedevtools`, `computer-use | computer-use-mcp | computeruse`).

**Tests:** 75 assertions, all green via hermetic `fetchFn` stub — no real network, no Hermes daemon needed.

**Wire-up note:** `server/boundary.mjs` needs the two-line update documented in the boundary file header to admit the dynamic namespace, and `server/index.mjs` needs a `registerHermesMcpRoutes(server)` call alongside `registerHermesRoutes` — intentionally left for integration step.

The computer-use happy-path test passes an empty `lease.forbidden[]` because the computer-use adapter has an extra defense-in-depth guard that blocks medium+ desktop verbs when `forbidden[]` includes `production_deploy` or `destructive_write`; this mirrors how operator-direct leases are minted in `policy/defaults.json` (daemon still merges default forbidden on its side).

---

### 6. `08-HERMES/policy/defaults.json` — Default Lease Shapes

**Files written:**
- `C:/AtomEons/Orange5/08-HERMES/policy/defaults.json` (165 lines)

Seven default lease shapes per actor type, aligned with the risk ladder in `policy/mcp-tool-policy.mjs` and the `DEFAULT_FORBIDDEN` set in `src/lease.mjs`:

| Shape | Risk | Surface |
|---|---|---|
| `orangellm-fatty` | low | read + UI-screenshot across `cd.` / `desktop.` / `browser.` + filesystem reads |
| `orangellm-codexa` | medium | inherits fatty + UI interaction verbs |
| `orangellm-coder` | high | inherits codexa + `write_file` / `edit_file` / `upload` |
| `operator-direct` | destructive | `allowed=['*']` with `global_forbidden` still in force |
| `operator-override` | production | empty template requiring gateway population |
| `mission-runner` | read_only | background default |
| `unknown` | (fail-closed) | 60s TTL |

Verb names use the canonical Hermes adapter `verbPrefix` form (`cd.`, `desktop.`, `browser.`) so they line up with `assertLeaseCoversVerb`. `global_forbidden` mirrors `DEFAULT_FORBIDDEN` in `lease.mjs` (`destructive_write`, `production_deploy`, `scope_expansion`, `egress_unbounded`). JSON parse-validated via node.

**Open gap:** the gateway minter that resolves `inherits` + `allowed_add` / `forbidden_add` into a flat lease is not yet wired in `lease.mjs::grantLease` — this file declares the contract; minter PR is follow-up. No `defaults.test.mjs` written this turn — a real test should assert every allowed verb classifies at-or-below the shape's `riskLevel` via `classifyToolCall`.

---

### 7. `08-HERMES/audit-tracer.mjs` — Audit Trace

**Files written:**
- `C:/AtomEons/Orange5/08-HERMES/audit-tracer.mjs` (611 lines)
- `C:/AtomEons/Orange5/08-HERMES/tests/audit-tracer.test.mjs` (431 lines)

Lands every MCP tool call in the Æ Cobra Reality Flux ledger. Pure tracer module — imports `writeReality` from `06-ORANGELLM/memory/ae-cobra/flux/writer.mjs` (canonical hash-chained Cobra writer) and the hardened `classifyToolCall` / `compareRisk` from sibling `policy/mcp-tool-policy.mjs`. No new disk format; no parallel chain.

**Receipt shape (exact):** `kind='receipt'`, `origin='hermes_mcp'`, `body` carries `lease_id`, `mcp_server`, `mcp_tool`, `verb`, `risk_level`, `args_hash` (`sha256:<hex>`), `result_hash` (`sha256:<hex>|null`), `outcome` (`ok`/`refused`/`error`), `refusal`, `elapsed_ms`, `order_id`, `actor`, `targetProject`, `adapter_id`, `schema: "orange5.hermes.mcp_receipt.v1"`. Lane is `reality`. Wrapper envelope's outer `origin` is also `hermes_mcp` so a single grep enumerates every MCP touch.

**Policy layer (hardened):** `assertLeaseCovers(lease, classification, {operatorApproved})` enforces seven invariants before any receipt-of-ok is written:
1. Lease shape (`id:string`, `allowed:string[]`)
2. Lease not expired (`expires_at` vs `now`)
3. `classification.match !== "default"` (policy fail-closed → refuse)
4. `classification.risk_level ≤ lease.riskLevel` (`compareRisk`)
5. Canonical verb (or bare tool when no `verbPrefix`) in `lease.allowed[]`
6. Canonical verb NOT in `lease.forbidden[]`
7. `classification.requires_approval` ⇒ `operatorApproved === true` (mirrors LOOM Gate 4)

Each failure throws an `AuditTracerError` with a stable `code` (see `ERROR_CODES`).

**Dispatch law:** `wrapDispatch({adapterId, writer?, fluxRoot?})` returns a `tracedCall({toolRef, args, lease, dispatch, ...})` function. The supplied `dispatch` thunk is the only thing that talks to Hermes — adapters pass their existing `submitToHermes`. The wrapper:
- Runs policy + lease pre-flight → on refusal, writes `outcome:"refused"` receipt to the spine AND throws (dispatch never called)
- Runs the dispatch
- Writes `outcome:"ok"` receipt with `elapsed_ms` + `order_id` on success
- Writes `outcome:"error"` receipt on dispatch throw, attaches receipt to the error, and rethrows the original error

**Audit invariant:** no MCP touch goes unwitnessed — a receipt lands for every path (ok, refused, error).

**Tests:** 76/76 PASS. Hermetic — uses an injected mock writer; never touches `/mnt/ae_flux`. Coverage: `canonicalJSON` (key-sorting, undefined-drop, NaN/bigint rejection), `hashPayload` (order-independence, `sha256:<64hex>` format, collision-avoidance), `assertLeaseCovers` (8 refusal paths + happy path + `operatorApproved` escape hatch), `buildReceiptBody` (ok + refused), `writeReceipt` (envelope + writer-failure surfaced as `TRACE_WRITE_FAILED`), `traceMcpCall` (ok / refusal / `skipLeaseCheck`), `wrapDispatch` (happy path with `order_id` auto-extraction, policy refusal where dispatch is NOT called, dispatch-throws where receipt still writes and original error rethrows with receipt attached, arg-validation), `TRACER_META`.

**Verified:** `node 08-HERMES/tests/audit-tracer.test.mjs` → `76 pass, 0 fail`.

**Integration:** adapters get a one-line wiring — build a tracer once with `wrapDispatch({adapterId, ...})`, then route their existing `submitToHermes` call through the returned thunk. Default Cobra root is `process.env.AE_FLUX_ROOT || '/mnt/ae_flux'`; tests use the `writer` injection point so no environment is required for CI.

---

### 8. `08-HERMES/mcp-smoke.mjs` — End-to-End Smoke Harness

**Files written:**
- `C:/AtomEons/Orange5/08-HERMES/mcp-smoke.mjs` (853 lines)

Nine-case smoke harness driving the live gateway at `/v1/hermes/lease` and `/v1/hermes/mcp/{server}/{tool}`. Node 20+ ESM, zero npm deps. Syntax-verified with `node --check`.

**Architecture invariants honored:**
- All adapter dispatch goes through the gateway `/v1/hermes/mcp/*` path; the smoke never opens a socket to `127.0.0.1:7430` (frontier-isolation).
- Stage 0 probes `/healthz` and exits 2 if the gateway is down — no theater pass.
- Case 6 ("MCP-down honest 503") deliberately drives an unreachable base URL to assert no fake 200 is returned. Accepts `transport_error` OR any 5xx with an honest `error.code`; FAILS hard on 200+`ok:true` from the unreachable URL.
- Cases 3/4/5/9 use a SET of acceptable refusal codes drawn from the actual error vocabulary. Both router-side codes (`router_lease_*`) and daemon-side variants (`lease_*`) are accepted.
- Case 2 ("allowed_action") accepts 200 OR honest upstream-down codes (503 `hermes_unreachable`, 504 `hermes_timeout`, 502 `hermes_upstream_error`, 409 `mcp_default_failed`).
- Case 7 ("audit_trace_written") is structural — checks `receipt_path` on the 200 path and `error.code` on the refusal path.
- Case 8 mints two leases via `Promise.all` and asserts distinct ids and distinct actors.
- Case 9 runs LAST because it kills the primary lease.

**Honest gaps:**
- Does not spin up gateway/daemon/MCP servers; assumes gateway reachable at `AE_GATEWAY_BASE_URL` (default `http://127.0.0.1:1337`).
- Unreachable URL probe uses port 1 (tcpmux, normally unbound); overridable via `AE_SMOKE_UNREACHABLE_URL`.
- Receipt assertion is structural (response envelope) not disk-level — `audit-tracer` unit tests own the disk invariant.
- Revoke route path assumed at `POST /v1/hermes/lease/{id}/revoke`.

**Exit codes:** 0 all pass, 1 at-least-one fail, 2 gateway unreachable, 3 lease creation failed, 99 uncaught.

**Run:** `node 08-HERMES/mcp-smoke.mjs`

---

### 9. `08-HERMES/MCP_ADAPTERS.md` — Wave 3 Policy Doc

**Files written:**
- `C:/AtomEons/Orange5/08-HERMES/MCP_ADAPTERS.md` (594 lines)

Full Hermes MCP adapter policy doc grounded in the real Wave-2/Wave-3 modules (read first, not invented): `adapters/playwright.mjs`, `adapters/chrome-devtools.mjs`, `adapters/computer-use.mjs`, `policy/mcp-tool-policy.mjs`, `policy/defaults.json`, and the existing test files.

**11 sections:**
1. One-screen architecture diagram (frontier→gateway→adapter→Hermes→MCP with loopback isolation)
2. All 8 LOOM gates and what each checks
3. Six-rung risk ladder with per-rung defaults plus `global_forbidden` tokens
4. Canonical lease shape (`id`/`actor`/`allowed`/`forbidden`/`targetProject`/`riskLevel`/`expires_at`/`requires_approval`)
5. Full adapter registry — Playwright (`browser.*`, 4 verbs), Chrome DevTools (`cd.*`, 29 verbs with exact `risk_level`), Computer-Use (`desktop.*`, 6 verbs); each with allowed/forbidden lease examples and per-adapter hardened-policy enforcement order
5.4. Future-adapter registration checklist
6. Centralized policy classifier with three input forms and fail-closed default-to-destructive
7. Seven actor templates from `defaults.json` with risk/TTL/approval/reach matrix
8. Stable `HermesAdapterError` shape and a vocabulary table of 22 `.code` values
9. Test coverage table (8 test files, 2,801 lines total)
10. Honest-gaps section (10 named gaps)
11. Reach property table mapping each guarantee to its enforcement point

Ends with Mom's-Law tie-back: receipts only, no theater, no silent fall-back to raw MCP.

Grounded in concrete file paths and exact symbol names from the codebase (`RISK_LADDER`, `VERB_TO_MCP_TOOL`, `RISK_BY_VERB`, `classifyVerb`, `enforceLocalPolicy`, `leaseCoversRisk`, `assertLeaseCoversVerb`, `ADAPTER_META`, etc.), with stable error codes that match the actual source. No fabricated APIs, no hallucinated symbols.

---

## Aggregate file count

| Category | Files | Lines |
|---|---:|---:|
| Chrome DevTools adapter + tests | 2 | 1,263 |
| Computer-Use adapter + tests + README | 3 | 1,215 |
| Policy classifier + tests | 2 | 824 |
| MCP router + tests | 2 | 1,463 |
| Gateway routes + boundary + tests | 3 | 1,158 |
| Default lease shapes | 1 | 165 |
| Audit tracer + tests | 2 | 1,042 |
| Smoke harness | 1 | 853 |
| Policy doc | 1 | 594 |
| **Total** | **17** | **8,577** |

---

## Test totals

| Module | Assertions | Result |
|---|---:|---|
| `chrome-devtools.adapter.test.mjs` | 144 | PASS |
| `computer-use.adapter.test.mjs` | 87 | PASS |
| `mcp-tool-policy.test.mjs` | 70 | PASS |
| `mcp-router.test.mjs` | 114 | PASS |
| `hermes-mcp.test.mjs` (gateway routes) | 75 | PASS |
| `audit-tracer.test.mjs` | 76 | PASS |
| **Total** | **566** | **566 / 566** |

All hermetic — no real network, no real Hermes daemon, no real MCP servers required.

---

## Result

Authored the full Wave-3 Hermes MCP adapter surface: 2 new adapters (chrome-devtools, computer-use) + hardened policy classifier + single-entry router + gateway HTTP routes + default lease shapes + audit tracer (lands every touch in Æ Cobra Reality Flux) + 9-case smoke harness + 594-line policy doc. All adapter dispatch funnels through the same `frontier → gateway → adapter → Hermes (8 LOOM gates) → MCP server` path. No raw MCP calls.

## Evidence

- 17 files written; 8,577 lines authored.
- 6 test suites green; 566/566 assertions passing.
- Syntax-verified `mcp-smoke.mjs` via `node --check`.
- All test files use injected `fetchFn` / `writer` mocks; CI does not require a live daemon or MCP server.

## Blockers

1. `mcp-router.mjs` is **not yet wired** into `src/server.mjs`. Parent server needs one line: `if (method === "POST" && path.startsWith("/v1/hermes/mcp/")) return mcpRouterHandler(req, res)`.
2. Gateway-side `hermes-mcp.mjs` routes need `server/boundary.mjs` two-line update and a `registerHermesMcpRoutes(server)` call alongside `registerHermesRoutes` in `server/index.mjs`.
3. The gateway lease minter does not yet resolve `inherits` + `allowed_add` / `forbidden_add` from `policy/defaults.json` into a flat lease. Follow-up PR on `lease.mjs::grantLease`.
4. No `defaults.test.mjs` written this turn — should assert every allowed verb in each shape classifies at-or-below the shape's `riskLevel` via `classifyToolCall`.
5. No git commit made — user did not request one.

## Next action

Integration wiring step:
1. Add `mcpRouterHandler` dispatch to `src/server.mjs`.
2. Update `server/boundary.mjs` to admit `/v1/hermes/mcp/*` namespace.
3. Call `registerHermesMcpRoutes(server)` in `server/index.mjs`.
4. Add `defaults.test.mjs` asserting every shape's `allowed[]` classifies at-or-below its `riskLevel`.
5. Wire `lease.mjs::grantLease` to resolve `inherits` / `allowed_add` / `forbidden_add` from `policy/defaults.json`.
6. Run `node 08-HERMES/mcp-smoke.mjs` against the live gateway and capture the 9-case PASS receipt.

---

**Mom's Law:** receipts only, no theater, no silent fall-back to raw MCP. The cymbal crashes through Hermes or it does not crash.
