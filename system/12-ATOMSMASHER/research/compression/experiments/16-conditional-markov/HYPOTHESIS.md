# Experiment 16 — Conditional Entropy Bounds + Range-Coded Markov Model

## Hypothesis
The receipt action sequence has Markovian structure: knowing the prior K actions sharply constrains the next. Measure H(A_i | history) for K=0,1,2,3 to get the true compression bound for predictive coding. Then implement an arithmetic / range coder using the 1st-order Markov model and measure the realized bits-per-symbol.

If bound is significantly below the 2.401 IID Shannon bound, predictive coding has real room over Huffman.

## Predicted bound curve
- H(A): 2.401 bits/sym (already measured at Exp 06)
- H(A|A_-1): likely 1.0–1.5 bits/sym (action runs are long; sequel after a run is mostly predictable)
- H(A|A_-1,A_-2): 0.5–1.0 bits/sym
- Asymptotic: floor near the corpus's true entropy rate

## Pass criterion
Document the bound curve. PASS if range-coded length < Huffman-coded length on action column.
