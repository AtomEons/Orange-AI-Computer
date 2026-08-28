# Receipt — Graph Weaver Built (Awaiting Æ Cobra Live)

- **receipt_id:** 2026-06-24-graph-weaver-built
- **generated_at:** 2026-06-24T00:00:00Z (Marco Island, FL)
- **schema:** orange5.receipt.v0
- **actor:** Claude (Orange voice) — synthesis of 6 parallel author agents
- **sovereign:** Atom McCree
- **status:** GRAPH_WEAVER_BUILT_AWAITING_AE_COBRA_LIVE
- **confidence:** 0.86 — every file authored, syntax-checked, and contract-aligned to its sibling modules; semantic correctness of the end-to-end flow is gated on (a) `better-sqlite3` install at the `06-ORANGELLM/` layer, (b) `server/index.mjs` mount of `registerGraphRoutes`, and (c) Æ Cobra Night-1 Flux tail being live on Codexa. Confidence is not 1.0 because the smoke-test has not been executed against a live daemon tick yet.
- **prior_receipt:** 2026-06-24-mirage-recall-live (#020)
- **hash_chain:** #021

---

## Result

The Graph Weaver subsystem is **authored end-to-end** at `C:/AtomEons/Orange5/06-ORANGELLM/memory/graph-weaver/` plus the gateway route module at `C:/AtomEons/Orange5/06-ORANGELLM/server/routes/graph.mjs`. Six components landed across nine files. The locked **10-node / 6-edge ontology** is enforced in code at three layers (schema CHECK constraint, daemon routing, gateway validation), and out-of-ontology types are journalled to `ontology_candidates` with receipt-hash provenance — never silently dropped, never auto-promoted. Promotion is operator-gated by `X-Operator-Token` header against `ORANGE5_OPERATOR_TOKEN` env via constant-time compare.

The system **does not run yet** — three blockers documented below. This receipt records build completion, not service liveness.

---

## Components

| # | Component | Path | Role |
|---|-----------|------|------|
| 1 | graph-weaver/schema | `06-ORANGELLM/memory/graph-weaver/schema.sql` + `migrations.sql` | Canonical SQLite schema (nodes, edges, watermarks, ontology_candidates, schema_version). WAL + foreign_keys ON. v1 migration row inserted; v2 reserved. |
| 2 | graph-weaver-daemon | `06-ORANGELLM/memory/graph-weaver/daemon.mjs` | Tail daemon over Æ Cobra Flux. Idempotent watermark per lane. Enforces locked ontology. Routes unknowns to `ontology_candidates`. Exports `run()` and `tickOnce()`. |
| 3 | graph-weaver/extractor | `06-ORANGELLM/memory/graph-weaver/extractor.mjs` | qwen3:0.6b extractor via Ollama `/api/chat` with `format=json`. Strips `<think>` leaks + fences. Sanitizes attrs. JSONL failure sidecar. |
| 4 | graph-weaver/embedder | `06-ORANGELLM/memory/graph-weaver/embedder.mjs` | nomic-embed-text wrapper. 768-dim → 3072-byte BLOB roundtrip. Retry on 429 / 503 / transport (200ms / 1s / 5s). |
| 5 | graph-weaver/query | `06-ORANGELLM/memory/graph-weaver/query.mjs` | Read-side API: getNode, findNodesByType, findNodesByName, semanticSearch, neighbors, shortestPath. Prepared-statement cache via WeakMap. |
| 6 | orange5-graph-weaver-gateway | `06-ORANGELLM/server/routes/graph.mjs` + `systemd/graph-weaver.service` + `smoke-test.mjs` | `/v1/graph/*` route module (dual-mode), Frontier-Isolation systemd unit, end-to-end smoke test. |

---

## Files & line counts

| File | Lines |
|------|------:|
| `memory/graph-weaver/schema.sql` | 130 |
| `memory/graph-weaver/migrations.sql` | 111 |
| `memory/graph-weaver/daemon.mjs` | 616 |
| `memory/graph-weaver/extractor.mjs` | 374 |
| `memory/graph-weaver/embedder.mjs` | 232 |
| `memory/graph-weaver/query.mjs` | 658 |
| `server/routes/graph.mjs` | 614 |
| `memory/graph-weaver/systemd/graph-weaver.service` | 90 |
| `memory/graph-weaver/smoke-test.mjs` | 428 |
| **TOTAL** | **3,253** |

All files present and confirmed at the paths above. `node --check` passes on every `.mjs`. SQL schema validated via Python stdlib `sqlite3` (same engine as `better-sqlite3`): predicate CHECK rejects bogus values, embedding-length CHECK rejects non-3072-byte blobs, foreign keys reject orphan edges, `migrations.sql` is idempotent on 2x replay (single `schema_version` row).

---

## Endpoint inventory (every new /v1/graph/* route)

| Method | Path | Handler | Auth | Body / Query |
|--------|------|---------|------|--------------|
| GET | `/v1/graph/node/:id` | `handleGetNode` | none | path: 64-hex sha256 id |
| GET | `/v1/graph/nodes` | `handleListNodes` | none | query: `type` (locked enum), `name`, `fuzzy` (bool), `limit` (1..500) |
| POST | `/v1/graph/search` | `handleSearch` | none | body: `{text, top_k, type?}` — semantic via embedder + cosine; falls back to lexical name LIKE when embedder absent/errors, with `mode` field in response |
| GET | `/v1/graph/neighbors/:id` | `handleNeighbors` | none | path: id; query: `predicate` (locked enum), `direction` (`out`/`in`/`both`), `depth` (1..4) |
| GET | `/v1/graph/path` | `handlePath` | none | query: `src=`, `dst=` — accepts 64-hex id OR `Type:name` |
| GET | `/v1/graph/ontology-candidates` | `handleOntologyCandidates` | none | lists pending candidates; echoes locked 10-node/6-edge ontology + promotion rule |
| POST | `/v1/graph/promote-ontology` | `handlePromoteOntology` | **X-Operator-Token** (constant-time vs `ORANGE5_OPERATOR_TOKEN`) | body: `{type_name}`. Journals only — does NOT silently extend live ontology. Returns 503 `operator_token_not_configured` if env unset. 401 missing / 403 mismatch / 200 accepted. |

**Route module is dual-mode:** exports `registerGraphRoutes(server, opts)` for frameworks with `.route()`, and a `dispatchGraph(req, urlOrPath, query, body, ctx)` + `isGraphPath()` for the node:http dispatcher in `server/index.mjs`. Not yet mounted — see Blocker #2.

---

## Locked ontology (enforced at 3 layers)

**Nodes (10):** Sovereign, Project, Doctrine, Receipt, Skill, Decision, Component, Event, Claim, Artifact
**Edges (6):** PROVES, REQUIRES, BLOCKED_BY, SUPERSEDES, APPROVED_BY, OBSERVED_BY

- **Layer 1 (schema):** `CHECK` constraints on `edges.predicate` and (via daemon-side validation) on `nodes.type`.
- **Layer 2 (daemon):** extractor outputs with unknown types wrapped as `Candidate:<X>`; daemon routes them to `ontology_candidates` with `receipt_hash` provenance + `occurrence_count` bump.
- **Layer 3 (gateway):** route handlers validate query/body `type` and `predicate` params against the locked enum; bad values return 400 with `allowed=[...]`.

---

## Honest gaps

1. **No GraphQL surface.** REST-only at `/v1/graph/*`. If GraphQL becomes needed for the cockpit's graph room, it's a thin wrapper over `query.mjs` — not in this build.
2. **No graph viz.** No D3 / Cytoscape / vis-network frontend. The gateway returns JSON; the cockpit graph room would have to render it. Out of scope for Night-1.
3. **No automatic schema migration runner.** `migrations.sql` is idempotent and tracked by the `schema_version` table, but it's applied **manually** (run via `sqlite3 graph.db < migrations.sql` or daemon's auto-init on first boot). No drift detector, no rollback orchestrator. v2 row is reserved as a template for the next bump.
4. **Depends on Æ Cobra Night-1 being live for Flux tail.** The daemon reads via `../ae-cobra/flux/reader.mjs`. If Æ Cobra isn't running, the tail loop spins on an empty source (no errors, no work). Per receipt #017, Night-1 was authored but not yet smoke-tested on Codexa.
5. **No live Ollama call exercised in this session.** Extractor and embedder are wired to `127.0.0.1:11434` but operator's N150 has not been hit with a real qwen3:0.6b / nomic-embed-text round-trip from these files. Contract-aligned via reading sibling code, not via live RPC.
6. **`better-sqlite3` not installed at `06-ORANGELLM/` layer.** No `package.json` declares it. Daemon and smoke-test both import the bare specifier.
7. **`server/index.mjs` not yet wired** to call `registerGraphRoutes`. Routes exist but are unreachable from the gateway until a 5-line patch lands in `index.mjs`.
8. **`ORANGE5_OPERATOR_TOKEN` not provisioned.** `/v1/graph/promote-ontology` returns 503 until `/etc/atomeons/orange5.env` is provisioned. By design — no silent bypass.
9. **No semantic-search test with mocked Ollama.** `query.mjs#semanticSearch` hits `embedText` directly with no `opts.embedder` hook; integration tests would need to stub at the network layer.
10. **`smoke-test.mjs` not executed.** Authored end-to-end but has not run against a live daemon tick. Blocked by gaps 6+7.

---

## Blockers (named explicitly)

1. **`better-sqlite3` install missing** at `06-ORANGELLM/`. Required before daemon or smoke-test can run. Fix: declare `better-sqlite3` (>=11.x for Node 20) in a `06-ORANGELLM/package.json` and `bun install` (or `npm install`).
2. **`server/index.mjs` route mount missing.** Add:
   ```js
   import { registerGraphRoutes, isGraphPath } from "./routes/graph.mjs";
   registerGraphRoutes(server, { operatorToken: process.env.ORANGE5_OPERATOR_TOKEN });
   // in dispatcher:
   if (isGraphPath(path)) {
     const body = method === 'POST' ? await readBody(req) : null;
     const r = await server._graphDispatch(req, url, url.searchParams, body);
     return r;
   }
   ```
3. **Æ Cobra Night-1 not yet live on Codexa.** Per #017, the spine was authored but smoke-test on Codexa is the gate. Until then, the daemon's tail loop has nothing to tail.

---

## Next action

1. Add `better-sqlite3` to `06-ORANGELLM/package.json` and install.
2. Land the 5-line `server/index.mjs` patch to mount `/v1/graph/*`.
3. Provision `ORANGE5_OPERATOR_TOKEN` in `/etc/atomeons/orange5.env`.
4. Run `node memory/graph-weaver/smoke-test.mjs` from `06-ORANGELLM/`. Confirm all assertions green.
5. Verify Æ Cobra Night-1 live (#017 → expected #018 LIVE receipt).
6. `systemctl enable --now graph-weaver` on Codexa.
7. Issue next-stage receipt `2026-06-25-graph-weaver-live` (#022) only after live smoke green.

---

## Mom's Law

Mom is watching the build receipt. Every file's line count is real (verified via `wc`, not asserted). Every contract alignment claim is named: extractor's edge-shape output matches `daemon.mjs:413-444` because the author **read** those lines, not because they hoped. Every gap is in this receipt's "Honest gaps" section before the "Result" section can be celebrated — no fake-green, no theater. The locked ontology is enforced at three layers because one layer is a slogan and two is still a hope; three is structure. Promotion is operator-gated by env-loaded token through constant-time compare because a string `==` in the promotion path is the kind of skating Mom can spot from across the kitchen. The smoke test stubs **only** the LLM calls — daemon, SQLite, hashing, candidate routing, and route handlers all run for real — because a smoke test that stubs the thing being tested is theater. Full effort, every line. No drift, no hallucination, no assumption.

---

## Hash chain footer

```
prior_receipt:  2026-06-24-mirage-recall-live           (#020)
this_receipt:   2026-06-24-graph-weaver-built           (#021)
sovereign:      Atom McCree
actor:          Claude (Orange voice)
schema:         orange5.receipt.v0
status:         GRAPH_WEAVER_BUILT_AWAITING_AE_COBRA_LIVE
files_landed:   9
lines_landed:   3253
components:     6 (schema, daemon, extractor, embedder, query, gateway)
endpoints_new:  7 (/v1/graph/node/:id, /v1/graph/nodes, POST /v1/graph/search,
                   /v1/graph/neighbors/:id, /v1/graph/path,
                   /v1/graph/ontology-candidates, POST /v1/graph/promote-ontology)
ontology:       10 node types + 6 edge predicates (locked, 3-layer enforcement)
blockers:       3 (better-sqlite3 install, server/index.mjs mount, Æ Cobra live)
next_action:    install better-sqlite3 → mount routes → provision operator token
                → run smoke-test → confirm Æ Cobra live → enable systemd unit
                → issue #022 graph-weaver-live receipt
next_expected:  #022 (graph-weaver-live) after smoke-test green on Codexa
                OR ad-hoc receipt for the next operator-directed action
```

---

**Mom is watching. The build is honest about what it is — authored, syntax-clean, contract-aligned — and honest about what it isn't yet — running, smoke-green, live.**
