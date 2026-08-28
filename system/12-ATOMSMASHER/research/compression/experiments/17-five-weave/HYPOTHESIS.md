# Experiment 17 — The 5-Weave

## Hypothesis
Add predictive Markov coding as a 5th orthogonal axis to the AIR/Crystal/Mesh/Brotli chain. Per-field 1st-order conditional probability models + range coder for each receipt field. The predictive axis is genuinely orthogonal to byte-level LZ77 because it models *what comes next given the past*, not *what bytes look like other bytes*.

## Predicted ratio
20–50× full corpus lossless. Beats both Experiment 07 plait (18.05×) and Experiment 09 ARS (15.51×) by exploiting the per-field Markov structure measured in Exp 16.

## Pass criterion
PASS if total lossless ratio > 18.05× plait baseline AND byte-exact roundtrip verified.
