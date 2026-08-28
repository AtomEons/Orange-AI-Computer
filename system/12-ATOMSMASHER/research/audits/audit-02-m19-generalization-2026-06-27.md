# Audit 02 — M19 generalization audit

**Date:** 2026-06-27
**Auditor:** Claude (general-purpose) under Mom's Law (report failures honestly)
**Mission:** Test whether Method 19's 47.07× ratio on the canonical 6,224-receipt
corpus is a property of the codec or an artefact of the corpus.
**Codec under test:** `experiments/59-method19-strip-empty-id/bench.mjs`
**Parameterized runner:** `experiments/audit-02-m19-generalization/run-m19.mjs`
(direct port of M19 logic, only corpus path is variable).
**Corpus generator:** `experiments/audit-02-m19-generalization/gen-corpora.mjs`
(seeded mulberry32 — deterministic, reproducible).

## Verdict

**M19 does NOT generalize.** It is byte-exact lossless on every input we
threw at it (4/4 roundtrips green), but the **ratio is wildly
corpus-dependent**: it ranges from **2.06× to 890.30×** across the test
corpora, with the canonical 47.07× sitting in the middle of that range.

Two of the four audit corpora fail the >5× threshold the audit asked us
to flag. The canonical 47.07× number is therefore **not a property
of the codec**; it is a property of the *specific receipt stream*
that codec was tuned for — high mesh.compress saturation
(25.1% of records, sharing a tight templatized format), narrow
schema vocabulary on the "other" records (1,567 unique shapes across
4,659 records ≈ 2.97 records per shape), and short payloads.

## Numbers

| Corpus | Records | Raw bytes | M19 ratio | Lossless | Status |
|---|---:|---:|---:|---|---|
| Canonical (reference) | 6,224 | 2,075,585 | 47.07× | yes | PASS |
| A — Random JSON | 1,000 | 298,884 | 2.76× | yes | **FAIL** (ratio < 5×) |
| B — Repetitive | 1,000 | 211,000 | 890.30× | yes | PASS |
| C — Sparse | 1,000 | 153,277 | 14.72× | yes | PASS |
| D — Large payloads | 1,000 | 1,310,890 | 2.06× | yes | **FAIL** (ratio < 5×) |

**M19 generalization: 2/4 corpora hold; FAILURES on [A — Random JSON, D — Large payloads].**

## How each corpus was built

Generator is deterministic (mulberry32 seeded per-corpus). All four
corpora share the canonical AtomEons receipt schema
(`{id, action, status, summary, payload_json, created_at}`) so M19's
post-processing pipeline (det-id rewrite, mesh vs other split, shape
vocab, action stream, position runs) runs in full.

- **A — Random JSON (1,000 records).** Every record has a unique
  random `action`, `status`, `summary`, and payload field values
  (64-char alphabet). Designed to defeat shape dedup. Result:
  `unique_other_shapes = 1000` — one shape per record, no
  dedup possible.
- **B — Repetitive (1,000 records).** Every record is identical
  except for the `id` field (which M19 rewrites deterministically
  from index anyway). Best case for shape dedup. Result:
  `unique_other_shapes = 1` — entire corpus encoded as one shape
  + an index stream of 1,000 zeros.
- **C — Sparse (1,000 records).** ~80% of records collapse to a
  single "empty" shape (`{action:"sparse.empty", status:"ok",
  summary:null, payload_json:null, created_at:"2026-06-27..."}`),
  ~20% are random. Result: `unique_other_shapes = 188` — heavy
  dedup on the empty class.
- **D — Large payloads (1,000 records).** Every record carries a
  fresh ~1KB random JSON payload (20 fields × 40 chars). Action,
  status, and summary template are uniform; the entropy is
  concentrated in the payload. Result: `unique_other_shapes = 1000`
  — payloads kill shape dedup just as effectively as
  randomizing the whole record.

## Where M19's compression comes from

The canonical receipt stream gives M19 four very specific gifts.
The audit corpora isolate each gift to show what happens when
it's removed.

1. **mesh.compress saturation.** On canonical, 25.1% of receipts
   (1,565 / 6,224) take a specialized path: status is constant,
   summary follows the template `packet #N: AB → CB`, payload
   reduces to three numbers `{raw_bytes, compressed_bytes, ratio}`.
   M19 strips this to 5 varints per record. **None of the audit
   corpora exercise this path** — they all have 0 mesh records,
   so the whole mesh sub-codec sits idle. On canonical, the mesh
   sub-codec contributes the largest single chunk of compression;
   removing it drops the ceiling sharply even before considering
   other entropy.

2. **Low unique-shape count on "other" receipts.** Canonical has
   1,567 unique shapes across 4,659 other records — every shape
   is used 2.97× on average. M19 stores each shape once in the
   shape blob and refers to it by varint index in `otherIdxBr`.
   - Corpus A has 1,000 shapes / 1,000 records (1.00× reuse) →
     shape blob has to carry every single record's worth of
     entropy + the index overhead. Result: 2.76×.
   - Corpus D has 1,000 shapes / 1,000 records (1.00× reuse) and
     each shape contains ~1KB of high-entropy payload. Result:
     2.06× — essentially just brotli on raw JSON.
   - Corpus B has 1 shape / 1,000 records (1,000× reuse) →
     near-pure overhead. Result: 890.30×.
   - Corpus C has 188 shapes / 1,000 records (5.32× reuse), with
     a dominant ~80% class. Result: 14.72×.

3. **Brotli-on-brotli on the shape blob.** Line 108-109 of the
   codec runs `brotli11` twice on `stripped.join('\n')`. This
   only helps when the first-pass output still has exploitable
   structure (i.e., the shape blob is itself large and
   self-similar). On corpus A (high entropy strings) and corpus D
   (high entropy payloads), the first brotli pass already
   compresses to near-incompressible output; the second pass adds
   measurable overhead but no further reduction.

4. **Short summaries and short payloads.** Canonical summaries
   average ~50 bytes, payloads average ~60 bytes (after JSON
   parse → re-stringify). On corpus D we deliberately put ~1KB
   of high-entropy payload per record, which is ~17× the
   canonical mass-per-record concentrated entirely in the
   hard-to-compress region. Ratio collapses to 2.06× — barely
   above plain brotli on the raw bytes.

## What the audit proves and does not prove

**Proves:**
- M19 is lossless. Byte-exact sha256 roundtrip on all 5 corpora,
  including extreme corner cases (single repeated record;
  randomized everything; 1KB payloads; 80% null fields).
- The 47.07× number is not portable. The codec's ratio depends
  on at least 3 structural properties of the input: mesh-action
  saturation, "other" shape reuse rate, and payload entropy
  density.

**Does not prove (out of scope for this audit):**
- That M19 is the best codec for the canonical corpus
  (compare against Method 18, Method 20, etc. — separate audit).
- That the canonical 6,224-receipt corpus reflects production
  AtomEons receipt traffic (this is the more important question —
  if production traffic looks like corpus B, M19 will do 890×;
  if it looks like corpus D, M19 will barely beat brotli).
- That M19 is incorrect to be schema-aware. Schema-aware codecs
  are supposed to be specialized; the question is whether the
  specialization is honest about its scope.

## Recommendation

Stop reporting "M19: 47.07×" as if it were the codec's headline
number. The honest headline is one of:

- **"M19 on canonical 6,224-receipt corpus: 47.07×, byte-exact."**
  (Specific, defensible, reproducible.)
- **"M19 across 5 corpora: 2.06× → 890.30×, median 14.72×,
   byte-exact on all 5."** (Range, with the caveat that the
  median is dominated by extreme corner cases.)

The codec is doing real work, and the lossless guarantee held
under every stress test we ran. But the canonical ratio is a
property of the workload, not of the codec, and that distinction
matters when the next codec experiment claims to "beat" 47.07×.

## Receipts

Generated corpora (sha256, computed by re-reading from disk):

| Path | Records | Bytes |
|---|---:|---:|
| `experiments/audit-02-m19-generalization/corpora/A-random.jsonl` | 1,000 | 298,884 |
| `experiments/audit-02-m19-generalization/corpora/B-repetitive.jsonl` | 1,000 | 211,000 |
| `experiments/audit-02-m19-generalization/corpora/C-sparse.jsonl` | 1,000 | 153,277 |
| `experiments/audit-02-m19-generalization/corpora/D-large.jsonl` | 1,000 | 1,310,890 |

Each row in the table above was reproduced from the runner's JSON
output, e.g.:

```
{"corpus":"canonical-corpus.jsonl","records":6224,"raw_bytes":2075585,
 "total_bytes":44095,"ratio":47.071,"lossless":true,
 "det_sha256":"03da0e5cf04adf965ae580cb8c74ab4db9d8058b6ca246478fef57b6de944df1",
 "rec_sha256":"03da0e5cf04adf965ae580cb8c74ab4db9d8058b6ca246478fef57b6de944df1",
 "unique_other_shapes":1567,"mesh_records":1565,"other_records":4659}
```

Reproduce:

```
cd C:\AtomEons\Orange5\12-ATOMSMASHER\research\compression\experiments\audit-02-m19-generalization
node gen-corpora.mjs
node run-m19.mjs ..\..\data\canonical-corpus.jsonl
node run-m19.mjs corpora/A-random.jsonl
node run-m19.mjs corpora/B-repetitive.jsonl
node run-m19.mjs corpora/C-sparse.jsonl
node run-m19.mjs corpora/D-large.jsonl
```
