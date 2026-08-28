// AE OrangeEye facade — Visual capability under OrangeLLM.
// PR-13: contract surface, real wiring lands when MCP bridge + heavy-rail token are live.

/**
 * @typedef {Object} VisualDescription
 * @property {string} kind   — 'image'|'pdf'|'url'|'screenshot'
 * @property {string} text   — what was seen, in structured natural language
 * @property {Object} meta   — provenance: { tool, model, ms, source }
 */

const ENABLED = process.env.ORANGE5_VISUAL_ENABLED === "1";

async function notWired(kind) {
  return {
    kind,
    text: "(visual stack not yet wired — operator activates with ORANGE5_VISUAL_ENABLED=1 + GLM-4.6V heavy lane + MCP bridge)",
    meta: { tool: "stub", model: null, ms: 0, source: "PR-13 scaffold" },
  };
}

/** Describe an image at `path` using primary VLM (GLM-4.6V) or MiniEyes addendum. */
export async function describeImage(path) {
  if (!ENABLED) return notWired("image");
  // wiring: POST to GLM-4.6V via Codexa rail; return VisualDescription
  throw new Error("describeImage live wiring lands when heavy lane is reachable");
}

/** Inspect a URL via Playwright MCP. Returns DOM + a11y summary as structured text. */
export async function inspectUrl(url) {
  if (!ENABLED) return notWired("url");
  throw new Error("inspectUrl live wiring lands when Playwright MCP is bridged");
}

/** Take screenshot of `target` (window | region | url). */
export async function screenshot(target) {
  if (!ENABLED) return notWired("screenshot");
  throw new Error("screenshot live wiring lands when screenshot tool is wired");
}

export const SPEC = {
  primary: "GLM-4.6V (z.ai)",
  secondary: ["Playwright MCP", "Chrome DevTools MCP"],
  addendum: "MiniEyes Model (deferred)",
  enabled: ENABLED,
};
