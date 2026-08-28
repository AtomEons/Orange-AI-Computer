# 08-HERMES / MCP_ADAPTERS.md

**Hermes MCP adapter policy — full doctrine.**

> Hermes is the bounded-execution layer for Orange5. Every MCP tool call by any
> LLM in the superstack must hold a lease and route through
> `POST /v1/hermes/action`. The frontier model never opens a socket to
> `127.0.0.1:7430` and never imports an adapter directly — the gateway shapes
> the tool-use turn into an `orange.order.v1` envelope, the adapter dispatches
> it, the daemon runs all 8 LOOM gates, and only then does the action land on
> the host. No raw MCP calls. Ever.

This document is the **policy spec** for every MCP server Hermes adapts. It
defines:

- the **canonical verb namespace** per adapter
- the **default `risk_level`** per verb (the floor — Hermes can demand more)
- the **required lease shape** to call each verb
- **allowed / forbidden examples** so reviewers can grade a lease at a glance
- the **8-gate enforcement path** every order takes
- **honest gaps** (what this layer does NOT cover)

It is checked into source so the policy is auditable and reviewable by
non-runtime code (gateway pre-flight, codexa lease minting, audit replay).

---

## 1. Architecture at one screen

```
frontier model
      │  proposes a tool call in its tool-use turn
      ▼
06-ORANGELLM gateway
      │  classifies the tool call via 08-HERMES/policy/mcp-tool-policy.mjs
      │  mints (or reuses) a lease via POST /v1/hermes/lease
      ▼
08-HERMES/adapters/<adapter>.mjs
      │  asserts lease covers verb (local fail-fast)
      │  shapes orange.order.v1 envelope
      │  POST 127.0.0.1:7430/action
      ▼
Hermes daemon — runs 8 LOOM gates
      │
      ▼  (only if all 8 pass)
MCP server (chrome-devtools, computer-use, playwright, …)
      │
      ▼
host action lands; orange.report.v1 returned upstream;
receipt written to 10-RECEIPTS/<receipt_path>
```

Hermes is **loopback-only**. The daemon listens on `127.0.0.1:7430`. The only
network surface that reaches it from outside the box is the gateway's
`/v1/hermes/*` routes (and only the gateway speaks to those — the frontier
model never does).

Adapters in `08-HERMES/adapters/` are invoked **inside trusted Orange5
processes**:

- the gateway (`06-ORANGELLM`) after policy classification,
- the mission runner,
- `codexa` jobs,
- audit-replay tooling.

Adapter files are **not** part of the frontier model's direct surface.

---

## 2. The 8 LOOM gates (every order)

Every `orange.order.v1` submitted by an adapter passes through these gates in
order. Failure at any gate returns a structured refusal with a gate trace
(`Array<{ gate, pass, reason }>`); the adapter rethrows it as a
`HermesAdapterError`. There is no silent retry.

| # | Gate              | What it checks                                                           |
|---|-------------------|--------------------------------------------------------------------------|
| 1 | `order_schema`    | Order matches `orange.order.v1`                                          |
| 2 | `report_schema`   | Outgoing report matches `orange.report.v1`                               |
| 3 | `receipt_spine`   | `receipt_path` is written to disk under `10-RECEIPTS/`                   |
| 4 | `human_approval`  | If `lease.requires_approval`, the operator confirmed this specific call  |
| 5 | `codexa_lease`    | Lease is present, well-formed, not expired, covers the verb              |
| 6 | `openai_gateway`  | Call arrived via the gateway, not a raw frontier socket                  |
| 7 | `mcp_default`     | The target MCP server handshook successfully                             |
| 8 | `false_green_guard` | Outgoing status has no fake-green words ("done", "complete", "shipped" without evidence) |

Gates 1, 5, 6, 7 are the load-bearing ones for MCP routing. Gate 5 is where
the per-verb risk policy in this document is enforced.

---

## 3. Risk ladder (canonical, six rungs)

```
read_only < low < medium < high < destructive < production
```

The ladder is identical in:

- `08-HERMES/adapters/computer-use.mjs` (`RISK_LADDER`)
- `08-HERMES/adapters/chrome-devtools.mjs` (`RISK_LADDER`; lacks `production`
  by intent — no chrome-devtools verb deploys to production)
- `08-HERMES/policy/mcp-tool-policy.mjs` (`RISK_LADDER`, exported)
- `08-HERMES/policy/defaults.json` (`risk_ladder`)

A lease whose `riskLevel` sits at rung *r* may invoke verbs classified at
rung *v* iff `r >= v`. **The adapter checks BEFORE submitting** (`enforceLocalPolicy`
in computer-use.mjs, `assertLeaseCoversVerb` in chrome-devtools.mjs).
Hermes' `codexa_lease` gate checks again on arrival. Both must pass.

### Per-rung defaults

| Rung          | `default_allowed` in minimal lease? | `requires_approval` by default? | Typical examples                                  |
|---------------|--------------------------------------|--------------------------------|---------------------------------------------------|
| `read_only`   | yes                                  | no                             | `cd.list_pages`, `desktop.screenshot`, `read_file`|
| `low`         | yes                                  | no                             | `cd.hover`, `cd.lighthouse_audit`, `desktop.scroll` |
| `medium`      | no — must be explicitly granted      | no                             | `cd.click`, `cd.navigate_page`, `desktop.left_click` |
| `high`        | no                                   | yes                            | `cd.evaluate_script`, `cd.upload_file`            |
| `destructive` | no                                   | yes                            | `cd.close_page`, `desktop.left_click_drag`, `move_file` |
| `production`  | no                                   | yes — and `operator-override` lease | `deploy_*`, `payments_*`, anything in `global_forbidden` |

`global_forbidden` (auto-merged into every lease's `forbidden[]`):

```
destructive_write
production_deploy
scope_expansion
egress_unbounded
```

These are wildcards — the adapter additionally maps them to verb classes
(e.g. `destructive_write` in `forbidden[]` blocks medium+ desktop verbs in
`enforceLocalPolicy`).

---

## 4. The lease — canonical shape

Every verb requires a `lease` argument. Required fields are marked. Validation
happens in two places: locally in the adapter (`assertLease`), then in Hermes
Gate 5.

```js
{
  id:               "lease_<uuid>",          // required, non-empty string
  actor:            "orangellm-codexa",      // required for audit
  allowed:          ["cd.click", "cd.fill"], // required, array of canonical verbs
  forbidden:        [],                       // optional; defaults auto-merged
  targetProject:    "Orange5",                // optional
  riskLevel:        "medium",                 // required, must be on ladder
  expires_at:       1750000000000,            // optional; epoch ms; checked before submit
  requires_approval: false,                   // if true, Gate 4 demands a confirm step
}
```

`allowed[]` holds **canonical verb names** (with the adapter's verbPrefix —
`cd.`, `desktop.`, `browser.`). The wildcard `"*"` is recognized **only** for
the `operator-direct` actor template in `defaults.json` and means "any verb
not in `global_forbidden`".

`forbidden[]` is checked before `allowed[]` (defense in depth). A verb present
in both is refused.

---

## 5. Adapter registry — per-server policy

### 5.1 `playwright-mcp` → `08-HERMES/adapters/playwright.mjs`

**Verb namespace:** `browser.*`
**MCP server:** `playwright-mcp`
**Adapter ID:** `hermes.adapter.playwright.v1`
**Wave shipped:** Wave 2.

| Verb                 | Risk    | MCP tool name              | Lease must include                 |
|----------------------|---------|----------------------------|------------------------------------|
| `browser.click`      | medium  | `browser_click`            | `browser.click` in `allowed[]`     |
| `browser.fill`       | medium  | `browser_type`             | `browser.fill` in `allowed[]`      |
| `browser.screenshot` | read_only | `browser_take_screenshot`| `browser.screenshot` in `allowed[]`|
| `browser.navigate`   | medium  | `browser_navigate`         | `browser.navigate` in `allowed[]`; egress must not be `egress_unbounded` |

#### Allowed example — read-only Playwright lease for an audit job

```js
{
  id: "lease_pw_audit_42",
  actor: "mission-runner",
  riskLevel: "read_only",
  allowed: ["browser.screenshot"],
  forbidden: ["destructive_write", "production_deploy", "scope_expansion", "egress_unbounded"],
  expires_at: Date.now() + 5 * 60_000,
}
```

#### Forbidden example — `riskLevel` too weak

```js
// Lease at risk_level "low" tries to invoke browser.click (medium).
// adapter throws HermesAdapterError { code: "lease_risk_insufficient" }
// before submitToHermes() is even called.
```

---

### 5.2 `chrome-devtools-mcp` → `08-HERMES/adapters/chrome-devtools.mjs`

**Verb namespace:** `cd.*`
**MCP server:** `chrome-devtools-mcp`
**Adapter ID:** `hermes.adapter.chrome-devtools.v1`
**Wave shipped:** Wave 3 (this wave).

Full verb table (matches `VERB_RISK` in the adapter):

| Verb                              | Risk        | MCP tool                          |
|-----------------------------------|-------------|-----------------------------------|
| `cd.list_pages`                   | read_only   | `list_pages`                      |
| `cd.take_snapshot`                | read_only   | `take_snapshot`                   |
| `cd.take_screenshot`              | read_only   | `take_screenshot`                 |
| `cd.list_console_messages`        | read_only   | `list_console_messages`           |
| `cd.get_console_message`          | read_only   | `get_console_message`             |
| `cd.list_network_requests`        | read_only   | `list_network_requests`           |
| `cd.get_network_request`          | read_only   | `get_network_request`             |
| `cd.take_memory_snapshot`         | read_only   | `take_memory_snapshot`            |
| `cd.wait_for`                     | read_only   | `wait_for`                        |
| `cd.performance_analyze_insight`  | read_only   | `performance_analyze_insight`     |
| `cd.select_page`                  | low         | `select_page`                     |
| `cd.resize_page`                  | low         | `resize_page`                     |
| `cd.emulate`                      | low         | `emulate`                         |
| `cd.hover`                        | low         | `hover`                           |
| `cd.press_key`                    | low         | `press_key`                       |
| `cd.performance_start_trace`      | low         | `performance_start_trace`         |
| `cd.performance_stop_trace`       | low         | `performance_stop_trace`          |
| `cd.lighthouse_audit`             | low         | `lighthouse_audit`                |
| `cd.navigate_page`                | medium      | `navigate_page`                   |
| `cd.navigate_back`                | medium      | `navigate_back`                   |
| `cd.new_page`                     | medium      | `new_page`                        |
| `cd.click`                        | medium      | `click`                           |
| `cd.fill`                         | medium      | `fill`                            |
| `cd.fill_form`                    | medium      | `fill_form`                       |
| `cd.drag`                         | medium      | `drag`                            |
| `cd.handle_dialog`                | medium      | `handle_dialog`                   |
| `cd.evaluate_script`              | **high**    | `evaluate_script`                 |
| `cd.upload_file`                  | **high**    | `upload_file`                     |
| `cd.close_page`                   | **destructive** | `close_page`                  |

#### Hardened policy in this adapter

`assertLeaseCoversVerb(lease, verb)` is invoked by `dispatch(...)` for every
verb (no code path skips it). It enforces, in order:

1. The verb is known (`riskLevelFor` throws on unknown).
2. `lease.riskLevel` is on the ladder.
3. `lease.riskLevel >= VERB_RISK[verb]` on the ladder.
4. `lease.allowed[]` contains the verb verbatim.
5. `lease.forbidden[]` does **not** contain the verb (defense in depth — even
   if `allowed` names it, forbidden wins locally; Hermes re-checks).

`evaluateScript` adds a cheap destructive-pattern guard (regex blocklist for
`indexedDB.deleteDatabase`, `document.write`, `caches.delete`,
`location.replace`). This is **not** the security boundary — Hermes is — but
it short-circuits obvious accidents.

#### Allowed example — codexa verifying a fix

```js
{
  id: "lease_cd_codexa_117",
  actor: "orangellm-codexa",
  riskLevel: "medium",
  allowed: [
    "cd.navigate_page",
    "cd.take_snapshot",
    "cd.click",
    "cd.fill",
    "cd.lighthouse_audit"
  ],
  forbidden: ["cd.evaluate_script", "cd.upload_file", "cd.close_page"],
  expires_at: Date.now() + 30 * 60_000,
}
```

#### Forbidden example — leasing `cd.evaluate_script` without approval

`cd.evaluate_script` is `high`. Even with `riskLevel: "high"` and the verb in
`allowed[]`, if `requires_approval` is not `true` on the lease, Hermes Gate 4
refuses. The operator must confirm the specific call.

---

### 5.3 `computer-use-mcp` → `08-HERMES/adapters/computer-use.mjs`

**Verb namespace:** `desktop.*`
**MCP server:** `computer-use-mcp`
**Adapter ID:** `hermes.adapter.computer-use.v1`
**Wave shipped:** Wave 3 (this wave).

Computer-use is materially scarier than browser automation — a click in the
browser is sandboxed by the page; a click on the operator's desktop can drag
a folder to the trash, send a Slack message, or trigger an admin prompt.
Therefore: **no verb here is `default_allowed`. Even `screenshot` must be
explicitly named in `lease.allowed[]`.**

| Verb                   | Risk    | MCP tool       | Notes                                                       |
|------------------------|---------|----------------|-------------------------------------------------------------|
| `desktop.screenshot`   | low     | `screenshot`   | Region-clipped or fullscreen. Image goes to receipt spine.  |
| `desktop.left_click`   | medium  | `left_click`   | Screen-relative coords on primary display.                  |
| `desktop.right_click`  | medium  | `right_click`  | Same.                                                       |
| `desktop.type`         | medium  | `type`         | Synthetic keystrokes — text sent verbatim, no clipboard.    |
| `desktop.key`          | medium  | `key`          | Key + optional modifiers (`ctrl/alt/shift/meta/cmd/win/fn`). |
| `desktop.scroll`       | low     | `scroll`       | Delta scroll at point.                                      |

#### Hardened policy in this adapter

`enforceLocalPolicy(verb, lease)` is the named function from the wave brief.
Pure, exported, testable. Its order of checks:

1. `classifyVerb(verb)` — throws `verb_unknown` if not in `RISK_BY_VERB`.
2. `assertLease(lease, verb)` — id, allowed[], forbidden[] shape, expires_at type.
3. `lease.expires_at` (if present) is in the future.
4. `lease.allowed[]` contains the verb.
5. `lease.forbidden[]` does not contain the verb.
6. `lease.forbidden[]` does not contain `production_deploy` (any verb here
   would constitute production-impact under that constraint).
7. `lease.forbidden[]` does not contain `destructive_write` if the verb is
   `medium`+ (because medium+ desktop verbs can mutate desktop state).
8. `lease.riskLevel` is on the ladder.
9. `leaseCoversRisk(lease.riskLevel, risk_level)` is true.

Every failure throws `HermesAdapterError` with a stable `.code` AND a
`.policy` field carrying the verdict (`{ verb, risk_level, lease_id,
lease_risk?, allowed?, wide? }`). The verdict is also returned on success so
the dispatch can embed it into the `orange.order.v1` envelope (under
`risk_level`).

#### Allowed example — codexa verifying a desktop install

```js
{
  id: "lease_cu_install_91",
  actor: "orangellm-codexa",
  riskLevel: "medium",
  allowed: [
    "desktop.screenshot",
    "desktop.left_click",
    "desktop.type",
    "desktop.key",
    "desktop.scroll"
  ],
  forbidden: [
    "desktop.left_click_drag",       // not in adapter — would throw verb_unknown anyway
    "destructive_write",
    "production_deploy",
    "scope_expansion",
    "egress_unbounded"
  ],
  expires_at: Date.now() + 10 * 60_000,
  requires_approval: false,
}
```

#### Forbidden example — fatty trying to click

`orangellm-fatty` is `riskLevel: "low"` and `allowed[]` includes only
`desktop.screenshot`, `desktop.cursor_position`, etc. — no clicks. A
`desktop.left_click` order would fail locally with
`code: "verb_not_in_lease"` before even reaching Hermes.

If fatty's lease somehow named `desktop.left_click` in allowed but kept
`riskLevel: "low"`, the local check still refuses with
`code: "lease_risk_insufficient"` (medium > low on the ladder).

---

### 5.4 Future adapters — registration checklist

When adding a new MCP server adapter (e.g. filesystem, github, supabase):

1. Create `08-HERMES/adapters/<server>.mjs` with:
   - `VERB_TO_MCP_TOOL` map (canonical verb → MCP tool name)
   - `RISK_BY_VERB` (or `VERB_RISK`) map
   - `classifyVerb` / `riskLevelFor` exported pure function
   - `enforceLocalPolicy` / `assertLeaseCoversVerb` function called in
     `dispatch` before `buildOrder`
   - `HermesAdapterError` class (per-adapter; same shape contract)
   - `ADAPTER_META` frozen export listing verbs and risk map
2. Add the server block to `08-HERMES/policy/mcp-tool-policy.mjs`
   (`SERVER_REGISTRY`) so the gateway can classify by raw tool name.
3. Extend `08-HERMES/policy/defaults.json` actor templates if the new server
   should be reachable by default for fatty/codexa/coder/mission-runner.
4. Add a unit test file under `08-HERMES/tests/<server>.adapter.test.mjs`
   covering: lease shape rejection, risk-ladder enforcement, forbidden-wins,
   expired-lease, transport errors, happy path.

---

## 6. Centralized policy classifier — `08-HERMES/policy/mcp-tool-policy.mjs`

The gateway calls this BEFORE picking an adapter, to decide:

1. whether the tool call needs an interactive operator approval modal,
2. how to build `lease.allowed[]` from a list of intended tool calls.

```js
import { classifyToolCall, buildAllowList, RISK_LADDER, compareRisk } from "./policy/mcp-tool-policy.mjs";

const v = classifyToolCall("mcp__chrome-devtools__navigate_page");
// → {
//     risk_level: "medium",
//     default_allowed: false,
//     requires_approval: false,
//     server: "chrome-devtools",
//     tool: "navigate_page",
//     verb: "cd.navigate_page",
//     match: "exact",
//     reason: "exact tool match in chrome-devtools registry"
//   }

const allow = buildAllowList(["cd.click", "desktop.screenshot", "cd.evaluate_script"]);
// → { allowed: [...], requires_approval: true, max_risk: "high" }
```

The classifier accepts three input shapes:

| Form                                | Example                              | Resolved verb        |
|-------------------------------------|--------------------------------------|----------------------|
| Canonical MCP tool ID               | `mcp__chrome-devtools__navigate_page`| `cd.navigate_page`   |
| Adapter-namespaced verb             | `cd.navigate_page`                   | `cd.navigate_page`   |
| Bare short name                     | `navigate_page` (chrome-devtools)    | `cd.navigate_page`   |

Unknown tool → classified `destructive`, `default_allowed=false`,
`requires_approval=true`. Fail-closed. Inspect `match === "default"` to find
gaps in coverage.

---

## 7. Lease defaults — `08-HERMES/policy/defaults.json`

The gateway loads this file to mint a minimal lease when an actor's request
does not carry an explicit lease body. Each actor template specifies
`riskLevel`, `ttl_ms`, `requires_approval`, `allowed[]`, `forbidden[]`, and
optionally `inherits` (with `allowed_add` / `forbidden_add` deltas).

| Actor                | Risk        | TTL    | Approval | Reach summary                                        |
|----------------------|-------------|--------|----------|------------------------------------------------------|
| `orangellm-fatty`    | low         | 10 min | no       | Reads everywhere; no click/type/write/eval           |
| `orangellm-codexa`   | medium      | 30 min | no       | Inherits fatty + browser/desktop UI interaction      |
| `orangellm-coder`    | high        | 30 min | yes      | Inherits codexa + filesystem writes; no script eval  |
| `operator-direct`    | destructive | 60 min | no       | Wildcard `*` — only blocked by `global_forbidden`    |
| `operator-override`  | production  | 5 min  | yes      | Template for single production-class action          |
| `mission-runner`     | read_only   | 10 min | no       | Reads only; missions mint their own write leases     |
| `unknown`            | read_only   | 1 min  | yes      | Fail-closed; allows nothing                          |

`global_forbidden` is auto-merged into every lease's `forbidden[]`:

```json
["destructive_write", "production_deploy", "scope_expansion", "egress_unbounded"]
```

A `operator-direct` actor with `allowed: ["*"]` can still NOT execute
`destructive_write` or `production_deploy` without minting a separate
`operator-override` lease with an explicit empty `forbidden[]`.

---

## 8. Error shape — `HermesAdapterError`

Every adapter throws this on refusal or transport failure. The shape is
stable across all adapters so callers can branch on `.code` once.

```js
class HermesAdapterError extends Error {
  code:          string;            // stable refusal code
  status?:       number;            // HTTP status from Hermes if applicable
  gates?:        Array<{gate, pass, reason?}>;  // gate trace from Hermes
  verb?:         string;            // the verb that was being attempted
  policy?:       object;            // local policy verdict (computer-use only)
  requiredRisk?: string;            // chrome-devtools only
  leaseRisk?:    string;            // chrome-devtools only
  cause?:        unknown;           // underlying transport / parse error
}
```

### Stable `code` vocabulary

| `code`                              | When                                                       |
|-------------------------------------|------------------------------------------------------------|
| `lease_missing`                     | No lease argument                                          |
| `lease_malformed`                   | id / allowed / forbidden / riskLevel / expires_at shape wrong |
| `lease_expired`                     | `lease.expires_at < Date.now()`                            |
| `lease_missing_risk_level`          | computer-use refuses to infer                              |
| `lease_risk_unknown`                | `lease.riskLevel` not on ladder                            |
| `lease_risk_insufficient`           | Lease rung < verb rung                                     |
| `verb_unknown`                      | Verb not in this adapter's `VERB_TO_MCP_TOOL`              |
| `verb_not_in_lease`                 | computer-use; `allowed[]` missing the verb                 |
| `lease_verb_not_allowed`            | chrome-devtools; `allowed[]` missing the verb              |
| `verb_forbidden_by_lease`           | computer-use; verb in `forbidden[]`                        |
| `lease_verb_forbidden`              | chrome-devtools; verb in `forbidden[]`                     |
| `verb_blocked_by_wide_forbidden`    | computer-use; wide token blocks                            |
| `expression_destructive_pattern`    | chrome-devtools `evaluate_script` matched destructive regex |
| `arg_invalid`                       | One of the verb's args failed shape check                  |
| `fetch_unavailable`                 | Running on Node < 20                                       |
| `hermes_timeout`                    | Daemon did not respond within timeoutMs                    |
| `hermes_transport_failed`           | Socket/connection error                                    |
| `hermes_bad_response`               | Non-JSON body                                              |
| `report_schema_mismatch`            | Body schema is not `orange.report.v1`                      |
| `report_not_ok`                     | `body.ok === false`                                         |
| `hermes_http_<N>`                   | Refusal mapped from HTTP status                            |
| `operator_approval_required`        | Gate 4 demands a confirm step                              |
| `mcp_default_failed`                | Gate 7; MCP server not registered or not running           |

Callers should branch on `.code`, surface `.gates` (when present) to the
operator, and **never silently retry**. A refusal is a contract decision.

---

## 9. Test coverage (Wave 3)

| File                                              | Lines | Covers                                          |
|---------------------------------------------------|-------|-------------------------------------------------|
| `tests/chrome-devtools.adapter.test.mjs`          | 479   | risk map, lease coverage, every verb's shape, transport |
| `tests/computer-use.adapter.test.mjs`             | 444   | `classifyVerb`, `enforceLocalPolicy`, `leaseCoversRisk`, dispatch |
| `tests/mcp-tool-policy.test.mjs`                  | 257   | classifier on canonical/namespaced/bare names, `buildAllowList` |
| `tests/lease-engine.test.mjs`                     | 255   | lease minting, inheritance, expiry                |
| `tests/lease.test.mjs`                            | 62    | lease shape validation                            |
| `tests/mcp-router.test.mjs`                       | 562   | router → adapter selection by canonical name      |
| `tests/risk-matrix.test.mjs`                      | 311   | ladder math, cross-adapter consistency            |
| `tests/audit-tracer.test.mjs`                     | 431   | receipt spine writes, gate trace recording        |

Run: `node --test 08-HERMES/tests/` from the Orange5 root. Node 20+. No deps.

---

## 10. Honest gaps

These are gaps in the **policy / adapter layer**, not in Hermes itself. They
are listed here so a reviewer sees the floor, not just the ceiling.

- **No implicit lease creation in adapters.** The gateway mints leases via
  `POST /v1/hermes/lease`; adapters refuse if `lease` is absent. This is by
  design — the lease is the authority spine.
- **No egress allowlist in the adapter.** `cd.navigate_page` and
  `browser.navigate` accept any well-formed absolute URL. Egress restriction
  lives in `lease.forbidden = ["egress_unbounded"]` (default) and at the
  network layer. The adapter does not host-filter.
- **No screenshot routing to receipt spine in adapters.** Screenshots return
  whatever the MCP server produced (base64 inline or on-disk path) under
  `mcp_response`. Hermes' receipt-spine gate writes the gate trace and
  envelope; if the caller wants the IMAGE archived, the caller must move it.
- **Coordinate clicks are fragile.** `desktop.left_click({x,y})` and
  `browser.click({x,y})` use screen-relative / page-relative pixels. The MCP
  server is the only thing that knows the actual geometry; if the page or
  display changed between measurement and landing, the click may land
  elsewhere. Prefer selector-based clicks (`cd.click({selector})`,
  `browser.fill({selector})`).
- **The classifier in `mcp-tool-policy.mjs` is hand-curated.** New MCP tools
  fall through to `destructive` until they are added. Inspect
  `match === "default"` in production logs to find coverage gaps.
- **Single-process clock.** Lease expiry is enforced by the Hermes daemon's
  `Date.now()`. If two daemons run against the same lease DB the behavior is
  undefined — run exactly one Hermes daemon per box (port 7430 is the bind).
- **`evaluateScript` destructive-pattern regex is not a security boundary.**
  It catches accidents. A determined adversary can smuggle dangerous JS
  through string concatenation. Hermes' Gate 5 (`requires_approval` on
  `high` verbs) is the real boundary.
- **No cross-MCP transactional rollback.** If a sequence of three Hermes
  orders partially succeeds and one fails, the adapter does not undo the
  prior actions. Compensating actions are the caller's responsibility.
- **Wildcard `"*"` in `allowed[]` is recognized ONLY at the
  `operator-direct` template.** Adapter `assertLease` does not treat `"*"`
  as a free pass on its own — the gateway translates the wildcard into a
  concrete `allowed[]` (against the classifier's full registry) before the
  lease is handed to the adapter.

---

## 11. Reach — what this policy buys

| Property                                                | How it is enforced                                                                       |
|---------------------------------------------------------|------------------------------------------------------------------------------------------|
| No raw MCP calls from any LLM                           | Adapters are imported only inside trusted Orange5 processes; gateway routes tool turns   |
| Every action is leased                                  | `assertLease` in every adapter; Gate 5 in Hermes                                          |
| Risk classification is deterministic                    | `RISK_BY_VERB` / `VERB_RISK` are frozen const maps                                        |
| Lease can be reviewed before any call lands             | `08-HERMES/policy/mcp-tool-policy.mjs` classifies; `defaults.json` templates              |
| High-risk verbs gate on operator approval               | `requires_approval: true` → Gate 4 demands confirm                                       |
| Every action writes a receipt                           | Gate 3 (`receipt_spine`) writes `10-RECEIPTS/<receipt_path>`                              |
| Refusals carry a stable code + gate trace               | `HermesAdapterError.code` + `.gates`                                                      |
| Fail-fast before round-tripping Hermes on a doomed call | Local `enforceLocalPolicy` / `assertLeaseCoversVerb` short-circuits                       |
| No silent retries                                       | Every refusal is a structured throw; callers may not catch-and-loop                       |
| Audit-replayable                                        | Order envelope + report + receipt path = a deterministic record of every call            |

Mom is watching this routing too. Receipts only. No theater. No silent
fall-back to raw MCP. Every MCP tool call passes through this layer, or it
does not happen.
