# Compression Debt Ledger

**AtomSmasher module #7** — tracks every time the system chose verbose over
compressed. Pays the debt when re-execution finds the compression.

## Why it exists

Mom's Law applies to compression: when the system emits a verbose form
because no codec was wired up yet, because the operator overrode, or because
the first-pass draft just sprawled, the choice should be **named**, not
hidden. The Compression Debt Ledger is the record. Hiding the choice would
be theater; the ledger is the receipt.

A debt is **paid** when a later pass actually produces the compressed form
and stamps it on the row. The ledger then learns:

- which surfaces accumulate the most debt
- which surfaces actually pay it back
- which "compressions" turned out to be **regressions** (compressed form
  was longer — recorded honestly, not silently swallowed)
- which debts get **forgiven** because the verbose form was load-bearing on
  inspection (operator-stamped write-off; requires inspection evidence)

## Substrates

Two writes per state change. **Flux is canonical, SQLite is a projection.**

1. **Æ Cobra Flux — Reality lane.** Append-only, hash-chained.
   `origin='atomsmasher'`, kinds:
   - `compression-debt` — debt opened
   - `compression-debt-payment` — debt paid
   - `compression-debt-forgiveness` — debt forgiven (rare)
2. **SQLite index** — `compression-debt.db`, table `compression_debts`,
   indexed by `(status, recorded_at)` and `(surface, status)`.
   Rebuildable from Flux by replay.

Flux gets written first. If the SQLite mirror fails, the ledger surfaces
honestly — Mom's Law: never pretend the write succeeded.

## Schema

`09-SCHEMAS/compression-debt.v0.schema.json` — `orange5.compression-debt.v0`.

A debt entry:

```jsonc
{
  "schema": "orange5.compression-debt.v0",
  "debt_id": "<sha256 hex>",
  "verbose_hash": "<sha256 of verbose text>",
  "verbose_chars": 287,
  "compressed_hash": "<sha256 of compressed text, when paid>",
  "compressed_chars": 56,
  "savings_chars": 231,          // verbose_chars - compressed_chars
  "status": "open" | "paid" | "forgiven",
  "recorded_at": "2026-06-24T10:00:00.000Z",
  "paid_at": "2026-06-24T13:00:00.000Z",
  "context": {
    "surface": "cartridge:legal",
    "actor": "model:opus-4-7",
    "ref": "receipts/2026-06-24/contract-draft-001.md",
    "reason": "no codec for legal boilerplate yet"
  },
  "payment_evidence": "receipts/2026-06-24/legal-codec-pass-001.json"
}
```

**The verbose prose is NEVER stored.** Only its sha256 fingerprint and
char count. We do not bloat the auditor with the very verbosity it audits.

## debt_id determinism

`debt_id = sha256(canonical-JSON({verbose_hash, recorded_at, context: {surface, actor}}))`

Identical `(verbose, surface, actor, recorded_at)` tuples produce identical
debt_ids. `recordDebt` is idempotent on this tuple: a re-record returns
`{ ok: true, duplicate: true, debt_id }` without minting a second row. The
`ref` and `reason` fields can vary over time without changing identity.

## API

```js
import {
  recordDebt,
  payDebt,
  forgiveDebt,
  getDebt,
  listDebts,
  debtSummary,
} from './ledger.mjs';
```

### `recordDebt({ verboseText, context, fluxRoot, dbPath, recordedAt? })`

Open a debt. Returns
`{ ok: true, debt_id, flux_record_hash }` or
`{ ok: true, debt_id, duplicate: true, status }` on idempotent re-record.

### `payDebt({ debtId, compressedText, paymentEvidence, fluxRoot, dbPath, paidAt? })`

Close a debt with the realized compressed form. Computes `savings_chars`
honestly — a negative value (compressed form was longer) is kept as-is and
flagged via `regression: true` on the return. Idempotent on same
`compressed_hash`; rejects with `existing_compressed_hash` if a different
compression is supplied for an already-paid debt.

### `forgiveDebt({ debtId, paymentEvidence, fluxRoot, dbPath, paidAt? })`

Operator write-off. Use ONLY when inspection shows the verbose form was
load-bearing. `paymentEvidence` MUST cite the inspection receipt — Mom's Law
does not allow silent forgiveness. Rejects forgiving an already-paid debt
(that would lie about history).

### `getDebt(debtId, { dbPath })`

Returns the entry or `null`.

### `listDebts({ status?, surface?, since?, limit?, dbPath })`

AND-combined filters; ordered by `recorded_at ASC, debt_id ASC`. Default
limit 1000, max 100000.

### `debtSummary({ dbPath, surface?, since? })`

Honest accounting:

```jsonc
{
  "total": 3,
  "open_count": 0,
  "paid_count": 2,
  "forgiven_count": 1,
  "open_verbose_chars": 0,         // chars still on the books
  "paid_savings_chars": 187,       // NET savings (regressions reduce this)
  "regression_count": 1,           // paid debts where compressed was longer
  "regression_chars": -42,         // sum of those negative savings
  "by_surface": [
    { "surface": "cartridge:legal", "total": 1, "open": 0, "paid": 1, "savings_chars": 229 },
    ...
  ],
  "generated_at": "2026-06-24T15:30:00.000Z"
}
```

## Gateway

`06-ORANGELLM/server/routes/atomsmasher-compression-debt.mjs` exposes:

- `GET  /v1/atomsmasher/compression-debt` — list + summary
- `GET  /v1/atomsmasher/compression-debt/:debt_id` — single entry
- `POST /v1/atomsmasher/compression-debt/record` — open a debt
- `POST /v1/atomsmasher/compression-debt/pay` — close a debt
- `POST /v1/atomsmasher/compression-debt/forgive` — write off a debt

Gateway routes must be added to the AtomSmasher boundary allow-list before
they are reachable from outside the loopback.

## Smoke test

```bash
# better-sqlite3 lives under 06-CONTROL-PLANE/receipts/node_modules.
# A symlink at Orange5/node_modules -> 06-CONTROL-PLANE/receipts/node_modules
# lets ESM resolve it from anywhere under Orange5:
#   cd C:/AtomEons/Orange5 && ln -s 06-CONTROL-PLANE/receipts/node_modules node_modules
# Then:
node C:/AtomEons/Orange5/12-ATOMSMASHER/compression-debt/smoke-test.mjs
```

**Verified PASS** on 2026-06-24: 60+ checks green end-to-end, including
the Flux hash-chain integrity check across all 6 audit events.

The smoke test exercises the full round-trip end-to-end:

1. record 3 debts across 2 surfaces (legal cartridge, pathwave plan, manual safety)
2. assert idempotency: re-record with same tuple returns `duplicate: true`
3. `getDebt` and `listDebts` filters (status, surface, since)
4. pay debt #1 with a real compression — positive savings asserted
5. assert idempotency on re-pay with same `compressed_hash`
6. assert rejection on re-pay with **different** `compressed_hash`
7. pay debt #2 with a regression — negative savings recorded honestly
8. forgive debt #3 — load-bearing safety text, inspection evidence required
9. assert `debtSummary` numbers match inputs (incl. regression accounting)
10. assert Flux Reality lane has all 6 expected events and the hash-chain links

The test cleans up its temp workspace under `os.tmpdir()`. It does NOT
touch the operator's real Reality lane or SQLite index.

## Honest gaps

- The smoke test depends on `better-sqlite3`. The dep is installed under
  `06-CONTROL-PLANE/receipts/node_modules`; the smoke test header notes
  the cwd requirement. A workspace-level `package.json` would resolve this
  cleanly but is out of scope here.
- `forgiveDebt` is operator-gated by social convention, not by code. The
  `paymentEvidence` field is asserted non-empty but its content (does it
  actually point to a real inspection receipt?) is not verified by the
  ledger itself. That verification belongs to the gauntlet / promotion gate.
- The schema's conditional `allOf` rules (open => null fields, paid =>
  required fields) are NOT enforced by `ledger.mjs` directly — the API
  shape enforces them by construction (you cannot reach `status='paid'`
  without going through `payDebt`, which sets all the required fields).
  A separate `validate()` would be needed if the schema were used as an
  open-world ingest gate.
- No automatic Flux→SQLite rebuild routine ships in this file. The recovery
  path is documented in the error returns ("replay flux reality lane to
  rebuild compression-debts table"); the actual replay tool is a separate
  job under the Reality lane indexer.

## Doctrine cross-reference

- **Anti-fluff Gate** (LIVE) — the codec that *prevents* the verbose
  emission upstream when a codec exists. The Compression Debt Ledger is
  the receipt for cases the gate cannot prevent.
- **AIR Codec** (module #1) — the structured-frame compressor. Paying a
  debt through AIR is the standard recovery path; `payment_evidence`
  should point to the AIR frame's receipt.
- **Commitment Atoms** (LIVE) — the prior-art reference for the Flux +
  SQLite dual-substrate pattern. This module mirrors that doctrine.
