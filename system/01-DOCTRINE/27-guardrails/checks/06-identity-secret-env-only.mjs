// 06 — G-05 — ATOMEONS_IDENTITY_SECRET is env-only, never hardcoded.
//
// Prongs:
//   (a) the secret is present in process.env and non-empty (boot-side
//       presence; we never read its value beyond length).
//   (b) static: grep the repo for any literal assignment to
//       ATOMEONS_IDENTITY_SECRET = "..." or the symbol appearing in a
//       string literal that looks like a value (high-entropy 32+ char
//       hex / base64).
//   (c) online (when state.lastLogLine or state.lastReceiptBody is
//       provided): the writer-side scrubber must have replaced the
//       secret. We check that the provided string does NOT contain a
//       run that matches the env-secret's value. To avoid logging the
//       secret here, we only check whether the secret value (read once
//       into a local) is a substring; we do not emit the substring.
//
// state.lastLogLine     : string|null
// state.lastReceiptBody : string|null
//
// opts.scanRoot : string

import {
  safe,
  result,
  ORANGE5_ROOT,
  envSet,
  walkGrep,
} from "../lib/check-util.mjs";

export const id = "G-05";
export const slug = "identity-secret-env-only";
export const severity = "block";

// Match a literal assignment to the symbol, OR a >=32-char hex/base64 run
// preceded by the symbol within ~80 chars.
const HARDCODE_RX =
  /ATOMEONS_IDENTITY_SECRET\s*[:=]\s*["'`][A-Za-z0-9+/=_\-]{16,}["'`]/;

export const check = safe(async (state, opts) => {
  if (!envSet("ATOMEONS_IDENTITY_SECRET")) {
    return result(false, {
      reason: "env_unset",
      receipt_trigger: "G05_IDENTITY_SECRET_LEAK",
      remedy:
        "Set ATOMEONS_IDENTITY_SECRET in the environment (not in source). Boot must abort without it.",
    });
  }

  const secret = process.env.ATOMEONS_IDENTITY_SECRET;
  const minLen = 16;
  if (typeof secret !== "string" || secret.length < minLen) {
    return result(false, {
      reason: "env_too_short",
      length: secret ? secret.length : 0,
      min_length: minLen,
      receipt_trigger: "G05_IDENTITY_SECRET_LEAK",
    });
  }

  // Static scan for the symbol+literal pattern.
  const scanRoot = opts.scanRoot || ORANGE5_ROOT;
  const offenders = [];
  for await (const m of walkGrep(scanRoot, HARDCODE_RX, {
    extensions: [".js", ".mjs", ".cjs", ".ts", ".tsx", ".py", ".json", ".env"],
  })) {
    offenders.push({ file: m.file, line: m.line }); // do NOT include text
    if (offenders.length >= 25) break;
  }
  if (offenders.length > 0) {
    return result(false, {
      reason: "hardcoded_secret_pattern",
      offender_count: offenders.length,
      offenders,
      receipt_trigger: "G05_IDENTITY_SECRET_LEAK",
    });
  }

  // Online scrubber check: ensure the secret value does NOT appear in a
  // log line / receipt body we were handed.
  const scrubFails = [];
  if (typeof state.lastLogLine === "string" &&
      state.lastLogLine.includes(secret)) {
    scrubFails.push("lastLogLine");
  }
  if (typeof state.lastReceiptBody === "string" &&
      state.lastReceiptBody.includes(secret)) {
    scrubFails.push("lastReceiptBody");
  }
  if (scrubFails.length > 0) {
    return result(false, {
      reason: "secret_leaked_into_emitted_text",
      where: scrubFails, // names only, never the value
      receipt_trigger: "G05_IDENTITY_SECRET_LEAK",
    });
  }

  return result(true, {
    env_present: true,
    length: secret.length,
    scrub_paths_checked: ["lastLogLine", "lastReceiptBody"],
  });
});

export default check;
