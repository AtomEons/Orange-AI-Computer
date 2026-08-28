# Experiment 09 — Determinism Floor Analysis

## Hypothesis
The canonical corpus contains a mix of (a) data deterministically derivable from inputs (action ids, timestamps as deltas, sha256 of canonical content) and (b) truly random nonces (uniqueRuntimeId hex strings, randomUUID outputs).

If we identify and isolate the irreducible-random bytes, the rest is regeneratable from a small seed. The regeneration ceiling = raw_bytes / (seed + code_sha + irreducible_random).

## Predicted ratio
- If 95%+ of corpus is derivable → regeneration ceiling 50-100×
- If 50%+ is derivable → 5-20×
- If <10% is derivable → no gain over current 54.57×

## Pass criterion
PASS if a deterministic-replay encoding (seed + code_sha + only the irreducible nonces) beats Experiment 07's 18.05× plait baseline.
