# Experiment 11 — Trefoil DCT Spectral Decomposition

## Hypothesis
The 3D parametric trefoil (x=sin(t)+2sin(2t), y=cos(t)-2cos(2t), z=-sin(3t)) shows that a complex weaving curve is determined by ~6 real numbers via sinusoidal basis. If the receipt action-id sequence has spectral structure (a few dominant Fourier modes), DCT decomposition will concentrate energy in low-frequency coefficients and the resulting coefficient stream will compress tighter than the raw sequence.

## Predicted ratio
1.5–5× over Experiment 06's Huffman baseline (32.57× on action col). Bound: real spectral structure of the corpus dictates the win.

## Pass criterion
PASS if DCT-encoded action-id stream + brotli + lossless roundtrip beats Experiment 06's 32.57× on action col.

## Honest caveat
For LOSSLESS reconstruction we cannot drop any coefficient. The win must come from coefficient redundancy (most coefficients near zero → compress to short codes), not from truncation. If the spectrum is flat (white noise), DCT does nothing.
