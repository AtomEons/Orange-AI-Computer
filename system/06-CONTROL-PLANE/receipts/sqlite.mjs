// sqlite.mjs — local re-export of the Orange5 Bun SQLite shim.
//
// Why this file exists: the `#sqlite` subpath import is resolved against the
// nearest package.json — this directory's own package.json. Bun's subpath
// import resolver rejects targets that escape the package root with `../`,
// so the imports map cannot point directly at ../../bin/sqlite-shim.mjs.
// This in-package re-export keeps the `#sqlite` alias working while the real
// Bun-only shim (Mom's Law: no Node fallback) stays canonical in bin/.
export { default } from "../../bin/sqlite-shim.mjs";
export { Database } from "../../bin/sqlite-shim.mjs";
