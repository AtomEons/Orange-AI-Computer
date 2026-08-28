# 13-TOOLMESH

OrangeLLM's capability map. The mesh tells the planner what the system **can** do
and at what cost, latency, and risk — **before** the planner asks the operator
for approval to actually do it.

> Tool-cards are capability INDICATORS, not permission-to-execute. Execution is
> gated by Hermes leases. Discovery here. Authority there. Receipts at the end.

This README is the orientation document for the lab. Schema and contracts are
authoritative in `09-SCHEMAS/tool-card.v0.schema.json`; runtime semantics are
authoritative in `registry.mjs`. If this README and either of those disagree,
the code and schema win — file a bug.

---

## The 11 labs

Each lab is a closed namespace of related capabilities. The set is frozen at
this level — adding a 12th lab is a schema-bumping event, not a card-add.

| # | Lab id          | What lives there                                                            |
|---|-----------------|-----------------------------------------------------------------------------|
| 1 | `image`         | Generate, edit, OCR, describe, ground bounding boxes in 2D raster pixels.   |
| 2 | `video`         | Generate, edit, transcode, caption, frame-extract video timelines.          |
| 3 | `audio`         | TTS, STT, music/SFX generation, denoise, diarize, stem-separate.            |
| 4 | `design`        | UI mock generation, layout systems, design-token ops, vector and SVG work.  |
| 5 | `coding`        | Code search, lint, refactor, run-tests, diff-review across the workspace.   |
| 6 | `automation`    | Browser drive, desktop drive, shell tasks, schedule, file ops at the seam.  |
| 7 | `analytics`     | SQL, dataframe ops, chart spec, summary stats, anomaly detection.           |
| 8 | `public-agent`  | Operator-approved outbound: email send, post, comment, ticket open.         |
| 9 | `observability` | Logs, traces, metrics, dashboards, alert queries, RCA scaffolding.          |
| 10| `security`      | Static scan, secret scan, SBOM diff, dependency CVE check, sandbox probes.  |
| 11| `releaseops`    | Build, sign, package, promote, deploy, rollback, tag, changelog.            |

Current card count is the source of truth at `registry.stats()` — run
`node registry.mjs` for the live grid. As of this commit the mesh holds
48 cards across all 11 labs.

---

## Why tool-cards are not lease grants

A tool-card answers four questions about a capability:

1. **What does it take in / give back?** (`inputs`, `outputs` — JSON-Schema'd.)
2. **What does it cost the operator?** (`cost_class`: `free | byo-key | metered`.)
3. **How fast does it return?** (`latency_class`: `sub-second | seconds | minutes`.)
4. **What can it touch?** (`risk_class`: `read-only | sandboxed | mutating | external-side-effect`,
   plus a `default_lease_template` describing the lease Hermes would mint if
   the operator approves.)

That is the entire surface of a tool-card. It is metadata. Reading a card
does not move a byte. To actually execute the capability the planner must:

1. Hand the card to Hermes alongside a request envelope.
2. Hermes materializes a lease from the card's `default_lease_template`,
   applies operator policy, and asks for human approval if required.
3. The operator approves (or denies) the lease in the cockpit.
4. Hermes hands the approved lease — not the card — to the adapter.
5. The adapter executes inside the lease's bounds (TTL, scopes, rate limit,
   egress allowlist), Hermes audits, and the receipt is filed.

So the card is the **menu**; the lease is the **check the operator signs**;
the adapter is the **kitchen**. Three separate trust layers. Mesh discovery
never bypasses lease minting, and lease minting never bypasses the cockpit's
Human Final Stop Authority.

### Tool-card → lease template (the handoff to Hermes)

Every tool-card carries a `default_lease_template`. The template names every
permission Hermes would need if the operator approves execution:

```jsonc
"default_lease_template": {
  "ttl_seconds": 300,              // 1..86400 — hard upper bound on lease life
  "max_invocations": 50,           // 1..10000 — count cap on calls
  "scopes": [                      // 1..N free-form scope strings
    "fs.read:sandbox://workspace/",
    "process.spawn:linter"
  ],
  "human_approval_required": false,  // optional — cockpit must approve before mint
  "rate_limit_per_minute": 30,       // optional — 1..600
  "egress_allowlist": ["*.example.com"]  // optional — domain pattern list
}
```

Hermes treats this as the **maximum** lease the card requests; the actual
minted lease is the intersection of (template ∩ operator policy ∩ cockpit
approval ∩ Hermes safety floor). The template never widens at runtime — it
only narrows.

Cards that mutate or reach outside the sandbox (`risk_class` in
`{mutating, external-side-effect}`) should set `human_approval_required: true`
and an `egress_allowlist` where applicable. The schema does not force this
because some `mutating` capabilities are still inside the workspace (e.g. a
linter's `--fix` flag); the spec leaves the policy to the author and trusts
review.

---

## Schema and hot-reload

### Schema

Authoritative file: `09-SCHEMAS/tool-card.v0.schema.json`.
Card constant: `"schema": "orange5.tool-card.v0"` (enforced exactly).

Validation lives in `registry.mjs::validateToolCard()`. It is a focused
subset of JSON-Schema draft 2020-12 sufficient to enforce `tool-card.v0`
(enum, const, pattern, min/max, required, additionalProperties, type,
format=date-time, items, uniqueItems). It is intentionally not a general
JSON-Schema engine — if the schema grows a feature this validator does not
cover, the loader **fails closed** on that card with a quarantine reason.

Required top-level fields:

- `schema` — const `"orange5.tool-card.v0"`
- `lab` — one of the 11 enums above
- `card_id` — kebab/dot pattern, unique within `(lab, card_id)`
- `capability` — dotted form, e.g. `coding.lint` or `image.generate`
- `cost_class`, `latency_class`, `risk_class` — closed enums
- `inputs`, `outputs` — JSON-Schema objects
- `default_lease_template` — Hermes-shaped (see above)
- `last_verified_at` — RFC 3339 UTC date-time

Optional: `vendor`, `version` (semver), `summary` (1..300), `tags` (unique,
1..32 each), `deprecated` (bool), `notes` (≤ 2000 chars).

`additionalProperties` is `false` at the card root. Typos quarantine the
card; they do not silently leak forward.

### On-disk layout

```
labs/
  <lab-id>/
    <card-id>.card.json      one tool-card per file
  index.mjs                   hand-maintained lab manifest
```

The card's `lab` field must match its directory. Drop a `security` card under
`labs/automation/` and the loader quarantines it — paste mistakes are caught,
not silently honored.

### Hot-reload

`registry.mjs` uses `node:fs.watch` against each `labs/<lab-id>/` directory.
Events are debounced 120 ms, then the affected lab is reloaded atomically:

1. Drop every card record whose `labDir` equals the changed directory.
2. Re-walk the directory, re-validate every `*.card.json`.
3. Re-run the three-index build (`byLab`, `byCapability`, `byCost`) over the
   merged card set.
4. Demote any `(lab, card_id)` collision to quarantine for **all** conflicting
   files — the planner is never given an ambiguous pick.
5. Emit `change` on the `EventEmitter` with `{ labs, touched, stats }`.

`fs.watch` is best-effort on some filesystems; the registry is correct under
full reload too (`registry.load()` from cold). Watch is opt-out via
`new ToolMeshRegistry({ watch: false })`.

Bad cards are **quarantined**, not silently dropped. `registry.quarantine()`
returns every file with its validation reasons, ordered by path — Mom's Law:
receipts only, no theater.

---

## Integration with Hermes (`08-HERMES`)

```
                       ┌─────────────────────┐
   operator goal  ──▶  │   06-ORANGELLM       │  plans, picks cards
                       │   (planner)          │
                       └──────────┬──────────┘
                                  │ search(query)
                                  ▼
                       ┌─────────────────────┐
                       │  13-TOOLMESH         │  registry.search()
                       │  registry.mjs        │  returns ranked cards
                       └──────────┬──────────┘
                                  │ card + envelope
                                  ▼
                       ┌─────────────────────┐
                       │  08-HERMES           │  mints lease from
                       │  mcp-router + policy │  default_lease_template
                       └──────────┬──────────┘
                                  │ approval ask
                                  ▼
                       ┌─────────────────────┐
                       │  Cockpit / Operator  │  Human Final Stop
                       └──────────┬──────────┘
                                  │ approved lease
                                  ▼
                       ┌─────────────────────┐
                       │  Adapter (vendor)    │  executes in lease bounds
                       └──────────┬──────────┘
                                  │ result + signals
                                  ▼
                       ┌─────────────────────┐
                       │  10-RECEIPTS         │  audit row
                       └─────────────────────┘
```

The mesh never opens a socket, spawns a subprocess, or calls a vendor. It is
a pure metadata service. Hermes is the only component allowed to convert a
card into action.

### Planner contract with the mesh

The planner calls `registry.search(query)` with any combination of:

- `lab` — string or string[]
- `capability` — exact dotted string, or prefix form ending in `.*`
- `cost_class`, `latency_class`, `risk_class` — string or string[]
- `tags` — string[] (card must include ALL listed tags)
- `vendor` — exact case-insensitive
- `query` — free-text substring across `card_id`, `capability`, `summary`,
  `tags`, `vendor`
- `includeDeprecated` — boolean (default `false`)
- `includeStaleAfterMs` — exclude cards whose `last_verified_at` is older
  than now − N ms
- `limit` — integer cap

Results are deterministic — sorted by `(lab, card_id)`, never random. Two
planner runs with the same query against the same mesh produce the same
ordered list. That property is load-bearing for replay.

---

## When to add a new card

Adding a tool-card is a **small but irreversible** doctrine event. Once a
card ships, OrangeLLM may select it for any matching task forever, and the
operator's audit trail will reference it. Add a card only when **all** of
the following hold:

1. **The capability is real.** A working adapter exists in `08-HERMES` (or
   is being landed in the same PR). No speculative cards.
2. **The capability is bounded.** It fits cleanly inside one of the 11 labs.
   If it sprawls across labs, the right move is usually to split the
   underlying tool, not to file under both.
3. **The lease shape is honest.** `default_lease_template` describes the
   *narrowest* set of scopes the adapter actually needs. No `"scopes": ["*"]`.
   If the work mutates state or reaches outside the sandbox, set
   `human_approval_required: true`.
4. **The IO is JSON-Schema'd.** `inputs` and `outputs` are real schemas with
   `additionalProperties: false` at every object level. Wide-open `object`
   types are rejected on review.
5. **Cost and latency classes are evidenced.** `cost_class` reflects who pays
   (the user, the platform, no one). `latency_class` reflects the p95 of a
   realistic invocation, not the optimistic case.
6. **A bakeoff has run.** When the new card overlaps with an existing card
   (same `capability` or same outcome with different inputs), a written
   bakeoff comparing accuracy, latency, and cost lives next to the PR.
7. **A receipt exists.** The first end-to-end invocation through Hermes is
   logged in `10-RECEIPTS` with the rendered lease and the adapter result.
   This is the proof attached to promotion (see Promotion Gate below).

If any of the seven is missing, the card is a **draft** and lives in
`18-HELD/` until it's not.

Cards are versioned in the file via `version` (semver). Backwards-incompatible
changes to `inputs`/`outputs` require a major bump and a transition window
where the old card is `deprecated: true` and the new card carries the new
behaviour. Hot-reload handles the cutover.

### Renaming, removing, deprecating

- **Rename**: `card_id` is part of the unique key — renaming is removal + add.
  Mark the old card `deprecated: true` for at least one release before
  deleting the file.
- **Remove**: delete the file. Hot-reload drops it; the planner stops seeing
  it on next search.
- **Deprecate**: set `deprecated: true` and keep the file. `registry.search()`
  excludes deprecated cards by default; explicit `{ includeDeprecated: true }`
  still surfaces them for debugging.

---

## Promotion Gate

A card is not "live" the moment it lands on disk. It is **loaded**. To be
**promoted** (i.e. eligible for unattended planner selection in production
sessions), it must clear:

| Gate                   | Evidence                                                                                 |
|------------------------|------------------------------------------------------------------------------------------|
| Schema valid           | `node registry.mjs --quarantine` — card not listed                                       |
| Adapter reachable      | `08-HERMES` smoke test exercises the underlying adapter end-to-end                        |
| Receipt on file        | `10-RECEIPTS` row from the first successful invocation, including rendered lease         |
| Bakeoff (if overlap)   | Written comparison vs. any pre-existing card sharing `capability` or outcome             |
| `last_verified_at`     | Within the staleness window the planner enforces via `includeStaleAfterMs`               |
| Cockpit acknowledged   | Operator has seen the card at least once in the deploy grid and not pinned `--exclude`   |

A card that clears all six is **promoted**. A card that misses any one stays
loaded but advisory — the planner can show it in candidate lists but will
not silently select it without operator confirmation.

The Promotion Gate is enforced by the cockpit using the registry's read API:
`registry.get(lab, card_id)` for the schema/staleness checks,
`registry.quarantine()` for the validity check, and the receipt store for
the rest. There is no separate "promoted" flag inside the card itself —
promotion is a runtime property derived from receipts, not a self-claim.

---

## CLI

```
node registry.mjs                       # mesh stats + lab counts
node registry.mjs --quarantine          # list every bad card with reasons
node registry.mjs --lab=coding          # cards in one lab
node registry.mjs --capability=image.*  # prefix match
node registry.mjs --cost=free           # filter by cost class
node registry.mjs --query=lint          # free-text search
node registry.mjs --json                # machine-readable
```

Exit code is non-zero when `--quarantine` finds bad cards. This is the
intended hook for the AE deploy grid: a clean mesh exits 0, a broken mesh
exits 1 with a line-by-line reason list.

---

## Honest gaps

- **Validator subset.** The bundled validator covers `tool-card.v0` exactly.
  It is not a general JSON-Schema engine. Schema features added later
  (e.g. `$ref` chains, `if/then/else`, `unevaluatedProperties`) require an
  upgrade to the validator before they can be used in cards. Until then,
  cards using such features fail closed at load.
- **`fs.watch` portability.** Best-effort on some filesystems (notably some
  network mounts and certain Windows configurations). The registry is
  correct under full reload regardless; watch is convenience, not contract.
- **`(lab, card_id)` collisions.** Duplicates quarantine **all** conflicting
  files. This is intentional — the planner must not pick one arbitrarily —
  but the operator must resolve the duplicate before either card is usable.
- **Staleness policy is the planner's.** The mesh stores `last_verified_at`;
  it does not decide what counts as stale. That decision lives in the
  planner's `includeStaleAfterMs` argument and the cockpit's policy.

---

## See also

- `09-SCHEMAS/tool-card.v0.schema.json` — the authoritative schema.
- `08-HERMES/MCP_ADAPTERS.md` — how leases become adapter calls.
- `10-RECEIPTS/` — the audit trail that closes the loop.
- `06-ORANGELLM/` — the planner that consumes this mesh.
- `00-CHARTER/` and `01-DOCTRINE/` — why all of the above exists.
