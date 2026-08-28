# Canon Pressure Detector

AtomSmasher module #9. **Status: detector + smoke LIVE; gateway route + schema
file PENDING in siblings.**

## What this module is

The Canon Pressure Detector watches the receipts stream for **ontology
candidates** — names / terms / concepts the AtomEons system has been using as
if they were canon, but that have never been formally promoted into the
ontology. When usage accumulates past a threshold, the detector raises a
**promotion candidate** for AE7 review.

The detector does not promote anything itself. AE7 review is the gate. The
detector only watches and reports.

## Promotion rules (binding)

A candidate enters a non-inert state when **either** rule trips:

1. **Receipt threshold.** ≥ 5 receipts reference the candidate AND those
   receipts span ≥ 2 distinct missions.
2. **Operator promotion.** A `recordOperatorPromotion(...)` call has been made
   against the candidate with a non-fluff rationale.

The two signals are independent. Both can be on at once — that's the strongest
signal — and an explicit `decision: 'reject'` decision later in time **does**
override an earlier `'promote'` (the decision log keeps the full history).

| state         | meaning                                              |
| ------------- | ---------------------------------------------------- |
| `inert`       | below threshold, no operator promotion               |
| `receipt`     | receipt threshold tripped only                       |
| `operator`    | operator promotion only                              |
| `receipt+op`  | both signals tripped (strongest case for AE7)        |

Thresholds are exported as `PRESSURE_THRESHOLDS = { MIN_RECEIPTS: 5,
MIN_MISSIONS: 2 }`. If operator doctrine ever changes the numbers, they change
there in one place.

## Doctrine (Mom's Law applied to ontology)

- **Observe, do not mutate.** Promotion happens elsewhere, with operator
  stamp. The detector raises signals; it does not edit ontology.
- **References must be explicit.** The detector does not infer references
  from prose similarity. Callers (the receipts ingest pipeline) pass the
  candidate name verbatim with each receipt. Silent inference would
  manufacture canon out of vibes.
- **Honest gaps.** Empty DB returns zeroed counts, not theatrical "all clear"
  language.
- **Idempotent.** Re-ingesting the same `(candidate, receipt_id)` pair does
  not double-count. The primary key is the gate.
- **Mission-coherence guard.** If the same `receipt_id` is later submitted
  under a *different* `mission_id` for the same candidate, the detector
  refuses and surfaces the conflict — that's an upstream data quality bug
  worth catching, not a thing to paper over.
- **Append-only at the row level.** A candidate's references are never
  deleted. A promotion *decision* may be reversed — but only by appending a
  new decision, never by erasing the old one.

## API

```js
import {
  ingestReceiptReference,
  recordOperatorPromotion,
  candidateStatus,
  listPromotionCandidates,
  pressureSummary,
  PRESSURE_THRESHOLDS,
  PRESSURE_STATES,
  SCHEMA_ID,
} from './detector.mjs';
```

### `ingestReceiptReference({ candidate, receiptId, missionId, dbPath, refActor?, refEvidence?, observedAt? })`

Record that a receipt referenced an ontology candidate, scoped to a mission.
Idempotent on `(candidate, receipt_id)`. Returns
`{ ok: true }`, `{ ok: true, duplicate: true }`, or
`{ ok: false, error: '...' }`.

### `recordOperatorPromotion({ candidate, decision, actor, rationale, dbPath, decidedAt? })`

Record an explicit operator promotion or rejection. `decision` is `'promote'`
or `'reject'`. Rationale is anti-fluff checked — `should_work`, `looks_ok`,
`probably`, `green_assumed` are rejected. Idempotent on a content-derived
`decision_id`.

### `candidateStatus(candidate, { dbPath })`

Return the current pressure status for one candidate:

```js
{
  candidate: 'Pathwaves',
  receipt_count: 5,
  mission_count: 2,
  missions: ['mission:misfits-frontier', 'mission:orange5-build'],
  threshold_tripped: true,
  operator_promoted: true,
  operator_decisions: [{ decision, actor, rationale, decided_at }, ...],
  state: 'receipt+op',
  first_seen_at: '2026-06-24T12:00:00Z',
  last_seen_at:  '2026-06-24T18:31:42Z',
}
```

### `listPromotionCandidates({ dbPath, includeInert?, limit? })`

Return every non-inert candidate, ordered by signal strength so AE7 review
sees the strongest cases first. Pass `includeInert: true` for dashboards.

### `pressureSummary({ dbPath })`

High-level counts for dashboards. Honest — if no observations, every count
is 0.

## SQLite layout

Two tables, both append-only at the application level:

- **`canon_pressure_references`** — `(candidate, receipt_id) PRIMARY KEY`,
  plus `mission_id`, `observed_at`, `ref_actor`, `ref_evidence`.
- **`canon_pressure_operator_decisions`** — `decision_id PRIMARY KEY`,
  `candidate`, `decision`, `actor`, `rationale`, `decided_at`.

`decision_id` is `sha256({candidate, decision, actor, decided_at, rationale})`
so resubmitting the exact same decision is naturally idempotent.

## What's NOT in this module (yet — explicit gaps)

- **JSON Schema file.** `09-SCHEMAS/canon-pressure.v0.schema.json` is not
  authored yet. The `SCHEMA_ID = 'orange5.canon-pressure.v0'` literal in
  `detector.mjs` is its forward declaration. Sister modules (commitment
  atoms, compression debt) carry their schemas in 09-SCHEMAS; this one
  should follow.
- **Gateway route.**
  `06-ORANGELLM/server/routes/atomsmasher-canon-pressure.mjs` is not yet
  written. It should expose `ingestReceiptReference`, `candidateStatus`,
  `listPromotionCandidates`, and `pressureSummary` over the gateway with
  the standard atomsmasher route boundary.
- **Receipts pipeline wiring.** Whoever owns the receipt ingest at
  `06-CONTROL-PLANE/receipts/` needs to extract candidate references from
  each receipt and call `ingestReceiptReference` per `(candidate,
  receipt_id, mission_id)` tuple. The detector intentionally does not do
  this extraction itself — extraction logic belongs with the receipts
  pipeline that already understands receipt structure.
- **Flux audit emission.** This detector keeps a local ledger only. Promotion
  *decisions* downstream (the actual ontology edits) are what should land in
  Æ Cobra Flux Reality lane as commitment atoms — that's the right place
  for the audit chain, and it lives in module #1.

## Run the smoke test

```
cd C:/AtomEons/Orange5/06-CONTROL-PLANE/receipts
node C:/AtomEons/Orange5/12-ATOMSMASHER/canon-pressure/smoke-test.mjs
```

The smoke test covers: honest-empty baseline, 4-receipt sub-threshold,
idempotency, mission-coherence rejection, 5th-receipt threshold trip,
single-mission concentration NOT tripping, operator-only path,
`receipt+op` stacking, anti-fluff rationale rejection, reject-overrides-promote
ordering, list ordering and inert exclusion, summary accounting,
input validation, and whitespace-collapse-without-case-merge normalization.

Exits non-zero on any failure. No test framework dependency.
