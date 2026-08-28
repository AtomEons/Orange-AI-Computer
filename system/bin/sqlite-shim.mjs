// bin/sqlite-shim.mjs — Orange5 SQLite shim
//
// Operator law (2026-06-25): Bun-only. "i run bun now. if its node or prior i dont
// need or want it." This shim retires `better-sqlite3` (Node native binding) in
// favor of `bun:sqlite` (built into Bun, no native-build, no node-gyp).
//
// API parity with better-sqlite3 for the surface Orange5 actually uses:
//   - `new Database(path[, options])`
//   - `.prepare(sql).run(...)`  → { changes, lastInsertRowid }
//   - `.prepare(sql).get(...)`  → row | undefined
//   - `.prepare(sql).all(...)`  → row[]
//   - `.prepare(sql).iterate(...)` → IterableIterator<row>
//   - `.exec(sql)`               → void (multi-statement)
//   - `.transaction(fn)`         → callable wrapper
//   - `.close()`                 → void
//   - `.pragma(stmt, opts?)`     → row[] (default) or scalar (opts.simple = true)
//
// Consumers import as: `import Database from '../../bin/sqlite-shim.mjs'`
// (or via package.json `imports` map as `#sqlite` once that lands).
//
// Mom's Law: this shim does NOT silently fall back to Node. Bun-only.
// If you run on Node, this file throws on import.

if (typeof globalThis.Bun === 'undefined') {
  throw new Error(
    "Orange5 sqlite-shim requires Bun. Operator law: 'i run bun now. " +
    "if its node or prior i dont need or want it.' " +
    "Install Bun from https://bun.sh and re-run with `bun <file>`."
  );
}

const { Database: BunDatabase } = await import('bun:sqlite');

// ---------------------------------------------------------------------------
// Named-parameter binding parity
// ---------------------------------------------------------------------------
//
// better-sqlite3 binds `@name` / `$name` / `:name` placeholders from a plain
// object with BARE keys: `stmt.run({ name: value })`. bun:sqlite requires the
// bind-object keys to carry the placeholder sigil: `stmt.run({ '@name': value })`.
// A bare-key object leaves the parameter unbound, which surfaces as
// `NOT NULL constraint failed: <table>.<col>` — silent data loss, not a clean
// error. Orange5's store/adapter layer was written to the better-sqlite3
// contract (e.g. commitment-atoms/store.mjs passes atomToRow(atom) with bare
// keys), so the shim must accept bare keys to deliver the parity it promises.
//
// Fix: when a prepared statement is invoked with a single plain-object bind
// argument, mirror every bare key into its @/$/: sigil forms before handing it
// to bun. bun ignores sigil variants that don't match a placeholder and
// tolerates extra unused named keys, so mirroring all three sigils is safe
// regardless of which style the SQL used. Positional (array / scalar) binds
// and objects that already carry sigils pass through untouched.
// Verified against bun:sqlite in Bun 1.3.14.
function isPlainBindObject(v) {
  if (v === null || typeof v !== 'object') return false;
  if (Array.isArray(v)) return false;
  // Only remap ordinary record objects. Anything with a custom prototype
  // (Date, Buffer, TypedArray, etc.) is a scalar bind value, not a bag of
  // named params — leave it alone.
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function withSigilAliases(obj) {
  const out = {};
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    out[key] = value;
    const c0 = key.charCodeAt(0);
    // 64 '@', 36 '$', 58 ':' — if already sigil-prefixed, don't re-wrap.
    if (c0 !== 64 && c0 !== 36 && c0 !== 58) {
      out['@' + key] = value;
      out['$' + key] = value;
      out[':' + key] = value;
    }
  }
  return out;
}

// Remap the bind arguments for a statement invocation. A better-sqlite3 caller
// passes either positional values (`stmt.run(a, b, c)`) or a single named-param
// object (`stmt.run({ ... })`). We only touch the single-plain-object case.
function remapBindArgs(args) {
  if (args.length === 1 && isPlainBindObject(args[0])) {
    return [withSigilAliases(args[0])];
  }
  return args;
}

const _BIND_METHODS = ['run', 'get', 'all', 'iterate', 'values'];

// Wrap a bun:sqlite Statement so its bind-taking methods accept bare-key named
// objects. The wrapper is a thin proxy: bind methods go through remapBindArgs,
// everything else (columnNames, finalize, toString, etc.) delegates unchanged.
function wrapStatement(stmt) {
  if (!stmt || typeof stmt !== 'object') return stmt;
  for (const name of _BIND_METHODS) {
    const orig = stmt[name];
    if (typeof orig !== 'function') continue;
    stmt[name] = (...args) => orig.apply(stmt, remapBindArgs(args));
  }
  return stmt;
}

// Extend bun:sqlite's Database with the better-sqlite3 convenience methods
// Orange5 modules expect. Anything not listed here is inherited from bun:sqlite
// (exec, transaction, close, etc. — already API-compatible enough).
class Database extends BunDatabase {
  /**
   * better-sqlite3-compatible prepare(). Returns a bun:sqlite Statement whose
   * bind methods (run/get/all/iterate/values) accept better-sqlite3-style
   * bare-key named-parameter objects in addition to bun's native sigil-key
   * form. See the "Named-parameter binding parity" note above.
   */
  prepare(sql) {
    return wrapStatement(super.prepare(sql));
  }

  /**
   * bun:sqlite's own query() cache path also returns Statements. Some Orange5
   * code (and this shim's pragma()) uses query(); wrap it too so the parity is
   * uniform no matter which entry point produced the statement.
   */
  query(sql) {
    return wrapStatement(super.query(sql));
  }

  /**
   * better-sqlite3-compatible pragma() helper.
   *
   * - `db.pragma('journal_mode = WAL')` — set pragma, returns rows (often empty).
   * - `db.pragma('journal_mode')`        — get current value, returns row array.
   * - `db.pragma('user_version', { simple: true })` — return the scalar value.
   *
   * better-sqlite3 returns either an array of rows or (with `simple: true`) the
   * single scalar from the first column of the first row. We match both.
   */
  pragma(stmt, options = {}) {
    if (typeof stmt !== 'string' || stmt.length === 0) {
      throw new TypeError('pragma: stmt must be a non-empty string');
    }
    const sql = `PRAGMA ${stmt}`;
    const rows = this.query(sql).all();
    if (options && options.simple) {
      if (!rows || rows.length === 0) return undefined;
      const firstRow = rows[0];
      const firstKey = Object.keys(firstRow)[0];
      return firstRow[firstKey];
    }
    return rows;
  }
}

export default Database;
export { Database };
