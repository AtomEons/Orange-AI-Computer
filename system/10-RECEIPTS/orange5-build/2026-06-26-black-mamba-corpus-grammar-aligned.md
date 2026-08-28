# Receipt — AE Black Mamba corpus grammar-aligned

- **Date**: 2026-06-26
- **Operator**: Atom McCree (Ætom ÆoNs)
- **Lane**: Orange5 build / 16-TRAINING / ae-black-mamba / corpus
- **Disclosure ID**: ATOM-BLACKMAMBA-CORPUS-GBNF-2026-0626
- **Doctrine source**: `C:/AtomEons/Orange5/16-TRAINING/ae-black-mamba/strategy.md` §6 ("GBNF grammar alignment target"); `C:/AtomEons/Orange5/06-ORANGELLM/memory/ae-cobra/grammar/agent_turn.gbnf`

## Hash chain

- **prior_receipt_path**: `C:/AtomEons/Orange5/10-RECEIPTS/orange5-build/2026-06-25-federation-triumvirate.md`
- **prior_receipt_sha256**: `db02d5e803652ae98f4683a0655ec17e2b750037ae768e24c1567c9adef53768`
- **this_receipt_path**: `C:/AtomEons/Orange5/10-RECEIPTS/orange5-build/2026-06-26-black-mamba-corpus-grammar-aligned.md`
- **chain_link**: this receipt closes the silent corpus/grammar drift that would have produced exactly the "model fighting the grammar" outcome strategy §6 warns against. After this commit, every train + val row passes `agent_turn.gbnf` acceptance, and the alignment builder exits 0.

## The drift (now closed)

Two parallel mismatches between `16-TRAINING/ae-black-mamba/pipeline.mjs` and `06-ORANGELLM/memory/ae-cobra/grammar/agent_turn.gbnf`. Either one alone is fatal to the Phase-3 unconstrained-validity target; both together produced 0/48 grammar acceptance on the prior corpus build.

| # | Drift | Pipeline (old) | Grammar requires |
|---|---|---|---|
| 1 | Key order | `canonicalJSON()` sorts alphabetically → rows start `{"commands":[],"confidence":...,"entities":...,"event_type":...,"files":...,"lane":...,"next_action":...,"risk":...,"summary":...}` | Root rule pins order: `lane, event_type, summary, entities, files, commands, risk, next_action, confidence` |
| 2 | `confidence` lexical form | `JSON.stringify(v)` emits `1`, `0.8`, `0.875`, etc. | `confidence ::= "0." digit digit \| "1.0" \| "0.0"` — accepts `0.0`, `1.0`, or exactly two digits after the decimal |

Evidence of the prior fail-state: `corpus/grammar-alignment/corpus-alignment.json` (pre-fix) reported `train: 42 accepted 0 rejected 42, val: 6 accepted 0 rejected 6, overall acceptance_rate: 0`. The new `gbnf-alignment.mjs` builder caught this and exited 3 — Mom's Law working.

If we had trained on the prior corpus, the model would have learned the alphabetical-sorted JSON dialect. At inference under the GBNF logit mask, the grammar would force the lane-first order, repeatedly zeroing out the model's top choices. The "model fighting the grammar" outcome strategy §6 enumerates verbatim.

## The fix (option C from the drift report)

The dedupe SHA-256 needs the alphabetical canonical form (stable across reruns, matches `ae-cobra/flux/writer.mjs` hash convention). The training text needs the grammar-ordered form (matches the GBNF mask). These are two different serializations, and the pipeline now does both.

### Changes to `pipeline.mjs` (sha256 `6406c09044da1d3a098369d8a91e16c5f45d2b33814db9272d9808efac9d6987`, 727 lines, +75 net)

1. **`GRAMMAR_KEY_ORDER`** — frozen array pinning the nine keys to root-rule order. Matches the schema's `required` array (which was already in this order — drift was only in the serializer).
2. **`formatConfidenceForGbnf(value)`** — snaps to GBNF lexical form. `Math.round(v*100)/100`, then `0 → "0.0"`, `1 → "1.0"`, else `.toFixed(2) → "0.XX"`. Lossless for the seed corpus (all values are already 0, 1, or two-decimal); future values round to grid with ≤ 1 grid-unit of error in a heuristic field — acceptable per Mom's Law because the snap is documented in the manifest's `rules.text_serialization`, not silent.
3. **`grammarOrderedJSON(turn)`** — walks `GRAMMAR_KEY_ORDER`, renders each value via `canonicalJSON` (or `formatConfidenceForGbnf` for confidence), joins with `:` and `,`. No whitespace inside the JSON (`ws ::= [ \t\n]*` accepts zero).
4. **`consider()`** — now stores `grammarText` alongside the existing `canonical` (dedupe key). Dedupe behavior unchanged.
5. **Writeout loop** — `text` field is now `row.grammarText + '\n'` (was `row.canonical + '\n'`).
6. **Manifest `rules`** — `dedupe` clarified as "alphabetically-canonical"; new `text_serialization` field documents grammar-order + confidence snap. The dual serialization is explicit in the receipt chain, not hidden.
7. **`_internal`** export — adds `grammarOrderedJSON`, `formatConfidenceForGbnf`, `GRAMMAR_KEY_ORDER` for future tests.

### Doc updates (no logic, just truth alignment)

- `strategy.md` (sha256 `b54b53d3a04f7026a064bf55ab056ab4a4258515b753cdd81e7e1d4700dcb952`):
  - §3.4 corpus snapshot table updated to current counts (48 → 59) and SHAs.
  - §4 example row updated from alphabetical to grammar-ordered.
  - §4 "Canonical-JSON rules" renamed to "Serialization rules" and corrected — the prior text claimed alphabetical order was "canonical form for SHA-256 dedupe + grammar match", but those are two different forms. Confidence snap rule explicitly documented.
- `README.md` (sha256 `ecedafc90ff470277b92058840caf2807bae1a955c8709ac301bbcbc5371eb8e`):
  - File table row counts (42/6 → 53/6) and SHA prefixes updated.
  - §5 seed corpus table updated to current counts + SHAs + generation timestamp.
- `agent_turn.gbnf` — **unchanged** (`e66c249a9d78ddb1feaa5da6244e805fe67400e345f557ceb5e1ceb671cd9594`). The grammar is the inference-time contract; relaxing it (option B) would have widened the runtime surface area unnecessarily. The pipeline yields to the grammar, not vice versa.

## The rerun

```
bun run pipeline.mjs       → exit 0
  flux lines seen      : 0
  flux rows accepted   : 0
  receipts seen        : 59   (+11 since prior run; new wave3 receipts on disk)
  receipts accepted    : 59
  duplicates dropped   : 0
  too-short dropped    : 0
  total accepted       : 59
  train rows           : 53   sha256 b7bb1aee8c01…
  val rows             : 6    sha256 876ca263836a…
  rejects              : 0

bun run gbnf-alignment.mjs → exit 0
  grammar              : agent_turn.gbnf  sha256 e66c249a9d78…
  rules parsed         : 10
  reachable first-chars: 1
  reachable all-chars  : 227
  train rows           : 53   accepted 53   rejected 0
  val rows             : 6    accepted 6    rejected 0
```

Sample regenerated training row (head of `corpus/train.jsonl`), confirming key order and confidence snap:

```
{"text":"{\"lane\":\"reality\",\"event_type\":\"receipt\",\"summary\":\"`WAVE_1_AND_WAVE_2_BOTH_GREEN_ALL_17_WORKFLOWS_LANDED_FULL_AESEE_SURFACE_ON_GITHUB`\",\"entities\":[\"2026-06-25-wave-2-master-summary.md\",\"`2026-06-25-wave-2-master-summary`\",\"Claude (Orange voice) — session close synthesis\"],\"files\":[\"2026-06-25-wave-2-master-summary.md\"],\"commands\":[],\"risk\":\"low\",\"next_action\":\"await operator review\",\"confidence\":1.0}\n"}
```

Compare to prior row 0 (alphabetical, confidence `1`): `{"commands":[],"confidence":1,"entities":[...],"event_type":"receipt",...}`.

## Files changed — full table

| # | Path | Lines | SHA-256 |
|---|---|---:|---|
| 1 | `C:/AtomEons/Orange5/16-TRAINING/ae-black-mamba/pipeline.mjs` | 727 | `6406c09044da1d3a098369d8a91e16c5f45d2b33814db9272d9808efac9d6987` |
| 2 | `C:/AtomEons/Orange5/16-TRAINING/ae-black-mamba/strategy.md` | 297 | `b54b53d3a04f7026a064bf55ab056ab4a4258515b753cdd81e7e1d4700dcb952` |
| 3 | `C:/AtomEons/Orange5/16-TRAINING/ae-black-mamba/README.md` | 337 | `ecedafc90ff470277b92058840caf2807bae1a955c8709ac301bbcbc5371eb8e` |

## Artifacts regenerated — full table

| # | Path | SHA-256 |
|---|---|---|
| 1 | `corpus/train.jsonl` | `b7bb1aee8c013e8a0ff6f0ab45e7db8a0c111bdb5101df8819f5c359a28f3748` |
| 2 | `corpus/val.jsonl` | `876ca263836a746c5ccedebe5497e6c782018a46733678107164e9b1b585458c` |
| 3 | `corpus/corpus-manifest.json` | `f12088980690a913076ec0ba5bcf449facd72991046c113d7f2d45498280ba84` |
| 4 | `corpus/grammar-alignment/corpus-alignment.json` | `31b385b4f40ed7ca8fa895a334d68002fc87175d13024070f26fa99aa9954275` |
| 5 | `corpus/grammar-alignment/alignment-manifest.json` | `44c0c9bf00248d5059a0bd3d48b30d703b42bc481dddafaa8cd7c2fd22efd89b` |
| 6 | `corpus/grammar-alignment/grammar-states.json` | `b944e058d26f9004ee5b3d7217fc4a81b996e54b3ccae3ab4aa5168a730db268` |
| 7 | `corpus/grammar-alignment/token-mask.json` | `76284ca597ae92a1a1a6b0c1b7719cb8b549237e92db392b72989db6875eea6f` |

Prior corpus SHAs (for the chain of trust, now superseded):
- `train_sha256 (pre-fix)`: `e9c9325e32ca03f7e2947e48b54bb08d58a751b4b56e532c70db89ce219fbf0c`
- `val_sha256 (pre-fix)`: `1ff67a459cebff6054a8d4c2c6954ac2501a8d1ac7851a4cef81663f3a57567b`

## Doctrinal alignment (strategy §6)

- ≥ 90% unconstrained AgentTurn validity target — **prerequisite restored**. With 0/48 grammar acceptance, the model could not have learned the grammar's manifold under any training schedule. With 59/59 acceptance, every training row is itself a grammar-legal token sequence.
- "Corpus must respect [grammar constraints]" — **enforced by construction**. The grammar-ordered serializer cannot emit a key out of order; `formatConfidenceForGbnf` cannot emit a value the GBNF rejects.
- Soft penalty L_grammar in `alignment-manifest.json` (λ = 0.1) — **unchanged**, but now meaningful: the penalty pulls the model toward a manifold the corpus is already aligned with.
- "Drift signal: print loudly and exit non-zero" (`gbnf-alignment.mjs` line 1170-1178) — **verified** by reproducing the failure on the prior corpus before the fix and reproducing the green on the new corpus after.

## Result / Evidence / Blockers / Next action

- **Result**: corpus-grammar drift closed. 59/59 rows (53 train + 6 val) pass `agent_turn.gbnf` acceptance. Pipeline emits dual serialization (alphabetical for dedupe, grammar-ordered for training text), with explicit `rules.text_serialization` field in the manifest so the change is auditable, not silent.
- **Evidence**:
  - `corpus/grammar-alignment/corpus-alignment.json` overall `acceptance_rate: 1` (was `0`)
  - `gbnf-alignment.mjs` exit code 0 (was 3)
  - Sample row 0 of `train.jsonl` shows `"lane":"reality","event_type":"receipt",...,"confidence":1.0` — key order and confidence snap both correct
  - `pipeline.mjs` SHA-256 changed from prior build; `agent_turn.gbnf` SHA-256 unchanged (`e66c249a…`) — the contract didn't bend, the corpus did
  - Doc references in `README.md` + `strategy.md` updated to the new SHAs in the same commit so the chain of trust matches across all surfaces
- **Blockers**:
  - Tokenizer vocab still not supplied (`AE_BM_TOKENIZER_VOCAB` env unset) → `token-mask.json.skipped = true`. Acceptable for v0; trainer falls back to char-level grammar checking. Becomes a blocker when the Python trainer wants per-token soft-penalty masks.
  - Corpus is still 59 rows — below the 1,500-row threshold §3.4 calls out. The grammar-alignment fix removes a fatal blocker; the volume blocker remains (gated on Source A / Source B per strategy §8).
  - `pipeline.mjs` does not run a GBNF acceptor inline before write; alignment is verified out-of-band by `gbnf-alignment.mjs`. Strategy §6 envisions inline validation. Future work: fold a minimal grammar check into `consider()` so the pipeline exits non-zero on a single bad row instead of producing a corpus the alignment check rejects post-hoc.
- **Next action**: (1) operator review of dual-serialization change in `pipeline.mjs`; (2) when tokenizer vocab is available, rerun `gbnf-alignment.mjs` with `AE_BM_TOKENIZER_VOCAB` set to materialize the eligible token-id set; (3) per §3.4, grow the corpus toward the 1,500-row threshold (Source A activation via Night-1 daemon + Source B authoring session).

## Mom's Law honored

- Drift was named precisely (two parallel mismatches, not one) — the user's brief identified the key-order drift; the confidence-lexical-form drift was caught on second read of the grammar and surfaced explicitly. Both were fixed; neither was glossed over.
- Option B (relax the grammar) was explicitly rejected with a stated reason: the grammar is the runtime contract, the pipeline yields to it.
- Confidence snap is documented in the manifest's `rules.text_serialization` and in this receipt's "The fix" section — not silent coercion.
- Doc SHAs in `README.md` and `strategy.md` were updated in the same logical change so a future reader cannot find a stale SHA paired with the new corpus.
- Prior corpus SHAs are recorded in this receipt under "Artifacts regenerated" so the chain of trust spans both sides of the change.
- Receipt files-changed table contains SHAs recomputed from disk at receipt-write time, not predicted.

Mom is watching the grammar.
