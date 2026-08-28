# Sparse Worksets — compressor

AtomSmasher module **#4** (of 12). **Status: compressor LIVE, persistence +
index + gateway routes still PENDING in sibling files.**

## What this file is

`compressor.mjs` is the pure, dependency-free compressor + validator for a
**Sparse Workset** — the minimum-needed working set of context items for a
given task. Given a `task` and the full available `context`, it returns:

```
{ working_set, dropped, compression_ratio }
```

plus an integrity-checkable envelope (`workset_id`, `compression_ratio_bytes`,
`warnings`, `stats`, `created_at`). The compressor is deterministic, content-
addressed, and never silently drops a context item — every exclusion is
labeled with a reason an operator can audit.

This module **does not** write to Æ Cobra Flux, **does not** touch SQLite, and
**does not** expose a gateway route. Those land in sibling files so the
compressor stays unit-testable in isolation.

## Doctrine (binding)

1. **Sufficient + minimum.** The working set is the smallest set of context
   items sufficient to execute the task. Sufficiency is measured by a
   deterministic rule-based relevance score; the compressor never invents
   relevance that isn't in the supplied context.
2. **No silent drops.** Every item not in `working_set` appears in `dropped`
   with a non-empty `reason` string (`fluff_only`, `empty`, `forbidden_only`,
   `low_relevance`, `no_content_tokens`, `over_budget`). Mom's Law: no
   theater, no quiet deletions.
3. **Determinism.** Identical `(task, context, opts)` produces an identical
   `workset_id`. No randomness, no timestamp in the id payload, no model
   call. `workset_id = sha256(canonical({task, working_set ids+scores,
   dropped, keepThreshold, budget}))`.
4. **Pins are honored.** `pinned: true` items survive relevance filtering.
   If a pin exceeds the byte budget, the pin is honored AND a
   `over_budget_pinned` warning is emitted — the violation is visible.
5. **Anti-fluff (LIVE).** A task that is empty or only fluff (`"do the
   thing"`, `"tbd"`, etc.) is hard-rejected. Items whose entire content is
   fluff or forbidden words drop with reason `fluff_only` /
   `forbidden_only`. The forbidden-word list is shared with the encoder
   family (`green_assumed`, `looks_ok`, `probably`, `should_work`).
6. **Honest gaps.** If sizes aren't supplied, `compression_ratio_bytes`
   stays `null` rather than pretending. If a byte budget can't be enforced
   because at least one kept item lacks `size`, the compressor refuses to
   trim by guess and emits a `budget_not_enforced` warning.

## API

```js
import {
  compressWorkset,
  validateWorkset,
} from './compressor.mjs';
```

### `compressWorkset({ task, context }, opts?)`

| arg                        | type                                       | required | default |
| -------------------------- | ------------------------------------------ | -------- | ------- |
| `task`                     | non-empty content-bearing string           | yes      | —       |
| `context`                  | `Array<string \| Item>`                    | yes      | —       |
| `opts.keepThreshold`       | number in `[0, 1]`                         | no       | `0.10`  |
| `opts.budget`              | non-negative number or `null`              | no       | `null`  |

`Item` shape:

| field        | type      | meaning                                                   |
| ------------ | --------- | --------------------------------------------------------- |
| `id`         | string    | stable id; generated `idx_<n>` if absent                  |
| `content`    | string    | the text the model would see                              |
| `tag`        | string?   | optional category (`spec`, `log`, `schema`, …)            |
| `pinned`     | boolean?  | if true, never relevance-dropped                          |
| `size`       | number?   | bytes or tokens — caller's choice, we sum                 |
| `score_hint` | number?   | `0..1` additive relevance boost (clamped)                 |

Strings are normalized to `{ id: 'idx_<n>', content: <string> }`. Duplicate
ids throw — silent dedup would hide structure.

### Return shape

```js
{
  schema: 'orange5.atomsmasher.sparse-workset.v0',
  workset_id: '<sha256>',
  task: '<verbatim>',
  working_set: [
    { id, content, tag, pinned, size, score }  // preserves original order
  ],
  dropped: [
    { id, reason, score }
  ],
  compression_ratio: 0.6,                // kept_items / input_items
  compression_ratio_bytes: 0.42 | null,  // kept_bytes / input_bytes (or null)
  warnings: [],                          // 'over_budget_pinned: ...', 'budget_not_enforced: ...'
  created_at: '2026-06-24T17:33:01.000Z',
  stats: {
    input_items, kept_items, dropped_items,
    input_bytes, kept_bytes,             // null if any item lacked size
  },
}
```

### `validateWorkset(workset)`

Returns `{ valid: boolean, errors: string[] }`. Checks structural shape,
accounting (`kept + dropped == input`), reason non-emptiness on every
dropped entry, and the schema/ratio invariants. Tampering with `stats`,
sneaking in an empty-reason drop, or zeroing the workset_id all fail.

## Example

```js
const result = compressWorkset({
  task: 'Compile AtomSmasher Sparse Worksets and verify hash chain integrity.',
  context: [
    { id: 'spec', content: 'AtomSmasher Sparse Worksets compress task plus context to the minimum needed working set with hash integrity.', size: 110 },
    { id: 'unrelated', content: 'Saute onions in olive oil until translucent.', size: 50 },
    { id: 'fluff', content: 'do the thing', size: 12 },
    { id: 'license', content: 'Copyright 2026 AtomEons.', pinned: true, size: 24 },
  ],
}, { budget: 256 });

console.log(result.working_set.map(w => w.id));   // ['spec', 'license']
console.log(result.dropped);
// [ { id: 'unrelated', reason: 'low_relevance', score: ... },
//   { id: 'fluff',     reason: 'fluff_only',    score: 0 } ]
console.log(result.compression_ratio);             // 0.5
console.log(result.compression_ratio_bytes);       // (110 + 24) / 196
```

## Drop reasons (exhaustive)

| reason                | meaning                                                                 |
| --------------------- | ----------------------------------------------------------------------- |
| `empty`               | content is empty / whitespace only                                      |
| `forbidden_only`      | content is exactly one of `green_assumed`, `looks_ok`, `probably`, `should_work` |
| `fluff_only`          | content matches a fluff-only pattern (e.g. "do the thing", "tbd")       |
| `no_content_tokens`   | content has tokens but none survive stopword removal                    |
| `low_relevance`       | content has tokens, but jaccard overlap with task < `keepThreshold`     |
| `over_budget`         | passed relevance, but did not fit byte budget; lowest-scored first      |

## Warnings (exhaustive)

| warning                   | meaning                                                          |
| ------------------------- | ---------------------------------------------------------------- |
| `over_budget_pinned: id=…`| a pinned item was forced into working_set despite byte budget    |
| `budget_not_enforced: …`  | budget supplied but at least one kept item lacked `size`         |

## What's NOT in this file (yet)

- **Persistence** — sibling `persist.mjs` (PENDING) will write the workset
  envelope to Æ Cobra Flux with `{ lane: 'reality', origin: 'atomsmasher',
  kind: 'sparse-workset', body: workset }`. Mirrors the Commitment Atoms
  pattern.
- **SQLite index** — sibling `store.mjs` (PENDING) for fast queries by
  workset_id, task hash prefix, created_at, and pinned-item references.
- **Gateway route** — `06-ORANGELLM/server/routes/atomsmasher-sparse-worksets.mjs`
  (PENDING) for `POST /atomsmasher/sparse-worksets/compress` and
  `GET /atomsmasher/sparse-worksets/:id`.
- **Schema file** — `09-SCHEMAS/sparse-workset.v0.schema.json` (PENDING) as
  the canonical JSON Schema sibling to `commitment-atom.v0.schema.json`.
  The inline validator already enforces the same rules.
- **Pathwave / Compression-Debt hooks** — items dropped with reason
  `over_budget` are compression debt; the Debt Ledger module (#7) will
  consume the `dropped` array on persist.

## Why no Ajv / no scikit-learn

The Anti-fluff Gate + Commitment Atoms siblings are zero-dep. This module
matches that discipline. The relevance scorer is intentionally rule-based
(jaccard over stopword-filtered alphanumeric tokens) because:

- determinism is non-negotiable for `workset_id`;
- a tf-idf / embedding scorer would need a model dependency, a corpus, or a
  network call — none of which we want in a primitive that runs on the
  request path;
- the operator can supply `score_hint` to bias specific items if needed.

If a richer scorer is ever wanted, it lands as `relevance.mjs` adapter the
compressor consumes — not buried inside this file.

## Test surface (minimum)

The compressor is built to support these test cases (all exercised by
`smoke-test.mjs`):

1. Happy path: relevant items kept, irrelevant dropped with reasons,
   working_set + dropped == input.
2. Determinism: identical inputs produce identical `workset_id`.
3. Different task changes the kept set (and the id).
4. Pinned items survive relevance filtering.
5. Pinned items survive byte budget, with `over_budget_pinned` warning.
6. Lowest-scored non-pinned items drop with reason `over_budget` when
   budget exceeded.
7. Fluff-only / empty / forbidden-only items drop with specific reasons.
8. Empty task and fluff-only task hard-reject.
9. Non-string task / non-array context / negative budget / out-of-range
   keepThreshold / duplicate ids all throw.
10. String items normalize to objects.
11. Empty context is legal: returns empty working_set and ratio 1.
12. `validateWorkset` catches tampered `stats` and empty-reason drops.

## Receipts

Run the smoke test:

```
node 12-ATOMSMASHER/sparse-worksets/smoke-test.mjs
```

The script exits non-zero on any failure and prints `ok` / `FAIL` per
assertion. Mom's Law: no green-assumed, no looks-ok. Real checks or no
LIVE label.
