# AIR Codec — Anti-Inflation Recursive

AtomSmasher module — compresses verbose model output to dense information per
byte by extracting structure and dropping filler.

**Status: encoder + decoder + smoke test LIVE.** Gateway routes wired at
`06-ORANGELLM/server/routes/atomsmasher-air.mjs`. Schema at
`09-SCHEMAS/air-frame.v0.schema.json`.

## What this is

Verbose LLM output looks like this:

> "Certainly! Here's a comprehensive overview. **In summary**, to summarize
> the situation as I understand it, the AtomSmasher initiative was launched
> on 2026-06-15. It is important to note that we will ship 11 modules by
> 2026-12-31. As an AI assistant, I don't have access to real-time data..."

The codec takes that input and emits an AIR Frame: a typed container that
holds the load-bearing pieces (facts, claims, citations, numbers, dates,
identifiers, code spans, decisions, questions) and tracks what it dropped
(hedges, fluff, transitions, pleasantries, self-references, whitespace,
duplicates) with character-count audit slots.

Downstream AtomSmasher modules — Commitment Atoms, EquationStore,
Compression Debt Ledger, Pathwave Compressor — consume frames, not prose.

## What "compression" means here

This is **not** statistical compression. The codec is not gzip. It is
**structural extraction**:

- The `facts`, `claims`, `decisions`, `questions`, `residue` slots preserve
  the prose payload (minus stripped filler) so a downstream consumer can
  read what was said.
- The `citations`, `numbers`, `dates`, `identifiers`, `code_spans` slots
  carry typed fields that are now machine-routable.
- The `dropped` slot is an **audit trail**: per-tag character counts of
  what was thrown away. The Compression Debt Ledger consumes this.

What you measure honestly:

| Metric | What it tells you |
| ------ | ----------------- |
| `original_chars` | Input length. |
| `prose_chars_preserved` | Bytes of real content kept across facts/claims/decisions/questions/residue. |
| `filler_chars_dropped` | Bytes of fluff/hedge/pleasantry/self-reference/transition/whitespace/duplicate removed. |
| `compression_ratio` (= `compressed_chars / original_chars`) | On-wire JSON envelope size vs input. For short, dense inputs this is **>1** (envelope overhead exceeds prose). For long, filler-heavy inputs it drops well below 1. |
| `summary.envelope_inflation` | Same number, named honestly in the route response. |

The codec's real win is **structure-per-byte for parsing**, not bytes-on-wire.
Treating it as gzip would be theater. See `smoke-test.mjs` output for the
honest receipt:

```
input chars      : 2488
prose preserved  : 1741 chars (70.0% of input)
filler dropped   : 463 chars (18.6% of input)
wire frame size  : 4231 chars (envelope inflation = 1.70x)
extracted        : 5 facts, 14 claims, 6 citations, 7 numbers, 3 dates
```

70% prose preserved, 18.6% filler crushed, 1.70x JSON envelope. Mom's Law:
that's the number, no hiding.

## Doctrine

1. **Frames are content-addressed.** `frame_id = sha256(canonical_json(structured_slots))`.
   Identical input produces identical `frame_id` regardless of when it was
   compressed. Same property as Commitment Atoms.
2. **`created_at` is excluded from `frame_id`.** Timestamps are metadata, not
   identity.
3. **Compression is lossy by design.** The original prose is NOT stored.
   `source_hash = sha256(input)` lets a receipt holder prove what was fed in
   if they still hold the input.
4. **Decompression reconstructs a readable rendition.** It is **not**
   byte-identical to the source. Anyone hashing the decompressed prose is
   using the codec wrong; hash the frame.
5. **Code spans are byte-exact.** Fenced and inline code is lifted out
   before sentence work and stored verbatim. The codec never paraphrases code.
6. **Citations are extracted globally before sentence splitting.** URLs,
   `U.S.C. §` statutes, and POSIX paths can't survive a naïve sentence
   splitter; the codec masks them out first, then splits.
7. **Anti-fluff is enforced, not warned.** Sentences that are pure fluff
   prefixes ("In summary,", "Certainly,") are dropped to the audit slot
   instead of stored. Pleasantries and self-references are scrubbed inline.

## Files

| File | Purpose |
| ---- | ------- |
| `codec.mjs` | Pure encoder + decoder + validator. Zero deps. |
| `smoke-test.mjs` | End-to-end test. Run with `node 12-ATOMSMASHER/air-codec/smoke-test.mjs`. Exits 0 on green, non-zero on any failure. |
| `README.md` | This file. |
| `../../09-SCHEMAS/air-frame.v0.schema.json` | JSON Schema (draft 2020-12) for the frame shape. |
| `../../06-ORANGELLM/server/routes/atomsmasher-air.mjs` | HTTP gateway routes. |

## API

```js
import { compress, decompress, validate } from './codec.mjs';

const frame = compress(verboseText);
// frame.schema       === 'orange5.atomsmasher.air-frame.v0'
// frame.frame_id     === sha256 of structured slots
// frame.source_hash  === sha256 of input
// frame.facts, .claims, .citations, .numbers, .dates, .identifiers,
//      .code_spans, .decisions, .questions, .residue, .dropped

const { valid, errors } = validate(frame);   // re-derives frame_id, catches tampering

const prose = decompress(frame);             // readable rendition, NOT byte-identical
```

## Gateway routes

All under `/v1/atomsmasher/air`:

```
POST /v1/atomsmasher/air/compress
     body: { "input": "<verbose prose>" }
     -> 200 { frame, summary, generated_at }

POST /v1/atomsmasher/air/decompress
     body: { "frame": <air-frame.v0> }
     -> 200 { prose, frame_id, note, generated_at }

POST /v1/atomsmasher/air/validate
     body: { "frame": <air-frame.v0> }
     -> 200 { valid, errors }
```

The `summary` field in the `compress` response carries the honest accounting:
`original_chars`, `prose_chars_preserved`, `filler_chars_dropped`,
`filler_ratio`, `wire_frame_chars`, `envelope_inflation`, `extracted` (per-slot
counts), `dropped_by_tag`.

Limits:
- input: 2 MiB UTF-8 bytes (`MAX_INPUT_BYTES`)
- total request body: 4 MiB

After wiring, add the prefix `/v1/atomsmasher/air` to the gateway allow-list
at `06-ORANGELLM/server/routes/atomsmasher-boundary.mjs`.

## Honest gaps

- **Sentence splitter is heuristic.** Abbreviations (Dr., Inc., e.g.) are
  handled but pathological inputs may split wrong. Code spans and citations
  are masked out first, so the dangerous cases (URLs, statutes, paths) are
  protected.
- **Claim vs fact classification is conservative.** A sentence is only a
  `fact` if it asserts AND has a grounding token (citation, number, date)
  in the same sentence. Otherwise it's a `claim` wrapped with a confidence
  cue. False positives in the "fact" slot are worse than false negatives,
  so the bias is intentional.
- **Identifier regex is heuristic.** CamelCase, snake_case, dotted paths,
  SCREAMING_SNAKE, and hex hashes are captured. Pure-prose proper nouns
  ("Atom McCree") are NOT identifier-captured — they survive in the fact /
  claim text instead, which is the right slot for them.
- **Compression ratio > 1 on short dense inputs.** This is real and named.
  The codec is designed for verbose filler-heavy outputs; it does not win
  on a 200-char dense fact. The summary surface tells you when this happens.
- **`U.S.C.` statute regex is U.S.-only.** Other jurisdictions' citation
  shapes (e.g., E.U. directives) are not yet matched and will fall through
  to identifier or path.
- **No language detection.** Hedge words / fluff prefixes are English-only.
  Non-English input compresses but the drop accounting will be near-zero.

## Test surface

`smoke-test.mjs` enforces:

1. Compress returns a schema-valid frame.
2. Content determinism: same input → same `frame_id`.
3. `created_at` does not affect `frame_id`.
4. `source_hash` = `sha256(input)`.
5. `compressed_chars` matches canonical-JSON length of structured slots.
6. Tamper detection (any field mutation breaks `frame_id` integrity).
7. Prose chars in frame < original chars (filler was dropped).
8. Dropped chars >= 15% of original (real filler crushed).
9. Code spans round-trip byte-exact.
10. Numbers / dates / citations / identifiers all populate correctly,
    including `$1.2M` → `1_200_000` with `$` unit, `18%`, ISO + `Month DD,
    YYYY` dates, URL, arXiv, RFC, statute, path, GitHub issue.
11. Decompress preserves every fact, citation ref, and code span.
12. Edge cases: empty input, pure-fluff input, non-string input (TypeError).

All 80+ checks PASS as of the LIVE promotion smoke run.

## What's next (sibling modules)

The codec is a primitive. The eleven remaining AtomSmasher modules build
on it:

- **EquationStore** — promotes specific facts (formal invariants like
  `FOUNDER_SALARY` math) from frames to a formal equation store.
- **Cartridges** — pre-compiled domain capability units. Frames are the
  cartridge input format.
- **Sparse Worksets** — selects minimum frames per turn from a working set.
- **Least-action Router** — uses frame structure to pick model routing.
- **Expansion Warrants** — operator-gated scope-expansion tokens; checked
  against frames before downstream side-effects fire.
- **Compression Debt Ledger** — consumes `frame.dropped` per turn and
  accumulates verbose-over-compressed debt.
- **Saved Work Certificates** — hash-chained reuse proofs; `frame_id` is
  the dedup key.
- **Canon Pressure Detector** — promotes ontology candidates from frame
  identifiers + facts when receipt density crosses a threshold.
- **Pathwave Compressor** — compresses entire execution trajectories;
  per-step output is a frame.
- **Persist** — sibling to Commitment Atoms; writes commitment-atom-shaped
  records derived from `frame.decisions`.
