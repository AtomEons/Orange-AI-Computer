# Celtic Equations — Modern Mathematical Standpoint (Reference)

Verbatim reference cached from operator drop 2026-06-26. Used to ground experiments 11+.

## 1. 3D Parametric Trefoil / Triquetra

The Trefoil knot is the geometric and topological foundation of the Celtic Triquetra. Maps interlacing strands as a continuous, non-self-intersecting curve through 3D space:

```
x(t) = sin(t) + 2·sin(2t)
y(t) = cos(t) - 2·cos(2t)
z(t) = -sin(3t)
```

with t ∈ [0, 2π].

- x and y plot the 2D footprint of the three-lobed Celtic circle
- z (frequency 3t) forces the alternating Over → Under weaving pattern

**Compression interpretation:** the entire continuous curve is determined by ~6 real numbers (3 frequencies × 2 amplitudes per coordinate, plus the t-period). DCT-style spectral basis decomposition is the corresponding lossless transform if the receipt sequence has periodic spectral structure.

## 2. Grand Combinatoric Knot Count K(n,m)

For an n×m Celtic plaitwork grid:

```
K(n,m) = (3/2)·nm - (n+m) + (3/2)·nm - (n+m)²/2 + ...
```

Components depend on parity of n, m and grid boundary conditions. This is the structural polynomial determining unique knot permutations on a finite grid.

(Closely related to Fisher's gcd(p,q) strand-component theorem already used in Experiment 05.)

## 3. Hyperbolic Celtic Mapping (Möbius)

Maps Celtic circles onto non-Euclidean surfaces (Poincaré disk, hyperbolic plane) via Möbius transformations:

```
f(z) = (a·z + b) / (c·z + d)
```

Ensures Celtic strands remain equidistant and topologically intact even as geometry stretches to infinity. Preserves cross-ratio (the fundamental Möbius invariant).

**Compression interpretation:** non-Euclidean re-mapping of the frequency space. Place high-frequency symbols near the hyperbolic origin (long codes get bounded depth) and rare symbols at the boundary (allowed to stretch). Equivalent in spirit to Huffman with non-Euclidean code-length budget.

## Operator-supplied photo refs (data/loomz/)

- **10267.png** — Adam Tetlow Instagram: Celtic rose generated from tangent-circle grid
- **10247.jpg** — Bird's-head spiral, Book of Kells, trumpet-petal join, four-fold close-packed spirals
- **10270.jpg** — "A circle divided into NINE generates mushrooms, S-curves, and hooked trumpets. All Celtic art motifs derive from tangenting circles and arcs."
- **10271.jpg** — TURNING KEYS: ring-shaped key requires unit-count to be an integer multiple of the key-unit, else units won't meet up. Examples: 4½, 7½, 42, 72 around.
- **10272.jpg** — Multiple patterns layered on a single radial grid. Multiple-of-N closure rule explicit.

## Distilled insights for compression

1. **Generative N-fold compression** — pick N, apply construction rules, regenerate everything. (One integer can encode the whole motif library.)
2. **Multiple-of-N closure rule** — periodic ring data only "closes" when length divides cleanly by the unit-period. Detect such N. Encode as fundamental_unit + N + boundary_adjustment.
3. **Layered patterns on shared grid** — multi-stream patterns sharing ONE generative substrate. Reinforces the plait/braid hypothesis.
4. **Tangent circles + grid = full image** — entire complex visual reconstructable from (center, radius) pairs + tangency rule. For receipts: (template, parameter) pairs + binding rule.

## Sources

- Fisher, A. & Brody, M. "Celtic Knot Mathematics" — https://www.mi.sanu.ac.rs/vismath/fisher/index.html
- Tetlow, A. "Celtic Pattern" (book photographed in loomz/) — turning keys, spiral construction grammar
- Hyperbolic Celtic Knot Patterns — ResearchGate 228573678 (Dunham, Univ. of Minnesota Duluth)
- Combinatorics on n×m Celtic knots — MathOverflow 412380 / Columbia CeltFrameGT-DCG.pdf
- Adelphi knot gallery — Stemkoski
