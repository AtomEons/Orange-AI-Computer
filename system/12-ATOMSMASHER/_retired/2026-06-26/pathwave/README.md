# Pathwave — compressor

AtomSmasher module **#10** (of 12). **Status: compressor LIVE, persistence
+ store + gateway route still PENDING in sibling files.**

## What this file is

`compressor.mjs` is the pure, dependency-free compressor + validator for
a **Pathwave** — the canonical, deterministic, content-addressed
compression of an execution trajectory.

A trajectory is a sequence of tuples:

```
(orange.order.v1) -> action -> (orange.report.v1) -> (receipt.v0?)
```

produced by a real run. The Pathwave preserves order, intent identity,
action label, terminal status, confidence, evidence identity, and
receipt anchor for every step. It drops verbose prose, log streams,
runtime nonces, and anything that varies run-to-run without changing
meaning.

The result is a stable shape suitable for **replay**, **diff**, and
**comparison** between alternative paths through the same task.

This module **does not** write to Æ Cobra Flux, **does not** touch
SQLite, and **does not** expose a gateway route. Those land in sibling
files so the compressor stays unit-testable in isolation, matching the
Sparse Worksets / Commitment Atoms / AIR Codec pattern.

Canonical JSON Schema: `09-SCHEMAS/pathwave.v0.schema.json`. The inline
validator (`validatePathwave`) enforces the same rules so the module is
usable before any schema validator is wired up.

## Doctrine (binding)

1. **Order is meaning.** The compressor never reorders steps. Two
   trajectories with the same multiset of steps but different orderings
   produce different `pathwave_id`s — that's correct, because the system
   did different things in different orders.
2. **Determinism.** Identical inputs produce a byte-identical
   `pathwave_id`. The id payload excludes `created_at`, `warnings`, and
   any synthesized stats — only meaning-bearing fields participate.
   `pathwave_id = sha256(canonical({task, steps[]={order_id, intent_hash,
   action, status, confidence, evidence_hashes[], receipt_id}}))`.
3. **Identity over payload.** Intent strings and evidence payloads are
   replaced by their sha256s. The Pathwave knows WHICH intent and WHICH
   evidence — not what they said. This is the compression.
4. **Honest gaps (Mom's Law).** If `order.requiresReceipt === true` and
   no receipt was supplied, `receipt_id` stays `null` and a
   `missing_receipt: step[<n>]` warning is emitted. The compressor
   NEVER fabricates a receipt id. Same discipline for
   `unexpected_receipt` (requiresReceipt was false but a receipt was
   supplied) and `no_evidence` (zero evidence objects on the report).
5. **Anti-fluff (LIVE).** A task that is empty or matches a fluff-only
   pattern (`do the thing`, `tbd`, `…`, etc.) is hard-rejected. The task
   is the meaning anchor of the trajectory; an empty anchor would make
   the id meaningless. The forbidden-word list is shared with sibling
   modules: `green_assumed`, `looks_ok`, `probably`, `should_work`.
6. **Strict input validation.** Each step's `order` must be a valid
   `orange.order.v1`, each `report` must be a valid `orange.report.v1`,
   each `receipt` (when present) must be a valid `orange5.receipt.v0`,
   and `report.orderId` must equal `order.orderId`. Mismatches throw.
7. **No silent dedup.** Duplicate `orderId`s across steps throw — a real
   trajectory cannot reuse an orderId because each order is a fresh
   authorization envelope.
8. **No external deps.** Pure `node:crypto`. The compressor never writes
   to disk, never opens a network, never calls a model.

## API

```js
import {
  compressPathwave,
  validatePathwave,
  diffPathwaves,
} from './compressor.mjs';
```

### `compressPathwave({ task, steps })`

| arg     | type                                      | required |
| ------- | ----------------------------------------- | -------- |
| `task`  | non-empty content-bearing string (≤ 1000) | yes      |
| `steps` | `Array<Step>` (≤ 10000)                   | yes      |

`Step` input shape:

| field    | type                  | required | meaning                                                              |
| -------- | --------------------- | -------- | -------------------------------------------------------------------- |
| `order`  | `orange.order.v1`     | yes      | The authorization envelope that initiated this step                  |
| `report` | `orange.report.v1`    | yes      | The terminal outcome; `report.orderId` must match `order.orderId`    |
| `receipt`| `orange5.receipt.v0?` | no       | The signed receipt, when one was produced                            |
| `action` | `string?`             | no       | Explicit action label override; defaults to `order.allowedActions[0]`|

### Return shape

```js
{
  schema: 'orange5.atomsmasher.pathwave.v0',
  pathwave_id: '<sha256>',
  task: '<verbatim>',
  steps: [
    {
      index: 0,
      order_id: 'ord-001',
      intent_hash: '<sha256 of order.intent>',
      action: 'read_file',
      status: 'ok',                     // normalized lowercase
      confidence: 0.98,
      evidence_hashes: ['<sha256>', ...],
      receipt_id: 'rcpt-001' | null,
      risk_level: 'low' | ...           // optional carry-over
      next_action: '...'                // optional carry-over (≤ 200 chars)
    },
    ...
  ],
  stats: {
    step_count, ok_count, fail_count,
    input_bytes, output_bytes,
    compression_ratio_bytes,            // output / input (1 when input is 0)
  },
  warnings: [],                         // 'missing_receipt: step[i]', 'no_evidence: step[i]', ...
  created_at: '2026-06-24T17:33:01.000Z',
}
```

### `validatePathwave(pathwave)`

Returns `{ valid: boolean, errors: string[] }`. Enforces:

- schema constant, `pathwave_id` is sha256 hex, task is non-empty;
- every `step.index` equals its array position and is strictly
  monotonic;
- every `intent_hash` and `evidence_hashes[*]` is sha256 hex;
- `confidence ∈ [0, 1]`;
- `receipt_id` is null OR a non-empty string;
- `risk_level`, when present, is one of the order's enumerated risk
  levels;
- `stats.step_count == steps.length`, `stats.ok_count` and
  `stats.fail_count` match the observed statuses;
- every warning string is non-empty.

### `diffPathwaves(a, b)`

Returns `{ equal, divergence_index, reasons }`. Two pathwaves are equal
iff their `pathwave_id`s match. When unequal, `divergence_index` is the
0-based index of the first step that differs (or the length of the
shorter steps array if one is a strict prefix of the other), and
`reasons` enumerates which fields diverged.

## Drop / warning surface (exhaustive)

| warning                            | meaning                                                                                |
| ---------------------------------- | -------------------------------------------------------------------------------------- |
| `missing_receipt: step[<n>]`       | `order.requiresReceipt === true` but no receipt was supplied; `receipt_id` left null   |
| `unexpected_receipt: step[<n>]`    | `order.requiresReceipt === false` but a receipt was supplied                           |
| `no_evidence: step[<n>]`           | `report.evidence.length === 0`                                                         |
| `unspecified_action: step[<n>]`    | no `action` override AND `order.allowedActions` was empty / first entry was empty      |

## Thrown errors (exhaustive)

| condition                                       | thrown message starts with                                |
| ----------------------------------------------- | --------------------------------------------------------- |
| non-string / empty / fluff-only `task`          | `pathwave: task rejected (…)` or `pathwave: task must be` |
| `task` > 1000 chars                             | `pathwave: task must be <= 1000 chars`                    |
| `steps` not an array                            | `pathwave: steps must be an array`                        |
| `steps.length > 10000`                          | `pathwave: steps.length (…) exceeds MAX_STEPS`            |
| `order.schema !== 'orange.order.v1'`            | `pathwave: steps[i].order.schema must be`                 |
| `report.schema !== 'orange.report.v1'`          | `pathwave: steps[i].report.schema must be`                |
| `report.orderId !== order.orderId`              | `pathwave: steps[i].report.orderId '…' != order.orderId`  |
| confidence outside `[0, 1]`                     | `pathwave: steps[i].report.confidence must be`            |
| duplicate `order.orderId` across steps          | `pathwave: duplicate order.orderId '…'`                   |
| `receipt.schema !== 'orange5.receipt.v0'`       | `pathwave: steps[i].receipt.schema must be`               |

## Example

```js
const wave = compressPathwave({
  task: 'Compile Pathwave Compressor and verify trajectory integrity.',
  steps: [
    {
      order: {
        schema: 'orange.order.v1',
        orderId: 'ord-001',
        intent: 'Read compressor.mjs source',
        scope: 'C:/AtomEons/Orange5',
        allowedActions: ['read_file'],
        forbiddenActions: ['delete'],
        targetProject: 'Orange5',
        riskLevel: 'low',
        requiresReceipt: true,
      },
      report: {
        schema: 'orange.report.v1',
        orderId: 'ord-001',
        status: 'ok',
        confidence: 0.98,
        actionsTaken: ['read_file'],
        evidence: [{ kind: 'file_read', path: 'compressor.mjs', sha256: 'a'.repeat(64) }],
        blockers: [],
        nextAction: 'compile module',
        receiptPath: 'receipts/ord-001.json',
      },
      receipt: {
        schema: 'orange5.receipt.v0',
        receipt_id: 'rcpt-001',
        generated_at: '2026-06-24T17:00:01.000Z',
        actor: 'atomsmasher',
        status: 'ok',
        confidence: 0.97,
        hash_chain: 1,
      },
    },
    // ...more steps
  ],
});

console.log(wave.pathwave_id);     // sha256, stable across runs
console.log(wave.stats);           // { step_count, ok_count, fail_count, input_bytes, output_bytes, compression_ratio_bytes }
console.log(wave.warnings);        // [] if every step is clean
```

## Why a Pathwave (and not just storing the raw trajectory)

A raw `(order, report, receipt)` trajectory is verbose and run-coupled:

- `order.createdAt` and `receipt.generated_at` are timestamps that vary
  every run;
- `report.evidence` can carry log lines, tool outputs, partial dumps —
  large and noisy;
- `report.actionsTaken` and prose `nextAction` carry intent that's
  already pinned by the order;
- two functionally identical runs would never hash-equal.

The Pathwave reduces each tuple to the **load-bearing identity** of that
step: which authorization fired, what intent it carried (by hash), what
action label, what terminal status, with what confidence, against which
evidence objects (by hash), anchored by which receipt. Two runs that
took the same path through the same task produce the same
`pathwave_id`. Two runs that diverged produce two ids that
`diffPathwaves` can localize to the first divergent step.

## What's NOT in this file (yet)

- **Persistence** — sibling `persist.mjs` (PENDING) will write the
  Pathwave to Æ Cobra Flux with `{ lane: 'reality', origin:
  'atomsmasher', kind: 'pathwave', body: wave }`. Mirrors the
  Commitment Atoms pattern.
- **SQLite index** — sibling `store.mjs` (PENDING) for queries by
  `pathwave_id`, task hash prefix, created_at, and first divergent step
  across two registered ids.
- **Gateway route** — `06-ORANGELLM/server/routes/atomsmasher-pathwave.mjs`
  (PENDING) for `POST /atomsmasher/pathwave/compress`,
  `GET /atomsmasher/pathwave/:id`, and `POST /atomsmasher/pathwave/diff`.
- **Replay runner** — a Pathwave is replay-ready, but the actual replay
  loop (re-issue each order, compare against the recorded path, halt on
  the first divergence) is a separate runner under `04-CONTROL-PLANE`.
- **Compression-Debt hookup** — verbose prose dropped from `evidence`
  and `nextAction` is a candidate compression debt entry consumed by
  module #7 on persist.

## Why no Ajv / no SQL in this file

The compressor stays as primitive as possible:

- determinism is non-negotiable for `pathwave_id`;
- the canonical JSON + sha256 path is identical to Commitment Atoms /
  Sparse Worksets / AIR Codec so verifier shape is uniform;
- a schema validator (Ajv) would be a useful addition at the gateway
  boundary, not inside the primitive — the inline `validatePathwave`
  already enforces the structural and accounting integrity the schema
  documents;
- a DB write inside the compressor would couple compression to I/O
  failure modes; we keep it pure so tests run anywhere.

## Receipts

Run the smoke test:

```
node 12-ATOMSMASHER/pathwave/smoke-test.mjs
```

The script exits non-zero on any failure and prints `ok` / `FAIL` per
assertion. Mom's Law: no `green_assumed`, no `looks_ok`. Real checks or
no LIVE label.

## Test surface (minimum)

The compressor is built to support these test cases (all exercised by
`smoke-test.mjs`):

1. Happy path: every step compressed with correct fields, statuses
   normalized, evidence hashed, receipts carried.
2. Determinism: identical `(task, steps)` produces an identical
   `pathwave_id`.
3. Reordering steps changes the id.
4. Mutating a single evidence payload changes the id.
5. `requiresReceipt=true` + missing receipt yields
   `missing_receipt: step[i]` and `receipt_id === null` (no
   fabrication).
6. `requiresReceipt=false` + receipt supplied yields
   `unexpected_receipt: step[i]`.
7. Empty `report.evidence` yields `no_evidence: step[i]` and
   `evidence_hashes` is an empty array (preserved, not omitted).
8. `stats.ok_count` / `stats.fail_count` accurately count `ok` /
   (`failed`/`fail`/`error`); `partial` / other statuses pass through.
9. Hardening: fluff task, empty task, non-string task, non-array steps,
   wrong `order.schema`, wrong `report.schema`, `orderId` mismatch,
   duplicate `orderId`, confidence > 1, wrong `receipt.schema` all
   throw.
10. Empty `steps` is legal: returns zero-step Pathwave with
    `compression_ratio_bytes === 1` and validates.
11. `validatePathwave` rejects tampered `stats`, tampered `step.index`,
    tampered `evidence_hashes`, empty warning strings, and out-of-range
    confidences.
12. `diffPathwaves` returns `equal=true` for matching ids,
    `divergence_index` at the first differing step otherwise, with the
    field-level reasons; handles task-only divergence, evidence-only
    divergence, and prefix-length divergence honestly.
