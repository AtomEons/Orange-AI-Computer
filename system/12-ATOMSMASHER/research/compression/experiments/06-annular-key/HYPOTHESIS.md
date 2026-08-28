# Experiment 06 — Annular Key (frequency-ring Huffman code)

## Hypothesis
Celtic annular key patterns place high-frequency motifs at the center and rare motifs at the periphery. Information-theoretically this is Huffman coding: assign shortest codes to most-frequent symbols. Apply directly to the action vocabulary.

## Predicted ratio
4–15× on the action stream. Huffman approaches the Shannon entropy of the distribution.

## Pass criterion
PASS if Huffman-coded action stream + roundtrip lossless beats per-byte brotli on the same column.
