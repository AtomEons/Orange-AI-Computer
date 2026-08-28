// Experiment 71 — Zstandard vs brotli, dict-mode comparison
// Compares brotli vs zstd, with and without a TRAIN-derived dictionary,
// on a held-out 20% TEST split of the canonical corpus.
//
// Important environment note (Bun 1.3.14 / node:zlib shim):
//   - The `dictionary` option to zlib.brotliCompressSync is silently ignored.
//   - The `dictionary` option to Bun.zstdCompressSync is silently ignored.
// We verified this by encoding with a dict claim and decoding without — both
// roundtripped cleanly, which they only could if the dict were never used.
//
// Therefore the dict-mode for both engines uses the PREFIX-CONCAT fallback:
// compress (train || test) and report (total - train_alone_compressed) as
// the test contribution. Roundtrip is validated by decompressing the
// concatenated blob and checking the trailing testBuf.length bytes match.

import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import zlib from "node:zlib";
import { performance } from "node:perf_hooks";

const CORPUS_PATH = "../../data/canonical-corpus.jsonl";
const SUMMARY_PATH = "summary.json";

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function timed(fn) {
  const t0 = performance.now();
  const out = fn();
  const ms = performance.now() - t0;
  return { out, ms };
}

// ------------------------------------------------------------------
// 1. Load corpus and split 80/20 by row index.
// ------------------------------------------------------------------
const raw = readFileSync(CORPUS_PATH);
const text = raw.toString("utf8");
const rows = text.split("\n").filter((l) => l.length > 0);
const TOTAL_ROWS = rows.length;
const TRAIN_COUNT = Math.floor(TOTAL_ROWS * 0.8);
const TEST_COUNT = TOTAL_ROWS - TRAIN_COUNT;

const trainRows = rows.slice(0, TRAIN_COUNT);
const testRows = rows.slice(TRAIN_COUNT);

const trainBuf = Buffer.from(trainRows.join("\n") + "\n", "utf8");
const testBuf = Buffer.from(testRows.join("\n") + "\n", "utf8");
const combinedBuf = Buffer.concat([trainBuf, testBuf]);

const testSha = sha256(testBuf);

console.log(
  `corpus: ${TOTAL_ROWS} rows / ${raw.length} bytes; ` +
    `train ${trainRows.length} rows / ${trainBuf.length} bytes; ` +
    `test ${testRows.length} rows / ${testBuf.length} bytes`,
);

// ------------------------------------------------------------------
// 2. Run the four methods.
// ------------------------------------------------------------------

const BROTLI_PARAMS = {
  params: {
    [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
    [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
    // Large window so prefix-concat (train+test ~2MB) fits in-window.
    [zlib.constants.BROTLI_PARAM_LGWIN]: 24,
  },
};

const ZSTD_OPTS = { level: 22 };

const results = {};

// ---- (a) brotli q11, no dict, on TEST only
{
  const enc = timed(() => zlib.brotliCompressSync(testBuf, BROTLI_PARAMS));
  const dec = timed(() => zlib.brotliDecompressSync(enc.out));
  const decSha = sha256(dec.out);
  results.brotli_plain = {
    compressed_bytes: enc.out.length,
    encode_ms: enc.ms,
    decode_ms: dec.ms,
    lossless: decSha === testSha,
    ratio: testBuf.length / enc.out.length,
    method_note: "brotli q11 on TEST only",
  };
}

// ---- (b) brotli q11 with prefix-concat (train then test)
// Encode (train || test); separately encode train alone; the test
// contribution is the size delta. Roundtrip: decompress the concat
// and assert tail matches testBuf.
{
  const trainAlone = timed(() =>
    zlib.brotliCompressSync(trainBuf, BROTLI_PARAMS),
  );
  const combined = timed(() =>
    zlib.brotliCompressSync(combinedBuf, BROTLI_PARAMS),
  );
  const testContribution = combined.out.length - trainAlone.out.length;

  const dec = timed(() => zlib.brotliDecompressSync(combined.out));
  const decBuf = Buffer.from(dec.out);
  const tail = decBuf.subarray(trainBuf.length);
  const decShaTail = sha256(tail);

  results.brotli_dict = {
    compressed_bytes: testContribution,
    train_alone_bytes: trainAlone.out.length,
    combined_bytes: combined.out.length,
    encode_ms: combined.ms, // measure the test-bearing encode
    decode_ms: dec.ms,
    lossless: decShaTail === testSha && tail.length === testBuf.length,
    ratio: testBuf.length / Math.max(1, testContribution),
    method_note:
      "brotli q11 prefix-concat (train||test); ratio = TEST_bytes / (combined - train_alone)",
  };
}

// ---- (c) zstd level 22, no dict, on TEST
{
  const enc = timed(() => Bun.zstdCompressSync(testBuf, ZSTD_OPTS));
  const encBuf = Buffer.from(enc.out);
  const dec = timed(() => Bun.zstdDecompressSync(encBuf));
  const decBuf = Buffer.from(dec.out);
  const decSha = sha256(decBuf);
  results.zstd_plain = {
    compressed_bytes: encBuf.length,
    encode_ms: enc.ms,
    decode_ms: dec.ms,
    lossless: decSha === testSha,
    ratio: testBuf.length / encBuf.length,
    method_note: "zstd level 22 on TEST only",
  };
}

// ---- (d) zstd level 22 with prefix-concat
{
  const trainAlone = timed(() => Bun.zstdCompressSync(trainBuf, ZSTD_OPTS));
  const trainAloneBuf = Buffer.from(trainAlone.out);
  const combined = timed(() => Bun.zstdCompressSync(combinedBuf, ZSTD_OPTS));
  const combinedBufC = Buffer.from(combined.out);
  const testContribution = combinedBufC.length - trainAloneBuf.length;

  const dec = timed(() => Bun.zstdDecompressSync(combinedBufC));
  const decBuf = Buffer.from(dec.out);
  const tail = decBuf.subarray(trainBuf.length);
  const decShaTail = sha256(tail);

  results.zstd_dict = {
    compressed_bytes: testContribution,
    train_alone_bytes: trainAloneBuf.length,
    combined_bytes: combinedBufC.length,
    encode_ms: combined.ms,
    decode_ms: dec.ms,
    lossless: decShaTail === testSha && tail.length === testBuf.length,
    ratio: testBuf.length / Math.max(1, testContribution),
    method_note:
      "zstd level 22 prefix-concat (train||test); ratio = TEST_bytes / (combined - train_alone)",
  };
}

// ------------------------------------------------------------------
// 3. Pick winner and emit summary.
// ------------------------------------------------------------------

const losslessRows = Object.entries(results).filter(([, v]) => v.lossless);
const ordered = losslessRows.sort((a, b) => b[1].ratio - a[1].ratio);
const [bestName, bestRow] = ordered[0];

const M19_PROJECTION = 47.07;
const allRatios = Object.fromEntries(
  Object.entries(results).map(([k, v]) => [k, v.ratio.toFixed(4)]),
);

const notes =
  `method=${bestName}; TEST=${TEST_COUNT} rows / ${testBuf.length} bytes (20% holdout); ` +
  `all 4 ratios: brotli=${allRatios.brotli_plain}, brotli+dict=${allRatios.brotli_dict}, ` +
  `zstd=${allRatios.zstd_plain}, zstd+dict=${allRatios.zstd_dict}; ` +
  `full-corpus extrapolation=${bestRow.ratio.toFixed(2)}x; ` +
  `M19 baseline=${M19_PROJECTION}x on full 2.07MB corpus; ` +
  `dict mode is prefix-concat (zlib brotli & Bun.zstd both silently ignore the dictionary option in Bun 1.3.14).`;

const summary = {
  experiment: "71-zstd-dict",
  ratio: Number(bestRow.ratio.toFixed(4)),
  encode_ms: Number(bestRow.encode_ms.toFixed(3)),
  decode_ms: Number(bestRow.decode_ms.toFixed(3)),
  lossless: bestRow.lossless,
  notes,
};

writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2));

console.log("\n--- per-method ---");
for (const [k, v] of Object.entries(results)) {
  console.log(
    `${k.padEnd(13)} ` +
      `bytes=${String(v.compressed_bytes).padStart(7)} ` +
      `ratio=${v.ratio.toFixed(4).padStart(8)} ` +
      `enc=${v.encode_ms.toFixed(1).padStart(7)}ms ` +
      `dec=${v.decode_ms.toFixed(2).padStart(6)}ms ` +
      `lossless=${v.lossless}`,
  );
}
console.log("\n--- summary ---");
console.log(JSON.stringify(summary, null, 2));
