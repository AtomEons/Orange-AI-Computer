# Audit 06 — Bun-Strict + Windows Safety

Date: 2026-06-27
Scope: `12-ATOMSMASHER/full-scope/` + `12-ATOMSMASHER/research/`
Operator law: Bun-only ("i run bun now"). Target: Windows 11.
Method: grep sweep across six pattern families; classify hits by severity.

---

## 1. Node.js residue

### 1a. `require()` use (CJS in ESM)

| File | Line | Snippet | Severity |
|---|---:|---|---|
| `full-scope/storage.mjs` | 416 | `const zlib = require('node:zlib');` | **FIX-ADVISED** |

Storage.mjs uses ESM `import` everywhere else except inside `exportCompressedAuditLog()`. Bun and Node both support `require()` in ESM via the `createRequire` polyfill, but operator law says **Bun-strict**. This single line breaks "no Node residue."

**Fix**: hoist to top-of-file `import zlibSync from 'node:zlib';` (already done elsewhere in the codebase — see `engines.mjs:12`). Then use `zlibSync` inside the function.

### 1b. `module.exports`

No hits across full-scope or research. Clean ESM throughout.

### 1c. `__dirname` / `__filename`

| File | Lines | Notes | Severity |
|---|---|---|---|
| `full-scope/tests/run-all.mjs` | 16-17, 29, 47, 80, 123, 131 | Polyfilled with `fileURLToPath(import.meta.url)` + `path.dirname()` — correct ESM idiom. | **HARMLESS** |
| `full-scope/engines.mjs` | 1697 | `fsSync.readFileSync(__filename ? __filename : 'engines.mjs', 'utf8')` — uses `__filename` as a bareword without polyfill | **BLOCKER** |

`engines.mjs:1697` references `__filename` directly in ESM. In an `.mjs` file, `__filename` is **`undefined`** and the ternary will always fall through to the literal `'engines.mjs'` (relative path). This is silent dead code disguised as a guard. The next line `fsSync.readFileSync('12-ATOMSMASHER/full-scope/engines.mjs', 'utf8')` assumes CWD = repo root — also a latent failure if invoked from anywhere else.

```js
1697:      const engineSrc = fsSync.readFileSync(__filename ? __filename : 'engines.mjs', 'utf8').slice(0, 1).length > 0
1698:        ? fsSync.readFileSync('12-ATOMSMASHER/full-scope/engines.mjs', 'utf8') : '';
```

**Severity = BLOCKER** because the bug is *invisible* in ESM (`__filename === undefined`, ternary always takes the false branch, the apparent "self-read" never happens, and a CWD-relative path is read instead). The `regenCompression` measurement is silently degraded.

**Fix**: import `fileURLToPath` and resolve via `import.meta.url`.

### 1d. `process.versions.node`

No hits. Clean.

### 1e. `fs.promises`

No hits across either tree.

---

## 2. Hardcoded Unix paths

### 2a. `/tmp` in production paths

| File | Line | Context | Severity |
|---|---:|---|---|
| `full-scope/README.md` | 35, 38, 41 | Example CLI invocations using `--db /tmp/as.db` | **FIX-ADVISED** |
| `research/.../29-codec-sweep/bench.mjs` | 75 | `function tryCli(... encFile = '/tmp/corpus.bin', ...)` — **but** lines 79-84 detect win32 and rewrite to `%TEMP%` | **HARMLESS** (already platform-guarded) |

The README hardcodes `/tmp/as.db` as the documented example. On Windows that becomes `C:\tmp\as.db` which works incidentally if `C:\tmp` exists but is not idiomatic. Operator runs Windows 11.

**Fix-advised**: rewrite README examples to use cross-platform paths (`./as.db` or `%TEMP%\as.db` / `$TMP/as.db`).

### 2b. `/var`, `/etc`, `/usr/`, `~`, `process.env.HOME`

`/usr/` only appears in shebangs (`#!/usr/bin/env bun`) — **harmless and standard** (Windows ignores shebangs; bun.cmd handles invocation).

No `/var`, `/etc`, `~/`, or `process.env.HOME` hits.

---

## 3. Path separator assumptions

No `.split('/')` on file paths. No raw `path.sep` use (none needed because nothing splits paths). All `${a}/${b}` template literals are label/identifier strings (e.g., `"5/12 pass"`, `"cartridge name/domain"`), not filesystem paths. Verified.

---

## 4. Missing `path.join()`

### 4a. `process.env.TEMP + '/...'` concat (Windows-unsafe-feeling, technically works)

| File | Lines | Snippet | Severity |
|---|---:|---|---|
| `research/.../41-break-brotli/bench.mjs` | 282-283 | `const tmpIn = process.env.TEMP + '/shapes.bin';` | **FIX-ADVISED** |

Raw `+` concat with a forward slash on Windows. Works because Windows accepts forward slashes in most contexts, but violates the codebase's own convention of using `path.join()` everywhere else. Two-line cleanup. Inside a try/catch so failure is non-fatal — this is why **FIX-ADVISED**, not BLOCKER.

### 4b. Other paths

`full-scope/bench/superiority.mjs:30`, `full-scope/tests/full-scope.test.mjs:37`, `research/compression/data/generate-canonical-corpus.mjs:16` all use `path.join(os.tmpdir(), ...)`. Correct.

`full-scope/tests/run-all.mjs:29, 123, 148` uses `path.join(__dirname, ...)`. Correct.

`full-scope/engines.mjs:1698` uses literal `'12-ATOMSMASHER/full-scope/engines.mjs'` — **see §1c, BLOCKER** (CWD-relative).

---

## 5. `chmod` / `chown`

No hits. Nothing tries to set Unix file modes. Clean for Windows.

---

## 6. Hidden externals / shell assumptions

### 6a. `child_process` imports

| File | Severity |
|---|---|
| `full-scope/bench/superiority.mjs:14` (`spawnSync`) | **HARMLESS** — used to invoke `python` for Bun-vs-Python superiority bench. Bench-only, gated. |
| `research/.../22-the-100-matrix/runner.mjs:28` | **HARMLESS** — research bench, calls external `xz` |
| `research/.../29-codec-sweep/bench.mjs:11` | **HARMLESS** — research bench, win32-guarded |
| `research/.../41-break-brotli/bench.mjs:12` | **HARMLESS** — research bench |
| `research/.../75-lzma2-xz/bench.mjs:9` | **HARMLESS** — research bench |
| `research/.../96-zstd-long/bench.mjs:8` | **HARMLESS** — codec probe, gracefully degrades to `N/A` when missing |
| `research/.../97-ppmd-7z/bench.mjs:7` | **HARMLESS** — codec probe, gracefully degrades |
| `research/.../98-zpaq/bench.mjs:6` | **HARMLESS** — codec probe, gracefully degrades |

`Bun.spawn(['bun', ...])` in `tests/run-all.mjs:46` is **Bun-native** — not `node:child_process`. Correct.

### 6b. `spawn('bash', ...)`, `spawn('sh', ...)`

No hits. No bash/sh assumptions anywhere.

### 6c. `execSync` shell invocations

Used in research bench scripts to call `xz`, `zstd`, `7z`, `zpaq`. Each is a codec probe; missing-binary errors are caught and tagged `N/A`. None are in the full-scope production path.

---

## 7. `node:*` import inventory (informational — Bun supports all of these)

| Module | Files | Status |
|---|---|---|
| `node:fs` | engines, bench, run-all, full-scope.test | Bun-supported, idiomatic |
| `node:path` | engines, bench, run-all, full-scope.test | Bun-supported |
| `node:crypto` | clc, clc-engine, engagements, engines, mesh-compression, crystal-compression, storage, utils, replay-integration.test | Bun-supported |
| `node:zlib` | engines, mesh-compression, storage (via require — see §1a) | Bun-supported |
| `node:os` | bench, full-scope.test, generate-canonical-corpus | Bun-supported |
| `node:url` | run-all | Bun-supported |
| `node:perf_hooks` | wellbeing-guardrails | Bun-supported |
| `node:child_process` | bench/superiority, research benches | Bun-supported (but operator law: prefer `Bun.spawn`) |

The `node:` prefix is correct and Bun-friendly. Not a violation of Bun-strict; Bun explicitly supports these.

`bench/superiority.mjs` uses `spawnSync` from `node:child_process` rather than `Bun.spawn`. Mom's Law note: this is a bench (out-of-band tooling), not the hot path, and `Bun.spawn` doesn't have a synchronous variant. **HARMLESS** but worth a future swap to async `Bun.spawn` for full Bun-strict.

---

## Severity ledger

| Category | Hits | Severity |
|---|---:|---|
| `require()` in ESM (storage.mjs:416) | 1 | FIX-ADVISED |
| `__filename` unguarded in ESM (engines.mjs:1697) | 1 | **BLOCKER** |
| `/tmp` in README examples | 3 lines | FIX-ADVISED |
| `process.env.TEMP + '/...'` concat | 2 lines | FIX-ADVISED |
| Node-only `spawnSync` in bench/superiority | 1 | HARMLESS (advisory) |

**Ship-blocker count = 1.** (engines.mjs:1697 silently degrades the `regenCompression` measurement because `__filename` is always undefined in ESM.)

The codebase is otherwise Bun-strict and Windows-safe. All `os.tmpdir()`, `path.join`, `path.resolve` usage is correct. No `chmod`/`chown`, no `/var`/`/etc`/`~`, no bash/sh spawns, no hardcoded Unix-only paths in production code.
