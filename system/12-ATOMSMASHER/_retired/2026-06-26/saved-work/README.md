# Saved Work Certificates — encoder + verifier + redeemer

AtomSmasher module #8 (of 12). **Status in this drop:**

| Surface                                   | Status                  |
| ----------------------------------------- | ----------------------- |
| `certs.mjs` — encoder/validator/redeemer  | **LIVE**                |
| `smoke-test.mjs` — end-to-end pure test   | **LIVE** (56/56 green)  |
| Persistence — `store.mjs`                 | PENDING (sibling drop)  |
| Schema file in `09-SCHEMAS/`              | PENDING (mirror v0 id)  |
| Gateway routes in `06-ORANGELLM/`         | PENDING (sibling drop)  |

No theater: the pure module + smoke test ship LIVE. The Flux/SQLite writer
and the `POST /v1/atomsmasher/certs/{mint,verify,redeem}` HTTP wiring
require sibling files to mirror the pattern in
`12-ATOMSMASHER/commitment-atoms/store.mjs` and
`06-ORANGELLM/server/routes/atomsmasher.mjs`; those are not in this drop and
are called out plainly so the gap is not hidden.

## What this module is

A **Saved Work Certificate** proves a piece of work was done AND can be
reused. It is the minted, hash-chained, content-addressed receipt for a
unit of completed work, designed so a future caller can:

1. **assert** that this work was performed (`mint`),
2. **verify** the certificate's hash chain + content integrity (`verify`),
3. **redeem** the certificate to short-circuit re-doing equivalent work
   (`redeem`).

The shape Atom asked for:

```
{ id: cert_id, work_hash, output_hash, signature_chain, references_receipt[] }
```

is exactly what this encoder produces, plus the structural metadata
(`schema`, `actor`, `created_at`, `policy`, `status`, `output_summary`,
`inputs_digest`, `work_kind`) needed to make verification self-contained
and to make `cert_id` deterministically content-derived.

## Doctrine (binding)

1. **Certificates are append-only.** A cert is never edited. To revise the
   work, mint a NEW certificate; the old one can be `redeem()`d or
   `revoke()`d, both of which return a NEW cert with an extended
   `signature_chain` — the input is not mutated.
2. **`cert_id` is content-derived.**
   `sha256(canonical({schema, work_kind, work_hash, output_hash,
   inputs_digest, references_receipt}))`. Two callers asserting identical
   work AND output collide on `cert_id` — by design. The `signature_chain`
   head hash still differs (it carries actor/ts/prevHash), so the chain is
   per-instance unique.
3. **`signature_chain` is the per-cert causal chain.** A non-empty array
   of `{prev_hash, hash, event, ts, …}` links. First link's `prev_hash` is
   `'GENESIS'` or a sha256 reference to a prior cert/atom hash. Every
   subsequent link's `prev_hash` MUST equal the previous link's `hash`.
   Rewriting any earlier link breaks the tail hash and `verify()` fails.
4. **`references_receipt` is non-negotiable.** A certificate that claims
   work was done with ZERO receipt evidence is a theatrical badge.
   Anti-fluff hard-rejects an empty (or non-array) `references_receipt`.
5. **Anti-fluff is a HARD reject, not a warning.** `output_summary`,
   `work_kind`, `references_receipt[*]`, and (on `redeem`/`revoke`) the
   `consumer`/`reason` strings cannot contain
   `green_assumed | looks_ok | probably | should_work`.
6. **Pure module, zero deps.** No file I/O, no DB, no HTTP. Same
   discipline as the Anti-fluff Gate and Commitment Atoms encoder. The
   schema object is exported so any caller that already has Ajv loaded
   can plug it in; the inline validator covers the rest.

## API

```js
import {
  mint,
  verify,
  redeem,
  revoke,
  CERT_SCHEMA_ID,
  SAVED_WORK_CERT_SCHEMA,
  VALID_POLICIES,
  VALID_STATUSES,
} from './certs.mjs';
```

### `mint({...})`

| arg                  | type                                  | required | default        |
| -------------------- | ------------------------------------- | -------- | -------------- |
| `work_kind`          | non-empty string                      | yes      | —              |
| `work_hash`          | 64-char lowercase hex (sha256)        | yes      | —              |
| `output_hash`        | 64-char lowercase hex (sha256)        | yes      | —              |
| `inputs_digest`      | non-empty string (any stable fingerprint) | yes  | —              |
| `output_summary`     | non-empty string (no fluff words)     | yes      | —              |
| `references_receipt` | `string[]` (non-empty)                | yes      | —              |
| `actor`              | non-empty string                      | yes      | —              |
| `prevHash`           | `'GENESIS'` or 64-hex sha256          | yes      | —              |
| `policy`             | `'single_use' \| 'multi_use'`         | no       | `'single_use'` |
| `ts`                 | unix ms (test override)               | no       | `Date.now()`   |

Returns the cert object. Throws on invalid input or anti-fluff hit.

### `verify(cert)`

Returns `{valid: boolean, errors: string[]}`. Checks:

- schema id match
- `additionalProperties: false` (no unknown keys)
- all required fields present and typed
- `cert_id` integrity (re-derived from canonical payload)
- `signature_chain` shape: non-empty, every link has well-formed `hash`,
  every `prev_hash` after index 0 equals the prior link's `hash`
- signature tail hash integrity (re-derived from canonical cert with the
  tail link's `hash` blanked)
- anti-fluff scan over `work_kind`, `output_summary`, `references_receipt`
- `references_receipt` non-empty and all-string
- `work_hash` + `output_hash` hex shape

### `redeem(cert, {consumer, reason?, ts?})`

Returns a NEW cert representing the post-redeem state. Original is not
mutated.

- `single_use` policy: status flips `minted → redeemed`. Second redeem
  throws.
- `multi_use` policy: status stays `minted`; chain still extends per
  redeem event so replays are auditable by chain depth.
- Throws if the input cert fails `verify`, if status is `revoked`, or if
  the single_use cert has already been redeemed.

### `revoke(cert, {actor, reason?, ts?})`

Returns a NEW cert with status `revoked` and a fresh chain link recording
the revoke event. Throws on double-revoke (operator must see the existing
revocation; idempotent revoke would mask intent).

### `SAVED_WORK_CERT_SCHEMA`

The JSON Schema (draft 2020-12) for the cert shape. Exported so Ajv users
can plug it in directly. Inline validator enforces the same rules without
a dependency.

## Example — mint, verify, redeem

```js
import crypto from 'node:crypto';
import { mint, verify, redeem } from './certs.mjs';

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

const cert = mint({
  work_kind: 'authoring',
  work_hash: sha(JSON.stringify({ goal: 'Compile certs.mjs' })),
  output_hash: sha(JSON.stringify({ path: 'certs.mjs', bytes: 14072 })),
  inputs_digest: `node:${process.version}|cwd:Orange5/12-ATOMSMASHER`,
  output_summary:
    'Authored certs.mjs (mint/verify/redeem/revoke). Pure, zero-dep, deterministic cert_id.',
  references_receipt: [
    'receipts/2026-06-24/atomsmasher-saved-work-cert-author.md',
  ],
  actor: 'system:atomsmasher',
  prevHash: 'GENESIS',
});

console.log(cert.cert_id);                          // 64-char sha256
console.log(cert.signature_chain[0].hash);          // 64-char sha256
console.log(cert.status);                           // 'minted'

const { valid } = verify(cert);                     // true

const redeemed = redeem(cert, {
  consumer: 'task:replay-001',
  reason: 'cache hit on identical work spec',
});

console.log(redeemed.status);                       // 'redeemed'
console.log(redeemed.signature_chain.length);       // 2
console.log(redeemed.signature_chain[1].event);     // 'redeem'
```

## What is NOT in this file (yet) — honest gaps

- **`store.mjs`** — Æ Cobra Flux Reality lane write + SQLite index. Mirrors
  the structure of `12-ATOMSMASHER/commitment-atoms/store.mjs`: the cert
  goes into the Flux lane as `{origin:'atomsmasher', kind:'saved-work-cert',
  body: cert}`, the SQLite row carries `(cert_id PRIMARY KEY, work_hash,
  output_hash, status, policy, created_at, flux_record_hash)` for fast
  filter queries.
- **`09-SCHEMAS/saved-work-cert.v0.schema.json`** — disk copy of
  `SAVED_WORK_CERT_SCHEMA` so the control plane and Ajv-based consumers
  can load it without importing the JS module.
- **`06-ORANGELLM/server/routes/atomsmasher-certs.mjs`** —
  `registerSavedWorkCertRoutes(server, opts)` exposing:
    - `POST /v1/atomsmasher/certs/mint`   → `mint()` + `store.createCert()`
    - `POST /v1/atomsmasher/certs/verify` → `verify()` + read-through index
    - `POST /v1/atomsmasher/certs/redeem` → `redeem()` + `store.updateCertChain()`
  Must also be added to the gateway boundary allow-list at
  `06-ORANGELLM/server/routes/atomsmasher-boundary.mjs`.
- **Cross-module hash-chain bridging.** `prevHash` in this module currently
  accepts `'GENESIS'` or any 64-hex string. When the store lands, the
  gateway should chain off `store.getLatestCertHash()` (mirroring the
  Commitment Atoms gateway's `store.getLatestHash()` pattern) so a single
  Reality-lane chain witnesses both atoms and certs.

These gaps are stated, not hidden — that is the contract Atom set for
"each module follows the Anti-fluff Gate's LIVE pattern." The pure-encoder
piece is LIVE; the wiring is the next drop.

## Why content-derived cert_id

If you re-run the same compile on the same inputs and produce the same
output, you should arrive at the same `cert_id`. That property is what
makes redeem economically meaningful: a downstream caller asking
"has this work been done?" hashes its `{work_kind, work_hash, output_hash,
inputs_digest, references_receipt}` exactly the way `mint()` does and looks
up that `cert_id`. A miss is honest; a hit is the redeemable receipt.

`signature_chain` carries the per-instance provenance — actor, time, redeem
history, consumers, revocations — independent of the content fingerprint.

## Test surface (what `smoke-test.mjs` actually asserts)

1. Module surface: exports + schema frozen.
2. `mint` round-trip: GENESIS chain, status `minted`, single chain link,
   tail hash is 64-hex.
3. Content determinism: same content → same `cert_id`; different
   `prevHash` → same `cert_id` but different chain head hash.
4. Tamper detection: editing `output_summary` after seal breaks
   `verify`; editing `cert_id` breaks `verify` with a distinct error.
5. Anti-fluff hard reject in `output_summary` and `references_receipt`.
6. `references_receipt` required + non-empty (array, all strings).
7. `work_hash` / `output_hash` must be 64-char lowercase hex (short
   strings, uppercase hex both rejected).
8. `redeem` (single_use): returns new cert, original unmutated, status
   flips, chain length goes 1→2, link[1].prev_hash == link[0].hash, second
   redeem throws.
9. `redeem` (multi_use): three serial redeems, chain length 4, every
   link's `prev_hash` matches the prior link's `hash`, status stays
   `minted`, final cert verifies.
10. `revoke`: returns new cert with status `revoked`, chain extends,
    post-revoke redeem throws, double-revoke throws.
11. `additionalProperties: false`: extra key on cert fails `verify`.
12. Chain-rewrite resistance: editing an earlier chain link breaks tail
    hash verification.

Run it:

```
node 12-ATOMSMASHER/saved-work/smoke-test.mjs
```

Current run on 2026-06-24, node v22: **56/56 checks green**.

## Why no Ajv

Same answer as the Commitment Atoms encoder and the Anti-fluff Gate:
zero-dep discipline keeps this module unit-testable in isolation and
keeps the verifier honest about what it actually checks. The schema
object is exported for callers that already have Ajv loaded.
