// 08-HERMES / policy / mcp-tool-policy.mjs
//
// Hardened MCP tool-call policy layer.
//
// Wave 3 ships two new MCP adapters — chrome-devtools and computer-use — on
// top of the Wave 2 playwright adapter. Each adapter already validates the
// lease against its OWN per-verb risk table, but those tables live inside the
// adapter files and only cover the verbs that adapter wraps. As soon as a
// non-adapter caller (e.g. the gateway, a Hermes pre-action middleware, or a
// codexa job that reflects raw MCP tool names) wants to classify a tool call
// BEFORE picking an adapter, it has nowhere central to look.
//
// This module is that central place.
//
// Given an MCP tool call by NAME (the canonical `mcp__<server>__<tool>` form,
// OR the adapter's namespaced verb form like `cd.navigate_page`, OR the bare
// short name like `take_screenshot`) it returns a deterministic verdict:
//
//   {
//     risk_level:        "read_only" | "low" | "medium" | "high" | "destructive" | "production",
//     default_allowed:   boolean,    // safe-by-default when leasing minimally?
//     requires_approval: boolean,    // operator must explicitly approve?
//     server:            string,     // the MCP server name (e.g. "chrome-devtools")
//     tool:              string,     // the short tool name on that server
//     verb:              string,     // the canonical Hermes verb (e.g. "cd.navigate_page")
//     match:             "exact" | "pattern" | "default",
//     reason:            string,     // human-readable classification reason
//   }
//
// The function NEVER throws on unknown tool names — an unknown tool is
// classified as `destructive` with `default_allowed=false` and
// `requires_approval=true`. This is the fail-closed default. Callers that
// want to learn about gaps should inspect `match === "default"`.
//
// Hermes' lease-engine and the per-adapter policy are STILL authoritative —
// this module is the pre-flight classifier the gateway uses to:
//
//   1. decide whether a tool call needs an interactive operator approval
//      modal before even minting the lease, and
//   2. auto-build the lease.allowed[] from a list of intended tool calls
//      (see `buildAllowList`).
//
// If this classifier and an adapter's per-verb table disagree, the adapter's
// table wins on its own verbs (it has tighter context), and Hermes wins
// over both (it has gate evidence). This module is the floor, not the
// ceiling.
//
// HONEST GAPS
// ───────────
//  - The mapping below is hand-curated against the MCP tool registry as of
//    Wave 3. New tools that don't match a pattern fall through to the
//    fail-closed default. Adding a tool means editing this file.
//  - Pattern matching is regex-based and order-sensitive: the FIRST pattern
//    that matches wins. The registry is ordered most-specific-first.
//  - "default_allowed" reflects whether the tool is safe enough to put in a
//    minimal lease for that server. It does NOT mean "the lease engine will
//    let you call it without one". You still need a lease.
//  - Node 20+. ESM. No deps.

// ─── ladder ─────────────────────────────────────────────────────────────────

/**
 * Canonical risk ladder. Index = severity rank. Aligned with the adapter
 * ladders in computer-use.mjs and chrome-devtools.mjs. "production" is the
 * topmost rung and is reserved for the production-deploy / payments class
 * of verbs that the lease.mjs default forbidden[] already blocks.
 */
export const RISK_LADDER = Object.freeze([
  "read_only",
  "low",
  "medium",
  "high",
  "destructive",
  "production",
]);

/** Compare two risk levels. Returns -1, 0, +1. Unknowns sort to the top (most dangerous). */
export function compareRisk(a, b) {
  const ia = RISK_LADDER.indexOf(a);
  const ib = RISK_LADDER.indexOf(b);
  const ra = ia === -1 ? RISK_LADDER.length : ia;
  const rb = ib === -1 ? RISK_LADDER.length : ib;
  if (ra < rb) return -1;
  if (ra > rb) return +1;
  return 0;
}

// ─── policy table ───────────────────────────────────────────────────────────
//
// The registry is grouped by MCP server. Each entry has:
//   - `server`: the canonical short server name
//   - `tools`: an object map of short-tool-name → classification
//   - `patterns` (optional): regex fallbacks evaluated in order
//   - `verbPrefix` (optional): the namespace used in adapter verbs
//                             (e.g. "cd." for chrome-devtools)
//
// Classifications must specify { risk_level } and may override the derived
// `default_allowed` / `requires_approval`. By default:
//   default_allowed = risk_level in {read_only, low}
//   requires_approval = risk_level in {high, destructive, production}

const SERVER_REGISTRY = Object.freeze([
  // ─── chrome-devtools MCP ─────────────────────────────────────────────────
  {
    server: "chrome-devtools",
    verbPrefix: "cd.",
    tools: {
      // observation — read_only
      list_pages:                  { risk_level: "read_only" },
      take_snapshot:               { risk_level: "read_only" },
      take_screenshot:             { risk_level: "read_only" },
      list_console_messages:       { risk_level: "read_only" },
      get_console_message:         { risk_level: "read_only" },
      list_network_requests:       { risk_level: "read_only" },
      get_network_request:         { risk_level: "read_only" },
      take_memory_snapshot:        { risk_level: "read_only" },
      wait_for:                    { risk_level: "read_only" },
      performance_analyze_insight: { risk_level: "read_only" },

      // low — page-state changes without external write
      select_page:                 { risk_level: "low" },
      resize_page:                 { risk_level: "low" },
      emulate:                     { risk_level: "low" },
      hover:                       { risk_level: "low" },
      press_key:                   { risk_level: "low" },
      performance_start_trace:     { risk_level: "low" },
      performance_stop_trace:      { risk_level: "low" },
      lighthouse_audit:            { risk_level: "low" },

      // medium — observable side-effects on remote systems
      navigate_page:               { risk_level: "medium" },
      navigate_back:               { risk_level: "medium" },
      new_page:                    { risk_level: "medium" },
      click:                       { risk_level: "medium" },
      fill:                        { risk_level: "medium" },
      fill_form:                   { risk_level: "medium" },
      drag:                        { risk_level: "medium" },
      handle_dialog:               { risk_level: "medium" },

      // high — arbitrary code execution or filesystem read
      evaluate_script:             { risk_level: "high" },
      upload_file:                 { risk_level: "high" },

      // destructive — closes tabs / loses state
      close_page:                  { risk_level: "destructive" },
    },
  },

  // ─── computer-use MCP ────────────────────────────────────────────────────
  {
    server: "computer-use",
    verbPrefix: "desktop.",
    tools: {
      screenshot:    { risk_level: "low" },
      cursor_position: { risk_level: "read_only" },
      list_granted_applications: { risk_level: "read_only" },
      read_clipboard: { risk_level: "low" },
      mouse_move:    { risk_level: "low" },
      scroll:        { risk_level: "low" },
      wait:          { risk_level: "read_only" },
      zoom:          { risk_level: "low" },

      left_click:    { risk_level: "medium", requires_approval: true },
      right_click:   { risk_level: "medium", requires_approval: true },
      double_click:  { risk_level: "medium", requires_approval: true },
      middle_click:  { risk_level: "medium", requires_approval: true },
      triple_click:  { risk_level: "medium", requires_approval: true },
      type:          { risk_level: "medium", requires_approval: true },
      key:           { risk_level: "medium", requires_approval: true },
      hold_key:      { risk_level: "medium", requires_approval: true },

      left_click_drag: { risk_level: "high" },
      left_mouse_down: { risk_level: "high" },
      left_mouse_up:   { risk_level: "high" },
      write_clipboard: { risk_level: "medium" },
      open_application: { risk_level: "medium" },
      switch_display:   { risk_level: "low" },

      // batch + teach can synthesize any sequence — treat as high
      computer_batch:   { risk_level: "high" },
      teach_batch:      { risk_level: "high" },
      teach_step:       { risk_level: "high" },

      // explicit consent operations
      request_access:        { risk_level: "low" },
      request_teach_access:  { risk_level: "low" },
    },
    patterns: [
      // any unmapped computer-use tool defaults to high (the desktop is
      // materially scarier than a sandboxed browser page)
      { re: /^.*$/, risk_level: "high", reason: "computer-use default" },
    ],
  },

  // ─── playwright MCP ──────────────────────────────────────────────────────
  {
    server: "playwright",
    verbPrefix: "browser.",
    tools: {
      browser_snapshot:         { risk_level: "read_only" },
      browser_console_messages: { risk_level: "read_only" },
      browser_network_requests: { risk_level: "read_only" },
      browser_network_request:  { risk_level: "read_only" },
      browser_take_screenshot:  { risk_level: "read_only" },

      browser_hover:            { risk_level: "low" },
      browser_press_key:        { risk_level: "low" },
      browser_resize:           { risk_level: "low" },
      browser_wait_for:         { risk_level: "low" },
      browser_select_option:    { risk_level: "low" },
      browser_tabs:             { risk_level: "low" },

      browser_click:            { risk_level: "medium" },
      browser_type:             { risk_level: "medium" },
      browser_fill_form:        { risk_level: "medium" },
      browser_drag:             { risk_level: "medium" },
      browser_drop:             { risk_level: "medium" },
      browser_navigate:         { risk_level: "medium" },
      browser_navigate_back:    { risk_level: "medium" },
      browser_handle_dialog:    { risk_level: "medium" },
      browser_file_upload:      { risk_level: "high" },
      browser_evaluate:         { risk_level: "high" },
      browser_run_code_unsafe:  { risk_level: "destructive" },
      browser_close:            { risk_level: "destructive" },
    },
  },

  // ─── filesystem MCP (read = low, write = high, delete = destructive) ─────
  {
    server: "filesystem-atomeons",
    tools: {
      read_file:               { risk_level: "read_only" },
      read_text_file:          { risk_level: "read_only" },
      read_media_file:         { risk_level: "read_only" },
      read_multiple_files:     { risk_level: "read_only" },
      list_directory:          { risk_level: "read_only" },
      list_directory_with_sizes: { risk_level: "read_only" },
      directory_tree:          { risk_level: "read_only" },
      get_file_info:           { risk_level: "read_only" },
      list_allowed_directories: { risk_level: "read_only" },
      search_files:            { risk_level: "read_only" },

      create_directory:        { risk_level: "low" },
      write_file:              { risk_level: "high" },
      edit_file:               { risk_level: "high" },
      move_file:               { risk_level: "destructive" },
    },
  },

  // ─── github MCP (most reads OK; writes high; merges/destructive guarded) ─
  {
    server: "github",
    patterns: [
      { re: /^(get|list|search)_/, risk_level: "read_only", reason: "read verb prefix" },
      { re: /^(create|add|update)_(pull_request|issue|branch|file|label|comment|reply)/, risk_level: "high", reason: "github write" },
      { re: /^(merge|delete|fork)_/, risk_level: "destructive", reason: "github merge/delete/fork" },
      { re: /^push_/, risk_level: "high", reason: "github push" },
      { re: /^run_secret_scanning$/, risk_level: "low", reason: "secret scan read-only result" },
      { re: /^.*$/, risk_level: "high", reason: "github default" },
    ],
  },

  // ─── supabase / database (cost / mutation / schema) ──────────────────────
  // The mcp__5c7fbfed-...-supabase server. Pattern-based for resilience to
  // tool-name churn.
  {
    server: "supabase",
    patterns: [
      { re: /^(list|get|search)_/, risk_level: "read_only", reason: "read verb prefix" },
      { re: /^generate_typescript_types$/, risk_level: "read_only", reason: "type generation" },
      { re: /^get_advisors$/, risk_level: "read_only", reason: "advisor read" },
      { re: /^get_logs$/, risk_level: "read_only", reason: "log read" },
      { re: /^execute_sql$/, risk_level: "high", reason: "arbitrary sql" },
      { re: /^apply_migration$/, risk_level: "destructive", reason: "schema migration" },
      { re: /^create_project$/, risk_level: "production", reason: "project create" },
      { re: /^(pause|restore)_project$/, risk_level: "production", reason: "project lifecycle" },
      { re: /^deploy_edge_function$/, risk_level: "production", reason: "edge deploy" },
      { re: /^(create|delete|reset|rebase|merge)_branch$/, risk_level: "destructive", reason: "branch mutation" },
      { re: /^confirm_cost$/, risk_level: "high", reason: "cost confirmation" },
      { re: /^.*$/, risk_level: "high", reason: "supabase default" },
    ],
  },

  // ─── vercel ──────────────────────────────────────────────────────────────
  {
    server: "vercel",
    patterns: [
      { re: /^(list|get|search)_/, risk_level: "read_only", reason: "read verb prefix" },
      { re: /^(get_deployment|get_project|get_runtime)/, risk_level: "read_only", reason: "vercel read" },
      { re: /^deploy_to_vercel$/, risk_level: "production", reason: "production deploy" },
      { re: /^check_domain_availability_and_price$/, risk_level: "low", reason: "domain check" },
      { re: /^.*$/, risk_level: "medium", reason: "vercel default" },
    ],
  },
]);

// ─── name parsing ───────────────────────────────────────────────────────────

/**
 * Parse an MCP-ish tool reference into { server, tool, source }.
 *
 * Accepted shapes:
 *   "mcp__<server>__<tool>"        → { server, tool, source: "mcp_namespace" }
 *   "mcp__<uuid>__<tool>"          → server resolved via UUID_TO_SERVER if known
 *   "<verbPrefix><tool>"            → server inferred by prefix (e.g. "cd.")
 *   "<server>:<tool>" or "<server>/<tool>" → { server, tool, source: "delim" }
 *   "<tool>" (bare)                → server inferred by exact tool-name lookup
 *
 * Returns null on no-match so callers can decide to fail-closed.
 */
export function parseToolName(name) {
  if (typeof name !== "string" || name.length === 0) return null;
  const raw = name.trim();

  // mcp__<server>__<tool>
  const mcp = raw.match(/^mcp__([^_]+(?:[-_][a-z0-9]+)*)__(.+)$/i);
  if (mcp) {
    const server = resolveServerAlias(mcp[1]);
    return { server, tool: mcp[2], source: "mcp_namespace" };
  }

  // <verbPrefix><rest>  — adapter-namespaced verbs
  for (const entry of SERVER_REGISTRY) {
    if (entry.verbPrefix && raw.startsWith(entry.verbPrefix)) {
      return { server: entry.server, tool: raw.slice(entry.verbPrefix.length), source: "verb_prefix" };
    }
  }

  // <server>:<tool>  or  <server>/<tool>
  const delim = raw.match(/^([a-z0-9_-]+)[:\/]([a-z0-9_.\-]+)$/i);
  if (delim) {
    return { server: resolveServerAlias(delim[1]), tool: delim[2], source: "delim" };
  }

  // bare tool — try exact lookup in every registry
  for (const entry of SERVER_REGISTRY) {
    if (entry.tools && Object.prototype.hasOwnProperty.call(entry.tools, raw)) {
      return { server: entry.server, tool: raw, source: "bare_exact" };
    }
  }

  return null;
}

// UUID-keyed MCP servers in the operator's registry are aliased to short
// names so the policy table stays stable across reconnects. Add new
// aliases here as the registry grows.
const UUID_TO_SERVER = Object.freeze({
  "5c7fbfed-1cd8-4816-94da-af57316a6405": "supabase",
  "5c846130-b4d7-4f54-aa2e-caf8b67581fa": "vercel",
});

function resolveServerAlias(s) {
  const k = String(s).toLowerCase();
  if (Object.prototype.hasOwnProperty.call(UUID_TO_SERVER, k)) return UUID_TO_SERVER[k];
  return k;
}

// ─── classification ─────────────────────────────────────────────────────────

/**
 * Classify a single MCP tool call. Never throws on unknown — fails closed
 * with risk_level = "destructive", default_allowed = false, requires_approval = true.
 *
 * @param {string|object} ref — either the raw tool name OR { server, tool }
 * @returns {{
 *   risk_level: string,
 *   default_allowed: boolean,
 *   requires_approval: boolean,
 *   server: string|null,
 *   tool: string|null,
 *   verb: string|null,
 *   match: "exact"|"pattern"|"default",
 *   reason: string,
 * }}
 */
export function classifyToolCall(ref) {
  let parsed;
  if (typeof ref === "string") {
    parsed = parseToolName(ref);
    if (parsed === null) return failClosed(ref, "unrecognized tool name");
  } else if (ref && typeof ref === "object" && typeof ref.tool === "string") {
    parsed = { server: ref.server ? resolveServerAlias(ref.server) : null, tool: ref.tool, source: "object" };
  } else {
    return failClosed(String(ref), "invalid argument");
  }

  const { server, tool } = parsed;
  const entry = server ? SERVER_REGISTRY.find((e) => e.server === server) : null;

  // 1. Exact tool match on the matched server.
  if (entry && entry.tools && Object.prototype.hasOwnProperty.call(entry.tools, tool)) {
    const t = entry.tools[tool];
    return verdict({
      server, tool, entry,
      risk_level: t.risk_level,
      match: "exact",
      reason: t.reason || `exact tool match on ${server}`,
      overrides: t,
    });
  }

  // 2. Pattern match on the matched server.
  if (entry && Array.isArray(entry.patterns)) {
    for (const p of entry.patterns) {
      if (p.re.test(tool)) {
        return verdict({
          server, tool, entry,
          risk_level: p.risk_level,
          match: "pattern",
          reason: p.reason || `pattern match on ${server}`,
          overrides: p,
        });
      }
    }
  }

  // 3. No server matched at all — try bare exact across every registry.
  if (!entry) {
    for (const e of SERVER_REGISTRY) {
      if (e.tools && Object.prototype.hasOwnProperty.call(e.tools, tool)) {
        const t = e.tools[tool];
        return verdict({
          server: e.server, tool, entry: e,
          risk_level: t.risk_level,
          match: "exact",
          reason: t.reason || `cross-server exact match on ${e.server}`,
          overrides: t,
        });
      }
    }
  }

  // 4. Fail closed.
  return failClosed(`${server || "?"}::${tool}`, server ? "unknown tool on known server" : "unknown server");
}

function verdict({ server, tool, entry, risk_level, match, reason, overrides }) {
  const rank = RISK_LADDER.indexOf(risk_level);
  if (rank === -1) return failClosed(`${server}::${tool}`, `invalid risk_level "${risk_level}"`);

  const default_allowed_default = rank <= RISK_LADDER.indexOf("low");
  const requires_approval_default = rank >= RISK_LADDER.indexOf("high");

  const default_allowed =
    typeof overrides?.default_allowed === "boolean" ? overrides.default_allowed : default_allowed_default;
  const requires_approval =
    typeof overrides?.requires_approval === "boolean" ? overrides.requires_approval : requires_approval_default;

  const verb = entry?.verbPrefix ? `${entry.verbPrefix}${tool}` : null;

  return {
    risk_level,
    default_allowed,
    requires_approval,
    server,
    tool,
    verb,
    match,
    reason,
  };
}

function failClosed(label, reason) {
  return {
    risk_level: "destructive",
    default_allowed: false,
    requires_approval: true,
    server: null,
    tool: null,
    verb: null,
    match: "default",
    reason: `fail-closed: ${reason} (${label})`,
  };
}

// ─── lease auto-build ───────────────────────────────────────────────────────

/**
 * Given a list of intended tool calls (by name), compute the minimal lease
 * fields the gateway should mint:
 *
 *   {
 *     allowed: string[],          // canonical Hermes verbs (or raw tool names if no verbPrefix)
 *     riskLevel: string,          // the MAX rung the lease needs
 *     requires_approval: boolean, // any one verb requires approval → lease does too
 *     unknown: string[],          // input names that fell to fail-closed
 *     items: object[],            // per-input verdict for audit
 *   }
 *
 * The "allowed" entries are the strings adapter `assertLeaseCoversVerb`
 * expects in lease.allowed[]. For servers WITHOUT a verbPrefix, the raw
 * tool name is used (chrome-devtools-via-cd. → "cd.navigate_page";
 * filesystem → "write_file").
 */
export function buildAllowList(toolNames) {
  if (!Array.isArray(toolNames)) {
    throw new TypeError("buildAllowList(toolNames): toolNames must be an array");
  }
  const allowed = new Set();
  const items = [];
  const unknown = [];
  let maxRisk = "read_only";
  let needsApproval = false;

  for (const name of toolNames) {
    const v = classifyToolCall(name);
    items.push({ input: name, ...v });

    if (v.match === "default") {
      unknown.push(name);
      // fail-closed still bumps the lease risk — calling the gateway must
      // surface "unknown" so the operator can refuse to proceed.
      maxRisk = riskMax(maxRisk, v.risk_level);
      if (v.requires_approval) needsApproval = true;
      continue;
    }

    const verbOrTool = v.verb || v.tool;
    if (verbOrTool) allowed.add(verbOrTool);
    maxRisk = riskMax(maxRisk, v.risk_level);
    if (v.requires_approval) needsApproval = true;
  }

  return {
    allowed: [...allowed].sort(),
    riskLevel: maxRisk,
    requires_approval: needsApproval,
    unknown,
    items,
  };
}

function riskMax(a, b) {
  return compareRisk(a, b) >= 0 ? a : b;
}

// ─── audit / introspection ──────────────────────────────────────────────────

/**
 * List every (server, tool, risk_level) triple in the registry. Useful for
 * tests and for the operator-facing /v1/hermes/policy snapshot endpoint.
 */
export function listAllPolicies() {
  const out = [];
  for (const e of SERVER_REGISTRY) {
    if (e.tools) {
      for (const [tool, t] of Object.entries(e.tools)) {
        out.push({
          server: e.server,
          tool,
          verb: e.verbPrefix ? `${e.verbPrefix}${tool}` : null,
          risk_level: t.risk_level,
        });
      }
    }
  }
  return out;
}

/** Stable module identity for diagnostics. */
export const POLICY_META = Object.freeze({
  id: "hermes.policy.mcp-tool.v1",
  schema: "orange5.hermes.mcp-tool-policy.v1",
  ladder: RISK_LADDER,
  server_count: SERVER_REGISTRY.length,
});
