# Commitment Atoms — store

AtomSmasher module #1 (of 12). **Status: encoder LIVE, store LIVE,
gateway route still PENDING.**

## What this file is

`store.mjs` is the storage backend for Commitment Atoms. It persists
encoded atoms into two substrates:

1. **Reality lane of Æ Cobra Flux** — the canonical, hash-chained audit
   record. One JSONL record per atom, plus one record per
   status-transition event (supersede, revoke).

2. **SQLite index** at `06-ORANGELLM/memory/commitment-atoms.db` — the
   fast-query view over the Flux chain. Indexed on `(kind, status,
   created_at)`.

Flux is canonical. SQLite is derived. If the SQLite file is ever lost
or corrupted, it can be rebuilt by replaying the Reality lane.

## API

```js
import {
  createAtom,
  getAtom,
  listAtoms,
  revokeAtom,
} from './store.mjs';
```

### `createAtom(atom, { fluxRoot, dbPath })`

Validates the atom via `validateCommitmentAtom()`, writes a Reality-lane
Flux record (`origin='atomsmasher'`, `kind='commitment'`,
`body=atom`), then mirrors the row into SQLite. If the atom names other
atoms in `supersedes`, those atoms' `status` is flipped from `active` to
`superseded` and a `commitment-status-change` event is written into Flux
for each transition.

Returns:

```js
{ ok: true, atom_id: '<sha256>', flux_record_hash: '<sha256>' }
```

On a duplicate atom (same content already committed) returns the same
shape plus `duplicate: true`. On validation failure returns
`{ ok: false, error, errors }` without touching either substrate.

### `getAtom(atomId, { dbPath })`

Reads a single atom from the SQLite index. Returns the reconstructed
atom (without `schema` and `expires_at` columns — those live in Flux
only) or `null` if not found.

### `listAtoms({ kind, status, since, dbPath, limit })`

Filters the SQLite index. All filters are AND-combined; omitting one
means "any value". Ordered by `created_at` ASC then `atom_id` ASC.
Default `limit` is 1000; hard ceiling is 100000.

| filter   | accepts                                            |
| -------- | -------------------------------------------------- |
| `kind`   | `decision\|promise\|invariant\|deadline\|threshold` |
| `status` | `active\|fulfilled\|revoked\|superseded`            |
| `since`  | ISO 8601 string; matches `created_at >= since`     |

### `revokeAtom(atomId, supersededByAtomId, { fluxRoot, dbPath })`

Marks an atom as `superseded` (when `supersededByAtomId` is a string) or
`revoked` (when it's `null`/`undefined`). Writes a
`commitment-revocation` event into Flux. The original atom's body,
signature, and identity are never mutated — only the `status` column on
its SQLite row.

Idempotent: an atom already in a terminal `superseded` / `revoked`
state returns `{ ok: true, already: <prior_status> }` without writing a
duplicate Flux event. A `fulfilled` atom is *not* revocable — revoking
it would lie about history.

## SQLite schema

```sql
CREATE TABLE atoms (
  atom_id            TEXT PRIMARY KEY,
  kind               TEXT NOT NULL,
  status             TEXT NOT NULL,
  body_json          TEXT NOT NULL,
  prev_hash          TEXT NOT NULL,
  hash               TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  actor              TEXT NOT NULL,
  evidence_json      TEXT NOT NULL,
  supersedes_json    TEXT NOT NULL,
  preconditions_json TEXT NOT NULL
);
CREATE INDEX idx_atoms_kind_status_created
  ON atoms (kind, status, created_at);
```

`expires_at` is not indexed in this version; queries that need it should
filter `listAtoms()` output in memory or read the Flux record. The
`schema` field is also omitted — it is constant across all atoms of
this version and would waste index space.

## Operational notes

- **WAL mode** is enabled (`journal_mode = WAL`, `synchronous = NORMAL`)
  so the gateway's many short reads don't block the indexer's appends.
- **Handle cache**: one `better-sqlite3` handle per absolute `dbPath` is
  kept in a process-local Map. Don't share the cache across forked
  workers; each fork gets its own handle.
- **Write order**: Flux first, SQLite second. If SQLite fails after
  Flux succeeds, the atom is recoverable from Flux. The reverse — a
  SQLite row with no Flux record — would silently corrupt the audit
  chain, so it is structurally impossible.
- **Supersede cascade**: only `active` atoms can be flipped to
  `superseded`. Already-revoked or already-superseded atoms named in a
  new atom's `supersedes` are left alone (the cascade is a no-op for
  them, by design).

## What this file does NOT do

- It does not encode atoms. Callers must encode via `encoder.mjs`
  first; the store rejects anything that doesn't pass
  `validateCommitmentAtom()`.
- It does not expose a gateway route. That belongs in
  `06-ORANGELLM/server/routes/commitment-atoms.mjs` (PENDING).
- It does not verify the Flux chain end-to-end. Use
  `writer.verifyChain()` for that.
- It does not rebuild the SQLite index from Flux. A separate
  `reindex.mjs` (PENDING) will own that recovery procedure.

## Dependencies

- `better-sqlite3` — already sanctioned in this project
  (`04-CONTROL-PLANE/src/registry.mjs` notes the migration plan;
  `06-ORANGELLM/memory/graph-weaver/daemon.mjs` already uses it).
- `node:fs`, `node:path` — stdlib.
- `./encoder.mjs` — for `validateCommitmentAtom` and `VALID_STATUSES`.
- `../../06-ORANGELLM/memory/ae-cobra/flux/writer.mjs` — for
  `writeFluxRecord`.

No new deps introduced.
