// 08 — G-07 — No code editor in the operator surface.
//
// Static grep of `02-APP/` for monaco / codemirror / ace-editor / a
// `<textarea>` used as a code field (heuristic: `code-input`, `language=`,
// `prismjs`). 18-HELD/ is explicitly allowed and excluded by walkGrep's
// DEFAULT_SKIP. Returns offenders with file+line.

import { resolve } from "node:path";
import {
  safe,
  result,
  ORANGE5_ROOT,
  walkGrep,
} from "../lib/check-util.mjs";

export const id = "G-07";
export const slug = "no-code-editor-in-app";
export const severity = "block";

const EDITOR_RX =
  /\b(monaco-editor|@monaco-editor|codemirror|@codemirror|ace-builds|ace-editor|prismjs|@uiw\/react-codemirror|react-ace)\b/;

// Heuristic: textarea wired as a code field by attribute.
const TEXTAREA_CODE_RX =
  /<textarea[^>]*(class|className)\s*=\s*["'][^"']*\b(code|monaco|editor|prism)\b/i;

export const check = safe(async (state, opts) => {
  const appRoot = resolve(opts.scanRoot || ORANGE5_ROOT, "02-APP");

  const offenders = [];
  for await (const m of walkGrep(appRoot, EDITOR_RX, {
    extensions: [".js", ".mjs", ".ts", ".tsx", ".json", ".html", ".css"],
  })) {
    offenders.push({ file: m.file, line: m.line, text: m.text, hit: "pkg" });
    if (offenders.length >= 25) break;
  }
  if (offenders.length < 25) {
    for await (const m of walkGrep(appRoot, TEXTAREA_CODE_RX, {
      extensions: [".tsx", ".jsx", ".html"],
    })) {
      offenders.push({
        file: m.file,
        line: m.line,
        text: m.text,
        hit: "textarea",
      });
      if (offenders.length >= 25) break;
    }
  }

  if (offenders.length > 0) {
    return result(false, {
      reason: "code_editor_in_operator_surface",
      offenders,
      receipt_trigger: "G07_CODE_EDITOR_IN_SURFACE",
      remedy:
        "Move the editor to 18-HELD/. The operator surface is calm and premium; code-editing belongs to the bonded experimental area.",
    });
  }

  return result(true, { scanned_root: appRoot, offenders: 0 });
});

export default check;
