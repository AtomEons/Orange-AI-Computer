# CPU Profile

| Duration | Samples | Interval | Functions |
|----------|---------|----------|----------|
| 2.73s | 194 | 1.0ms | 147 |

**Top 10:** `join` 17.1%, `close` 16.1%, `has` 10.2%, `async (anonymous)` 8.2%, `run` 7.6%, `(anonymous)` 4.5%, `anonymous` 3.4%, `readFileSync` 3.3%, `tokens` 3.0%, `normalizeToken` 2.7%

## Hot Functions (Self Time)

| Self% | Self | Total% | Total | Function | Location |
|------:|-----:|-------:|------:|----------|----------|
| 17.1% | 469.4ms | 17.1% | 469.4ms | `join` | `[native code]` |
| 16.1% | 443.6ms | 16.1% | 443.6ms | `close` | `[native code]` |
| 10.2% | 279.9ms | 10.2% | 279.9ms | `has` | `[native code]` |
| 8.2% | 226.0ms | 8.2% | 226.0ms | `async (anonymous)` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs` |
| 7.6% | 208.7ms | 7.6% | 208.7ms | `run` | `[native code]` |
| 4.5% | 125.5ms | 4.5% | 125.5ms | `(anonymous)` | `C:\AtomEons\Orange5\bin\sqlite-shim.mjs:100` |
| 3.4% | 95.1ms | 17.4% | 477.5ms | `anonymous` | `[native code]` |
| 3.3% | 91.0ms | 6.6% | 182.0ms | `readFileSync` | `[native code]` |
| 3.0% | 84.7ms | 3.1% | 85.7ms | `tokens` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:85` |
| 2.7% | 75.4ms | 2.7% | 75.4ms | `normalizeToken` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:80` |
| 2.3% | 64.3ms | 2.3% | 64.3ms | `Set` | `[native code]` |
| 1.9% | 52.1ms | 1.9% | 52.1ms | `pointId` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:25` |
| 1.7% | 47.5ms | 11.9% | 327.4ms | `(anonymous)` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:86` |
| 1.3% | 35.7ms | 1.3% | 35.7ms | `normalizeToken` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:77` |
| 1.1% | 32.2ms | 1.2% | 34.0ms | `Database` | `[native code]` |
| 1.1% | 31.9ms | 1.1% | 31.9ms | `normalizeToken` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:74` |
| 1.1% | 30.7ms | 1.1% | 30.7ms | `stableJson` | `C:\AtomEons\Orange5\03-BACKEND\learning-queue.mjs:13` |
| 1.1% | 30.3ms | 1.1% | 30.3ms | `hostname` | `[native code]` |
| 1.0% | 29.0ms | 1.0% | 29.0ms | `get` | `[native code]` |
| 0.8% | 22.2ms | 2.0% | 56.8ms | `(anonymous)` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:297` |
| 0.8% | 22.1ms | 0.8% | 22.1ms | `normalizeToken` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:79` |
| 0.6% | 17.9ms | 0.6% | 17.9ms | `Boolean` | `[native code]` |
| 0.6% | 17.9ms | 0.6% | 17.9ms | `recordPayload` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:63` |
| 0.6% | 17.8ms | 13.8% | 379.4ms | `filter` | `[native code]` |
| 0.6% | 17.6ms | 0.6% | 17.6ms | `update` | `[native code]` |
| 0.5% | 16.1ms | 0.5% | 16.1ms | `lexicalLedgerSignature` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs` |
| 0.5% | 16.0ms | 0.5% | 16.0ms | `(anonymous)` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:298` |
| 0.5% | 15.8ms | 0.5% | 15.8ms | `(anonymous)` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:182` |
| 0.5% | 15.5ms | 0.5% | 15.5ms | `trim` | `[native code]` |
| 0.5% | 15.0ms | 0.5% | 15.0ms | `recordPayload` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:48` |
| 0.5% | 14.6ms | 1.5% | 43.0ms | `reduce` | `[native code]` |
| 0.5% | 14.1ms | 0.5% | 14.1ms | `readFlux` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\flux\reader.mjs:210` |
| 0.4% | 11.3ms | 1.3% | 36.0ms | `sort` | `[native code]` |
| 0.4% | 11.1ms | 0.4% | 11.1ms | `stringify` | `[native code]` |
| 0.3% | 8.8ms | 0.3% | 8.8ms | `(anonymous)` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:300` |
| 0.2% | 7.3ms | 0.2% | 7.3ms | `test` | `[native code]` |
| 0.1% | 4.6ms | 0.1% | 4.6ms | `parse` | `[native code]` |
| 0.0% | 2.3ms | 0.0% | 2.3ms | `async jsonFetch` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs` |
| 0.0% | 2.3ms | 0.0% | 2.3ms | `normalizeToken` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:78` |
| 0.0% | 1.7ms | 0.0% | 1.7ms | `open` | `[native code]` |
| 0.0% | 1.3ms | 0.0% | 1.3ms | `writeFast` | `internal:fs/streams` |
| 0.0% | 1.3ms | 0.0% | 1.3ms | `every` | `[native code]` |
| 0.0% | 1.2ms | 0.0% | 1.2ms | `async embed` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs` |
| 0.0% | 1.1ms | 0.0% | 1.1ms | `internal:streams/utils` | `internal:streams/utils:189` |
| 0.0% | 1.1ms | 0.0% | 1.1ms | `(anonymous)` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs` |
| 0.0% | 1.1ms | 0.0% | 1.1ms | `wrapTransaction` | `bun:sqlite:408` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `Hash` | `[native code]` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `[Symbol.match]` | `[native code]` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `(anonymous)` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:288` |
| 0.0% | 957us | 0.0% | 957us | `internal:streams/destroy` | `internal:streams/destroy:16` |
| 0.0% | 877us | 0.6% | 18.8ms | `(anonymous)` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:290` |

## Call Tree (Total Time)

| Total% | Total | Self% | Self | Function | Location |
|-------:|------:|------:|-----:|----------|----------|
| 37.1% | 1.01s | 0.0% | 0us | `map` | `[native code]` |
| 25.6% | 702.5ms | 0.0% | 0us | `async querySemanticMemory` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:592` |
| 22.6% | 619.0ms | 0.0% | 0us | `lexicalCandidates` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:283` |
| 21.8% | 599.2ms | 0.0% | 0us | `(anonymous)` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:283` |
| 20.5% | 561.7ms | 0.0% | 0us | `tokens` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:86` |
| 17.4% | 477.5ms | 3.4% | 95.1ms | `anonymous` | `[native code]` |
| 17.1% | 469.4ms | 0.0% | 0us | `bound join` | `[native code]` |
| 17.1% | 469.4ms | 17.1% | 469.4ms | `join` | `[native code]` |
| 17.0% | 467.4ms | 0.0% | 0us | `async benchmarkQueue` | `C:\AtomEons\Orange5\scripts\bun-runtime-benchmark.mjs:66` |
| 17.0% | 467.4ms | 0.0% | 0us | `(module)` | `C:\AtomEons\Orange5\scripts\bun-runtime-benchmark.mjs:27` |
| 17.0% | 467.4ms | 0.0% | 0us | `async benchmarkQueue` | `C:\AtomEons\Orange5\scripts\bun-runtime-benchmark.mjs:67` |
| 16.3% | 449.1ms | 0.0% | 0us | `async querySemanticMemory` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:565` |
| 16.3% | 449.1ms | 0.0% | 0us | `async benchmarkSemantic` | `C:\AtomEons\Orange5\scripts\bun-runtime-benchmark.mjs:110` |
| 16.1% | 443.6ms | 16.1% | 443.6ms | `close` | `[native code]` |
| 16.1% | 443.6ms | 0.0% | 0us | `async benchmarkQueue` | `C:\AtomEons\Orange5\scripts\bun-runtime-benchmark.mjs:89` |
| 16.1% | 443.6ms | 0.0% | 0us | `close` | `C:\AtomEons\Orange5\03-BACKEND\learning-queue.mjs:269` |
| 13.8% | 379.4ms | 0.6% | 17.8ms | `filter` | `[native code]` |
| 11.9% | 327.4ms | 1.7% | 47.5ms | `(anonymous)` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:86` |
| 10.2% | 279.9ms | 10.2% | 279.9ms | `has` | `[native code]` |
| 8.3% | 229.5ms | 0.0% | 0us | `async querySemanticMemory` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:587` |
| 8.2% | 226.0ms | 8.2% | 226.0ms | `async (anonymous)` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs` |
| 8.0% | 219.5ms | 0.0% | 0us | `async lexicalCorpus` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:185` |
| 8.0% | 219.5ms | 0.0% | 0us | `async querySemanticMemory` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:589` |
| 7.6% | 208.7ms | 7.6% | 208.7ms | `run` | `[native code]` |
| 6.9% | 189.2ms | 0.0% | 0us | `async benchmarkQueue` | `C:\AtomEons\Orange5\scripts\bun-runtime-benchmark.mjs:72` |
| 6.6% | 182.0ms | 3.3% | 91.0ms | `readFileSync` | `[native code]` |
| 5.0% | 139.0ms | 0.0% | 0us | `run` | `bun:sqlite:336` |
| 4.7% | 129.3ms | 0.0% | 0us | `async benchmarkQueue` | `C:\AtomEons\Orange5\scripts\bun-runtime-benchmark.mjs:78` |
| 4.6% | 128.2ms | 0.0% | 0us | `transaction` | `bun:sqlite:416` |
| 4.6% | 126.5ms | 0.0% | 0us | `get` | `C:\AtomEons\Orange5\03-BACKEND\learning-queue.mjs:194` |
| 4.5% | 125.5ms | 4.5% | 125.5ms | `(anonymous)` | `C:\AtomEons\Orange5\bin\sqlite-shim.mjs:100` |
| 3.5% | 95.9ms | 0.0% | 0us | `LearningQueueStore` | `C:\AtomEons\Orange5\03-BACKEND\learning-queue.mjs:65` |
| 3.5% | 95.9ms | 0.0% | 0us | `initializeDatabase` | `C:\AtomEons\Orange5\03-BACKEND\learning-queue.mjs:44` |
| 3.4% | 94.2ms | 0.0% | 0us | `async lexicalCorpus` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:200` |
| 3.2% | 88.2ms | 0.0% | 0us | `async querySemanticMemory` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:593` |
| 3.1% | 85.7ms | 3.0% | 84.7ms | `tokens` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:85` |
| 2.9% | 80.1ms | 0.0% | 0us | `readLaneRecords` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\flux\reader.mjs:126` |
| 2.9% | 80.1ms | 0.0% | 0us | `readFlux` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\flux\reader.mjs:203` |
| 2.7% | 75.4ms | 2.7% | 75.4ms | `normalizeToken` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:80` |
| 2.7% | 74.1ms | 0.0% | 0us | `async benchmarkQueue` | `C:\AtomEons\Orange5\scripts\bun-runtime-benchmark.mjs:80` |
| 2.6% | 71.4ms | 0.0% | 0us | `internal:streams/lazy_transform` | `internal:streams/lazy_transform:2` |
| 2.6% | 71.4ms | 0.0% | 0us | `node:crypto` | `node:crypto:2` |
| 2.6% | 71.4ms | 0.0% | 0us | `internal:streams/transform` | `internal:streams/transform:2` |
| 2.6% | 71.4ms | 0.0% | 0us | `internal:streams/duplex` | `internal:streams/duplex:2` |
| 2.6% | 71.2ms | 0.0% | 0us | `rerankHits` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:124` |
| 2.5% | 70.0ms | 0.0% | 0us | `async lexicalCorpus` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:202` |
| 2.5% | 70.0ms | 0.0% | 0us | `(anonymous)` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:202` |
| 2.5% | 69.6ms | 0.0% | 0us | `#run` | `bun:sqlite:185` |
| 2.3% | 64.9ms | 0.0% | 0us | `async benchmarkQueue` | `C:\AtomEons\Orange5\scripts\bun-runtime-benchmark.mjs:77` |
| 2.3% | 64.3ms | 2.3% | 64.3ms | `Set` | `[native code]` |
| 2.1% | 58.1ms | 0.0% | 0us | `complete` | `C:\AtomEons\Orange5\03-BACKEND\learning-queue.mjs:178` |
| 2.0% | 56.8ms | 0.8% | 22.2ms | `(anonymous)` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:297` |
| 1.9% | 52.4ms | 0.0% | 0us | `internal:streams/legacy` | `internal:streams/legacy:2` |
| 1.9% | 52.4ms | 0.0% | 0us | `node:events` | `node:events:9` |
| 1.9% | 52.4ms | 0.0% | 0us | `internal:validators` | `internal:validators:2` |
| 1.9% | 52.1ms | 1.9% | 52.1ms | `pointId` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:25` |
| 1.7% | 47.0ms | 0.0% | 0us | `(anonymous)` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:126` |
| 1.6% | 44.5ms | 0.0% | 0us | `lexicalCandidates` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:296` |
| 1.5% | 43.1ms | 0.0% | 0us | `LearningQueueStore` | `C:\AtomEons\Orange5\03-BACKEND\learning-queue.mjs:71` |
| 1.5% | 43.0ms | 0.5% | 14.6ms | `reduce` | `[native code]` |
| 1.5% | 42.0ms | 0.0% | 0us | `stableJson` | `C:\AtomEons\Orange5\03-BACKEND\learning-queue.mjs:14` |
| 1.3% | 36.0ms | 0.4% | 11.3ms | `sort` | `[native code]` |
| 1.3% | 35.7ms | 1.3% | 35.7ms | `normalizeToken` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:77` |
| 1.2% | 34.0ms | 1.1% | 32.2ms | `Database` | `[native code]` |
| 1.2% | 34.0ms | 0.0% | 0us | `LearningQueueStore` | `C:\AtomEons\Orange5\03-BACKEND\learning-queue.mjs:64` |
| 1.1% | 31.9ms | 1.1% | 31.9ms | `normalizeToken` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:74` |
| 1.1% | 30.7ms | 0.0% | 0us | `(anonymous)` | `C:\AtomEons\Orange5\03-BACKEND\learning-queue.mjs:14` |
| 1.1% | 30.7ms | 1.1% | 30.7ms | `stableJson` | `C:\AtomEons\Orange5\03-BACKEND\learning-queue.mjs:13` |
| 1.1% | 30.7ms | 0.0% | 0us | `enqueue` | `C:\AtomEons\Orange5\03-BACKEND\learning-queue.mjs:147` |
| 1.1% | 30.3ms | 1.1% | 30.3ms | `hostname` | `[native code]` |
| 1.1% | 30.3ms | 0.0% | 0us | `(module)` | `C:\AtomEons\Orange5\scripts\bun-runtime-benchmark.mjs:32` |
| 1.0% | 29.2ms | 0.0% | 0us | `enqueue` | `C:\AtomEons\Orange5\03-BACKEND\learning-queue.mjs:157` |
| 1.0% | 29.0ms | 1.0% | 29.0ms | `get` | `[native code]` |
| 0.8% | 22.1ms | 0.8% | 22.1ms | `normalizeToken` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:79` |
| 0.8% | 22.1ms | 0.0% | 0us | `async lexicalCorpus` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:187` |
| 0.6% | 18.8ms | 0.0% | 877us | `(anonymous)` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:290` |
| 0.6% | 18.7ms | 0.0% | 0us | `sha256` | `C:\AtomEons\Orange5\03-BACKEND\learning-queue.mjs:20` |
| 0.6% | 17.9ms | 0.6% | 17.9ms | `Boolean` | `[native code]` |
| 0.6% | 17.9ms | 0.6% | 17.9ms | `recordPayload` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:63` |
| 0.6% | 17.6ms | 0.6% | 17.6ms | `update` | `[native code]` |
| 0.5% | 16.1ms | 0.0% | 0us | `async lexicalCorpus` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:195` |
| 0.5% | 16.1ms | 0.5% | 16.1ms | `lexicalLedgerSignature` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs` |
| 0.5% | 16.1ms | 0.0% | 0us | `LearningQueueStore` | `C:\AtomEons\Orange5\03-BACKEND\learning-queue.mjs:69` |
| 0.5% | 16.0ms | 0.5% | 16.0ms | `(anonymous)` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:298` |
| 0.5% | 15.8ms | 0.5% | 15.8ms | `(anonymous)` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:182` |
| 0.5% | 15.5ms | 0.0% | 0us | `(anonymous)` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:142` |
| 0.5% | 15.5ms | 0.0% | 0us | `lowInformationPayload` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:90` |
| 0.5% | 15.5ms | 0.5% | 15.5ms | `trim` | `[native code]` |
| 0.5% | 15.4ms | 0.0% | 0us | `lexicalCandidates` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:299` |
| 0.5% | 15.4ms | 0.0% | 0us | `(module)` | `C:\AtomEons\Orange5\scripts\bun-runtime-benchmark.mjs:52` |
| 0.5% | 15.0ms | 0.5% | 15.0ms | `recordPayload` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:48` |
| 0.5% | 15.0ms | 0.0% | 0us | `async lexicalCorpus` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:201` |
| 0.5% | 15.0ms | 0.0% | 0us | `usefulRecord` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:104` |
| 0.5% | 14.6ms | 0.0% | 0us | `lexicalCandidates` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:291` |
| 0.5% | 14.6ms | 0.0% | 0us | `(anonymous)` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:292` |
| 0.5% | 14.1ms | 0.0% | 0us | `WriteStream` | `internal:fs/streams:245` |
| 0.5% | 14.1ms | 0.0% | 0us | `setup` | `[native code]` |
| 0.5% | 14.1ms | 0.0% | 0us | `(anonymous)` | `[native code]` |
| 0.5% | 14.1ms | 0.0% | 0us | `nextTick` | `[native code]` |
| 0.5% | 14.1ms | 0.0% | 0us | `Writable` | `internal:streams/writable:196` |
| 0.5% | 14.1ms | 0.0% | 0us | `construct` | `internal:streams/destroy:124` |
| 0.5% | 14.1ms | 0.5% | 14.1ms | `readFlux` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\flux\reader.mjs:210` |
| 0.4% | 11.6ms | 0.0% | 0us | `node:fs` | `node:fs:2` |
| 0.4% | 11.3ms | 0.0% | 0us | `complete` | `C:\AtomEons\Orange5\03-BACKEND\learning-queue.mjs:176` |
| 0.4% | 11.1ms | 0.4% | 11.1ms | `stringify` | `[native code]` |
| 0.4% | 11.1ms | 0.0% | 0us | `loadLexicalMirror` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:218` |
| 0.3% | 10.9ms | 0.0% | 0us | `loadLexicalMirror` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:216` |
| 0.3% | 8.8ms | 0.0% | 0us | `lexicalCandidates` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:300` |
| 0.3% | 8.8ms | 0.3% | 8.8ms | `(anonymous)` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:300` |
| 0.2% | 7.3ms | 0.2% | 7.3ms | `test` | `[native code]` |
| 0.2% | 7.3ms | 0.0% | 0us | `(anonymous)` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:149` |
| 0.2% | 7.3ms | 0.0% | 0us | `machineTelemetryPayload` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:112` |
| 0.1% | 5.2ms | 0.0% | 0us | `internal:streams/readable` | `internal:streams/readable:2` |
| 0.1% | 4.6ms | 0.1% | 4.6ms | `parse` | `[native code]` |
| 0.1% | 4.6ms | 0.0% | 0us | `get` | `C:\AtomEons\Orange5\03-BACKEND\learning-queue.mjs:200` |
| 0.1% | 3.5ms | 0.0% | 0us | `async (anonymous)` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:578` |
| 0.1% | 3.5ms | 0.0% | 0us | `async (anonymous)` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:576` |
| 0.1% | 2.8ms | 0.0% | 0us | `enqueue` | `C:\AtomEons\Orange5\03-BACKEND\learning-queue.mjs:152` |
| 0.0% | 2.7ms | 0.0% | 0us | `(anonymous)` | `C:\AtomEons\Orange5\03-BACKEND\learning-queue.mjs:168` |
| 0.0% | 2.3ms | 0.0% | 0us | `async embed` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:366` |
| 0.0% | 2.3ms | 0.0% | 0us | `async embed` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:367` |
| 0.0% | 2.3ms | 0.0% | 2.3ms | `async jsonFetch` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs` |
| 0.0% | 2.3ms | 0.0% | 2.3ms | `normalizeToken` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:78` |
| 0.0% | 2.2ms | 0.0% | 0us | `internal:shared` | `internal:shared:2` |
| 0.0% | 1.9ms | 0.0% | 0us | `async lexicalCorpus` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:186` |
| 0.0% | 1.7ms | 0.0% | 1.7ms | `open` | `[native code]` |
| 0.0% | 1.7ms | 0.0% | 0us | `Database` | `bun:sqlite:260` |
| 0.0% | 1.3ms | 0.0% | 0us | `async jsonFetch` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:342` |
| 0.0% | 1.3ms | 0.0% | 1.3ms | `writeFast` | `internal:fs/streams` |
| 0.0% | 1.3ms | 0.0% | 1.3ms | `every` | `[native code]` |
| 0.0% | 1.3ms | 0.0% | 0us | `(module)` | `C:\AtomEons\Orange5\scripts\bun-runtime-benchmark.mjs:33` |
| 0.0% | 1.2ms | 0.0% | 0us | `(anonymous)` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:137` |
| 0.0% | 1.2ms | 0.0% | 1.2ms | `async embed` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs` |
| 0.0% | 1.1ms | 0.0% | 1.1ms | `internal:streams/utils` | `internal:streams/utils:189` |
| 0.0% | 1.1ms | 0.0% | 0us | `internal:streams/add-abort-signal` | `internal:streams/add-abort-signal:2` |
| 0.0% | 1.1ms | 0.0% | 1.1ms | `(anonymous)` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs` |
| 0.0% | 1.1ms | 0.0% | 0us | `transaction` | `bun:sqlite:376` |
| 0.0% | 1.1ms | 0.0% | 0us | `leaseNext` | `C:\AtomEons\Orange5\03-BACKEND\learning-queue.mjs:167` |
| 0.0% | 1.1ms | 0.0% | 1.1ms | `wrapTransaction` | `bun:sqlite:408` |
| 0.0% | 1.0ms | 0.0% | 0us | `Hash` | `node:crypto:178` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `Hash` | `[native code]` |
| 0.0% | 1.0ms | 0.0% | 0us | `enqueue` | `C:\AtomEons\Orange5\03-BACKEND\learning-queue.mjs:150` |
| 0.0% | 1.0ms | 0.0% | 0us | `createHash` | `node:crypto:201` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `[Symbol.match]` | `[native code]` |
| 0.0% | 1.0ms | 0.0% | 0us | `match` | `[native code]` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `(anonymous)` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:288` |
| 0.0% | 957us | 0.0% | 957us | `internal:streams/destroy` | `internal:streams/destroy:16` |

## Function Details

### `join`
`[native code]` | Self: 17.1% (469.4ms) | Total: 17.1% (469.4ms) | Samples: 2

**Called by:**
- `bound join` (2)

### `close`
`[native code]` | Self: 16.1% (443.6ms) | Total: 16.1% (443.6ms) | Samples: 48

**Called by:**
- `close` (48)

### `has`
`[native code]` | Self: 10.2% (279.9ms) | Total: 10.2% (279.9ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `async (anonymous)`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs` | Self: 8.2% (226.0ms) | Total: 8.2% (226.0ms) | Samples: 1

**Called by:**
- `async querySemanticMemory` (1)

### `run`
`[native code]` | Self: 7.6% (208.7ms) | Total: 7.6% (208.7ms) | Samples: 20

**Called by:**
- `run` (15)
- `#run` (5)

### `(anonymous)`
`C:\AtomEons\Orange5\bin\sqlite-shim.mjs:100` | Self: 4.5% (125.5ms) | Total: 4.5% (125.5ms) | Samples: 25

**Called by:**
- `get` (25)

### `anonymous`
`[native code]` | Self: 3.4% (95.1ms) | Total: 17.4% (477.5ms) | Samples: 8

**Called by:**
- `internal:streams/transform` (8)
- `node:crypto` (8)
- `internal:streams/duplex` (8)
- `internal:streams/lazy_transform` (8)
- `internal:streams/readable` (4)
- `internal:validators` (3)
- `internal:streams/legacy` (3)
- `node:events` (3)
- `internal:shared` (2)
- `setup` (1)
- `internal:streams/add-abort-signal` (1)
- `node:fs` (1)

**Calls:**
- `internal:streams/transform` (8)
- `internal:streams/duplex` (8)
- `internal:streams/lazy_transform` (8)
- `internal:streams/readable` (4)
- `internal:streams/legacy` (3)
- `internal:validators` (3)
- `node:events` (3)
- `internal:shared` (2)
- `internal:streams/destroy` (1)
- `internal:streams/add-abort-signal` (1)
- `internal:streams/utils` (1)

### `readFileSync`
`[native code]` | Self: 3.3% (91.0ms) | Total: 6.6% (182.0ms) | Samples: 6

**Called by:**
- `readFileSync` (6)
- `loadLexicalMirror` (3)
- `readLaneRecords` (3)

**Calls:**
- `readFileSync` (6)

### `tokens`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:85` | Self: 3.0% (84.7ms) | Total: 3.1% (85.7ms) | Samples: 2

**Called by:**
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)

**Calls:**
- `match` (1)

### `normalizeToken`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:80` | Self: 2.7% (75.4ms) | Total: 2.7% (75.4ms) | Samples: 5

**Called by:**
- `map` (5)

### `Set`
`[native code]` | Self: 2.3% (64.3ms) | Total: 2.3% (64.3ms) | Samples: 8

**Called by:**
- `tokens` (8)

### `pointId`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:25` | Self: 1.9% (52.1ms) | Total: 1.9% (52.1ms) | Samples: 2

**Called by:**
- `(anonymous)` (2)

### `(anonymous)`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:86` | Self: 1.7% (47.5ms) | Total: 11.9% (327.4ms) | Samples: 6

**Called by:**
- `filter` (7)

**Calls:**
- `has` (1)

### `normalizeToken`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:77` | Self: 1.3% (35.7ms) | Total: 1.3% (35.7ms) | Samples: 4

**Called by:**
- `map` (4)

### `Database`
`[native code]` | Self: 1.1% (32.2ms) | Total: 1.2% (34.0ms) | Samples: 1

**Called by:**
- `LearningQueueStore` (3)

**Calls:**
- `Database` (2)

### `normalizeToken`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:74` | Self: 1.1% (31.9ms) | Total: 1.1% (31.9ms) | Samples: 3

**Called by:**
- `map` (3)

### `stableJson`
`C:\AtomEons\Orange5\03-BACKEND\learning-queue.mjs:13` | Self: 1.1% (30.7ms) | Total: 1.1% (30.7ms) | Samples: 2

**Called by:**
- `(anonymous)` (2)

### `hostname`
`[native code]` | Self: 1.1% (30.3ms) | Total: 1.1% (30.3ms) | Samples: 3

**Called by:**
- `(module)` (3)

### `get`
`[native code]` | Self: 1.0% (29.0ms) | Total: 1.0% (29.0ms) | Samples: 7

**Called by:**
- `LearningQueueStore` (3)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `enqueue` (1)
- `get` (1)

### `(anonymous)`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:297` | Self: 0.8% (22.2ms) | Total: 2.0% (56.8ms) | Samples: 2

**Called by:**
- `reduce` (3)
- `map` (3)

**Calls:**
- `reduce` (3)
- `get` (1)

### `normalizeToken`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:79` | Self: 0.8% (22.1ms) | Total: 0.8% (22.1ms) | Samples: 1

**Called by:**
- `map` (1)

### `Boolean`
`[native code]` | Self: 0.6% (17.9ms) | Total: 0.6% (17.9ms) | Samples: 2

**Called by:**
- `filter` (2)

### `recordPayload`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:63` | Self: 0.6% (17.9ms) | Total: 0.6% (17.9ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `filter`
`[native code]` | Self: 0.6% (17.8ms) | Total: 13.8% (379.4ms) | Samples: 2

**Called by:**
- `tokens` (8)
- `(anonymous)` (2)
- `async querySemanticMemory` (1)
- `async lexicalCorpus` (1)
- `lexicalCandidates` (1)

**Calls:**
- `(anonymous)` (7)
- `Boolean` (2)
- `usefulRecord` (1)
- `(anonymous)` (1)

### `update`
`[native code]` | Self: 0.6% (17.6ms) | Total: 0.6% (17.6ms) | Samples: 1

**Called by:**
- `sha256` (1)

### `lexicalLedgerSignature`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs` | Self: 0.5% (16.1ms) | Total: 0.5% (16.1ms) | Samples: 1

**Called by:**
- `async lexicalCorpus` (1)

### `(anonymous)`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:298` | Self: 0.5% (16.0ms) | Total: 0.5% (16.0ms) | Samples: 1

**Called by:**
- `map` (1)

### `(anonymous)`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:182` | Self: 0.5% (15.8ms) | Total: 0.5% (15.8ms) | Samples: 1

**Called by:**
- `sort` (1)

### `trim`
`[native code]` | Self: 0.5% (15.5ms) | Total: 0.5% (15.5ms) | Samples: 1

**Called by:**
- `lowInformationPayload` (1)

### `recordPayload`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:48` | Self: 0.5% (15.0ms) | Total: 0.5% (15.0ms) | Samples: 1

**Called by:**
- `usefulRecord` (1)

### `reduce`
`[native code]` | Self: 0.5% (14.6ms) | Total: 1.5% (43.0ms) | Samples: 2

**Called by:**
- `(anonymous)` (3)
- `(anonymous)` (2)

**Calls:**
- `(anonymous)` (3)

### `readFlux`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\flux\reader.mjs:210` | Self: 0.5% (14.1ms) | Total: 0.5% (14.1ms) | Samples: 1

**Called by:**
- `async lexicalCorpus` (1)

### `sort`
`[native code]` | Self: 0.4% (11.3ms) | Total: 1.3% (36.0ms) | Samples: 1

**Called by:**
- `lexicalCandidates` (2)
- `async querySemanticMemory` (1)
- `stableJson` (1)

**Calls:**
- `(anonymous)` (2)
- `(anonymous)` (1)

### `stringify`
`[native code]` | Self: 0.4% (11.1ms) | Total: 0.4% (11.1ms) | Samples: 1

**Called by:**
- `loadLexicalMirror` (1)

### `(anonymous)`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:300` | Self: 0.3% (8.8ms) | Total: 0.3% (8.8ms) | Samples: 2

**Called by:**
- `sort` (2)

### `test`
`[native code]` | Self: 0.2% (7.3ms) | Total: 0.2% (7.3ms) | Samples: 1

**Called by:**
- `machineTelemetryPayload` (1)

### `parse`
`[native code]` | Self: 0.1% (4.6ms) | Total: 0.1% (4.6ms) | Samples: 1

**Called by:**
- `get` (1)

### `async jsonFetch`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs` | Self: 0.0% (2.3ms) | Total: 0.0% (2.3ms) | Samples: 2

**Called by:**
- `async embed` (1)
- `async jsonFetch` (1)

### `normalizeToken`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:78` | Self: 0.0% (2.3ms) | Total: 0.0% (2.3ms) | Samples: 2

**Called by:**
- `map` (2)

### `open`
`[native code]` | Self: 0.0% (1.7ms) | Total: 0.0% (1.7ms) | Samples: 2

**Called by:**
- `Database` (2)

### `writeFast`
`internal:fs/streams` | Self: 0.0% (1.3ms) | Total: 0.0% (1.3ms) | Samples: 1

**Called by:**
- `(module)` (1)

### `every`
`[native code]` | Self: 0.0% (1.3ms) | Total: 0.0% (1.3ms) | Samples: 1

**Called by:**
- `(module)` (1)

### `async embed`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs` | Self: 0.0% (1.2ms) | Total: 0.0% (1.2ms) | Samples: 1

**Called by:**
- `async (anonymous)` (1)

### `internal:streams/utils`
`internal:streams/utils:189` | Self: 0.0% (1.1ms) | Total: 0.0% (1.1ms) | Samples: 1

**Called by:**
- `anonymous` (1)

### `(anonymous)`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs` | Self: 0.0% (1.1ms) | Total: 0.0% (1.1ms) | Samples: 1

**Called by:**
- `filter` (1)

### `wrapTransaction`
`bun:sqlite:408` | Self: 0.0% (1.1ms) | Total: 0.0% (1.1ms) | Samples: 1

**Called by:**
- `transaction` (1)

### `Hash`
`[native code]` | Self: 0.0% (1.0ms) | Total: 0.0% (1.0ms) | Samples: 1

**Called by:**
- `Hash` (1)

### `[Symbol.match]`
`[native code]` | Self: 0.0% (1.0ms) | Total: 0.0% (1.0ms) | Samples: 1

**Called by:**
- `match` (1)

### `(anonymous)`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:288` | Self: 0.0% (1.0ms) | Total: 0.0% (1.0ms) | Samples: 1

**Called by:**
- `map` (1)

### `internal:streams/destroy`
`internal:streams/destroy:16` | Self: 0.0% (957us) | Total: 0.0% (957us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `(anonymous)`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:290` | Self: 0.0% (877us) | Total: 0.6% (18.8ms) | Samples: 1

**Called by:**
- `map` (3)

**Calls:**
- `filter` (2)

### `machineTelemetryPayload`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:112` | Self: 0.0% (0us) | Total: 0.2% (7.3ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `test` (1)

### `async jsonFetch`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:342` | Self: 0.0% (0us) | Total: 0.0% (1.3ms) | Samples: 0

**Called by:**
- `async embed` (1)

**Calls:**
- `async jsonFetch` (1)

### `lexicalCandidates`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:283` | Self: 0.0% (0us) | Total: 22.6% (619.0ms) | Samples: 0

**Called by:**
- `async querySemanticMemory` (31)

**Calls:**
- `map` (31)

### `async lexicalCorpus`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:187` | Self: 0.0% (0us) | Total: 0.8% (22.1ms) | Samples: 0

**Called by:**
- `async lexicalCorpus` (4)

**Calls:**
- `loadLexicalMirror` (3)
- `loadLexicalMirror` (1)

### `async (anonymous)`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:578` | Self: 0.0% (0us) | Total: 0.1% (3.5ms) | Samples: 0

**Called by:**
- `async (anonymous)` (3)

**Calls:**
- `async embed` (2)
- `async embed` (1)

### `internal:streams/duplex`
`internal:streams/duplex:2` | Self: 0.0% (0us) | Total: 2.6% (71.4ms) | Samples: 0

**Called by:**
- `anonymous` (8)

**Calls:**
- `anonymous` (8)

### `(anonymous)`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:137` | Self: 0.0% (0us) | Total: 0.0% (1.2ms) | Samples: 0

**Called by:**
- `map` (1)

**Calls:**
- `tokens` (1)

### `(anonymous)`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:149` | Self: 0.0% (0us) | Total: 0.2% (7.3ms) | Samples: 0

**Called by:**
- `map` (1)

**Calls:**
- `machineTelemetryPayload` (1)

### `internal:streams/readable`
`internal:streams/readable:2` | Self: 0.0% (0us) | Total: 0.1% (5.2ms) | Samples: 0

**Called by:**
- `anonymous` (4)

**Calls:**
- `anonymous` (4)

### `async benchmarkQueue`
`C:\AtomEons\Orange5\scripts\bun-runtime-benchmark.mjs:77` | Self: 0.0% (0us) | Total: 2.3% (64.9ms) | Samples: 0

**Calls:**
- `enqueue` (2)
- `enqueue` (2)
- `get` (1)
- `enqueue` (1)
- `enqueue` (1)

### `createHash`
`node:crypto:201` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `sha256` (1)

**Calls:**
- `Hash` (1)

### `(anonymous)`
`C:\AtomEons\Orange5\03-BACKEND\learning-queue.mjs:14` | Self: 0.0% (0us) | Total: 1.1% (30.7ms) | Samples: 0

**Called by:**
- `map` (2)

**Calls:**
- `stableJson` (2)

### `Database`
`bun:sqlite:260` | Self: 0.0% (0us) | Total: 0.0% (1.7ms) | Samples: 0

**Called by:**
- `Database` (2)

**Calls:**
- `open` (2)

### `async querySemanticMemory`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:589` | Self: 0.0% (0us) | Total: 8.0% (219.5ms) | Samples: 0

**Called by:**
- `async querySemanticMemory` (14)

**Calls:**
- `async lexicalCorpus` (14)

### `(module)`
`C:\AtomEons\Orange5\scripts\bun-runtime-benchmark.mjs:27` | Self: 0.0% (0us) | Total: 17.0% (467.4ms) | Samples: 0

**Calls:**
- `async benchmarkQueue` (1)

### `node:fs`
`node:fs:2` | Self: 0.0% (0us) | Total: 0.4% (11.6ms) | Samples: 0

**Calls:**
- `anonymous` (1)

### `async querySemanticMemory`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:593` | Self: 0.0% (0us) | Total: 3.2% (88.2ms) | Samples: 0

**Calls:**
- `rerankHits` (9)
- `sort` (1)
- `filter` (1)

### `LearningQueueStore`
`C:\AtomEons\Orange5\03-BACKEND\learning-queue.mjs:64` | Self: 0.0% (0us) | Total: 1.2% (34.0ms) | Samples: 0

**Called by:**
- `async benchmarkQueue` (3)

**Calls:**
- `Database` (3)

### `async (anonymous)`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:576` | Self: 0.0% (0us) | Total: 0.1% (3.5ms) | Samples: 0

**Called by:**
- `async querySemanticMemory` (3)

**Calls:**
- `async (anonymous)` (3)

### `(module)`
`C:\AtomEons\Orange5\scripts\bun-runtime-benchmark.mjs:33` | Self: 0.0% (0us) | Total: 0.0% (1.3ms) | Samples: 0

**Calls:**
- `every` (1)

### `complete`
`C:\AtomEons\Orange5\03-BACKEND\learning-queue.mjs:178` | Self: 0.0% (0us) | Total: 2.1% (58.1ms) | Samples: 0

**Called by:**
- `async benchmarkQueue` (4)

**Calls:**
- `#run` (3)
- `sha256` (1)

### `#run`
`bun:sqlite:185` | Self: 0.0% (0us) | Total: 2.5% (69.6ms) | Samples: 0

**Called by:**
- `complete` (3)
- `enqueue` (2)

**Calls:**
- `run` (5)

### `nextTick`
`[native code]` | Self: 0.0% (0us) | Total: 0.5% (14.1ms) | Samples: 0

**Called by:**
- `construct` (1)

**Calls:**
- `setup` (1)

### `map`
`[native code]` | Self: 0.0% (0us) | Total: 37.1% (1.01s) | Samples: 0

**Called by:**
- `lexicalCandidates` (31)
- `tokens` (15)
- `rerankHits` (9)
- `lexicalCandidates` (4)
- `async lexicalCorpus` (3)
- `lexicalCandidates` (2)
- `stableJson` (2)

**Calls:**
- `(anonymous)` (27)
- `(anonymous)` (6)
- `normalizeToken` (5)
- `normalizeToken` (4)
- `normalizeToken` (3)
- `(anonymous)` (3)
- `(anonymous)` (3)
- `(anonymous)` (3)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `normalizeToken` (2)
- `normalizeToken` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)

### `(anonymous)`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:202` | Self: 0.0% (0us) | Total: 2.5% (70.0ms) | Samples: 0

**Called by:**
- `map` (3)

**Calls:**
- `pointId` (2)
- `recordPayload` (1)

### `async benchmarkQueue`
`C:\AtomEons\Orange5\scripts\bun-runtime-benchmark.mjs:66` | Self: 0.0% (0us) | Total: 17.0% (467.4ms) | Samples: 0

**Called by:**
- `(module)` (1)

**Calls:**
- `async benchmarkQueue` (1)

### `Hash`
`node:crypto:178` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `createHash` (1)

**Calls:**
- `Hash` (1)

### `enqueue`
`C:\AtomEons\Orange5\03-BACKEND\learning-queue.mjs:152` | Self: 0.0% (0us) | Total: 0.1% (2.8ms) | Samples: 0

**Called by:**
- `async benchmarkQueue` (1)

**Calls:**
- `get` (1)

### `leaseNext`
`C:\AtomEons\Orange5\03-BACKEND\learning-queue.mjs:167` | Self: 0.0% (0us) | Total: 0.0% (1.1ms) | Samples: 0

**Called by:**
- `async benchmarkQueue` (1)

**Calls:**
- `transaction` (1)

### `async benchmarkQueue`
`C:\AtomEons\Orange5\scripts\bun-runtime-benchmark.mjs:89` | Self: 0.0% (0us) | Total: 16.1% (443.6ms) | Samples: 0

**Calls:**
- `close` (48)

### `(anonymous)`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:283` | Self: 0.0% (0us) | Total: 21.8% (599.2ms) | Samples: 0

**Called by:**
- `map` (27)

**Calls:**
- `tokens` (26)
- `tokens` (1)

### `(anonymous)`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:292` | Self: 0.0% (0us) | Total: 0.5% (14.6ms) | Samples: 0

**Called by:**
- `map` (2)

**Calls:**
- `reduce` (2)

### `readLaneRecords`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\flux\reader.mjs:126` | Self: 0.0% (0us) | Total: 2.9% (80.1ms) | Samples: 0

**Called by:**
- `readFlux` (3)

**Calls:**
- `readFileSync` (3)

### `async benchmarkQueue`
`C:\AtomEons\Orange5\scripts\bun-runtime-benchmark.mjs:72` | Self: 0.0% (0us) | Total: 6.9% (189.2ms) | Samples: 0

**Calls:**
- `LearningQueueStore` (12)
- `LearningQueueStore` (3)
- `LearningQueueStore` (3)
- `LearningQueueStore` (3)

### `internal:streams/transform`
`internal:streams/transform:2` | Self: 0.0% (0us) | Total: 2.6% (71.4ms) | Samples: 0

**Called by:**
- `anonymous` (8)

**Calls:**
- `anonymous` (8)

### `complete`
`C:\AtomEons\Orange5\03-BACKEND\learning-queue.mjs:176` | Self: 0.0% (0us) | Total: 0.4% (11.3ms) | Samples: 0

**Called by:**
- `async benchmarkQueue` (1)

**Calls:**
- `stableJson` (1)

### `node:crypto`
`node:crypto:2` | Self: 0.0% (0us) | Total: 2.6% (71.4ms) | Samples: 0

**Calls:**
- `anonymous` (8)

### `LearningQueueStore`
`C:\AtomEons\Orange5\03-BACKEND\learning-queue.mjs:69` | Self: 0.0% (0us) | Total: 0.5% (16.1ms) | Samples: 0

**Called by:**
- `async benchmarkQueue` (3)

**Calls:**
- `get` (3)

### `(anonymous)`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:142` | Self: 0.0% (0us) | Total: 0.5% (15.5ms) | Samples: 0

**Called by:**
- `map` (1)

**Calls:**
- `lowInformationPayload` (1)

### `sha256`
`C:\AtomEons\Orange5\03-BACKEND\learning-queue.mjs:20` | Self: 0.0% (0us) | Total: 0.6% (18.7ms) | Samples: 0

**Called by:**
- `complete` (1)
- `enqueue` (1)

**Calls:**
- `update` (1)
- `createHash` (1)

### `initializeDatabase`
`C:\AtomEons\Orange5\03-BACKEND\learning-queue.mjs:44` | Self: 0.0% (0us) | Total: 3.5% (95.9ms) | Samples: 0

**Called by:**
- `LearningQueueStore` (12)

**Calls:**
- `run` (12)

### `lexicalCandidates`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:296` | Self: 0.0% (0us) | Total: 1.6% (44.5ms) | Samples: 0

**Called by:**
- `async querySemanticMemory` (4)

**Calls:**
- `map` (4)

### `lexicalCandidates`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:300` | Self: 0.0% (0us) | Total: 0.3% (8.8ms) | Samples: 0

**Called by:**
- `async querySemanticMemory` (2)

**Calls:**
- `sort` (2)

### `Writable`
`internal:streams/writable:196` | Self: 0.0% (0us) | Total: 0.5% (14.1ms) | Samples: 0

**Called by:**
- `WriteStream` (1)

**Calls:**
- `construct` (1)

### `async querySemanticMemory`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:587` | Self: 0.0% (0us) | Total: 8.3% (229.5ms) | Samples: 0

**Called by:**
- `async querySemanticMemory` (4)

**Calls:**
- `async (anonymous)` (3)
- `async (anonymous)` (1)

### `match`
`[native code]` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `tokens` (1)

**Calls:**
- `[Symbol.match]` (1)

### `enqueue`
`C:\AtomEons\Orange5\03-BACKEND\learning-queue.mjs:150` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `async benchmarkQueue` (1)

**Calls:**
- `sha256` (1)

### `async embed`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:366` | Self: 0.0% (0us) | Total: 0.0% (2.3ms) | Samples: 0

**Called by:**
- `async (anonymous)` (2)

**Calls:**
- `async embed` (2)

### `setup`
`[native code]` | Self: 0.0% (0us) | Total: 0.5% (14.1ms) | Samples: 0

**Called by:**
- `nextTick` (1)

**Calls:**
- `anonymous` (1)

### `enqueue`
`C:\AtomEons\Orange5\03-BACKEND\learning-queue.mjs:147` | Self: 0.0% (0us) | Total: 1.1% (30.7ms) | Samples: 0

**Called by:**
- `async benchmarkQueue` (2)

**Calls:**
- `stableJson` (2)

### `lexicalCandidates`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:299` | Self: 0.0% (0us) | Total: 0.5% (15.4ms) | Samples: 0

**Called by:**
- `async querySemanticMemory` (1)

**Calls:**
- `filter` (1)

### `transaction`
`bun:sqlite:376` | Self: 0.0% (0us) | Total: 0.0% (1.1ms) | Samples: 0

**Called by:**
- `leaseNext` (1)

**Calls:**
- `wrapTransaction` (1)

### `async lexicalCorpus`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:201` | Self: 0.0% (0us) | Total: 0.5% (15.0ms) | Samples: 0

**Called by:**
- `async lexicalCorpus` (1)

**Calls:**
- `filter` (1)

### `close`
`C:\AtomEons\Orange5\03-BACKEND\learning-queue.mjs:269` | Self: 0.0% (0us) | Total: 16.1% (443.6ms) | Samples: 0

**Called by:**
- `async benchmarkQueue` (48)

**Calls:**
- `close` (48)

### `lexicalCandidates`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:291` | Self: 0.0% (0us) | Total: 0.5% (14.6ms) | Samples: 0

**Called by:**
- `async querySemanticMemory` (2)

**Calls:**
- `map` (2)

### `(module)`
`C:\AtomEons\Orange5\scripts\bun-runtime-benchmark.mjs:32` | Self: 0.0% (0us) | Total: 1.1% (30.3ms) | Samples: 0

**Calls:**
- `hostname` (3)

### `WriteStream`
`internal:fs/streams:245` | Self: 0.0% (0us) | Total: 0.5% (14.1ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `Writable` (1)

### `usefulRecord`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:104` | Self: 0.0% (0us) | Total: 0.5% (15.0ms) | Samples: 0

**Called by:**
- `filter` (1)

**Calls:**
- `recordPayload` (1)

### `LearningQueueStore`
`C:\AtomEons\Orange5\03-BACKEND\learning-queue.mjs:71` | Self: 0.0% (0us) | Total: 1.5% (43.1ms) | Samples: 0

**Called by:**
- `async benchmarkQueue` (3)

**Calls:**
- `run` (3)

### `lowInformationPayload`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:90` | Self: 0.0% (0us) | Total: 0.5% (15.5ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `trim` (1)

### `node:events`
`node:events:9` | Self: 0.0% (0us) | Total: 1.9% (52.4ms) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `anonymous` (3)

### `internal:shared`
`internal:shared:2` | Self: 0.0% (0us) | Total: 0.0% (2.2ms) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `anonymous` (2)

### `async benchmarkQueue`
`C:\AtomEons\Orange5\scripts\bun-runtime-benchmark.mjs:80` | Self: 0.0% (0us) | Total: 2.7% (74.1ms) | Samples: 0

**Calls:**
- `complete` (4)
- `get` (1)
- `complete` (1)

### `async lexicalCorpus`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:195` | Self: 0.0% (0us) | Total: 0.5% (16.1ms) | Samples: 0

**Called by:**
- `async lexicalCorpus` (1)

**Calls:**
- `lexicalLedgerSignature` (1)

### `run`
`bun:sqlite:336` | Self: 0.0% (0us) | Total: 5.0% (139.0ms) | Samples: 0

**Called by:**
- `initializeDatabase` (12)
- `LearningQueueStore` (3)

**Calls:**
- `run` (15)

### `(anonymous)`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:126` | Self: 0.0% (0us) | Total: 1.7% (47.0ms) | Samples: 0

**Called by:**
- `map` (6)

**Calls:**
- `tokens` (5)
- `tokens` (1)

### `internal:streams/add-abort-signal`
`internal:streams/add-abort-signal:2` | Self: 0.0% (0us) | Total: 0.0% (1.1ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `anonymous` (1)

### `stableJson`
`C:\AtomEons\Orange5\03-BACKEND\learning-queue.mjs:14` | Self: 0.0% (0us) | Total: 1.5% (42.0ms) | Samples: 0

**Called by:**
- `enqueue` (2)
- `complete` (1)

**Calls:**
- `map` (2)
- `sort` (1)

### `construct`
`internal:streams/destroy:124` | Self: 0.0% (0us) | Total: 0.5% (14.1ms) | Samples: 0

**Called by:**
- `Writable` (1)

**Calls:**
- `nextTick` (1)

### `async lexicalCorpus`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:185` | Self: 0.0% (0us) | Total: 8.0% (219.5ms) | Samples: 0

**Called by:**
- `async querySemanticMemory` (14)

**Calls:**
- `async lexicalCorpus` (4)
- `async lexicalCorpus` (4)
- `async lexicalCorpus` (3)
- `async lexicalCorpus` (1)
- `async lexicalCorpus` (1)
- `async lexicalCorpus` (1)

### `readFlux`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\flux\reader.mjs:203` | Self: 0.0% (0us) | Total: 2.9% (80.1ms) | Samples: 0

**Called by:**
- `async lexicalCorpus` (3)

**Calls:**
- `readLaneRecords` (3)

### `bound join`
`[native code]` | Self: 0.0% (0us) | Total: 17.1% (469.4ms) | Samples: 0

**Called by:**
- `async lexicalCorpus` (1)
- `async benchmarkQueue` (1)

**Calls:**
- `join` (2)

### `async embed`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:367` | Self: 0.0% (0us) | Total: 0.0% (2.3ms) | Samples: 0

**Called by:**
- `async embed` (2)

**Calls:**
- `async jsonFetch` (1)
- `async jsonFetch` (1)

### `async benchmarkQueue`
`C:\AtomEons\Orange5\scripts\bun-runtime-benchmark.mjs:67` | Self: 0.0% (0us) | Total: 17.0% (467.4ms) | Samples: 0

**Called by:**
- `async benchmarkQueue` (1)

**Calls:**
- `bound join` (1)

### `(anonymous)`
`[native code]` | Self: 0.0% (0us) | Total: 0.5% (14.1ms) | Samples: 0

**Called by:**
- `(module)` (1)

**Calls:**
- `WriteStream` (1)

### `async querySemanticMemory`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:592` | Self: 0.0% (0us) | Total: 25.6% (702.5ms) | Samples: 0

**Calls:**
- `lexicalCandidates` (31)
- `lexicalCandidates` (4)
- `lexicalCandidates` (2)
- `lexicalCandidates` (2)
- `lexicalCandidates` (1)

### `async lexicalCorpus`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:200` | Self: 0.0% (0us) | Total: 3.4% (94.2ms) | Samples: 0

**Called by:**
- `async lexicalCorpus` (4)

**Calls:**
- `readFlux` (3)
- `readFlux` (1)

### `async benchmarkQueue`
`C:\AtomEons\Orange5\scripts\bun-runtime-benchmark.mjs:78` | Self: 0.0% (0us) | Total: 4.7% (129.3ms) | Samples: 0

**Calls:**
- `transaction` (26)
- `leaseNext` (1)

### `enqueue`
`C:\AtomEons\Orange5\03-BACKEND\learning-queue.mjs:157` | Self: 0.0% (0us) | Total: 1.0% (29.2ms) | Samples: 0

**Called by:**
- `async benchmarkQueue` (2)

**Calls:**
- `#run` (2)

### `rerankHits`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:124` | Self: 0.0% (0us) | Total: 2.6% (71.2ms) | Samples: 0

**Called by:**
- `async querySemanticMemory` (9)

**Calls:**
- `map` (9)

### `tokens`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:86` | Self: 0.0% (0us) | Total: 20.5% (561.7ms) | Samples: 0

**Called by:**
- `(anonymous)` (26)
- `(anonymous)` (5)

**Calls:**
- `map` (15)
- `filter` (8)
- `Set` (8)

### `get`
`C:\AtomEons\Orange5\03-BACKEND\learning-queue.mjs:194` | Self: 0.0% (0us) | Total: 4.6% (126.5ms) | Samples: 0

**Called by:**
- `transaction` (25)
- `async benchmarkQueue` (1)

**Calls:**
- `(anonymous)` (25)
- `get` (1)

### `(anonymous)`
`C:\AtomEons\Orange5\03-BACKEND\learning-queue.mjs:168` | Self: 0.0% (0us) | Total: 0.0% (2.7ms) | Samples: 0

**Called by:**
- `transaction` (1)

**Calls:**
- `get` (1)

### `LearningQueueStore`
`C:\AtomEons\Orange5\03-BACKEND\learning-queue.mjs:65` | Self: 0.0% (0us) | Total: 3.5% (95.9ms) | Samples: 0

**Called by:**
- `async benchmarkQueue` (12)

**Calls:**
- `initializeDatabase` (12)

### `(module)`
`C:\AtomEons\Orange5\scripts\bun-runtime-benchmark.mjs:52` | Self: 0.0% (0us) | Total: 0.5% (15.4ms) | Samples: 0

**Calls:**
- `(anonymous)` (1)
- `writeFast` (1)

### `internal:validators`
`internal:validators:2` | Self: 0.0% (0us) | Total: 1.9% (52.4ms) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `anonymous` (3)

### `async querySemanticMemory`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:565` | Self: 0.0% (0us) | Total: 16.3% (449.1ms) | Samples: 0

**Called by:**
- `async benchmarkSemantic` (18)

**Calls:**
- `async querySemanticMemory` (14)
- `async querySemanticMemory` (4)

### `async lexicalCorpus`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:202` | Self: 0.0% (0us) | Total: 2.5% (70.0ms) | Samples: 0

**Called by:**
- `async lexicalCorpus` (3)

**Calls:**
- `map` (3)

### `internal:streams/legacy`
`internal:streams/legacy:2` | Self: 0.0% (0us) | Total: 1.9% (52.4ms) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `anonymous` (3)

### `transaction`
`bun:sqlite:416` | Self: 0.0% (0us) | Total: 4.6% (128.2ms) | Samples: 0

**Called by:**
- `async benchmarkQueue` (26)

**Calls:**
- `get` (25)
- `(anonymous)` (1)

### `async lexicalCorpus`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:186` | Self: 0.0% (0us) | Total: 0.0% (1.9ms) | Samples: 0

**Called by:**
- `async lexicalCorpus` (1)

**Calls:**
- `bound join` (1)

### `loadLexicalMirror`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:218` | Self: 0.0% (0us) | Total: 0.4% (11.1ms) | Samples: 0

**Called by:**
- `async lexicalCorpus` (1)

**Calls:**
- `stringify` (1)

### `get`
`C:\AtomEons\Orange5\03-BACKEND\learning-queue.mjs:200` | Self: 0.0% (0us) | Total: 0.1% (4.6ms) | Samples: 0

**Called by:**
- `async benchmarkQueue` (1)

**Calls:**
- `parse` (1)

### `async benchmarkSemantic`
`C:\AtomEons\Orange5\scripts\bun-runtime-benchmark.mjs:110` | Self: 0.0% (0us) | Total: 16.3% (449.1ms) | Samples: 0

**Calls:**
- `async querySemanticMemory` (18)

### `internal:streams/lazy_transform`
`internal:streams/lazy_transform:2` | Self: 0.0% (0us) | Total: 2.6% (71.4ms) | Samples: 0

**Called by:**
- `anonymous` (8)

**Calls:**
- `anonymous` (8)

### `loadLexicalMirror`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:216` | Self: 0.0% (0us) | Total: 0.3% (10.9ms) | Samples: 0

**Called by:**
- `async lexicalCorpus` (3)

**Calls:**
- `readFileSync` (3)

## Files

| Self% | Self | File |
|------:|-----:|------|
| 68.1% | 1.86s | `[native code]` |
| 25.4% | 696.7ms | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs` |
| 4.5% | 125.5ms | `C:\AtomEons\Orange5\bin\sqlite-shim.mjs` |
| 1.1% | 30.7ms | `C:\AtomEons\Orange5\03-BACKEND\learning-queue.mjs` |
| 0.5% | 14.1ms | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\flux\reader.mjs` |
| 0.0% | 1.3ms | `internal:fs/streams` |
| 0.0% | 1.1ms | `internal:streams/utils` |
| 0.0% | 1.1ms | `bun:sqlite` |
| 0.0% | 957us | `internal:streams/destroy` |
