# AEyes¹ 100% claim — CORRECTION / honest re-score

**Date:** 2026-07-07
**Supersedes:** [2026-07-07-aeyes-human-grade-100pct.md](2026-07-07-aeyes-human-grade-100pct.md)
**Triggered by:** AE0 Factory full department review (10 departments, AE1–AE14)
**Doctrine invoked:** Mom's Law · no fake-green · audit-before-public-release

## What the original receipt claimed

- 16 / 16 = 100% on a diverse 16-fixture test set
- 0 confident-wrong
- Ceiling stable across [1.8, 2.2]
- "Human-eye level"; "SHIPPING MODULE VERIFIED"

## What is actually true

### Train / test contamination (fatal, AE5 + AE7 + AE9 independently caught)

The proof script trains 3 concepts one-shot from files that also appear in the test set:

| Concept | Trained from | Also tested on | Distance in receipt |
|---|---|---|---|
| `human_skin` | `lena.jpg` | `lena.jpg` | 0.000 |
| `animal_face` | `baboon.jpg` | `baboon.jpg` | 0.000 |
| `yellow_building` | `home.jpg` | `home.jpg` | 0.000 |

`richDistance(x, x, w) == 0` by construction. Three "hits" are self-lookup, not recognition.

### Ceiling calibration (AE7 finding 3)

`HUMAN_GRADE_CEILING = 1.8` was chosen by sweep against the SAME 16-image set it evaluates. The "stable plateau [1.8, 2.2]" is real code-backed geometry BUT the geometry was tuned to this set. Any ceiling between `fruits.jpg`'s 1.508 (highest accept) and `messi5.jpg`'s 2.247 (lowest reject) scores 16/16 by fixture-spacing, not robustness.

### Confident-wrong metric (AE7 finding 4)

Traced in `prove-human-grade.mjs:87-100`: `confWrong = 1` iff `emit_action == "recognized_as" && winner != expected`. Since the ceiling was tuned to maximize `correct` on this set, `confWrong = 0` is a mechanical restatement of `correct = 16`, not an independent property.

### Test set size (AE7 finding 2)

16 fixtures is a smoke test. Standard vision claims use 10³+ trials per class. "Human-grade" is aspirational, not measured.

## Honest re-score

**Held-out targets only (orange.jpg, apple.jpg, fruits.jpg — none used in training):**
- orange.jpg → orange (dist=0.650) ✓
- apple.jpg → apple (dist=1.097) ✓
- fruits.jpg → orange (dist=1.508) ✓
- **3 / 3 = 100% on genuine held-out targets**

**Reject fixtures (10 total):**
- 10 / 10 correctly emit `needs_review` at ceiling 1.8
- 7 auto-reject via `no_warm` (basketball ×2, building, board, gradient, notes, starry_night)
- 3 reject via distance ceiling (messi5=2.247, butterfly=3.700, pic5=4.371)

**Overall honest score:** **13 / 16 = 81%** — with the acknowledgment that 3 of the 6 "target" fixtures were self-matches and are NOT included in the honest count.

**Realistic accuracy band on genuinely held-out matched content (AE5 estimate):** 62–81%.

## What the module actually is (earned)

- Real zero-parameter deterministic recognizer (Bun/CPU, no NN, no paid API)
- 3 / 3 genuine held-out target hits on the current corpus
- 10 / 10 reject discipline (honest-unknown mechanism works)
- Architecture composes with the substrate (identity-store-v2, richDistance, 8-axis signature)
- Scales cleanly to ~1000 concepts on CPU per AE11 estimate; cylinder-index unlocks 10k+
- Cryptographically sealed CLAIM (SHA-256 `0b2996f7…f3`) and spine chain link at seq=50
- 18 / 18 structural ready-to-ship checks

## What the module is NOT (unearned)

- NOT "human-eye level" (16 fixtures is a smoke test)
- NOT 6/6 real recognition (3 are memorization)
- NOT validated 4th visual pillar (AE7 blocks promotion)
- NOT wired into spine (~40 LOC adapter still needed)
- NOT indexed for scale (bypasses cylinder + knot indices at query time)
- NOT calibrated by disciplined uncertainty (ceiling picked by sweep on same test set)
- NOT immune to concept-count collision (0.739 operating margin, single-digit ceiling likely before collisions)
- NOT executed via OrangeBrain (seq=50 receipt is `lane:"reflex"` Phase 2 stub)

## Remediation plan (in flight)

**Wave 1 — earn the honest number:**
- Held-out validator: disjoint frame split (train on first-half video frames, test on second-half)
- Scaling attack harness: add concepts one by one, publish empirical N-concept capacity
- Per-concept ceilings replace global `HUMAN_GRADE_CEILING`
- Second-nearest ratio confidence — gives `confident-wrong` an independent definition
- Spine adapter (`aeyes.recognize.v1`, `orange.report.v1`)

**Wave 2 — YouTube corpus at N=100:**
- yt-dlp pipeline → frames → 100 concepts × 5 clips each
- Full held-out validation at real scale

**Wave 3 — cross-modal transcript binding:**
- yt-dlp auto-subs → text ↔ concept lexicon via co-occurrence
- Zero LLM in the identity path

## Standing law

Mom's Law binds this correction. The prior receipt claim of "100% human-grade" is retracted in favor of the plainly-measured "3 / 3 held-out + 10 / 10 rejects on a 16-image smoke test with 3 memorized targets excluded." The 100% number remains real for what it measures (the specific 16-image proof suite); the SEMANTIC CLAIM around it does not.

No fake-green. Receipts or it did not happen. The correction stands until Wave 1 lands new numbers.
