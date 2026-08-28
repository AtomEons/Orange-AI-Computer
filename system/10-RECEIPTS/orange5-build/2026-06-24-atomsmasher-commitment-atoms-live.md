# Receipt — AtomSmasher Commitment Atoms promoted STUB to LIVE

- **Receipt ID:** `2026-06-24-atomsmasher-commitment-atoms-live`
- **generated_at:** 2026-06-24T18:30:00-04:00
- **schema:** `orange5.receipt.v0`
- **actor:** Atom McCree
- **status:** `ATOMSMASHER_COMMITMENT_ATOMS_PROMOTED_STUB_TO_LIVE`
- **confidence:** HIGH on encoder + store + decoder (each module has its own smoke test passing or independently node-`--check` clean). MEDIUM on gateway routes (syntax-clean, end-to-end smoke at `12-ATOMSMASHER/commitment-atoms/smoke-test.mjs` exercises the store contract the routes depend on, but the main `06-ORANGELLM/server/boundary.mjs` splice is not yet committed — see "What this does NOT do yet").
- **prior_receipt:** `2026-06-24-atomic-orange-private-repo-published.md` (#018)
- **hash_chain:** #019

---

## Result

The AtomSmasher Commitment Atoms module is promoted from STUB to LIVE. Five components landed across three Orange5 trees:

1. JSON Schema for the atom contract (`orange5.commitment-atom.v0`, draft 2020-12, strict).
2. Pure encoder with content-derived `atom_id`, self-hashing signature, anti-fluff guards, and an embedded zero-dep validator.
3. Decoder + iterative chain traversal (BFS, cycle-safe, duck-typed store).
4. SQLite-backed store layered on top of the `ae-cobra` Flux writer (canonical-record-first, append-only, idempotent revoke).
5. Gateway route module + boundary splice file + integration smoke test that mints a 3-atom chain (decision → invariant → promise), revokes, lists, and traverses.

Commitments now have a durable, content-addressable, append-only home with a hash chain that links every atom back to genesis through `signature.prev_hash`.

---

## Components

| Component | Files | Lines |
|---|---|---|
| commitment-atom-schema | `C:/AtomEons/Orange5/09-SCHEMAS/commitment-atom.v0.schema.json` | 130 |
| commitment-atoms/encoder | `C:/AtomEons/Orange5/12-ATOMSMASHER/commitment-atoms/encoder.mjs` | 440 |
| commitment-atoms/encoder (docs) | `C:/AtomEons/Orange5/12-ATOMSMASHER/commitment-atoms/README.md` | 141 |
| commitment-atoms/encoder (smoke) | `C:/AtomEons/Orange5/12-ATOMSMASHER/commitment-atoms/_smoke.mjs` | 169 |
| commitment-atoms/decoder | `C:/AtomEons/Orange5/12-ATOMSMASHER/commitment-atoms/decoder.mjs` | 438 |
| commitment-atoms/store | `C:/AtomEons/Orange5/12-ATOMSMASHER/commitment-atoms/store.mjs` | 475 |
| commitment-atoms/store (docs) | `C:/AtomEons/Orange5/12-ATOMSMASHER/commitment-atoms/store.README.md` | 146 |
| gateway-routes | `C:/AtomEons/Orange5/06-ORANGELLM/server/routes/atomsmasher.mjs` | 790 |
| gateway-boundary splice | `C:/AtomEons/Orange5/06-ORANGELLM/server/routes/atomsmasher-boundary.mjs` | 130 |
| end-to-end smoke | `C:/AtomEons/Orange5/12-ATOMSMASHER/commitment-atoms/smoke-test.mjs` | 391 |
| **Total** | **10 files** | **3,250** |

---

## Endpoint inventory

All routes prefixed `/v1/atomsmasher/atoms` and gated by `atomsmasher-boundary.mjs` (`ATOMSMASHER_ALLOWED` literal pairs + `isAtomSmasherRouteAllowed` parameterized predicate that requires `:atom_id` to match `^[0-9a-f]{64}$`).

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/atomsmasher/atoms` | Create a new commitment atom. Body: `{kind, body, preconditions?, supersedes?, evidence?, actor, expires_at?}`. Server fills `atom_id`, `signature.prev_hash` (from `store.getLatestHash` or `GENESIS`), `signature.hash`, `created_at`, and `sovereign`. Validates via encoder + defence-in-depth re-validate before store. Returns 201 with `{atom_id, hash, prev_hash, flux_record_hash, atom}`. Anti-fluff rejection → 422; invalid request → 400; store failure → 500. |
| `GET` | `/v1/atomsmasher/atoms/:atom_id` | Fetch a single atom + its decoded markdown view + a chain summary (uses `store.getAtomSync` when available; degrades cleanly when absent). Returns 404 `atom_not_found` if id is well-formed hex but unknown; 400 if id shape is wrong. |
| `GET` | `/v1/atomsmasher/atoms?kind=&status=&since=&limit=` | List atoms with AND-combined filters. `kind ∈ {decision,promise,invariant,deadline,threshold}`, `status ∈ {active,fulfilled,revoked,superseded}`, `since` parsed as RFC 3339. Returns `{atoms, count, filters}`. Bad filter values → 400. |
| `POST` | `/v1/atomsmasher/atoms/:atom_id/revoke` | Revoke or supersede an existing atom. Body: `{superseded_by?, reason?}`. If `superseded_by` is provided it must match 64-hex shape. Idempotent on terminal states (`{ok:true, already:<status>}`). Refuses to revoke `fulfilled` atoms. Writes a `commitment-revocation` event to Flux before updating the SQLite index. |
| `GET` | `/v1/atomsmasher/atoms/:atom_id/chain` | Traverse the supersedes graph from the given atom. Uses `store.getAtomSync` if available, else materializes via `listAtoms` into a Map (O(n) fallback, documented honestly). Returns `{atom, preconditions_resolved, supersedes_chain}` with cycle counts surfaced. |

Body cap: 256 KiB (matches `memory.mjs`). All responses include `generated_at`. Method-not-allowed returns 405 with an `Allow` header.

---

## Evidence

- `node --check` clean on every `.mjs` file authored.
- 22/22 smoke checks PASS in `commitment-atoms/_smoke.mjs` (round-trip, determinism, key-order independence, tamper detection, all 4 forbidden words `green_assumed | looks_ok | probably | should_work` rejected, evidence-required for `invariant` and `promise` kinds, supersede chain links via `prev_hash`, bad-input throws).
- `commitment-atoms/smoke-test.mjs` mints a 3-atom hash chain in an isolated `os.tmpdir()` workspace: decision → invariant → promise, then revokes decision with `superseded_by=promise.atom_id`, lists three ways (no filter, status=active, status=superseded, kind=decision), traverses chain from promise, recomputes every `signature.hash` on re-read. Cleans up the temp tree on exit.
- Schema hand-verified against draft 2020-12 (no `ajv` in repo, so structural-only — all 12 required props defined, SHA-256 and RFC 3339 regex patterns discriminate valid/invalid inputs, `sovereign` const-locked to `"Atom McCree"`, `schema` discriminator const-locked to `"orange5.commitment-atom.v0"`).
- Decoder's two-atom Map-store smoke renders `[invariant] OrangeLLM-fatty is the only trained brain` correctly, resolves precondition + supersedes pointers, and falls back to id-only Markdown when the store is omitted. Missing-atom case surfaces a `note` field instead of throwing.
- Store doctrine compliance: Flux written **before** SQLite (partial failure recoverable from Flux, never the reverse); only the `status` column is ever `UPDATE`d, all other columns are append-only; duplicate `atom_id` returns `{ok:true, duplicate:true}` honestly because the content is already true; re-revoking returns `{ok:true, already:<prior_status>}` with no duplicate audit event.

---

## What this does NOT do yet

Honest scope boundaries. The promotion is for what landed, not for the full vision.

- **No cross-machine atom sync.** Atoms live in the local SQLite index + local Flux lane on whatever machine wrote them. There is no replication protocol, no gossip layer, no signed-receipt exchange between Codexa/Orange5 instances on different hosts. Two operators on two machines would have two disjoint chains.
- **No atom signing with hardware keys.** `signature.hash` is `sha256(canonical_atom)` — a content hash, not a cryptographic identity signature. There is no YubiKey / TPM / PIV binding. An attacker with write access to the SQLite file or Flux lane could forge atoms; the chain detects tamper of an existing atom but does not prove who wrote it.
- **No automatic supersession detection.** Supersession is operator-asserted via the `supersedes: [atom_id, ...]` field at write time. The system does not scan for semantic conflicts between atoms and propose supersession candidates. A stale invariant remains `active` until someone explicitly revokes or supersedes it.
- **No GUI for viewing atoms.** Markdown render via `decodeCommitmentAtom` is wire-format only — there is no Tauri room, no Atomic Orange tab, no dashboard. Inspection today is `curl /v1/atomsmasher/atoms/:id` or a direct SQLite query. A viewer is a separate PR.
- **Main boundary splice not yet committed.** `atomsmasher-boundary.mjs` is the splice file with import + spread guidance, but `06-ORANGELLM/server/boundary.mjs` itself is not modified by this PR. Until that one-line import + spread lands, the boundary will reject requests to `/v1/atomsmasher/atoms`. Wiring is documented in the splice file header.
- **No `reindex.mjs` yet.** SQLite is the projection; Flux is the canonical record. If the SQLite file is lost, there is no replay tool yet to rebuild the index from Flux. Named honestly in `store.README.md`.

---

## Mom's Law alignment

- Asked for STUB → LIVE promotion; delivered a working module with smoke tests, not a skeleton.
- Anti-fluff guards live in the encoder, not in a separate "validator someone will add later" — `green_assumed | looks_ok | probably | should_work` throw at write time, walking nested objects and array values **and key names**. The doctrine is structurally enforced, not aspirational.
- Append-only is real: only `status` is ever `UPDATE`d in SQLite, and every status transition emits a `commitment-status-change` Flux event. The audit trail is permanent.
- Evidence-required kinds (`invariant`, `promise`) reject empty evidence arrays at encoder time — you cannot make a promise without showing receipts.
- Sovereign is `const "Atom McCree"` in the schema and re-asserted in the encoder. No free-text impersonation.
- `atom_id` is content-derived (`sha256(canonical({kind, body, preconditions, supersedes}))`), so duplicate commitments collide deterministically — the system cannot pretend two identical commitments are different just because they were written at different times.
- Honest about every gap: cross-machine sync, hardware signing, automatic supersession, GUI, boundary splice, reindex tool — all named above. No theater.
- Smoke test runs in `os.tmpdir()`, never pollutes the operator's real Reality lane. Setup and teardown are real, not "trust me, it works."
- `confidence` field is graded per-component, not blanket-HIGH. Routes are MEDIUM until the boundary splice lands and end-to-end through the actual gateway runs.

---

## Rollback

```powershell
# Remove the LIVE module surface (encoder, decoder, store, smoke, routes, boundary splice)
Remove-Item -Recurse -Force C:\AtomEons\Orange5\12-ATOMSMASHER\commitment-atoms
Remove-Item -Force C:\AtomEons\Orange5\06-ORANGELLM\server\routes\atomsmasher.mjs
Remove-Item -Force C:\AtomEons\Orange5\06-ORANGELLM\server\routes\atomsmasher-boundary.mjs
Remove-Item -Force C:\AtomEons\Orange5\09-SCHEMAS\commitment-atom.v0.schema.json

# Any SQLite index file the smoke test or operator may have created lives under the path
# passed in `dbPath` — by default the smoke runs in os.tmpdir() and self-cleans; for any
# production index path the operator chose, delete that file explicitly.
```

Flux records written during smoke or operator use are append-only and remain in the Reality lane — that is intentional. Rolling back the module does NOT erase the audit trail.

---

## Next action

1. Splice `ATOMSMASHER_ALLOWED` + `isAtomSmasherRouteAllowed` into `06-ORANGELLM/server/boundary.mjs` (one-line import, spread into flat ALLOWED list, parameterized check in the route resolver). One-line PR.
2. Run `smoke-test.mjs` against a live gateway (not just standalone store) to upgrade routes confidence from MEDIUM to HIGH.
3. Author `reindex.mjs` that replays Flux → SQLite so the projection is recoverable.
4. Open a sibling PR for the Atomic Orange `Commitments` tab consuming `GET /v1/atomsmasher/atoms`.

---

## Hash chain

#019. Prior: #018 (Atomic Orange private repo published). Next expected: #020 (boundary splice committed + gateway-live smoke green) OR ad-hoc receipt for the next operator-directed action.

---

**Mom is watching. Commitments are atoms now. Content-addressable, append-only, hash-chained. No fluff words. No silent supersession. No sovereign impersonation.**
