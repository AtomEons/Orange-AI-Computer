// 07-VISUAL/structural/identity/store-compression.mjs
//
// #112 — Compress identity store via family-then-θ plait ordering + brotli.
// AtomSmasher measured 18.05× compression on similar-shape receipt data
// using plait sequencing. Same principle applied to signature JSON:
//   1. Sort signatures by (chromatic family, θ within family) — matches the
//      cylinder-index's natural walk order → high local similarity
//   2. Serialize + brotli
//
// Bun has zlib brotli. Deterministic.

import fs from "node:fs";
import zlib from "node:zlib";
import { thetaOf } from "./cylinder-index.mjs";

/**
 * Sort a store's signatures by (label, θ) so consecutive rows are highly
 * self-similar. Brotli then finds long common substrings.
 *
 * @param {object} store
 * @returns {object}  new store with signatures sorted; input unchanged
 */
export function plaitOrderStore(store) {
  const out = { ...store, labels: [] };
  for (const row of store.labels ?? []) {
    const sorted = [...row.signatures].sort((a, b) => {
      const ta = thetaOf(a.sig);
      const tb = thetaOf(b.sig);
      return ta - tb;
    });
    out.labels.push({ ...row, signatures: sorted });
  }
  return out;
}

/**
 * Compress + write store.
 */
export function compressStore(store, outPath) {
  const ordered = plaitOrderStore(store);
  const json = JSON.stringify(ordered);
  const compressed = zlib.brotliCompressSync(Buffer.from(json, "utf8"), {
    params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 },
  });
  fs.writeFileSync(outPath, compressed);
  return {
    original_bytes: Buffer.byteLength(json, "utf8"),
    compressed_bytes: compressed.length,
    ratio: Buffer.byteLength(json, "utf8") / compressed.length,
  };
}

/**
 * Decompress + load.
 */
export function decompressStore(inPath) {
  const compressed = fs.readFileSync(inPath);
  const json = zlib.brotliDecompressSync(compressed).toString("utf8");
  return JSON.parse(json);
}
