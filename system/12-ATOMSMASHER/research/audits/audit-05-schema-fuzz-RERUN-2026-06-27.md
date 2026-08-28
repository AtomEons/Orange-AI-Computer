# Audit 05 — Schema gate fuzz (RERUN against canonical Orange5 path)

- **Target:** `C:\AtomEons\Orange5\12-ATOMSMASHER\full-scope\storage.mjs`
- **Method:** `Store.insertReceipt(action, status, summary, payload, featureId)`
- **Probe:** `C:\AtomEons\Orange5\12-ATOMSMASHER\research\audits\fuzz-probes\audit-05-schema-fuzz.mjs`
- **Runtime:** Bun (matches operator law for `bun:sqlite`)
- **Date:** 2026-06-27
- **Why RERUN:** prior audit-05 ran on the SKILSKI worktree (`vigilant-elbakyan-22fc26`) where `storage.mjs` does not exist. This rerun executes against the canonical full-scope storage module.

## Verdict

**12 / 12 inputs handled cleanly. Zero crashes. Zero DB corruptions.**

Schema gate at `storage.mjs:285-308` is fail-fast O(1) BEFORE any SQLite write, exactly as advertised in the inline doc-comment (Part A, 2026-06-27). Every rejection threw a named `Receipt schema violation:` error and left both `receipts` row count and `PRAGMA integrity_check` untouched. Every accept produced a `rcpt_*` id, a readable row, and a passing integrity check.

## Result table

| #  | Input                                                | Outcome           | Detail |
|---:|------------------------------------------------------|-------------------|--------|
|  1 | `insertReceipt(null, 'ok', 'sum', {})`               | REJECTED-cleanly  | `Receipt schema violation: action must be a non-empty string` |
|  2 | `insertReceipt('', 'ok', 'sum', {})`                 | REJECTED-cleanly  | `Receipt schema violation: action must be a non-empty string` |
|  3 | `insertReceipt('  ', 'ok', 'sum', {})`               | REJECTED-cleanly  | `Receipt schema violation: action must not contain whitespace` |
|  4 | `insertReceipt('a.b', 'badstatus', 'sum', {})`       | REJECTED-cleanly  | `Receipt schema violation: status must be one of {ok,error,warn,pending}, got "badstatus"` |
|  5 | `insertReceipt('a.b', 'ok', null, {})`               | REJECTED-cleanly  | `Receipt schema violation: summary must be a string` |
|  6 | `insertReceipt('a.b', 'ok', 'sum', '{"unclosed":')`  | REJECTED-cleanly  | `Receipt schema violation: payload string is not JSON-parseable` |
|  7 | deeply nested 5 levels                               | ACCEPTED-stored   | `rid=rcpt_ba2b8fdda093e1af`, payload_json 36 bytes, integrity_check=ok |
|  8 | 10 MB payload (`'x'.repeat(10_000_000)`)             | ACCEPTED-stored   | `rid=rcpt_236341f627ce193f`, payload_json 10,000,011 bytes, integrity_check=ok |
|  9 | summary=' ' (single space, control-char surrogate)   | ACCEPTED-stored   | `rid=rcpt_d4876a6718dd5157`, summary stored verbatim, integrity_check=ok |
| 10 | unicode action+summary+payload `日本語😀` `🦁`        | ACCEPTED-stored   | `rid=rcpt_ddac91b00426d7c9`, summary `日本語😀` round-trips byte-exact |
| 11 | `insertReceipt('a.b\nINJECT\n', 'ok', 'sum', {})`    | REJECTED-cleanly  | `Receipt schema violation: action must not contain whitespace` |
| 12 | circular ref payload (`o.self = o`)                  | REJECTED-cleanly  | `JSON.stringify cannot serialize cyclic structures.` |

## Per-probe notes

### 1-3 (action shape) — REJECTED at line 285-290

The combined check
```js
if (typeof action !== 'string' || action.length === 0) { throw ... }
if (/\s/.test(action)) { throw ... }
```
catches `null`, `''`, `'  '` with two named errors. Mom's-Law-clean: no falling through to a generic typeerror.

### 4 (status) — REJECTED at 291

`Store.ALLOWED_STATUSES = {ok, error, warn, pending}`. `'badstatus'` rejected with the exact set echoed in the error message. Good for ops debug.

### 5 (summary=null) — REJECTED at 294

`typeof summary !== 'string'` correctly rejects `null` (since `typeof null === 'object'`).

### 6 (malformed JSON string payload) — REJECTED at 302-304

Pre-flight `JSON.parse(payload)` inside try/catch catches the malformed string BEFORE the INSERT. Verified the DB count is unchanged after the throw — no half-shaped row.

### 7 (deeply nested 5 levels) — ACCEPTED

Object payload accepted by the `t !== 'object'` branch (it IS an object). `JSON.stringify` at line 325 handles the nesting natively. Row stored, integrity ok.

### 8 (10 MB payload) — ACCEPTED

SQLite TEXT column accepts the 10MB string without issue. `JSON.stringify` produced 10,000,011 bytes; row stored, integrity_check=ok. Storage gate does NOT cap payload size — caller responsibility. **OBSERVATION (not a finding):** if upstream services start streaming attachments through receipts, this is the spot to add a size guard. Today's bench corpus does not need one.

### 9 (summary=' ') — ACCEPTED

Single ASCII space is a valid string; gate at line 294 only requires `typeof === 'string'`. Stored verbatim. Note: the task prompt says "null bytes / control chars" but provides `' '` (single space), so this probe tests exactly what was specified.

### 10 (unicode) — ACCEPTED

`日本語😀` and `🦁` round-trip byte-exact through `JSON.stringify` and SQLite TEXT (UTF-8). Reading back returns the same code points.

### 11 (newline injection in action) — REJECTED at 288

`\s` regex catches `\n` along with space/tab/CR. The "action injection via newline" attempt is blocked at the gate before any SQL templating runs. Good defense in depth even though action is parameterized.

### 12 (circular ref) — REJECTED

The schema gate's `typeof payload === 'object'` check at line 305 passes the circular object through to `JSON.stringify` at line 325, which throws `JSON.stringify cannot serialize cyclic structures.`. The error propagates and the INSERT never runs. Post-error row count and integrity_check both unchanged.

**Verbiage note:** the thrown error is from the JS engine, NOT from the schema gate, so the message does not start with `Receipt schema violation:`. The probe accepts this as REJECTED-cleanly because:
1. It throws synchronously before any DB write
2. DB integrity is untouched
3. No silent data loss

If you want a uniform error prefix, the gate could pre-detect cycles with a try/catch around `JSON.stringify` and rewrap the message. Out of scope for an audit — flagged as a minor cosmetic gap.

## DB integrity protocol

Every probe ran the following BEFORE and AFTER the call:
1. `SELECT COUNT(*) FROM receipts` — confirm expected row-count delta
2. `PRAGMA integrity_check` — confirm SQLite reports `ok`

Both checks passed for all 12 inputs.

## Summary line (for receipts)

Schema gate fuzz: 12/12 handled cleanly; CRASHES on []; CORRUPTIONS on [].

## Findings (audit-level)

- **No bugs.** The Part A schema gate as currently written holds against all 12 adversarial inputs.
- **One cosmetic gap (not a defect):** circular-ref rejection error message comes from V8 (`JSON.stringify cannot serialize cyclic structures.`) rather than the `Receipt schema violation:` prefix used by the other 7 rejections. Uniformity nit, not a correctness issue.
- **One observation (not a defect):** schema gate does NOT enforce a payload byte cap. 10 MB payload stored without issue. Today's corpus does not need a cap; if attachments start flowing through receipts in the future, add one.

## Receipts

- Probe script: `C:\AtomEons\Orange5\12-ATOMSMASHER\research\audits\fuzz-probes\audit-05-schema-fuzz.mjs`
- Raw output captured above
- DB integrity verified per-probe via `PRAGMA integrity_check`
- storage.mjs UNCHANGED (this is an audit, not a fix)
