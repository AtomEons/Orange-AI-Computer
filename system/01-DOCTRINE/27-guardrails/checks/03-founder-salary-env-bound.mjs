// 03 — G-02 — FOUNDER_SALARY_PER_INSTALL_CENTS is env-bound and never hardcoded.
//
// Two prongs:
//   (a) boot: process.env.FOUNDER_SALARY_PER_INSTALL_CENTS is set and parses
//       as a positive integer.
//   (b) static-grep: no source file contains a literal numeric assignment
//       to FOUNDER_SALARY_PER_INSTALL_CENTS (e.g. `= 5000`, `: 5000`).
//
// state.statusDb["G-02"].allowedFiles : string[] — explicit allowlist of
//   files permitted to contain the symbol (the env loader, the .env.example
//   template, this doctrine spec). Anything else is a breach.
//
// opts:
//   opts.scanRoot : string  — defaults to ORANGE5_ROOT
//   opts.skipEnv  : boolean — skip prong (a) (useful for static-only runs)

import {
  safe,
  result,
  ORANGE5_ROOT,
  envInt,
  walkGrep,
} from "../lib/check-util.mjs";

export const id = "G-02";
export const slug = "founder-salary-env-bound";
export const severity = "block";

const HARDCODE_RX =
  /FOUNDER_SALARY_PER_INSTALL_CENTS\s*[:=]\s*[0-9_]+/;

const DEFAULT_ALLOW = [
  /\.env(\..+)?$/,
  /\.env\.example$/,
  /27-guardrails[\\/].+\.md$/,
  /27-guardrails[\\/]checks[\\/]03-founder-salary-env-bound\.mjs$/,
  /docs?[\\/].+\.md$/,
];

export const check = safe(async (state, opts) => {
  const allow = (state.statusDb &&
    state.statusDb["G-02"] &&
    state.statusDb["G-02"].allowedFiles) || null;

  const evidence = { env: null, grep_hits: [] };

  if (!opts.skipEnv) {
    const n = envInt("FOUNDER_SALARY_PER_INSTALL_CENTS");
    evidence.env = n;
    if (n === null || n <= 0) {
      return result(false, {
        reason: "env_unset_or_invalid",
        env_value: process.env.FOUNDER_SALARY_PER_INSTALL_CENTS ?? null,
        receipt_trigger: "G02_FOUNDER_SALARY_UNSET",
      });
    }
  }

  const scanRoot = opts.scanRoot || ORANGE5_ROOT;
  const hits = [];
  for await (const m of walkGrep(scanRoot, HARDCODE_RX, {
    extensions: [".js", ".mjs", ".cjs", ".ts", ".tsx", ".py", ".env"],
  })) {
    const f = m.file.replace(/\\/g, "/");
    const allowed = allow
      ? allow.some((a) => f.endsWith(a))
      : DEFAULT_ALLOW.some((rx) => rx.test(f));
    if (allowed) continue;
    hits.push({ file: m.file, line: m.line, text: m.text });
    if (hits.length >= 25) break;
  }

  if (hits.length > 0) {
    evidence.grep_hits = hits;
    return result(false, {
      reason: "hardcoded_literal_found",
      offenders: hits,
      receipt_trigger: "G02_FOUNDER_SALARY_HARDCODE",
    });
  }

  return result(true, evidence);
});

export default check;
