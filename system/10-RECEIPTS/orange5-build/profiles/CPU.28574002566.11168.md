# CPU Profile

| Duration | Samples | Interval | Functions |
|----------|---------|----------|----------|
| 1.66s | 171 | 1.0ms | 151 |

**Top 10:** `statSync` 13.0%, `fetch` 10.9%, `payloadTokens` 7.1%, `get` 6.7%, `readFileSync` 5.5%, `mkdirSync` 4.7%, `run` 4.0%, `async benchmarkQueue` 3.4%, `Set` 3.1%, `anonymous` 2.9%

## Hot Functions (Self Time)

| Self% | Self | Total% | Total | Function | Location |
|------:|-----:|-------:|------:|----------|----------|
| 13.0% | 216.7ms | 16.2% | 270.3ms | `statSync` | `[native code]` |
| 10.9% | 182.9ms | 10.9% | 182.9ms | `fetch` | `[native code]` |
| 7.1% | 118.7ms | 7.1% | 118.7ms | `payloadTokens` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:103` |
| 6.7% | 112.2ms | 6.7% | 112.2ms | `get` | `[native code]` |
| 5.5% | 92.4ms | 11.1% | 184.9ms | `readFileSync` | `[native code]` |
| 4.7% | 78.9ms | 9.4% | 157.9ms | `mkdirSync` | `[native code]` |
| 4.0% | 68.0ms | 4.0% | 68.0ms | `run` | `[native code]` |
| 3.4% | 57.6ms | 3.4% | 57.6ms | `async benchmarkQueue` | `C:\AtomEons\Orange5\scripts\bun-runtime-benchmark.mjs` |
| 3.1% | 53.0ms | 3.1% | 53.0ms | `Set` | `[native code]` |
| 2.9% | 49.9ms | 10.8% | 180.4ms | `anonymous` | `[native code]` |
| 2.3% | 39.5ms | 2.3% | 39.5ms | `[Symbol.match]` | `[native code]` |
| 2.2% | 38.0ms | 2.2% | 38.0ms | `/\/+$/` | `[native code]` |
| 2.0% | 33.3ms | 2.0% | 33.3ms | `resolve` | `[native code]` |
| 1.9% | 32.8ms | 1.9% | 32.8ms | `close` | `[native code]` |
| 1.9% | 31.8ms | 1.9% | 31.8ms | `(anonymous)` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:87` |
| 1.8% | 30.8ms | 1.8% | 30.8ms | `join` | `[native code]` |
| 1.8% | 30.7ms | 59.1% | 985.9ms | `map` | `[native code]` |
| 1.7% | 28.8ms | 1.7% | 28.8ms | `hostname` | `[native code]` |
| 1.6% | 27.1ms | 1.6% | 27.1ms | `normalizeToken` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:77` |
| 1.6% | 26.6ms | 3.2% | 53.3ms | `(anonymous)` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:302` |
| 1.4% | 23.4ms | 2.8% | 46.8ms | `readdirSync` | `[native code]` |
| 1.3% | 22.1ms | 1.3% | 22.1ms | `toLowerCase` | `[native code]` |
| 1.2% | 20.5ms | 1.6% | 28.1ms | `(anonymous)` | `C:\AtomEons\Orange5\bin\sqlite-shim.mjs:100` |
| 1.2% | 20.4ms | 1.2% | 20.4ms | `machineTelemetryPayload` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs` |
| 1.0% | 17.9ms | 1.0% | 17.9ms | `update` | `[native code]` |
| 1.0% | 17.3ms | 1.0% | 17.3ms | `has` | `[native code]` |
| 1.0% | 17.1ms | 6.5% | 109.1ms | `filter` | `[native code]` |
| 1.0% | 16.8ms | 1.0% | 16.8ms | `normalizeToken` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:78` |
| 0.9% | 16.2ms | 0.9% | 16.2ms | `normalizeToken` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:75` |
| 0.9% | 15.5ms | 3.0% | 51.3ms | `transaction` | `bun:sqlite:417` |
| 0.9% | 15.3ms | 19.1% | 319.2ms | `(anonymous)` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:300` |
| 0.8% | 14.0ms | 0.8% | 14.0ms | `copyObject` | `internal:fs/streams:32` |
| 0.6% | 11.4ms | 0.6% | 11.4ms | `parse` | `[native code]` |
| 0.5% | 8.4ms | 2.8% | 47.9ms | `tokens` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:86` |
| 0.4% | 7.6ms | 0.4% | 7.6ms | `isPlainBindObject` | `C:\AtomEons\Orange5\bin\sqlite-shim.mjs` |
| 0.4% | 6.7ms | 0.4% | 6.7ms | `createChangesObject` | `bun:sqlite:9` |
| 0.3% | 6.5ms | 0.3% | 6.5ms | `async benchmarkSemantic` | `C:\AtomEons\Orange5\scripts\bun-runtime-benchmark.mjs:112` |
| 0.3% | 6.4ms | 0.3% | 6.4ms | `slice` | `[native code]` |
| 0.3% | 6.0ms | 0.3% | 6.0ms | `setName` | `node:fs` |
| 0.3% | 6.0ms | 0.3% | 6.0ms | `payloadTokens` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:101` |
| 0.3% | 5.6ms | 0.3% | 5.6ms | `(anonymous)` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:180` |
| 0.2% | 4.4ms | 0.2% | 4.4ms | `(anonymous)` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:199` |
| 0.2% | 3.9ms | 0.2% | 3.9ms | `lowInformationPayload` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:119` |
| 0.1% | 3.3ms | 0.1% | 3.3ms | `/\b(?:benchmark\|performance\|latency\|p50\|p95\|throughput\|timings?\|health metrics?\|routes per second\|proof\|receipt\|current status\|fully operational\|green)\b/i` | `[native code]` |
| 0.1% | 3.0ms | 0.1% | 3.0ms | `(anonymous)` | `C:\AtomEons\Orange5\03-BACKEND\learning-queue.mjs:14` |
| 0.1% | 2.9ms | 0.1% | 2.9ms | `normalizeToken` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:81` |
| 0.1% | 2.3ms | 2.7% | 46.3ms | `reduce` | `[native code]` |
| 0.1% | 2.0ms | 0.1% | 2.0ms | `Database` | `bun:sqlite` |
| 0.1% | 1.9ms | 1.2% | 21.3ms | `readLaneRecords` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\flux\reader.mjs:126` |
| 0.0% | 1.2ms | 0.0% | 1.2ms | `(anonymous)` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:308` |
| 0.0% | 1.2ms | 0.0% | 1.2ms | `(anonymous)` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:152` |
| 0.0% | 1.1ms | 0.0% | 1.1ms | `payloadTokens` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:102` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `@lazy` | `[native code]` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `toFixed` | `[native code]` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `(anonymous)` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:174` |
| 0.0% | 1.0ms | 0.2% | 4.3ms | `test` | `[native code]` |
| 0.0% | 892us | 0.0% | 892us | `pointId` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:25` |

## Call Tree (Total Time)

| Total% | Total | Self% | Self | Function | Location |
|-------:|------:|------:|-----:|----------|----------|
| 59.1% | 985.9ms | 1.8% | 30.7ms | `map` | `[native code]` |
| 22.0% | 366.9ms | 0.0% | 0us | `async querySemanticMemory` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:602` |
| 20.6% | 343.7ms | 0.0% | 0us | `(module)` | `C:\AtomEons\Orange5\scripts\bun-runtime-benchmark.mjs:52` |
| 19.1% | 319.2ms | 0.9% | 15.3ms | `(anonymous)` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:300` |
| 19.1% | 319.2ms | 0.0% | 0us | `lexicalCandidates` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:300` |
| 16.9% | 281.8ms | 0.0% | 0us | `writeChainedJsonReceipt` | `C:\AtomEons\Orange5\10-RECEIPTS\tools\json-receipt-chain.mjs:53` |
| 16.2% | 270.3ms | 13.0% | 216.7ms | `statSync` | `[native code]` |
| 13.9% | 232.2ms | 0.0% | 0us | `latestReceipt` | `C:\AtomEons\Orange5\10-RECEIPTS\tools\json-receipt-chain.mjs:42` |
| 13.0% | 216.7ms | 0.0% | 0us | `(anonymous)` | `C:\AtomEons\Orange5\10-RECEIPTS\tools\json-receipt-chain.mjs:44` |
| 11.1% | 184.9ms | 5.5% | 92.4ms | `readFileSync` | `[native code]` |
| 10.9% | 182.9ms | 0.0% | 0us | `(module)` | `C:\AtomEons\Orange5\scripts\bun-runtime-benchmark.mjs:26` |
| 10.9% | 182.9ms | 0.0% | 0us | `async timedFetch` | `C:\AtomEons\Orange5\scripts\bun-runtime-benchmark.mjs:59` |
| 10.9% | 182.9ms | 0.0% | 0us | `async timedFetch` | `C:\AtomEons\Orange5\scripts\bun-runtime-benchmark.mjs:56` |
| 10.9% | 182.9ms | 10.9% | 182.9ms | `fetch` | `[native code]` |
| 10.8% | 180.4ms | 2.9% | 49.9ms | `anonymous` | `[native code]` |
| 10.5% | 175.9ms | 0.0% | 0us | `tokens` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:87` |
| 9.4% | 157.9ms | 4.7% | 78.9ms | `mkdirSync` | `[native code]` |
| 7.6% | 127.1ms | 0.0% | 0us | `payloadTokens` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:106` |
| 7.2% | 120.1ms | 0.0% | 0us | `async benchmarkQueue` | `C:\AtomEons\Orange5\scripts\bun-runtime-benchmark.mjs:73` |
| 7.1% | 118.7ms | 7.1% | 118.7ms | `payloadTokens` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:103` |
| 7.0% | 116.7ms | 0.0% | 0us | `async querySemanticMemory` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:575` |
| 7.0% | 116.7ms | 0.0% | 0us | `async querySemanticMemory` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:599` |
| 7.0% | 116.7ms | 0.0% | 0us | `async lexicalCorpus` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:202` |
| 7.0% | 116.7ms | 0.0% | 0us | `async benchmarkSemantic` | `C:\AtomEons\Orange5\scripts\bun-runtime-benchmark.mjs:114` |
| 6.8% | 113.5ms | 0.0% | 0us | `async benchmarkQueue` | `C:\AtomEons\Orange5\scripts\bun-runtime-benchmark.mjs:79` |
| 6.7% | 112.2ms | 6.7% | 112.2ms | `get` | `[native code]` |
| 6.5% | 109.1ms | 1.0% | 17.1ms | `filter` | `[native code]` |
| 6.2% | 103.7ms | 0.0% | 0us | `async querySemanticMemory` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:603` |
| 6.1% | 102.5ms | 0.0% | 0us | `payloadTokens` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:105` |
| 5.9% | 99.3ms | 0.0% | 0us | `rerankHits` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:148` |
| 4.7% | 78.9ms | 0.0% | 0us | `LearningQueueStore` | `C:\AtomEons\Orange5\03-BACKEND\learning-queue.mjs:86` |
| 4.0% | 68.0ms | 4.0% | 68.0ms | `run` | `[native code]` |
| 3.7% | 63.2ms | 0.0% | 0us | `async benchmarkQueue` | `C:\AtomEons\Orange5\scripts\bun-runtime-benchmark.mjs:81` |
| 3.7% | 63.2ms | 0.0% | 0us | `complete` | `C:\AtomEons\Orange5\03-BACKEND\learning-queue.mjs:206` |
| 3.7% | 62.1ms | 0.0% | 0us | `transaction` | `bun:sqlite:416` |
| 3.7% | 61.8ms | 0.0% | 0us | `writeChainedJsonReceipt` | `C:\AtomEons\Orange5\10-RECEIPTS\tools\json-receipt-chain.mjs:63` |
| 3.6% | 61.3ms | 0.0% | 0us | `(anonymous)` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:150` |
| 3.5% | 59.5ms | 0.0% | 0us | `(anonymous)` | `C:\AtomEons\Orange5\03-BACKEND\learning-queue.mjs:199` |
| 3.4% | 57.6ms | 3.4% | 57.6ms | `async benchmarkQueue` | `C:\AtomEons\Orange5\scripts\bun-runtime-benchmark.mjs` |
| 3.4% | 57.6ms | 0.0% | 0us | `async benchmarkQueue` | `C:\AtomEons\Orange5\scripts\bun-runtime-benchmark.mjs:67` |
| 3.4% | 57.6ms | 0.0% | 0us | `(module)` | `C:\AtomEons\Orange5\scripts\bun-runtime-benchmark.mjs:29` |
| 3.2% | 53.3ms | 1.6% | 26.6ms | `(anonymous)` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:302` |
| 3.1% | 53.0ms | 3.1% | 53.0ms | `Set` | `[native code]` |
| 3.0% | 51.3ms | 0.9% | 15.5ms | `transaction` | `bun:sqlite:417` |
| 2.9% | 49.6ms | 0.0% | 0us | `latestReceipt` | `C:\AtomEons\Orange5\10-RECEIPTS\tools\json-receipt-chain.mjs:46` |
| 2.8% | 47.9ms | 0.5% | 8.4ms | `tokens` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:86` |
| 2.8% | 46.8ms | 1.4% | 23.4ms | `readdirSync` | `[native code]` |
| 2.7% | 46.3ms | 0.1% | 2.3ms | `reduce` | `[native code]` |
| 2.6% | 44.7ms | 0.0% | 0us | `async lexicalCorpus` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:217` |
| 2.6% | 44.7ms | 0.0% | 0us | `readFlux` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\flux\reader.mjs:203` |
| 2.3% | 39.5ms | 2.3% | 39.5ms | `[Symbol.match]` | `[native code]` |
| 2.3% | 39.5ms | 0.0% | 0us | `match` | `[native code]` |
| 2.3% | 39.0ms | 0.0% | 0us | `run` | `bun:sqlite:336` |
| 2.3% | 38.8ms | 0.0% | 0us | `async lexicalCorpus` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:204` |
| 2.2% | 38.0ms | 0.0% | 0us | `(module)` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:9` |
| 2.2% | 38.0ms | 2.2% | 38.0ms | `/\/+$/` | `[native code]` |
| 2.2% | 38.0ms | 0.0% | 0us | `replace` | `[native code]` |
| 2.2% | 37.0ms | 0.0% | 0us | `(anonymous)` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:307` |
| 2.0% | 33.3ms | 2.0% | 33.3ms | `resolve` | `[native code]` |
| 2.0% | 33.3ms | 0.0% | 0us | `(anonymous)` | `C:\AtomEons\Orange5\10-RECEIPTS\tools\json-receipt-chain.mjs:46` |
| 1.9% | 32.8ms | 0.0% | 0us | `async benchmarkQueue` | `C:\AtomEons\Orange5\scripts\bun-runtime-benchmark.mjs:90` |
| 1.9% | 32.8ms | 1.9% | 32.8ms | `close` | `[native code]` |
| 1.9% | 32.8ms | 0.0% | 0us | `close` | `C:\AtomEons\Orange5\03-BACKEND\learning-queue.mjs:277` |
| 1.9% | 31.8ms | 1.9% | 31.8ms | `(anonymous)` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:87` |
| 1.8% | 30.8ms | 1.8% | 30.8ms | `join` | `[native code]` |
| 1.7% | 28.9ms | 0.0% | 0us | `#runNoArgs` | `bun:sqlite:138` |
| 1.7% | 28.8ms | 0.0% | 0us | `(module)` | `C:\AtomEons\Orange5\scripts\bun-runtime-benchmark.mjs:34` |
| 1.7% | 28.8ms | 1.7% | 28.8ms | `hostname` | `[native code]` |
| 1.6% | 28.1ms | 1.2% | 20.5ms | `(anonymous)` | `C:\AtomEons\Orange5\bin\sqlite-shim.mjs:100` |
| 1.6% | 27.1ms | 1.6% | 27.1ms | `normalizeToken` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:77` |
| 1.6% | 26.6ms | 0.0% | 0us | `lexicalCandidates` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:301` |
| 1.5% | 25.7ms | 0.0% | 0us | `async lexicalCorpus` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:218` |
| 1.5% | 25.7ms | 0.0% | 0us | `usefulRecord` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:129` |
| 1.5% | 25.6ms | 0.0% | 0us | `node:fs` | `node:fs:2` |
| 1.5% | 25.4ms | 0.0% | 0us | `LearningQueueStore` | `C:\AtomEons\Orange5\03-BACKEND\learning-queue.mjs:94` |
| 1.5% | 25.3ms | 0.0% | 0us | `internal:streams/add-abort-signal` | `internal:streams/add-abort-signal:2` |
| 1.5% | 25.3ms | 0.0% | 0us | `node:crypto` | `node:crypto:2` |
| 1.5% | 25.3ms | 0.0% | 0us | `internal:streams/transform` | `internal:streams/transform:2` |
| 1.5% | 25.3ms | 0.0% | 0us | `internal:streams/duplex` | `internal:streams/duplex:2` |
| 1.5% | 25.3ms | 0.0% | 0us | `internal:streams/lazy_transform` | `internal:streams/lazy_transform:2` |
| 1.5% | 25.3ms | 0.0% | 0us | `internal:streams/readable` | `internal:streams/readable:2` |
| 1.4% | 23.4ms | 0.0% | 0us | `readLaneRecords` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\flux\reader.mjs:102` |
| 1.3% | 22.1ms | 1.3% | 22.1ms | `toLowerCase` | `[native code]` |
| 1.2% | 21.4ms | 0.0% | 0us | `(anonymous)` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:166` |
| 1.2% | 21.3ms | 0.1% | 1.9ms | `readLaneRecords` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\flux\reader.mjs:126` |
| 1.2% | 21.2ms | 0.0% | 0us | `lowInformationPayload` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:114` |
| 1.2% | 20.9ms | 0.0% | 0us | `lexicalCandidates` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:306` |
| 1.2% | 20.8ms | 0.0% | 0us | `loadLexicalMirror` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:233` |
| 1.2% | 20.4ms | 1.2% | 20.4ms | `machineTelemetryPayload` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs` |
| 1.1% | 19.8ms | 0.0% | 0us | `async benchmarkQueue` | `C:\AtomEons\Orange5\scripts\bun-runtime-benchmark.mjs:78` |
| 1.0% | 17.9ms | 0.0% | 0us | `loadLexicalMirror` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:235` |
| 1.0% | 17.9ms | 0.0% | 0us | `sha256` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:21` |
| 1.0% | 17.9ms | 1.0% | 17.9ms | `update` | `[native code]` |
| 1.0% | 17.3ms | 1.0% | 17.3ms | `has` | `[native code]` |
| 1.0% | 16.8ms | 1.0% | 16.8ms | `normalizeToken` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:78` |
| 0.9% | 16.2ms | 0.9% | 16.2ms | `normalizeToken` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:75` |
| 0.9% | 15.4ms | 0.0% | 0us | `(anonymous)` | `C:\AtomEons\Orange5\10-RECEIPTS\tools\json-receipt-chain.mjs:43` |
| 0.8% | 14.0ms | 0.8% | 14.0ms | `copyObject` | `internal:fs/streams:32` |
| 0.8% | 14.0ms | 0.0% | 0us | `(anonymous)` | `[native code]` |
| 0.8% | 14.0ms | 0.0% | 0us | `WriteStream` | `internal:fs/streams:200` |
| 0.8% | 14.0ms | 0.0% | 0us | `(module)` | `C:\AtomEons\Orange5\scripts\bun-runtime-benchmark.mjs:53` |
| 0.8% | 13.5ms | 0.0% | 0us | `initializeDatabase` | `C:\AtomEons\Orange5\03-BACKEND\learning-queue.mjs:67` |
| 0.8% | 13.5ms | 0.0% | 0us | `LearningQueueStore` | `C:\AtomEons\Orange5\03-BACKEND\learning-queue.mjs:88` |
| 0.6% | 11.4ms | 0.6% | 11.4ms | `parse` | `[native code]` |
| 0.5% | 9.6ms | 0.0% | 0us | `payloadTokens` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:107` |
| 0.5% | 8.7ms | 0.0% | 0us | `enqueue` | `C:\AtomEons\Orange5\03-BACKEND\learning-queue.mjs:179` |
| 0.4% | 7.6ms | 0.4% | 7.6ms | `isPlainBindObject` | `C:\AtomEons\Orange5\bin\sqlite-shim.mjs` |
| 0.4% | 7.6ms | 0.0% | 0us | `remapBindArgs` | `C:\AtomEons\Orange5\bin\sqlite-shim.mjs:84` |
| 0.4% | 7.3ms | 0.0% | 0us | `(anonymous)` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:219` |
| 0.4% | 7.3ms | 0.0% | 0us | `async lexicalCorpus` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:219` |
| 0.4% | 6.7ms | 0.4% | 6.7ms | `createChangesObject` | `bun:sqlite:9` |
| 0.3% | 6.5ms | 0.0% | 0us | `(module)` | `C:\AtomEons\Orange5\scripts\bun-runtime-benchmark.mjs:30` |
| 0.3% | 6.5ms | 0.3% | 6.5ms | `async benchmarkSemantic` | `C:\AtomEons\Orange5\scripts\bun-runtime-benchmark.mjs:112` |
| 0.3% | 6.5ms | 0.0% | 0us | `async benchmarkSemantic` | `C:\AtomEons\Orange5\scripts\bun-runtime-benchmark.mjs:110` |
| 0.3% | 6.4ms | 0.0% | 0us | `recordPayload` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:56` |
| 0.3% | 6.4ms | 0.3% | 6.4ms | `slice` | `[native code]` |
| 0.3% | 6.2ms | 0.0% | 0us | `enqueue` | `C:\AtomEons\Orange5\03-BACKEND\learning-queue.mjs:184` |
| 0.3% | 6.0ms | 0.3% | 6.0ms | `setName` | `node:fs` |
| 0.3% | 6.0ms | 0.0% | 0us | `node:fs` | `node:fs:772` |
| 0.3% | 6.0ms | 0.3% | 6.0ms | `payloadTokens` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:101` |
| 0.3% | 5.6ms | 0.3% | 5.6ms | `(anonymous)` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:180` |
| 0.2% | 4.4ms | 0.0% | 0us | `sort` | `[native code]` |
| 0.2% | 4.4ms | 0.2% | 4.4ms | `(anonymous)` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:199` |
| 0.2% | 4.3ms | 0.0% | 1.0ms | `test` | `[native code]` |
| 0.2% | 4.2ms | 0.0% | 0us | `(anonymous)` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:159` |
| 0.2% | 3.9ms | 0.2% | 3.9ms | `lowInformationPayload` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:119` |
| 0.2% | 3.8ms | 0.0% | 0us | `bound join` | `[native code]` |
| 0.2% | 3.4ms | 0.0% | 0us | `node:fs/promises` | `node:fs/promises:2` |
| 0.1% | 3.3ms | 0.1% | 3.3ms | `/\b(?:benchmark\|performance\|latency\|p50\|p95\|throughput\|timings?\|health metrics?\|routes per second\|proof\|receipt\|current status\|fully operational\|green)\b/i` | `[native code]` |
| 0.1% | 3.3ms | 0.0% | 0us | `(anonymous)` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:167` |
| 0.1% | 3.0ms | 0.0% | 0us | `enqueue` | `C:\AtomEons\Orange5\03-BACKEND\learning-queue.mjs:174` |
| 0.1% | 3.0ms | 0.1% | 3.0ms | `(anonymous)` | `C:\AtomEons\Orange5\03-BACKEND\learning-queue.mjs:14` |
| 0.1% | 3.0ms | 0.0% | 0us | `stableJson` | `C:\AtomEons\Orange5\03-BACKEND\learning-queue.mjs:14` |
| 0.1% | 2.9ms | 0.1% | 2.9ms | `normalizeToken` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:81` |
| 0.1% | 2.8ms | 0.0% | 0us | `lowInformationPayload` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:115` |
| 0.1% | 2.6ms | 0.0% | 0us | `(anonymous)` | `C:\AtomEons\Orange5\03-BACKEND\learning-queue.mjs:197` |
| 0.1% | 2.0ms | 0.1% | 2.0ms | `Database` | `bun:sqlite` |
| 0.1% | 2.0ms | 0.0% | 0us | `LearningQueueStore` | `C:\AtomEons\Orange5\03-BACKEND\learning-queue.mjs:87` |
| 0.1% | 2.0ms | 0.0% | 0us | `Database` | `[native code]` |
| 0.1% | 1.7ms | 0.0% | 0us | `rowToItem` | `C:\AtomEons\Orange5\03-BACKEND\learning-queue.mjs:33` |
| 0.0% | 1.2ms | 0.0% | 1.2ms | `(anonymous)` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:308` |
| 0.0% | 1.2ms | 0.0% | 1.2ms | `(anonymous)` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:152` |
| 0.0% | 1.1ms | 0.0% | 1.1ms | `payloadTokens` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:102` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `@lazy` | `[native code]` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `toFixed` | `[native code]` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:191` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `(anonymous)` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:174` |
| 0.0% | 1.0ms | 0.0% | 0us | `machineTelemetryPayload` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:135` |
| 0.0% | 970us | 0.0% | 0us | `lowInformationPayload` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:123` |
| 0.0% | 909us | 0.0% | 0us | `lowInformationPayload` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:116` |
| 0.0% | 892us | 0.0% | 892us | `pointId` | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:25` |

## Function Details

### `statSync`
`[native code]` | Self: 13.0% (216.7ms) | Total: 16.2% (270.3ms) | Samples: 24

**Called by:**
- `(anonymous)` (24)
- `statSync` (6)

**Calls:**
- `statSync` (6)

### `fetch`
`[native code]` | Self: 10.9% (182.9ms) | Total: 10.9% (182.9ms) | Samples: 1

**Called by:**
- `async timedFetch` (1)

### `payloadTokens`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:103` | Self: 7.1% (118.7ms) | Total: 7.1% (118.7ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `get`
`[native code]` | Self: 6.7% (112.2ms) | Total: 6.7% (112.2ms) | Samples: 20

**Called by:**
- `complete` (11)
- `enqueue` (4)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `enqueue` (1)

### `readFileSync`
`[native code]` | Self: 5.5% (92.4ms) | Total: 11.1% (184.9ms) | Samples: 13

**Called by:**
- `readFileSync` (13)
- `writeChainedJsonReceipt` (8)
- `readLaneRecords` (3)
- `loadLexicalMirror` (2)

**Calls:**
- `readFileSync` (13)

### `mkdirSync`
`[native code]` | Self: 4.7% (78.9ms) | Total: 9.4% (157.9ms) | Samples: 1

**Called by:**
- `LearningQueueStore` (1)
- `mkdirSync` (1)

**Calls:**
- `mkdirSync` (1)

### `run`
`[native code]` | Self: 4.0% (68.0ms) | Total: 4.0% (68.0ms) | Samples: 8

**Called by:**
- `run` (4)
- `#runNoArgs` (4)

### `async benchmarkQueue`
`C:\AtomEons\Orange5\scripts\bun-runtime-benchmark.mjs` | Self: 3.4% (57.6ms) | Total: 3.4% (57.6ms) | Samples: 1

**Called by:**
- `async benchmarkQueue` (1)

### `Set`
`[native code]` | Self: 3.1% (53.0ms) | Total: 3.1% (53.0ms) | Samples: 8

**Called by:**
- `tokens` (7)
- `lowInformationPayload` (1)

### `anonymous`
`[native code]` | Self: 2.9% (49.9ms) | Total: 10.8% (180.4ms) | Samples: 4

**Called by:**
- `node:fs` (4)
- `node:fs/promises` (2)
- `internal:streams/transform` (1)
- `node:crypto` (1)
- `internal:streams/duplex` (1)
- `internal:streams/add-abort-signal` (1)
- `internal:streams/readable` (1)
- `internal:streams/lazy_transform` (1)

**Calls:**
- `node:fs/promises` (3)
- `internal:streams/transform` (1)
- `internal:streams/duplex` (1)
- `internal:streams/add-abort-signal` (1)
- `internal:streams/readable` (1)
- `internal:streams/lazy_transform` (1)

### `[Symbol.match]`
`[native code]` | Self: 2.3% (39.5ms) | Total: 2.3% (39.5ms) | Samples: 3

**Called by:**
- `match` (3)

### `/\/+$/`
`[native code]` | Self: 2.2% (38.0ms) | Total: 2.2% (38.0ms) | Samples: 1

**Called by:**
- `replace` (1)

### `resolve`
`[native code]` | Self: 2.0% (33.3ms) | Total: 2.0% (33.3ms) | Samples: 7

**Called by:**
- `(anonymous)` (7)

### `close`
`[native code]` | Self: 1.9% (32.8ms) | Total: 1.9% (32.8ms) | Samples: 7

**Called by:**
- `close` (7)

### `(anonymous)`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:87` | Self: 1.9% (31.8ms) | Total: 1.9% (31.8ms) | Samples: 3

**Called by:**
- `filter` (3)

### `join`
`[native code]` | Self: 1.8% (30.8ms) | Total: 1.8% (30.8ms) | Samples: 7

**Called by:**
- `bound join` (2)
- `(anonymous)` (2)
- `payloadTokens` (2)
- `payloadTokens` (1)

### `map`
`[native code]` | Self: 1.8% (30.7ms) | Total: 59.1% (985.9ms) | Samples: 1

**Called by:**
- `latestReceipt` (28)
- `lexicalCandidates` (22)
- `rerankHits` (21)
- `tokens` (9)
- `lexicalCandidates` (5)
- `lexicalCandidates` (2)
- `async lexicalCorpus` (2)
- `(module)` (1)
- `stableJson` (1)

**Calls:**
- `(anonymous)` (24)
- `(anonymous)` (22)
- `(anonymous)` (10)
- `(anonymous)` (4)
- `(anonymous)` (4)
- `(anonymous)` (3)
- `normalizeToken` (2)
- `normalizeToken` (2)
- `(anonymous)` (2)
- `normalizeToken` (2)
- `normalizeToken` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `async timedFetch` (1)

### `hostname`
`[native code]` | Self: 1.7% (28.8ms) | Total: 1.7% (28.8ms) | Samples: 2

**Called by:**
- `(module)` (2)

### `normalizeToken`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:77` | Self: 1.6% (27.1ms) | Total: 1.6% (27.1ms) | Samples: 2

**Called by:**
- `map` (2)

### `(anonymous)`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:302` | Self: 1.6% (26.6ms) | Total: 3.2% (53.3ms) | Samples: 2

**Called by:**
- `reduce` (2)
- `map` (2)

**Calls:**
- `reduce` (2)

### `readdirSync`
`[native code]` | Self: 1.4% (23.4ms) | Total: 2.8% (46.8ms) | Samples: 1

**Called by:**
- `readLaneRecords` (1)
- `readdirSync` (1)

**Calls:**
- `readdirSync` (1)

### `toLowerCase`
`[native code]` | Self: 1.3% (22.1ms) | Total: 1.3% (22.1ms) | Samples: 5

**Called by:**
- `lowInformationPayload` (4)
- `lowInformationPayload` (1)

### `(anonymous)`
`C:\AtomEons\Orange5\bin\sqlite-shim.mjs:100` | Self: 1.2% (20.5ms) | Total: 1.6% (28.1ms) | Samples: 1

**Called by:**
- `enqueue` (2)
- `(anonymous)` (1)

**Calls:**
- `remapBindArgs` (2)

### `machineTelemetryPayload`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs` | Self: 1.2% (20.4ms) | Total: 1.2% (20.4ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `update`
`[native code]` | Self: 1.0% (17.9ms) | Total: 1.0% (17.9ms) | Samples: 2

**Called by:**
- `sha256` (2)

### `has`
`[native code]` | Self: 1.0% (17.3ms) | Total: 1.0% (17.3ms) | Samples: 3

**Called by:**
- `(anonymous)` (3)

### `filter`
`[native code]` | Self: 1.0% (17.1ms) | Total: 6.5% (109.1ms) | Samples: 2

**Called by:**
- `latestReceipt` (8)
- `async lexicalCorpus` (6)
- `tokens` (3)
- `lowInformationPayload` (1)
- `machineTelemetryPayload` (1)

**Calls:**
- `(anonymous)` (7)
- `usefulRecord` (6)
- `(anonymous)` (3)
- `test` (1)

### `normalizeToken`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:78` | Self: 1.0% (16.8ms) | Total: 1.0% (16.8ms) | Samples: 2

**Called by:**
- `map` (2)

### `normalizeToken`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:75` | Self: 0.9% (16.2ms) | Total: 0.9% (16.2ms) | Samples: 2

**Called by:**
- `map` (2)

### `transaction`
`bun:sqlite:417` | Self: 0.9% (15.5ms) | Total: 3.0% (51.3ms) | Samples: 1

**Called by:**
- `async benchmarkQueue` (6)

**Calls:**
- `#runNoArgs` (4)
- `createChangesObject` (1)

### `(anonymous)`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:300` | Self: 0.9% (15.3ms) | Total: 19.1% (319.2ms) | Samples: 1

**Called by:**
- `map` (22)

**Calls:**
- `payloadTokens` (9)
- `payloadTokens` (9)
- `payloadTokens` (1)
- `payloadTokens` (1)
- `payloadTokens` (1)

### `copyObject`
`internal:fs/streams:32` | Self: 0.8% (14.0ms) | Total: 0.8% (14.0ms) | Samples: 1

**Called by:**
- `WriteStream` (1)

### `parse`
`[native code]` | Self: 0.6% (11.4ms) | Total: 0.6% (11.4ms) | Samples: 3

**Called by:**
- `loadLexicalMirror` (2)
- `rowToItem` (1)

### `tokens`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:86` | Self: 0.5% (8.4ms) | Total: 2.8% (47.9ms) | Samples: 3

**Called by:**
- `payloadTokens` (3)
- `payloadTokens` (2)
- `payloadTokens` (1)

**Calls:**
- `match` (3)

### `isPlainBindObject`
`C:\AtomEons\Orange5\bin\sqlite-shim.mjs` | Self: 0.4% (7.6ms) | Total: 0.4% (7.6ms) | Samples: 2

**Called by:**
- `remapBindArgs` (2)

### `createChangesObject`
`bun:sqlite:9` | Self: 0.4% (6.7ms) | Total: 0.4% (6.7ms) | Samples: 1

**Called by:**
- `transaction` (1)

### `async benchmarkSemantic`
`C:\AtomEons\Orange5\scripts\bun-runtime-benchmark.mjs:112` | Self: 0.3% (6.5ms) | Total: 0.3% (6.5ms) | Samples: 1

**Called by:**
- `async benchmarkSemantic` (1)

### `slice`
`[native code]` | Self: 0.3% (6.4ms) | Total: 0.3% (6.4ms) | Samples: 1

**Called by:**
- `recordPayload` (1)

### `setName`
`node:fs` | Self: 0.3% (6.0ms) | Total: 0.3% (6.0ms) | Samples: 1

**Called by:**
- `node:fs` (1)

### `payloadTokens`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:101` | Self: 0.3% (6.0ms) | Total: 0.3% (6.0ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:180` | Self: 0.3% (5.6ms) | Total: 0.3% (5.6ms) | Samples: 3

**Called by:**
- `map` (3)

### `(anonymous)`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:199` | Self: 0.2% (4.4ms) | Total: 0.2% (4.4ms) | Samples: 1

**Called by:**
- `sort` (1)

### `lowInformationPayload`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:119` | Self: 0.2% (3.9ms) | Total: 0.2% (3.9ms) | Samples: 1

**Called by:**
- `usefulRecord` (1)

### `/\b(?:benchmark\|performance\|latency\|p50\|p95\|throughput\|timings?\|health metrics?\|routes per second\|proof\|receipt\|current status\|fully operational\|green)\b/i`
`[native code]` | Self: 0.1% (3.3ms) | Total: 0.1% (3.3ms) | Samples: 1

**Called by:**
- `test` (1)

### `(anonymous)`
`C:\AtomEons\Orange5\03-BACKEND\learning-queue.mjs:14` | Self: 0.1% (3.0ms) | Total: 0.1% (3.0ms) | Samples: 1

**Called by:**
- `map` (1)

### `normalizeToken`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:81` | Self: 0.1% (2.9ms) | Total: 0.1% (2.9ms) | Samples: 2

**Called by:**
- `map` (2)

### `reduce`
`[native code]` | Self: 0.1% (2.3ms) | Total: 2.7% (46.3ms) | Samples: 1

**Called by:**
- `(anonymous)` (4)
- `(anonymous)` (2)

**Calls:**
- `(anonymous)` (3)
- `(anonymous)` (2)

### `Database`
`bun:sqlite` | Self: 0.1% (2.0ms) | Total: 0.1% (2.0ms) | Samples: 1

**Called by:**
- `Database` (1)

### `readLaneRecords`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\flux\reader.mjs:126` | Self: 0.1% (1.9ms) | Total: 1.2% (21.3ms) | Samples: 1

**Called by:**
- `readFlux` (4)

**Calls:**
- `readFileSync` (3)

### `(anonymous)`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:308` | Self: 0.0% (1.2ms) | Total: 0.0% (1.2ms) | Samples: 1

**Called by:**
- `map` (1)

### `(anonymous)`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:152` | Self: 0.0% (1.2ms) | Total: 0.0% (1.2ms) | Samples: 1

**Called by:**
- `map` (1)

### `payloadTokens`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:102` | Self: 0.0% (1.1ms) | Total: 0.0% (1.1ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `@lazy`
`[native code]` | Self: 0.0% (1.0ms) | Total: 0.0% (1.0ms) | Samples: 1

**Called by:**
- `node:fs/promises` (1)

### `toFixed`
`[native code]` | Self: 0.0% (1.0ms) | Total: 0.0% (1.0ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:174` | Self: 0.0% (1.0ms) | Total: 0.0% (1.0ms) | Samples: 1

**Called by:**
- `map` (1)

### `test`
`[native code]` | Self: 0.0% (1.0ms) | Total: 0.2% (4.3ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)
- `filter` (1)

**Calls:**
- `/\b(?:benchmark\|performance\|latency\|p50\|p95\|throughput\|timings?\|health metrics?\|routes per second\|proof\|receipt\|current status\|fully operational\|green)\b/i` (1)

### `pointId`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:25` | Self: 0.0% (892us) | Total: 0.0% (892us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:307` | Self: 0.0% (0us) | Total: 2.2% (37.0ms) | Samples: 0

**Called by:**
- `map` (4)
- `reduce` (3)

**Calls:**
- `reduce` (4)
- `has` (3)

### `readFlux`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\flux\reader.mjs:203` | Self: 0.0% (0us) | Total: 2.6% (44.7ms) | Samples: 0

**Called by:**
- `async lexicalCorpus` (5)

**Calls:**
- `readLaneRecords` (4)
- `readLaneRecords` (1)

### `(anonymous)`
`[native code]` | Self: 0.0% (0us) | Total: 0.8% (14.0ms) | Samples: 0

**Called by:**
- `(module)` (1)

**Calls:**
- `WriteStream` (1)

### `(anonymous)`
`C:\AtomEons\Orange5\10-RECEIPTS\tools\json-receipt-chain.mjs:44` | Self: 0.0% (0us) | Total: 13.0% (216.7ms) | Samples: 0

**Called by:**
- `map` (24)

**Calls:**
- `statSync` (24)

### `node:fs/promises`
`node:fs/promises:2` | Self: 0.0% (0us) | Total: 0.2% (3.4ms) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `anonymous` (2)
- `@lazy` (1)

### `(anonymous)`
`C:\AtomEons\Orange5\10-RECEIPTS\tools\json-receipt-chain.mjs:43` | Self: 0.0% (0us) | Total: 0.9% (15.4ms) | Samples: 0

**Called by:**
- `map` (4)

**Calls:**
- `bound join` (2)
- `join` (2)

### `payloadTokens`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:105` | Self: 0.0% (0us) | Total: 6.1% (102.5ms) | Samples: 0

**Called by:**
- `(anonymous)` (9)
- `(anonymous)` (3)

**Calls:**
- `tokens` (9)
- `tokens` (2)
- `join` (1)

### `internal:streams/duplex`
`internal:streams/duplex:2` | Self: 0.0% (0us) | Total: 1.5% (25.3ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `anonymous` (1)

### `async benchmarkQueue`
`C:\AtomEons\Orange5\scripts\bun-runtime-benchmark.mjs:90` | Self: 0.0% (0us) | Total: 1.9% (32.8ms) | Samples: 0

**Calls:**
- `close` (7)

### `#runNoArgs`
`bun:sqlite:138` | Self: 0.0% (0us) | Total: 1.7% (28.9ms) | Samples: 0

**Called by:**
- `transaction` (4)

**Calls:**
- `run` (4)

### `internal:streams/readable`
`internal:streams/readable:2` | Self: 0.0% (0us) | Total: 1.5% (25.3ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `anonymous` (1)

### `rerankHits`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:148` | Self: 0.0% (0us) | Total: 5.9% (99.3ms) | Samples: 0

**Called by:**
- `async querySemanticMemory` (21)

**Calls:**
- `map` (21)

### `lexicalCandidates`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:306` | Self: 0.0% (0us) | Total: 1.2% (20.9ms) | Samples: 0

**Called by:**
- `async querySemanticMemory` (5)

**Calls:**
- `map` (5)

### `payloadTokens`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:106` | Self: 0.0% (0us) | Total: 7.6% (127.1ms) | Samples: 0

**Called by:**
- `(anonymous)` (9)
- `(anonymous)` (6)

**Calls:**
- `tokens` (10)
- `tokens` (3)
- `join` (2)

### `(anonymous)`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:166` | Self: 0.0% (0us) | Total: 1.2% (21.4ms) | Samples: 0

**Called by:**
- `map` (2)

**Calls:**
- `machineTelemetryPayload` (1)
- `machineTelemetryPayload` (1)

### `complete`
`C:\AtomEons\Orange5\03-BACKEND\learning-queue.mjs:206` | Self: 0.0% (0us) | Total: 3.7% (63.2ms) | Samples: 0

**Called by:**
- `async benchmarkQueue` (11)

**Calls:**
- `get` (11)

### `async querySemanticMemory`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:599` | Self: 0.0% (0us) | Total: 7.0% (116.7ms) | Samples: 0

**Called by:**
- `async querySemanticMemory` (19)

**Calls:**
- `async lexicalCorpus` (19)

### `writeChainedJsonReceipt`
`C:\AtomEons\Orange5\10-RECEIPTS\tools\json-receipt-chain.mjs:63` | Self: 0.0% (0us) | Total: 3.7% (61.8ms) | Samples: 0

**Called by:**
- `(module)` (8)

**Calls:**
- `readFileSync` (8)

### `(module)`
`C:\AtomEons\Orange5\scripts\bun-runtime-benchmark.mjs:53` | Self: 0.0% (0us) | Total: 0.8% (14.0ms) | Samples: 0

**Calls:**
- `(anonymous)` (1)

### `latestReceipt`
`C:\AtomEons\Orange5\10-RECEIPTS\tools\json-receipt-chain.mjs:46` | Self: 0.0% (0us) | Total: 2.9% (49.6ms) | Samples: 0

**Called by:**
- `writeChainedJsonReceipt` (8)

**Calls:**
- `filter` (8)

### `usefulRecord`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:129` | Self: 0.0% (0us) | Total: 1.5% (25.7ms) | Samples: 0

**Called by:**
- `filter` (6)

**Calls:**
- `lowInformationPayload` (2)
- `lowInformationPayload` (1)
- `lowInformationPayload` (1)
- `lowInformationPayload` (1)
- `lowInformationPayload` (1)

### `node:fs`
`node:fs:2` | Self: 0.0% (0us) | Total: 1.5% (25.6ms) | Samples: 0

**Calls:**
- `anonymous` (4)

### `close`
`C:\AtomEons\Orange5\03-BACKEND\learning-queue.mjs:277` | Self: 0.0% (0us) | Total: 1.9% (32.8ms) | Samples: 0

**Called by:**
- `async benchmarkQueue` (7)

**Calls:**
- `close` (7)

### `(anonymous)`
`C:\AtomEons\Orange5\03-BACKEND\learning-queue.mjs:197` | Self: 0.0% (0us) | Total: 0.1% (2.6ms) | Samples: 0

**Called by:**
- `transaction` (2)

**Calls:**
- `get` (2)

### `async timedFetch`
`C:\AtomEons\Orange5\scripts\bun-runtime-benchmark.mjs:59` | Self: 0.0% (0us) | Total: 10.9% (182.9ms) | Samples: 0

**Called by:**
- `async timedFetch` (1)

**Calls:**
- `fetch` (1)

### `async lexicalCorpus`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:218` | Self: 0.0% (0us) | Total: 1.5% (25.7ms) | Samples: 0

**Called by:**
- `async lexicalCorpus` (6)

**Calls:**
- `filter` (6)

### `initializeDatabase`
`C:\AtomEons\Orange5\03-BACKEND\learning-queue.mjs:67` | Self: 0.0% (0us) | Total: 0.8% (13.5ms) | Samples: 0

**Called by:**
- `LearningQueueStore` (1)

**Calls:**
- `run` (1)

### `lexicalCandidates`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:301` | Self: 0.0% (0us) | Total: 1.6% (26.6ms) | Samples: 0

**Called by:**
- `async querySemanticMemory` (2)

**Calls:**
- `map` (2)

### `lexicalCandidates`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:300` | Self: 0.0% (0us) | Total: 19.1% (319.2ms) | Samples: 0

**Called by:**
- `async querySemanticMemory` (22)

**Calls:**
- `map` (22)

### `WriteStream`
`internal:fs/streams:200` | Self: 0.0% (0us) | Total: 0.8% (14.0ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `copyObject` (1)

### `node:fs`
`node:fs:772` | Self: 0.0% (0us) | Total: 0.3% (6.0ms) | Samples: 0

**Calls:**
- `setName` (1)

### `(anonymous)`
`C:\AtomEons\Orange5\10-RECEIPTS\tools\json-receipt-chain.mjs:46` | Self: 0.0% (0us) | Total: 2.0% (33.3ms) | Samples: 0

**Called by:**
- `filter` (7)

**Calls:**
- `resolve` (7)

### `replace`
`[native code]` | Self: 0.0% (0us) | Total: 2.2% (38.0ms) | Samples: 0

**Called by:**
- `(module)` (1)

**Calls:**
- `/\/+$/` (1)

### `async benchmarkQueue`
`C:\AtomEons\Orange5\scripts\bun-runtime-benchmark.mjs:73` | Self: 0.0% (0us) | Total: 7.2% (120.1ms) | Samples: 0

**Calls:**
- `LearningQueueStore` (3)
- `LearningQueueStore` (1)
- `LearningQueueStore` (1)
- `LearningQueueStore` (1)

### `async querySemanticMemory`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:575` | Self: 0.0% (0us) | Total: 7.0% (116.7ms) | Samples: 0

**Called by:**
- `async benchmarkSemantic` (19)

**Calls:**
- `async querySemanticMemory` (19)

### `async lexicalCorpus`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:219` | Self: 0.0% (0us) | Total: 0.4% (7.3ms) | Samples: 0

**Called by:**
- `async lexicalCorpus` (2)

**Calls:**
- `map` (2)

### `latestReceipt`
`C:\AtomEons\Orange5\10-RECEIPTS\tools\json-receipt-chain.mjs:42` | Self: 0.0% (0us) | Total: 13.9% (232.2ms) | Samples: 0

**Called by:**
- `writeChainedJsonReceipt` (28)

**Calls:**
- `map` (28)

### `(anonymous)`
`C:\AtomEons\Orange5\03-BACKEND\learning-queue.mjs:199` | Self: 0.0% (0us) | Total: 3.5% (59.5ms) | Samples: 0

**Called by:**
- `transaction` (3)

**Calls:**
- `get` (2)
- `(anonymous)` (1)

### `lowInformationPayload`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:114` | Self: 0.0% (0us) | Total: 1.2% (21.2ms) | Samples: 0

**Called by:**
- `usefulRecord` (2)
- `(anonymous)` (2)

**Calls:**
- `toLowerCase` (4)

### `(anonymous)`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:159` | Self: 0.0% (0us) | Total: 0.2% (4.2ms) | Samples: 0

**Called by:**
- `map` (2)

**Calls:**
- `lowInformationPayload` (2)

### `loadLexicalMirror`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:235` | Self: 0.0% (0us) | Total: 1.0% (17.9ms) | Samples: 0

**Called by:**
- `async lexicalCorpus` (2)

**Calls:**
- `sha256` (2)

### `recordPayload`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:56` | Self: 0.0% (0us) | Total: 0.3% (6.4ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `slice` (1)

### `match`
`[native code]` | Self: 0.0% (0us) | Total: 2.3% (39.5ms) | Samples: 0

**Called by:**
- `tokens` (3)

**Calls:**
- `[Symbol.match]` (3)

### `enqueue`
`C:\AtomEons\Orange5\03-BACKEND\learning-queue.mjs:179` | Self: 0.0% (0us) | Total: 0.5% (8.7ms) | Samples: 0

**Called by:**
- `async benchmarkQueue` (3)

**Calls:**
- `(anonymous)` (2)
- `get` (1)

### `(anonymous)`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:167` | Self: 0.0% (0us) | Total: 0.1% (3.3ms) | Samples: 0

**Called by:**
- `map` (1)

**Calls:**
- `test` (1)

### `(anonymous)`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:191` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `map` (1)

**Calls:**
- `toFixed` (1)

### `(anonymous)`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:219` | Self: 0.0% (0us) | Total: 0.4% (7.3ms) | Samples: 0

**Called by:**
- `map` (2)

**Calls:**
- `pointId` (1)
- `recordPayload` (1)

### `lowInformationPayload`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:115` | Self: 0.0% (0us) | Total: 0.1% (2.8ms) | Samples: 0

**Called by:**
- `usefulRecord` (1)

**Calls:**
- `Set` (1)

### `LearningQueueStore`
`C:\AtomEons\Orange5\03-BACKEND\learning-queue.mjs:88` | Self: 0.0% (0us) | Total: 0.8% (13.5ms) | Samples: 0

**Called by:**
- `async benchmarkQueue` (1)

**Calls:**
- `initializeDatabase` (1)

### `payloadTokens`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:107` | Self: 0.0% (0us) | Total: 0.5% (9.6ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `tokens` (1)

### `machineTelemetryPayload`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:135` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `filter` (1)

### `tokens`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:87` | Self: 0.0% (0us) | Total: 10.5% (175.9ms) | Samples: 0

**Called by:**
- `payloadTokens` (10)
- `payloadTokens` (9)

**Calls:**
- `map` (9)
- `Set` (7)
- `filter` (3)

### `(module)`
`C:\AtomEons\Orange5\scripts\bun-runtime-benchmark.mjs:34` | Self: 0.0% (0us) | Total: 1.7% (28.8ms) | Samples: 0

**Calls:**
- `hostname` (2)

### `lowInformationPayload`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:116` | Self: 0.0% (0us) | Total: 0.0% (909us) | Samples: 0

**Called by:**
- `usefulRecord` (1)

**Calls:**
- `toLowerCase` (1)

### `async benchmarkQueue`
`C:\AtomEons\Orange5\scripts\bun-runtime-benchmark.mjs:78` | Self: 0.0% (0us) | Total: 1.1% (19.8ms) | Samples: 0

**Calls:**
- `enqueue` (4)
- `enqueue` (3)
- `rowToItem` (1)
- `enqueue` (1)

### `LearningQueueStore`
`C:\AtomEons\Orange5\03-BACKEND\learning-queue.mjs:86` | Self: 0.0% (0us) | Total: 4.7% (78.9ms) | Samples: 0

**Called by:**
- `async benchmarkQueue` (1)

**Calls:**
- `mkdirSync` (1)

### `internal:streams/transform`
`internal:streams/transform:2` | Self: 0.0% (0us) | Total: 1.5% (25.3ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `anonymous` (1)

### `(anonymous)`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:150` | Self: 0.0% (0us) | Total: 3.6% (61.3ms) | Samples: 0

**Called by:**
- `map` (10)

**Calls:**
- `payloadTokens` (6)
- `payloadTokens` (3)
- `payloadTokens` (1)

### `sort`
`[native code]` | Self: 0.0% (0us) | Total: 0.2% (4.4ms) | Samples: 0

**Called by:**
- `async querySemanticMemory` (1)

**Calls:**
- `(anonymous)` (1)

### `async benchmarkSemantic`
`C:\AtomEons\Orange5\scripts\bun-runtime-benchmark.mjs:114` | Self: 0.0% (0us) | Total: 7.0% (116.7ms) | Samples: 0

**Calls:**
- `async querySemanticMemory` (19)

### `run`
`bun:sqlite:336` | Self: 0.0% (0us) | Total: 2.3% (39.0ms) | Samples: 0

**Called by:**
- `LearningQueueStore` (3)
- `initializeDatabase` (1)

**Calls:**
- `run` (4)

### `node:crypto`
`node:crypto:2` | Self: 0.0% (0us) | Total: 1.5% (25.3ms) | Samples: 0

**Calls:**
- `anonymous` (1)

### `internal:streams/add-abort-signal`
`internal:streams/add-abort-signal:2` | Self: 0.0% (0us) | Total: 1.5% (25.3ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `anonymous` (1)

### `stableJson`
`C:\AtomEons\Orange5\03-BACKEND\learning-queue.mjs:14` | Self: 0.0% (0us) | Total: 0.1% (3.0ms) | Samples: 0

**Called by:**
- `enqueue` (1)

**Calls:**
- `map` (1)

### `enqueue`
`C:\AtomEons\Orange5\03-BACKEND\learning-queue.mjs:184` | Self: 0.0% (0us) | Total: 0.3% (6.2ms) | Samples: 0

**Called by:**
- `async benchmarkQueue` (4)

**Calls:**
- `get` (4)

### `async timedFetch`
`C:\AtomEons\Orange5\scripts\bun-runtime-benchmark.mjs:56` | Self: 0.0% (0us) | Total: 10.9% (182.9ms) | Samples: 0

**Called by:**
- `map` (1)

**Calls:**
- `async timedFetch` (1)

### `LearningQueueStore`
`C:\AtomEons\Orange5\03-BACKEND\learning-queue.mjs:87` | Self: 0.0% (0us) | Total: 0.1% (2.0ms) | Samples: 0

**Called by:**
- `async benchmarkQueue` (1)

**Calls:**
- `Database` (1)

### `lowInformationPayload`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:123` | Self: 0.0% (0us) | Total: 0.0% (970us) | Samples: 0

**Called by:**
- `usefulRecord` (1)

**Calls:**
- `filter` (1)

### `(module)`
`C:\AtomEons\Orange5\scripts\bun-runtime-benchmark.mjs:26` | Self: 0.0% (0us) | Total: 10.9% (182.9ms) | Samples: 0

**Calls:**
- `map` (1)

### `async querySemanticMemory`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:602` | Self: 0.0% (0us) | Total: 22.0% (366.9ms) | Samples: 0

**Calls:**
- `lexicalCandidates` (22)
- `lexicalCandidates` (5)
- `lexicalCandidates` (2)

### `bound join`
`[native code]` | Self: 0.0% (0us) | Total: 0.2% (3.8ms) | Samples: 0

**Called by:**
- `(anonymous)` (2)

**Calls:**
- `join` (2)

### `async benchmarkQueue`
`C:\AtomEons\Orange5\scripts\bun-runtime-benchmark.mjs:67` | Self: 0.0% (0us) | Total: 3.4% (57.6ms) | Samples: 0

**Called by:**
- `(module)` (1)

**Calls:**
- `async benchmarkQueue` (1)

### `loadLexicalMirror`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:233` | Self: 0.0% (0us) | Total: 1.2% (20.8ms) | Samples: 0

**Called by:**
- `async lexicalCorpus` (4)

**Calls:**
- `readFileSync` (2)
- `parse` (2)

### `async lexicalCorpus`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:204` | Self: 0.0% (0us) | Total: 2.3% (38.8ms) | Samples: 0

**Called by:**
- `async lexicalCorpus` (6)

**Calls:**
- `loadLexicalMirror` (4)
- `loadLexicalMirror` (2)

### `sha256`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:21` | Self: 0.0% (0us) | Total: 1.0% (17.9ms) | Samples: 0

**Called by:**
- `loadLexicalMirror` (2)

**Calls:**
- `update` (2)

### `rowToItem`
`C:\AtomEons\Orange5\03-BACKEND\learning-queue.mjs:33` | Self: 0.0% (0us) | Total: 0.1% (1.7ms) | Samples: 0

**Called by:**
- `async benchmarkQueue` (1)

**Calls:**
- `parse` (1)

### `async benchmarkQueue`
`C:\AtomEons\Orange5\scripts\bun-runtime-benchmark.mjs:81` | Self: 0.0% (0us) | Total: 3.7% (63.2ms) | Samples: 0

**Calls:**
- `complete` (11)

### `async benchmarkQueue`
`C:\AtomEons\Orange5\scripts\bun-runtime-benchmark.mjs:79` | Self: 0.0% (0us) | Total: 6.8% (113.5ms) | Samples: 0

**Calls:**
- `transaction` (6)
- `transaction` (5)

### `(module)`
`C:\AtomEons\Orange5\scripts\bun-runtime-benchmark.mjs:30` | Self: 0.0% (0us) | Total: 0.3% (6.5ms) | Samples: 0

**Calls:**
- `async benchmarkSemantic` (1)

### `(module)`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:9` | Self: 0.0% (0us) | Total: 2.2% (38.0ms) | Samples: 0

**Calls:**
- `replace` (1)

### `(module)`
`C:\AtomEons\Orange5\scripts\bun-runtime-benchmark.mjs:29` | Self: 0.0% (0us) | Total: 3.4% (57.6ms) | Samples: 0

**Calls:**
- `async benchmarkQueue` (1)

### `async querySemanticMemory`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:603` | Self: 0.0% (0us) | Total: 6.2% (103.7ms) | Samples: 0

**Calls:**
- `rerankHits` (21)
- `sort` (1)

### `enqueue`
`C:\AtomEons\Orange5\03-BACKEND\learning-queue.mjs:174` | Self: 0.0% (0us) | Total: 0.1% (3.0ms) | Samples: 0

**Called by:**
- `async benchmarkQueue` (1)

**Calls:**
- `stableJson` (1)

### `(module)`
`C:\AtomEons\Orange5\scripts\bun-runtime-benchmark.mjs:52` | Self: 0.0% (0us) | Total: 20.6% (343.7ms) | Samples: 0

**Calls:**
- `writeChainedJsonReceipt` (36)
- `writeChainedJsonReceipt` (8)

### `LearningQueueStore`
`C:\AtomEons\Orange5\03-BACKEND\learning-queue.mjs:94` | Self: 0.0% (0us) | Total: 1.5% (25.4ms) | Samples: 0

**Called by:**
- `async benchmarkQueue` (3)

**Calls:**
- `run` (3)

### `writeChainedJsonReceipt`
`C:\AtomEons\Orange5\10-RECEIPTS\tools\json-receipt-chain.mjs:53` | Self: 0.0% (0us) | Total: 16.9% (281.8ms) | Samples: 0

**Called by:**
- `(module)` (36)

**Calls:**
- `latestReceipt` (28)
- `latestReceipt` (8)

### `transaction`
`bun:sqlite:416` | Self: 0.0% (0us) | Total: 3.7% (62.1ms) | Samples: 0

**Called by:**
- `async benchmarkQueue` (5)

**Calls:**
- `(anonymous)` (3)
- `(anonymous)` (2)

### `async lexicalCorpus`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:217` | Self: 0.0% (0us) | Total: 2.6% (44.7ms) | Samples: 0

**Called by:**
- `async lexicalCorpus` (5)

**Calls:**
- `readFlux` (5)

### `async lexicalCorpus`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs:202` | Self: 0.0% (0us) | Total: 7.0% (116.7ms) | Samples: 0

**Called by:**
- `async querySemanticMemory` (19)

**Calls:**
- `async lexicalCorpus` (6)
- `async lexicalCorpus` (6)
- `async lexicalCorpus` (5)
- `async lexicalCorpus` (2)

### `Database`
`[native code]` | Self: 0.0% (0us) | Total: 0.1% (2.0ms) | Samples: 0

**Called by:**
- `LearningQueueStore` (1)

**Calls:**
- `Database` (1)

### `remapBindArgs`
`C:\AtomEons\Orange5\bin\sqlite-shim.mjs:84` | Self: 0.0% (0us) | Total: 0.4% (7.6ms) | Samples: 0

**Called by:**
- `(anonymous)` (2)

**Calls:**
- `isPlainBindObject` (2)

### `async benchmarkSemantic`
`C:\AtomEons\Orange5\scripts\bun-runtime-benchmark.mjs:110` | Self: 0.0% (0us) | Total: 0.3% (6.5ms) | Samples: 0

**Called by:**
- `(module)` (1)

**Calls:**
- `async benchmarkSemantic` (1)

### `internal:streams/lazy_transform`
`internal:streams/lazy_transform:2` | Self: 0.0% (0us) | Total: 1.5% (25.3ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `anonymous` (1)

### `readLaneRecords`
`C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\flux\reader.mjs:102` | Self: 0.0% (0us) | Total: 1.4% (23.4ms) | Samples: 0

**Called by:**
- `readFlux` (1)

**Calls:**
- `readdirSync` (1)

## Files

| Self% | Self | File |
|------:|-----:|------|
| 72.8% | 1.21s | `[native code]` |
| 18.6% | 310.2ms | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\semantic-index.mjs` |
| 3.8% | 64.1ms | `C:\AtomEons\Orange5\scripts\bun-runtime-benchmark.mjs` |
| 1.6% | 28.1ms | `C:\AtomEons\Orange5\bin\sqlite-shim.mjs` |
| 1.4% | 24.3ms | `bun:sqlite` |
| 0.8% | 14.0ms | `internal:fs/streams` |
| 0.3% | 6.0ms | `node:fs` |
| 0.1% | 3.0ms | `C:\AtomEons\Orange5\03-BACKEND\learning-queue.mjs` |
| 0.1% | 1.9ms | `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\flux\reader.mjs` |
