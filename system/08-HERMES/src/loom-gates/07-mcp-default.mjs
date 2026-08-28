// LOOM gate 7 — mcp_default
//
// Hermes pre-flight gate 7 of 8. Verifies that any action which uses an
// MCP (Model Context Protocol) tool produced evidence of a completed
// default MCP handshake against the tool's server. Concretely the gate
// asserts three things, in order:
//
//   1. server_reachable     — the MCP server transport was resolved
//                             (stdio command + args, OR an explicit
//                             URL endpoint we recognise as an MCP
//                             transport).
//   2. capabilities_exchanged
//                           — the JSON-RPC `initialize` handshake
//                             completed: the evidence carries a
//                             `protocolVersion`, a `capabilities`
//                             object, and a `serverInfo` block with
//                             `name` (per the MCP base protocol).
//   3. tool_card_resolved   — the specific tool the action calls
//                             (`action.tool` or `evidence.mcp.tool`)
//                             was returned by the server's
//                             `tools/list` response, with a non-empty
//                             `inputSchema`. A tool card resolved at
//                             handshake time is the load-bearing
//                             receipt that the server actually knows
//                             how to satisfy this action.
//
// Doctrine (08-HERMES/ project CLAUDE.md):
//   - Hermes replaces "OpenClaw". Every action by every LLM in the
//     superstack passes through the LOOM chain. The MCP adapters
//     currently in the operator's environment include Playwright MCP
//     and Chrome DevTools MCP (declared in PR-14-SPEC tool-adapter
//     section). This gate is provider-agnostic — it checks the
//     handshake shape, not the server identity.
//   - Hermes daemon listens on loopback 127.0.0.1:7430 for control
//     plane traffic. MCP servers used as tool adapters DO NOT have to
//     be loopback (some are stdio child processes, some are local
//     HTTP servers); the loopback rule is gate 6's concern, not this
//     gate's. We deliberately do not enforce host restrictions here.
//   - Frontier isolation: the frontier model NEVER speaks to MCP
//     servers directly. The gateway brokers tool-use; Hermes gates the
//     pre-flight. This gate runs after the action has been issued and
//     evidence accumulated, so it inspects evidence, not live sockets.
//
// Contract: actions that do NOT touch an MCP server (pure schema work,
// pure filesystem, lease-only operations) pass this gate as a no-op.
// The gate is only strict for actions whose `kind` declares MCP use
// (`mcp.*`, or `tool.use` with an `evidence.mcp` block, or any action
// carrying a non-null `evidence.mcp`).
//
// Module shape:
//   - default export: async function mcpDefaultGate(action, opts?) → { pass, reasons, evidence? }
//   - named exports:  mcpDefaultGate, declaresMcpUse, extractMcpEvidence,
//                     resolveRequestedTool, isServerReachable,
//                     hasCapabilitiesExchanged, hasToolCardResolved,
//                     GATE_ID, GATE_INDEX, MIN_PROTOCOL_VERSION,
//                     SUPPORTED_TRANSPORTS, REASON_*
//
// Action shape this gate reads (informal — full schema lives at
// 09-SCHEMAS/orange.action.v1.schema.json when it lands):
//   {
//     "id":     "action_…",
//     "kind":   "mcp.tool" | "tool.use" | …
//     "tool":   "browser_navigate",                  // OPTIONAL — falls back to evidence.mcp.tool
//     "evidence": {
//       "mcp": {                                     // present iff this action used an MCP tool
//         "server": {                                // REQUIRED — how the server was reached
//           "transport": "stdio" | "http" | "ws",
//           "command":   "npx",                      // for stdio
//           "args":      ["-y", "@modelcontextprotocol/server-playwright"],
//           "url":       "http://127.0.0.1:9000",    // for http/ws
//           "name":      "playwright",               // friendly id (optional)
//         },
//         "handshake": {                             // REQUIRED — initialize() round-trip
//           "protocolVersion": "2024-11-05",
//           "capabilities":   { "tools": {}, "resources": {} },
//           "serverInfo":     { "name": "playwright-mcp", "version": "0.6.1" },
//         },
//         "tool":    "browser_navigate",             // tool the action invoked
//         "tools":   [                               // tools/list result (or at minimum the
//                                                    //   resolved card for `tool`)
//           {
//             "name":        "browser_navigate",
//             "description": "Navigate to a URL",
//             "inputSchema": { "type": "object", "properties": { "url": { "type": "string" } } }
//           },
//           …
//         ]
//       },
//       …
//     }
//   }
//
// Refusal reasons (stable strings — adapters may key off these):
//   - "action_invalid"           — action arg was not a usable object
//   - "evidence_missing"         — action declares MCP use but no evidence.mcp
//   - "server_unreachable"       — server block missing or transport unrecognised
//   - "transport_unsupported"    — transport not in SUPPORTED_TRANSPORTS
//   - "handshake_missing"        — no handshake evidence
//   - "protocol_version_missing" — handshake has no protocolVersion
//   - "protocol_version_bad"     — protocolVersion older than MIN_PROTOCOL_VERSION
//   - "capabilities_missing"     — handshake.capabilities absent or not an object
//   - "server_info_missing"      — handshake.serverInfo absent or missing name
//   - "tool_unspecified"         — action declared MCP use but no tool name
//   - "tool_card_missing"        — tool not found in tools/list result
//   - "tool_card_invalid"        — tool card present but inputSchema empty/missing
//
// Honest gaps (read me):
//   - This gate inspects EVIDENCE, not a live socket. It is the
//     LOOM-time check, not a runtime traffic sniffer. The Hermes
//     daemon (out of band) is responsible for refusing to record a
//     handshake evidence block for a server it did not actually
//     reach, and for refusing to fabricate `tools/list` responses.
//     If the adapter is compromised and emits forged handshake
//     records, this gate will accept them — same trust boundary as
//     gates 4 and 6.
//   - We do NOT speak JSON-RPC here. We do not call `initialize`,
//     `tools/list`, or anything else. The gate is pure validation
//     against an in-memory evidence object. Live MCP traffic is the
//     adapter's job; we only certify that the receipt is well-formed.
//   - `protocolVersion` is compared lexicographically against
//     `MIN_PROTOCOL_VERSION`. The MCP project uses date-stamped
//     versions (e.g. "2024-11-05") which sort correctly under string
//     comparison; if the project ever switches to semver-style
//     versions, replace this with a real comparator and bump the
//     reason strings — do not loosen the comparison silently.
//   - `tools/list` is expected to be either flattened onto
//     `evidence.mcp.tools` (an array of tool cards) or supplied as
//     the singular resolved card for the action's tool. We accept
//     either shape. We do NOT require the adapter to upload every
//     tool the server advertises — only the card for the tool this
//     action actually invoked.
//   - We do not enforce loopback addresses for the MCP server. That
//     would be wrong: Playwright MCP and Chrome DevTools MCP both
//     run as local stdio children, not as loopback HTTP. Loopback
//     enforcement belongs to gate 6 (openai_gateway), which governs
//     the frontier egress, not MCP tool adapters.
//   - We accept any non-empty `inputSchema`. We do not validate that
//     the action's actual arguments conform to the schema — that is
//     gate 1's territory (order_schema) plus the adapter's own
//     pre-flight validator. Schema *existence* is the gate-7 check.
//   - This is gate 7 of 8. It does not look at lease shape (gate 5),
//     gateway origin (gate 6), receipts (gate 3), schemas (1, 2),
//     human approval (4), or status prose (8). Single-assertion
//     design, same as the other gates in this directory.
//   - Pure logic, no I/O, no network. Synchronous core wrapped in an
//     async surface to keep parity with the rest of the LOOM chain.
//   - Requires Node 20+ (uses optional chaining, structuredClone-free
//     local copies, `Array.isArray`).

export const GATE_ID = "mcp_default";
export const GATE_INDEX = 7;

// Minimum MCP base-protocol version we will accept on the handshake.
// The MCP project tags revisions as date strings; "2024-11-05" is the
// first revision that stabilised `initialize` / `tools/list` shape.
// Bump this only after auditing every adapter the operator depends on.
export const MIN_PROTOCOL_VERSION = "2024-11-05";

// Transports we recognise. `stdio` covers `npx ... mcp-server-*`
// children (the dominant case for Playwright MCP and Chrome DevTools
// MCP). `http` and `ws` cover local-network MCP servers. Other
// transports (sse, in-process) are not in scope for this gate.
export const SUPPORTED_TRANSPORTS = Object.freeze(["stdio", "http", "ws"]);

// Action kinds that imply MCP use. Conservative list — any kind
// starting with `mcp.` is treated as MCP regardless of suffix. We
// also gate `tool.use` because the operator's default-MCP adapters
// surface as generic tool-use from the action layer.
const MCP_KIND_PREFIX = "mcp.";
const MCP_EXPLICIT_KINDS = new Set([
  "mcp",
  "tool.use",
  "tool",
]);

// Stable refusal-reason tags. Surface strings include context; downstream
// code should match on the tag, not the prose.
export const REASON_ACTION_INVALID           = "action_invalid";
export const REASON_EVIDENCE_MISSING         = "evidence_missing";
export const REASON_SERVER_UNREACHABLE       = "server_unreachable";
export const REASON_TRANSPORT_UNSUPPORTED    = "transport_unsupported";
export const REASON_HANDSHAKE_MISSING        = "handshake_missing";
export const REASON_PROTOCOL_VERSION_MISSING = "protocol_version_missing";
export const REASON_PROTOCOL_VERSION_BAD     = "protocol_version_bad";
export const REASON_CAPABILITIES_MISSING     = "capabilities_missing";
export const REASON_SERVER_INFO_MISSING      = "server_info_missing";
export const REASON_TOOL_UNSPECIFIED         = "tool_unspecified";
export const REASON_TOOL_CARD_MISSING        = "tool_card_missing";
export const REASON_TOOL_CARD_INVALID        = "tool_card_invalid";

/**
 * Does this action declare that it used an MCP tool? Two signals:
 *   (a) action.kind starts with "mcp." or is in MCP_EXPLICIT_KINDS,
 *   (b) action.evidence.mcp is a non-null object (the actor itself
 *       attached an MCP evidence block).
 *
 * Either signal is sufficient. We take the union deliberately — same
 * rationale as gate 6's declaresLlmCall:
 *   - an adapter that forgets to set `kind: mcp.tool` but does fill
 *     in `evidence.mcp` should still be gated;
 *   - an adapter that sets `kind: mcp.tool` but forgets the evidence
 *     block must fail the gate (and will, via the evidence_missing
 *     path below).
 *
 * @param {object} action
 * @returns {boolean}
 */
export function declaresMcpUse(action) {
  if (!action || typeof action !== "object" || Array.isArray(action)) return false;
  const kind = typeof action.kind === "string" ? action.kind.toLowerCase() : "";
  if (kind.startsWith(MCP_KIND_PREFIX)) return true;
  if (MCP_EXPLICIT_KINDS.has(kind)) return true;
  const ev = action.evidence;
  if (ev && typeof ev === "object" && !Array.isArray(ev)) {
    if (ev.mcp && typeof ev.mcp === "object" && !Array.isArray(ev.mcp)) return true;
  }
  return false;
}

/**
 * Pull the MCP evidence sub-object out of an action. Returns null if
 * no block is present. Does NOT validate the contents — that is the
 * gate's job.
 *
 * @param {object} action
 * @returns {object | null}
 */
export function extractMcpEvidence(action) {
  if (!action || typeof action !== "object" || Array.isArray(action)) return null;
  const ev = action.evidence;
  if (!ev || typeof ev !== "object" || Array.isArray(ev)) return null;
  const mcp = ev.mcp;
  if (!mcp || typeof mcp !== "object" || Array.isArray(mcp)) return null;
  return mcp;
}

/**
 * Resolve the name of the MCP tool this action invoked. Lookup order:
 *   1. opts.tool                — explicit override (tests, replay)
 *   2. action.tool              — direct field on the action
 *   3. evidence.mcp.tool        — fallback on the evidence block
 *   4. action.params?.tool      — some adapters tuck it under params
 * Returns null if no tool name is resolvable.
 *
 * @param {object} action
 * @param {object | null} mcpEvidence
 * @param {{ tool?: string }} [opts]
 * @returns {string | null}
 */
export function resolveRequestedTool(action, mcpEvidence, opts = {}) {
  if (opts && typeof opts.tool === "string" && opts.tool.length > 0) {
    return opts.tool;
  }
  if (action && typeof action.tool === "string" && action.tool.length > 0) {
    return action.tool;
  }
  if (mcpEvidence && typeof mcpEvidence.tool === "string" && mcpEvidence.tool.length > 0) {
    return mcpEvidence.tool;
  }
  if (action && action.params && typeof action.params === "object" && !Array.isArray(action.params)) {
    if (typeof action.params.tool === "string" && action.params.tool.length > 0) {
      return action.params.tool;
    }
  }
  return null;
}

/**
 * Did the adapter surface enough information to claim the MCP server
 * was reachable? We require:
 *   - a `server` block on the evidence,
 *   - a recognised `transport`,
 *   - and the transport-specific identifier (command for stdio,
 *     url for http/ws).
 *
 * @param {object} mcpEvidence
 * @returns {{ ok: boolean, reason?: string }}
 */
export function isServerReachable(mcpEvidence) {
  const server = mcpEvidence && mcpEvidence.server;
  if (!server || typeof server !== "object" || Array.isArray(server)) {
    return { ok: false, reason: "server block missing on evidence.mcp" };
  }
  const transport = typeof server.transport === "string" ? server.transport.toLowerCase() : null;
  if (!transport) {
    return { ok: false, reason: "server.transport missing" };
  }
  if (!SUPPORTED_TRANSPORTS.includes(transport)) {
    return {
      ok: false,
      reason: `transport ${JSON.stringify(server.transport)} not in supported set ${JSON.stringify(SUPPORTED_TRANSPORTS)}`,
      tag: REASON_TRANSPORT_UNSUPPORTED,
    };
  }
  if (transport === "stdio") {
    if (typeof server.command !== "string" || server.command.length === 0) {
      return { ok: false, reason: "stdio transport requires non-empty server.command" };
    }
    // args is optional but if present must be an array of strings.
    if (server.args !== undefined) {
      if (!Array.isArray(server.args)) {
        return { ok: false, reason: "server.args must be array of strings when present" };
      }
      for (let i = 0; i < server.args.length; i++) {
        if (typeof server.args[i] !== "string") {
          return { ok: false, reason: `server.args[${i}] must be string` };
        }
      }
    }
    return { ok: true };
  }
  // http or ws
  if (typeof server.url !== "string" || server.url.length === 0) {
    return { ok: false, reason: `${transport} transport requires non-empty server.url` };
  }
  try {
    // URL parse just to ensure it is at least syntactically a URL.
    // We do not enforce host/port here (see honest-gaps).
    // eslint-disable-next-line no-new
    new URL(server.url);
  } catch {
    return { ok: false, reason: `server.url ${JSON.stringify(server.url)} is not a parseable URL` };
  }
  return { ok: true };
}

/**
 * Did the `initialize` round-trip complete? We require:
 *   - handshake.protocolVersion (string, ≥ MIN_PROTOCOL_VERSION),
 *   - handshake.capabilities    (non-null object),
 *   - handshake.serverInfo      (non-null object with non-empty `name`).
 *
 * Returns one reason tag at a time so callers can switch on it.
 *
 * @param {object} mcpEvidence
 * @returns {{ ok: boolean, reason?: string, tag?: string }}
 */
export function hasCapabilitiesExchanged(mcpEvidence) {
  const h = mcpEvidence && mcpEvidence.handshake;
  if (!h || typeof h !== "object" || Array.isArray(h)) {
    return { ok: false, reason: "handshake block missing", tag: REASON_HANDSHAKE_MISSING };
  }
  if (typeof h.protocolVersion !== "string" || h.protocolVersion.length === 0) {
    return { ok: false, reason: "handshake.protocolVersion missing", tag: REASON_PROTOCOL_VERSION_MISSING };
  }
  if (h.protocolVersion < MIN_PROTOCOL_VERSION) {
    return {
      ok: false,
      reason: `handshake.protocolVersion ${JSON.stringify(h.protocolVersion)} < MIN_PROTOCOL_VERSION ${JSON.stringify(MIN_PROTOCOL_VERSION)}`,
      tag: REASON_PROTOCOL_VERSION_BAD,
    };
  }
  const caps = h.capabilities;
  if (!caps || typeof caps !== "object" || Array.isArray(caps)) {
    return { ok: false, reason: "handshake.capabilities missing or not an object", tag: REASON_CAPABILITIES_MISSING };
  }
  const info = h.serverInfo;
  if (!info || typeof info !== "object" || Array.isArray(info)) {
    return { ok: false, reason: "handshake.serverInfo missing or not an object", tag: REASON_SERVER_INFO_MISSING };
  }
  if (typeof info.name !== "string" || info.name.length === 0) {
    return { ok: false, reason: "handshake.serverInfo.name missing or empty", tag: REASON_SERVER_INFO_MISSING };
  }
  return { ok: true };
}

/**
 * Did the server resolve a tool card for the action's tool?
 * Accepts either:
 *   - evidence.mcp.tools  : array of tool cards from tools/list
 *   - evidence.mcp.toolCard : single resolved card for `tool`
 *
 * The card must carry `name === tool` and a non-empty `inputSchema`
 * object. `description` is recommended but not enforced (some servers
 * omit descriptions for internal tools — out of scope to fight here).
 *
 * @param {object} mcpEvidence
 * @param {string} tool   resolved tool name from resolveRequestedTool
 * @returns {{ ok: boolean, reason?: string, tag?: string, card?: object }}
 */
export function hasToolCardResolved(mcpEvidence, tool) {
  let cards = [];
  if (Array.isArray(mcpEvidence.tools)) {
    cards = mcpEvidence.tools;
  } else if (mcpEvidence.toolCard && typeof mcpEvidence.toolCard === "object" && !Array.isArray(mcpEvidence.toolCard)) {
    cards = [mcpEvidence.toolCard];
  } else {
    return {
      ok: false,
      reason: "evidence.mcp.tools (array) or evidence.mcp.toolCard (object) required",
      tag: REASON_TOOL_CARD_MISSING,
    };
  }

  let match = null;
  for (const c of cards) {
    if (c && typeof c === "object" && !Array.isArray(c) && c.name === tool) {
      match = c;
      break;
    }
  }
  if (match === null) {
    return {
      ok: false,
      reason: `tool ${JSON.stringify(tool)} not found in tools/list result (${cards.length} cards inspected)`,
      tag: REASON_TOOL_CARD_MISSING,
    };
  }
  const schema = match.inputSchema;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return {
      ok: false,
      reason: `tool ${JSON.stringify(tool)} card has no inputSchema object`,
      tag: REASON_TOOL_CARD_INVALID,
      card: match,
    };
  }
  // "Non-empty" = at least one own key. A schema of literal `{}` is
  // technically valid JSON Schema (matches anything) but signals that
  // the adapter never actually fetched the card body.
  if (Object.keys(schema).length === 0) {
    return {
      ok: false,
      reason: `tool ${JSON.stringify(tool)} inputSchema is empty object — adapter likely did not fetch card`,
      tag: REASON_TOOL_CARD_INVALID,
      card: match,
    };
  }
  return { ok: true, card: match };
}

/**
 * LOOM gate 7 entry point. Pure decision over the action object. Never
 * throws on a failed check — only returns structured `{ pass: false,
 * reasons }`.
 *
 * Non-MCP actions pass as a no-op. MCP actions must surface:
 *   (1) a reachable, supported-transport MCP server,
 *   (2) a completed `initialize` handshake with protocolVersion,
 *       capabilities, and serverInfo,
 *   (3) a resolved tool card for the specific tool invoked, with a
 *       non-empty inputSchema.
 *
 * @param {object} action
 * @param {{
 *   tool?: string,
 * }} [opts]
 *   - `tool`: explicit override; bypasses tool discovery on the action.
 * @returns {Promise<{ pass: boolean, reasons: string[], evidence?: object, tool?: string, card?: object }>}
 */
export async function mcpDefaultGate(action, opts = {}) {
  if (!action || typeof action !== "object" || Array.isArray(action)) {
    return { pass: false, reasons: [REASON_ACTION_INVALID] };
  }

  // No-op for non-MCP actions.
  if (!declaresMcpUse(action)) {
    return { pass: true, reasons: [] };
  }

  const mcp = extractMcpEvidence(action);
  if (mcp === null) {
    return { pass: false, reasons: [REASON_EVIDENCE_MISSING] };
  }

  // (1) server_reachable
  const reach = isServerReachable(mcp);
  if (!reach.ok) {
    const tag = reach.tag || REASON_SERVER_UNREACHABLE;
    return { pass: false, reasons: [`${tag}: ${reach.reason}`], evidence: mcp };
  }

  // (2) capabilities_exchanged
  const caps = hasCapabilitiesExchanged(mcp);
  if (!caps.ok) {
    return { pass: false, reasons: [`${caps.tag}: ${caps.reason}`], evidence: mcp };
  }

  // (3) tool_card_resolved
  const tool = resolveRequestedTool(action, mcp, opts);
  if (tool === null) {
    return { pass: false, reasons: [REASON_TOOL_UNSPECIFIED], evidence: mcp };
  }
  const card = hasToolCardResolved(mcp, tool);
  if (!card.ok) {
    return { pass: false, reasons: [`${card.tag}: ${card.reason}`], evidence: mcp, tool };
  }

  return {
    pass: true,
    reasons: [],
    evidence: mcp,
    tool,
    card: card.card,
  };
}

export default mcpDefaultGate;
