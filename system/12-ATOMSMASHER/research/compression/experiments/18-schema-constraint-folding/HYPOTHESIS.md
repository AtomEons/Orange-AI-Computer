# Experiment 18 — Schema-Derived Field Constraints

## Hypothesis
The corpus has functional dependencies: fields whose values are determined by other fields.
- payload `{"raw_bytes":X, "compressed_bytes":Y, "ratio":Z}` has Z = X/Y *exactly*
- summary often contains a printable form of payload numerics
- ratio field in receipts is a function of the bytes fields

Encoding only the *independent* axes losslessly + deriving the rest on decode should give a real ratio improvement.

## Method
1. Per-payload-template, identify numeric fields that are deterministic functions of others
2. Verify the relationship holds across ALL receipts using that template
3. Strip the derived field; store only inputs
4. On decode, recompute the derived field

## Pass criterion
PASS if functional folding + brotli beats Experiment 07 plait baseline (18.05×).
