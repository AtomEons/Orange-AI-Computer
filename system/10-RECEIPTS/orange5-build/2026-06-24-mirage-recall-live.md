# Receipt — Mirage Recall LIVE (gateway routes + shadow cache authored)

- **Receipt ID:** `2026-06-24-mirage-recall-live`
- **generated_at:** 2026-06-24T22:15:00-04:00
- **schema:** `orange5.receipt.v0`
- **actor:** Claude (Orange voice)
- **status:** `MIRAGE_RECALL_LIVE_GATEWAY_ROUTES_AND_SHADOW_CACHE_AUTHORED`
- **confidence:** HIGH on gateway routes, shadow-cache subsystem, middleware, cockpit chip, and adapter registry — every file is on disk, parses clean (`node --check` / PowerShell AST), and the READY adapters were exercised against real disk (receipts adapter pulled 3 real receipts; flux adapter degraded honestly with `cobra_unreachable_and_shadow_empty`). MEDIUM on end-to-end glue: `registerMemoryRoutes` is not yet imported by `server/index.mjs`, and the memory-inject middleware is authored but not yet wired into the inline `http.createServer` router. Both are named explicitly in blockers and require a separate splice change.
- **prior_receipt:** `2026-06-24-atomsmasher-commitment-atoms-live` (#019)
- **hash_chain:** #020

---

## Result

Mirage Recall is now an authored, parse-clean, locally-coherent surface across five components — gateway routes, an 11-mount adapter registry, the N150 shadow cache writer + reader + scheduler, an Express/Hono-style chat-completion injection middleware, and the Atomic Orange cockpit freshness chip. The Reality > Thought > Receipts ordering is enforced at every layer (route, middleware, cockpit). Degraded modes are honest: when Æ Cobra at `127.0.0.1:7419` is unreachable, the shadow cache at `06-ORANGELLM/memory/cache/` serves with `served_by=n150_shadow_cache, degraded=true`; when both planes are down, the routes return `503 memory_unavailable` and the middleware injects a tombstone system message rather than silently dropping the contract. Stale shadow >2h light `memory.stale` on `/healthz` and prepend `[MEMORY:STALE]` per Mom's Law.

---

## Components

| # | Component | Files | Lines | Status |
|---|---|---:|---:|---|
| 1 | `gateway-memory-routes` | 3 (`memory.mjs`, `memory-boundary.mjs`, `boundary.mjs`) | 680 | AUTHORED + boundary-allowed, NOT YET REGISTERED in `server/index.mjs` |
| 2 | `11-MIRAGE adapter registry skeleton` | 12 (`index.mjs` + 11 adapters) | 861 | REGISTRY READY; 3 of 11 adapters LIVE (flux, graph, receipts), 8 STUB Night-1 |
| 3 | `n150-shadow-cache-sync` | 5 (`sync.mjs`, `shadow-reader.mjs`, `shadow-state-brief.mjs`, `cron-windows.ps1`, `README.md`) | 1015 | AUTHORED; awaiting Windows Scheduled-Task install + rail endpoint confirmation |
| 4 | `memory-inject-middleware` | 1 (`memory-inject.mjs`) | 551 | AUTHORED + smoke-tested (pure-function); NOT YET WIRED into inline http router |
| 5 | `cockpit-memory-freshness-indicator` | 3 (`useMemoryFreshness.ts`, `MemoryFreshnessChip.tsx`, `README.md`) | 493 | AUTHORED as standalone splice patch into Atomic Orange ChromeBar |

**Total authored:** 24 files, 3600 lines of real code + docs across five surfaces. Zero placeholder TODOs in READY paths.

---

## Endpoint inventory

### Gateway (06-ORANGELLM, exposed on the OrangeLLM server)

| Method | Path | Behavior | Fallback |
|---|---|---|---|
| `POST` | `/v1/memory/state-brief` | Normalizes `{query, time_range_ms (1min..30d), lanes (reality\|thought\|receipt\|conflict), max_records (1..256), include_conflicts}`, POSTs to Æ Cobra `:7419/state-brief` with 1500ms AbortController. On success refreshes N150 shadow snapshot (tmp+rename atomic). | N150 shadow cache filtered by lane+window → `degraded=true, served_by=n150_shadow_cache`. Both down → `503 memory_unavailable`. |
| `POST` | `/v1/memory/recall` | Operator-default shortcut: requires `{query}`, then merges 72h window / all 3 lanes / 24 records / conflicts-on and delegates to state-brief path. | Inherits state-brief fallback. |
| `GET`  | `/v1/memory/healthz` | Probes Cobra `:7419/healthz` AND shadow-cache directory in parallel. | Reports `serving=ae_cobra \| n150_shadow_cache \| none`, `status=ok \| degraded \| down`. |

Body cap: **256 KiB**. Cache dir resolved via `import.meta.url` at registration; non-fatal `mkdir -p` on attach. Boundary allow-list updated; `MEMORY_ALLOWED` exported as frozen list from `memory-boundary.mjs`.

### Mirage adapter registry (11-MIRAGE — per-mount GET surface)

Each mount exposes a uniform `{read, write, healthz}` shape via `getAdapter(name)`:

| Mount | Family | Status | Writes gated? | Notes |
|---|---|---|---|---|
| `data/postgres` | data | **STUB Night-1** | yes | header names target backend, auth env, approval ceremony |
| `data/drive` | data | **STUB Night-1** | yes | Google Drive — `oauth2_token`, scoped per-folder |
| `data/gmail` | data | **STUB Night-1** | yes | Gmail — read-mostly until ceremony |
| `data/slack` | data | **STUB Night-1** | yes | Slack — workspace + channel scope |
| `data/github` | data | **STUB Night-1** | yes | GitHub — repo-scoped PAT |
| `data/redis` | data | **STUB Night-1** | yes | Redis — keyspace-scoped |
| `memory/flux` | memory | **READY** | n/a | Proxies Æ Cobra `:7419` → Codexa rail `10.0.99.1:8097` → N150 shadow (3-tier) |
| `memory/graph` | memory | **READY** | gated (`use_graph_weaver_build_workflow`) | Direct SQLite read on `memory/graph.db`, 6 read ops, ontology-validated |
| `memory/receipts` | memory | **READY** | append-only dated md | Globs `10-RECEIPTS/orange5-build/` + `runtime-logs/`; smoke-pulled 3 real receipts |
| `memory/atoms` | memory | **STUB Night-1** | yes | AtomSmasher commitment-atom store |
| `memory/cache` | memory | **STUB Night-1** | n/a | Generic cache plane |

`healthAll()` returns 11 entries via `Promise.allSettled`; cold-box smoke shows `receipts=ok`, everything else honestly degraded.

---

## Honest gaps

1. **8 of 11 Mirage adapters are STUBS Night-1.** `data/postgres`, `data/drive`, `data/gmail`, `data/slack`, `data/github`, `data/redis`, `memory/atoms`, `memory/cache` all return `{ok:false, reason:'stub_night_1', spec:'<link>'}` from read/write and an honest stub-status from healthz. **Full activation is gated on a per-mount approval ceremony** — operator must explicitly sign each mount's auth env vars, scope, and write-gate posture before promotion. The adapter file headers document target backend / auth env / posture so Night-2 wiring is unambiguous.
2. **`11-MIRAGE/SPEC.md` does not yet exist.** Every adapter's `spec` field points to anchors that will land when the spec is written. Recommend authoring SPEC.md before Night-2 promotion so the spec links resolve.
3. **`registerMemoryRoutes` is not yet called from `server/index.mjs`.** Routes are authored and boundary-allowed but not live until a one-line splice: `import { registerMemoryRoutes } from "./routes/memory.mjs"; registerMemoryRoutes(server);` after `createServer(...)`. Out of scope for this authoring pass; named so it cannot be forgotten.
4. **Memory-inject middleware is not yet wired into the inline `http.createServer` router.** `index.mjs` uses raw node:http with inline routing, not an Express/Hono chain. Wiring requires either (a) calling `runInjection(body, cfg)` directly before `handleV1ChatCompletions(body)` in the POST `/v1/chat/completions` branch and setting `X-Memory-Injected-Bytes` from the result, or (b) refactoring to a middleware chain.
5. **Auto-inject is conservative (8 records).** The middleware's auto-recent StateBrief default of `max_records:8` and the deep-recall default of 24 records / 72h window are operator-chosen Option-C values. **These may need tuning** once real chat-completion traffic exercises the inject contract — too few records starves the system message; too many bloats the prompt and burns context budget. No empirical data yet; honest acknowledgment that the knobs exist.
6. **Rail endpoint shape is inferred.** `sync.mjs` assumes `GET /flux/events?lane=&since=&until=` on the Codexa rail at `10.0.99.1:8097`. If the actual contract differs (POST, different params, paged cursor), `fetchLane()` needs the URL adjusted — single function, easy swap.
7. **Live Cobra `/state-brief` response shape was matched on best inference** from Mirage doctrine (`reality/thought/receipts/open_conflicts + counts + window`). If the live shape diverges, align field names in `shadow-state-brief.mjs` so the gateway fallback is genuinely drop-in.
8. **`ORANGEBOX_RAIL_TOKEN` under SYSTEM principal** requires machine-scope env var — flagged in README and PS install output.
9. **Cockpit chip is a splice patch.** Not yet imported into `ChromeBar.tsx` next to the existing SYNC indicator; ships as three standalone files at `06-ORANGELLM/memory/cache/atomic-orange-patch/` with documented integration steps.
10. **Graph Weaver HTTP route layer does not exist.** Spec said "proxies to Graph Weaver routes" but only schema.sql + migrations.sql exist under `06-ORANGELLM/memory/graph-weaver/`. Wired direct to SQLite per the schema's own `Target:` comment. If routes get added later, swap `graph.mjs` read() body to fetch() calls.

---

## Mom's Law

Mom is watching the routing. Every degraded path returns `degraded=true` and `served_by=<plane>` instead of pretending the live plane is up. Every stale shadow surface lights `memory.stale` on `/healthz`. Every STUB adapter returns `{ok:false, reason:'stub_night_1'}` instead of silently no-op'ing — the operator sees the honest gap before approving the ceremony. The middleware tombstones rather than dropping when both planes die. The cockpit chip classifies `codexa-with-lag` (60s–1h) as **shadow not live** — no green-wash. The receipts adapter is append-only with overwrite-refused. The graph adapter refuses out-of-band mutation and names the workflow that owns it. Full effort, every line. No theater.

---

## Hash chain footer

```
prior_receipt: 2026-06-24-atomsmasher-commitment-atoms-live (#019)
this_receipt:  2026-06-24-mirage-recall-live              (#020)
sovereign:     Atom McCree
actor:         Claude (Orange voice)
schema:        orange5.receipt.v0
status:        MIRAGE_RECALL_LIVE_GATEWAY_ROUTES_AND_SHADOW_CACHE_AUTHORED
files_landed:  24
lines_landed:  3600
ready_mounts:  3 of 11 (flux, graph, receipts)
stub_mounts:   8 of 11 (postgres, drive, gmail, slack, github, redis, atoms, cache) — Night-1 gated
next_action:   (1) wire registerMemoryRoutes into server/index.mjs
               (2) splice runInjection() into POST /v1/chat/completions branch
               (3) author 11-MIRAGE/SPEC.md with named anchors
               (4) install cron-windows.ps1 scheduled task + verify ORANGEBOX_RAIL_TOKEN at machine scope
               (5) per-mount approval ceremony to promote Night-2 (recommended order: redis → atoms → cache → postgres → github → drive → gmail → slack)
```
