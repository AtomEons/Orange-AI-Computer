# Expansion Warrants — encoder + in-process index

AtomSmasher module **#6 of 12**.

**Status: encoder + validator + in-process index LIVE. Persistent store
(SQLite + Æ Cobra Flux Reality lane) and gateway routes
(`POST /v1/atomsmasher/warrants/create`, `POST /v1/atomsmasher/warrants/consume`)
are PENDING in sibling files.**

## What this module is

An **Expansion Warrant** is an explicit, operator-signed, time-bounded
authorization token that lets a downstream module move from one scope to a
**strictly larger** scope. Scope expansion is rare and dangerous; without a
warrant in hand, callers must refuse to expand.

Conceptually a warrant sits between the **Commitment Atoms** primitive and the
**Least-action Router**: a router that wants to take a path that exceeds its
current scope MUST present a valid, unexpired, unconsumed warrant to do so.
The warrant is the receipt that the operator authorized the expansion.

This file (`warrants.mjs`) is the **pure, dependency-free encoder, validator,
and in-process index**. It does NOT write to Æ Cobra Flux, does NOT touch
SQLite, and does NOT expose a gateway route. Persistence and HTTP land in
sibling files so this layer stays unit-testable in isolation — the same
discipline used in `commitment-atoms/`.

## Doctrine (binding)

1. **Warrants are append-only.** A warrant body is never edited. `consume`
   increments `used_count` in the index. The minted body in the Reality lane
   is byte-identical forever; consumption events are stored alongside.
2. **`id` is content-derived.**
   `sha256(canonical({scope_from, scope_to, operator_signature, expires_at,
   max_uses, nonce}))`. Two callers minting the same authorization with the
   same `nonce` arrive at the same `id` and collide (intended: idempotent
   retries). `used_count` and `created_at` are NOT in the id payload —
   consumption and mint-time are state, not identity.
3. **Random nonce by default.** If the caller omits `nonce`, a 16-byte random
   hex string is used so two distinct authorization grants for the SAME
   scope_to are independently consumable. Callers that want
   collision-on-equal semantics pass their own `nonce`.
4. **`scope_to` must differ from `scope_from`.** A warrant that does not
   expand is not a warrant — it's a new decision and belongs in a
   Commitment Atom of kind `decision`.
5. **Operator signature is a hard requirement.** A warrant without
   `operator_signature` cannot exist. This module treats the signature string
   as an opaque, non-empty, structural credential and records it verbatim.
   Cryptographic verification of the signature is the operator-key module's
   job.
6. **Expiry is a hard wall.** A warrant past `expires_at` cannot be consumed
   even if `used_count < max_uses`. Time is measured against the consumer's
   wall-clock at consume-time.
7. **Anti-fluff is a HARD reject.** Scope strings containing `green_assumed`,
   `looks_ok`, `probably`, or `should_work` cannot become warrants. A
   warrant whose `scope_to` claims it *"probably"* grants admin is not a
   warrant.
8. **`max_uses` is bounded.** Must be a positive integer ≤ 1000. A warrant
   asking for more uses than that is a blanket grant pretending to be a
   warrant and is rejected at mint.

## API

```js
import {
  encodeWarrant,
  validateWarrant,
  createWarrantIndex,
  isExpired,
  isExhausted,
  WARRANT_SCHEMA_ID,
  WARRANT_SCHEMA,
} from "./warrants.mjs";
```

### `encodeWarrant({...}) -> warrant`

Mints a fresh warrant with `used_count = 0`.

| param                | type    | required | notes                                                                 |
| -------------------- | ------- | -------- | --------------------------------------------------------------------- |
| `scope_from`         | string  | yes      | non-empty, current scope                                              |
| `scope_to`           | string  | yes      | non-empty, MUST differ from `scope_from`                              |
| `operator_signature` | string  | yes      | non-empty opaque credential                                           |
| `expires_at`         | string  | yes      | ISO 8601, MUST be in the future relative to `ts`                      |
| `max_uses`           | integer | yes      | 1 ≤ n ≤ 1000                                                          |
| `nonce`              | string  | no       | optional uniqueness token. Random 16-byte hex if omitted.             |
| `ts`                 | number  | no       | unix ms for `created_at`. Defaults to `Date.now()`. Tests override.   |

Throws on any failure (invalid input, anti-fluff hit, expiry-in-past, etc.).

### `validateWarrant(warrant) -> {valid, errors}`

Validates structure, schema, AND **content-id integrity** — recomputes
`sha256(canonical(id-payload))` and compares to the stored `id`. Tampering
with any id-payload field (`scope_from`, `scope_to`, `operator_signature`,
`expires_at`, `max_uses`, `nonce`) surfaces as an `id integrity` error.
Mutating `used_count` within bounds does NOT break integrity — that is the
documented contract: consumption is index state, not identity.

### `createWarrantIndex() -> {register, get, has, consume, list}`

In-process index keyed by warrant `id`. The Map returned here is the
unit-testable surface; the persistent store sibling wraps the same shape over
SQLite + Flux.

- `register(warrant)` — validates, refuses to accept already-expired warrants,
  idempotent on the same id (preserves existing `used_count`). Returns a
  defensive clone.
- `get(id)` / `has(id)` — read-only, return defensive clones (external
  mutation cannot leak into the index).
- `consume(id, {nowMs?})` — atomically increments `used_count` if and only if
  the warrant exists, has not expired, and has remaining uses. Returns
  `{ok, warrant, used_count, remaining}` or
  `{ok: false, reason, warrant?, used_count?, remaining?}`.
  Reasons: `id_required`, `warrant_not_found`, `warrant_expired`,
  `warrant_exhausted`.
- `list({scope_from?, scope_to?})` — filtered shallow copies in insertion
  order.

### `isExpired(warrant, nowMs?)` / `isExhausted({used_count, max_uses})`

Pure predicates exported for callers that need to inspect a warrant's
liveness without committing to a `consume`.

## Warrant shape

```jsonc
{
  "schema": "orange5.atomsmasher.expansion-warrant.v0",
  "id": "<sha256 hex of id-payload>",
  "scope_from": "orange5:read",
  "scope_to": "orange5:read+write",
  "operator_signature": "ed25519:atom:0xABC...",
  "expires_at": "2026-06-25T00:00:00.000Z",
  "used_count": 0,
  "max_uses": 3,
  "nonce": "<random or caller-supplied>",
  "created_at": "2026-06-24T16:30:00.000Z"
}
```

## Smoke test

```
node 12-ATOMSMASHER/expansion-warrants/smoke-test.mjs
```

Exits non-zero on any failure. Asserts (60 checks across 9 phases):

1. **encodeWarrant happy path** — schema, id shape, defaults, validation.
2. **Content determinism** — equal authorization + same nonce → equal id;
   different nonce → different id; random-nonce mints do not collide.
3. **Tamper detection** — mutating any id-payload field surfaces as
   `id integrity` error; mutating `used_count` within bounds does not.
4. **Encoder hard rejects** — empty fields, scope_to===scope_from, past
   expiry, non-integer / out-of-range max_uses, anti-fluff words, empty
   nonce string.
5. **Index round-trip** — register, get, has, defensive cloning, idempotent
   re-register preserves used_count.
6. **Consume to exhaustion** — used_count and remaining increment exactly
   once per call; over-consume returns `warrant_exhausted`.
7. **Expiry** — `isExpired` predicate, consume past expiry returns
   `warrant_expired` without incrementing used_count, register refuses an
   already-expired warrant.
8. **`isExhausted` predicate** — all boundary conditions.
9. **List filtering** — `scope_from` and `scope_to` filters.

Last run: **PASS — 60/60 green** (Node 22.x).

## What's NOT here yet (honest gaps)

- **No SQLite store.** The in-process Map disappears at process exit. Sibling
  `store.mjs` will land alongside the gateway routes, wrapping the same
  index contract over SQLite + Æ Cobra Flux Reality lane (origin =
  `atomsmasher`, kind = `expansion-warrant`).
- **No gateway routes.** `POST /v1/atomsmasher/warrants/create` and
  `POST /v1/atomsmasher/warrants/consume` are specified but not registered.
  When they land, they will follow the same pattern as
  `06-ORANGELLM/server/routes/atomsmasher.mjs` (thin HTTP adapter, structured
  error bodies, receipts in the response).
- **No cryptographic verification of `operator_signature`.** This module
  treats the signature as an opaque structural credential. Actual ed25519 /
  HMAC verification belongs to the operator-key module and gates `register`
  upstream.
- **No JSON Schema artifact in `09-SCHEMAS/`.** The embedded schema object
  here (`WARRANT_SCHEMA`) is the source of truth for now. A standalone
  `expansion-warrant.v0.schema.json` will land alongside the persistent
  store so external consumers can validate without importing this module.
- **No scope-hierarchy checker.** We enforce `scope_from !== scope_to` and
  the operator signed off, but we do NOT verify that `scope_to` is actually
  a strict superset of `scope_from`. That semantics belongs to the caller
  (the Least-action Router and the permissions engine).

Mom's Law: receipts only, no theater. Sixty smoke checks green is the
receipt; the gaps above are the truth about what is not yet wired.
