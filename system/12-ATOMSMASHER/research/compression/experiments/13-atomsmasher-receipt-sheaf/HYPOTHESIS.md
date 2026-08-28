# Experiment 13 — AtomSmasher Receipt Sheaf (ARS)

## Hypothesis
Custom sheaf not based on Čech closure. Stratify by action; extract per-action structural templates from payload_json; isolate numeric parameter vectors as irreducible H^1; encode action sequence via RLE (it has avg run length 1.48).

This addresses Experiment 08's overhead-bound shortfall: instead of per-receipt component_id + 5-vocab residual, we get template_id (rare changes) + tight parameter arrays.

## Predicted ratio
20–30× full corpus. Solving for X = the per-receipt overhead in Exp 08.

## Pass criterion
PASS if ratio > 18.05× plait baseline AND lossless via sha256 roundtrip.
