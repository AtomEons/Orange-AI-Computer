// LOOM gate 6 — openai_gateway
//
// Hermes pre-flight gate 6 of 8. Verifies that any LLM call made on
// behalf of an action was mediated by the local Frontier-Isolation
// gateway at 127.0.0.1:1337 — i.e. the frontier model never opened a
// direct socket to OpenAI/Anthropic/Google/etc. and the AtomEons
// gateway is the sole egress point. Inspects `action.evidence` for a
// gateway-issued `request_id` plus a small set of corroborating
// origin markers.
//
// Doctrine (08-HERMES/PR-14-SPEC.md and project CLAUDE.md):
//   - Frontier-Isolation: the frontier model is reachable ONLY through
//     the gateway. The gateway lives on the loopback interface
//     127.0.0.1 port 1337. No other host:port satisfies this gate.
//   - Hermes is reachable only through the gateway (Hermes daemon
//     itself binds 127.0.0.1:7430 — that is the Hermes control plane,
//     NOT the frontier path). This gate's concern is the frontier
//     egress, so 7430 is irrelevant here and is documented as such.
//   - Every LLM call from any actor in the superstack must therefore
//     produce evidence that includes:
//       * a gateway-issued request id (UUID/ULID-ish, prefixed
//         "gw_" by the gateway),
//       * either the literal gateway URL/host:port the call hit,
//         OR a header echo proving the call went through the gateway
//         (gateway sets `x-orange-gateway: 1` on every response).
//
// Contract: actions that do NOT call an LLM at all (pure filesystem,
// pure schema work, etc.) pass this gate as a no-op. The gate is only
// strict for actions whose `kind` or `evidence.llm` declares an LLM
// step. This keeps the gate from blocking legitimate non-LLM work
// while still being a hard chokepoint for any frontier traffic.
//
// Module shape:
//   - default export: async function openaiGatewayGate(action, opts?) → { pass, reasons, evidence? }
//   - named exports:  openaiGatewayGate, extractLlmEvidence,
//                     declaresLlmCall, isGatewayOrigin,
//                     GATE_ID, GATE_INDEX, GATEWAY_HOST, GATEWAY_PORT,
//                     GATEWAY_BASE_URL, REQUEST_ID_PATTERN,
//                     REASON_*
//
// Action shape this gate reads (informal — full schema lives at
// 09-SCHEMAS/orange.action.v1.schema.json when it lands):
//   {
//     "id":     "action_…",
//     "kind":   "llm.completion" | "llm.chat" | "tool.use" | "fs.read" | …
//     "evidence": {
//       "llm": {                         // present iff this action called a frontier model
//         "request_id": "gw_01HZ…",      // issued by the gateway, REQUIRED here
//         "origin":     "http://127.0.0.1:1337",   // OR
//         "host":       "127.0.0.1",
//         "port":       1337,
//         "headers":    { "x-orange-gateway": "1", … }  // OPTIONAL corroborator
//       },
//       …
//     }
//   }
//
// Refusal reasons (stable strings — adapters may key off these):
//   - "action_invalid"               — action arg was not a usable object
//   - "evidence_missing"             — action declares LLM use but no evidence.llm
//   - "request_id_missing"           — evidence.llm has no request_id
//   - "request_id_malformed"         — request_id is the wrong shape / wrong prefix
//   - "gateway_origin_missing"       — no origin/host:port info on the evidence
//   - "gateway_origin_mismatch"      — origin/host:port points somewhere other than 127.0.0.1:1337
//   - "gateway_header_mismatch"      — x-orange-gateway header present but not "1"
//
// Honest gaps (read me):
//   - This gate inspects EVIDENCE, not the live socket. It is the
//     LOOM-time check, not a runtime traffic sniffer. The gateway
//     itself is responsible for refusing to emit a request_id for a
//     call it did not actually proxy, and for refusing to attach the
//     `x-orange-gateway: 1` header on a response it did not mint. If
//     the gateway is compromised and emits forged request_ids, this
//     gate will accept them — same trust boundary as gate 4 with
//     signatures. Tracked: see Hermes daemon roadmap.
//   - We deliberately do NOT call the gateway to verify the
//     request_id exists in its log here. That would (a) couple the
//     LOOM chain to a live network dependency, breaking determinism
//     in tests and replays, and (b) create a circular trust
//     relationship (we'd be asking the very component we're trying
//     to gate). The gateway-side log audit is a separate concern
//     handled out of band.
//   - `request_id` prefix is "gw_" by convention. The gateway's id
//     allocator (see 08-HERMES/PR-14-SPEC.md when published) uses
//     ULIDs prefixed `gw_`. If the prefix scheme ever changes, update
//     REQUEST_ID_PATTERN and bump the gate's reason strings — do not
//     overload this gate to accept multiple prefixes silently.
//   - `127.0.0.1` is the canonical loopback address. We do NOT accept
//     `localhost` (DNS dependent, can be hijacked via /etc/hosts) or
//     `::1` (the gateway binds v4 only by design — see PR-14-SPEC).
//     If the gateway ever dual-stacks, extend `isGatewayOrigin`
//     explicitly rather than loosening the regex.
//   - Port 1337 is the canonical Frontier-Isolation gateway port.
//     Configurable via `opts.gatewayPort` or env
//     `HERMES_OPENAI_GATEWAY_PORT` for staging environments. Tests
//     should pass `opts.gatewayHost`/`opts.gatewayPort` explicitly so
//     the env does not leak between cases.
//   - This gate is named `openai_gateway` for historical reasons
//     (the first frontier vendor proxied through the gateway was
//     OpenAI). The gateway is provider-agnostic in practice: any
//     frontier vendor call must traverse the same loopback proxy.
//     The gate ID is preserved for stable callers; treat the name
//     as "frontier_gateway" semantically.
//   - This is gate 6 of 8. It does not look at lease shape (gate 5),
//     receipts (gate 3), schemas (1, 2), human approval (4), MCP
//     handshake (7), or status prose (8). Single-assertion design,
//     same as the other gates in this directory.
//   - Pure logic, no I/O, no network. Synchronous core wrapped in an
//     async surface to keep parity with the rest of the LOOM chain.
//   - Requires Node 20+ (uses `URL`, `Number.isFinite`).

export const GATE_ID = "openai_gateway";
export const GATE_INDEX = 6;

// Canonical Frontier-Isolation gateway address. Loopback v4 only —
// see "Honest gaps" above for why we refuse `localhost` and `::1`.
export const GATEWAY_HOST = "127.0.0.1";
export const GATEWAY_PORT = Number(process.env.HERMES_OPENAI_GATEWAY_PORT) || 1337;
export const GATEWAY_BASE_URL = `http://${GATEWAY_HOST}:${GATEWAY_PORT}`;

// Header the gateway stamps on every response it mints. Adapters that
// pass headers through into evidence get this for free.
export const GATEWAY_HEADER = "x-orange-gateway";
export const GATEWAY_HEADER_VALUE = "1";

// Gateway request_id format: `gw_` followed by 16-32 base32/ULID-ish
// characters. We keep the alphabet permissive to survive minor format
// shifts but reject anything that does not start `gw_`.
export const REQUEST_ID_PATTERN = /^gw_[A-Za-z0-9_-]{8,64}$/;

// Action kinds that imply an LLM call. Conservative list — any kind
// starting with `llm.` is treated as LLM regardless of suffix.
const LLM_KIND_PREFIX = "llm.";
const LLM_EXPLICIT_KINDS = new Set([
  "llm",
  "completion",
  "chat",
  "frontier_call",
]);

// Stable refusal-reason tags. Surface strings include context;
// downstream code should match on the tag, not the prose.
export const REASON_ACTION_INVALID         = "action_invalid";
export const REASON_EVIDENCE_MISSING       = "evidence_missing";
export const REASON_REQUEST_ID_MISSING     = "request_id_missing";
export const REASON_REQUEST_ID_MALFORMED   = "request_id_malformed";
export const REASON_GATEWAY_ORIGIN_MISSING = "gateway_origin_missing";
export const REASON_GATEWAY_ORIGIN_MISMATCH = "gateway_origin_mismatch";
export const REASON_GATEWAY_HEADER_MISMATCH = "gateway_header_mismatch";

/**
 * Does this action declare that it called an LLM? Two signals:
 *   (a) action.kind starts with "llm." or is in LLM_EXPLICIT_KINDS,
 *   (b) action.evidence.llm is a non-null object (the actor itself
 *       attached an LLM evidence block).
 *
 * Either signal is sufficient. We take the union deliberately:
 *   - an adapter that forgets to set `kind: llm.chat` but does fill
 *     in `evidence.llm` should still be gated;
 *   - an adapter that sets `kind: llm.chat` but forgets the
 *     evidence block must fail the gate (and will, via the
 *     evidence_missing path below).
 *
 * @param {object} action
 * @returns {boolean}
 */
export function declaresLlmCall(action) {
  if (!action || typeof action !== "object") return false;
  const kind = typeof action.kind === "string" ? action.kind.toLowerCase() : "";
  if (kind.startsWith(LLM_KIND_PREFIX)) return true;
  if (LLM_EXPLICIT_KINDS.has(kind)) return true;
  const ev = action.evidence;
  if (ev && typeof ev === "object" && !Array.isArray(ev)) {
    if (ev.llm && typeof ev.llm === "object" && !Array.isArray(ev.llm)) return true;
  }
  return false;
}

/**
 * Pull the LLM evidence sub-object out of an action, normalising
 * shape. Returns null if no block is present. Does NOT validate the
 * contents — that is the gate's job.
 *
 * @param {object} action
 * @returns {object | null}
 */
export function extractLlmEvidence(action) {
  if (!action || typeof action !== "object") return null;
  const ev = action.evidence;
  if (!ev || typeof ev !== "object" || Array.isArray(ev)) return null;
  const llm = ev.llm;
  if (!llm || typeof llm !== "object" || Array.isArray(llm)) return null;
  return llm;
}

/**
 * Does the supplied origin information point at the canonical
 * gateway (127.0.0.1:<configured port>)? Accepts any of:
 *   - llm.origin     : string URL ("http://127.0.0.1:1337" or "http://127.0.0.1:1337/v1/chat")
 *   - llm.host+port  : "127.0.0.1" + numeric port
 *   - llm.url        : alias for origin, accepted for convenience
 *
 * @param {object} llm                 normalised LLM evidence block
 * @param {{ gatewayHost?: string, gatewayPort?: number }} [opts]
 * @returns {{ ok: boolean, reason?: string }}
 */
export function isGatewayOrigin(llm, opts = {}) {
  const host = (opts.gatewayHost || GATEWAY_HOST).trim();
  const port = Number.isFinite(opts.gatewayPort) ? Number(opts.gatewayPort) : GATEWAY_PORT;

  // (1) URL string forms — llm.origin or llm.url
  const urlStr = (typeof llm.origin === "string" && llm.origin)
              || (typeof llm.url === "string" && llm.url)
              || null;
  if (urlStr) {
    let parsed;
    try {
      parsed = new URL(urlStr);
    } catch {
      return { ok: false, reason: `cannot parse origin url ${JSON.stringify(urlStr)}` };
    }
    // URL.port is "" for default ports; we always require an explicit
    // port match against the gateway port. Loopback gateway never runs
    // on the URL-default port.
    const parsedPort = parsed.port === "" ? null : Number(parsed.port);
    if (parsed.hostname !== host) {
      return {
        ok: false,
        reason: `origin host ${JSON.stringify(parsed.hostname)} != gateway host ${JSON.stringify(host)}`,
      };
    }
    if (parsedPort !== port) {
      return {
        ok: false,
        reason: `origin port ${JSON.stringify(parsed.port)} != gateway port ${port}`,
      };
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return {
        ok: false,
        reason: `origin protocol ${JSON.stringify(parsed.protocol)} not http(s)`,
      };
    }
    return { ok: true };
  }

  // (2) Discrete host + port fields
  if (typeof llm.host === "string" && llm.host.length > 0) {
    if (llm.host !== host) {
      return {
        ok: false,
        reason: `host ${JSON.stringify(llm.host)} != gateway host ${JSON.stringify(host)}`,
      };
    }
    if (!Number.isFinite(llm.port) || Number(llm.port) !== port) {
      return {
        ok: false,
        reason: `port ${JSON.stringify(llm.port)} != gateway port ${port}`,
      };
    }
    return { ok: true };
  }

  // (3) Nothing present — caller decides whether that is fatal.
  return { ok: false, reason: "no origin/host:port present" };
}

/**
 * Check the optional `x-orange-gateway` header echo. The header is a
 * corroborator, not a strict requirement — an action may pass without
 * it as long as origin and request_id check out. But if the header IS
 * present and has the wrong value, that is a hard fail (it would mean
 * an adapter is forging the header field, which is worse than
 * omitting it).
 *
 * @param {object} llm
 * @returns {{ present: boolean, ok: boolean, reason?: string }}
 */
function checkGatewayHeader(llm) {
  const headers = llm.headers;
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
    return { present: false, ok: true };
  }
  // Header lookup is case-insensitive by HTTP rules; evidence blocks
  // may arrive normalised either way.
  let found = null;
  for (const [k, v] of Object.entries(headers)) {
    if (typeof k === "string" && k.toLowerCase() === GATEWAY_HEADER) {
      found = v;
      break;
    }
  }
  if (found === null || found === undefined) return { present: false, ok: true };
  const asStr = String(found).trim();
  if (asStr !== GATEWAY_HEADER_VALUE) {
    return {
      present: true,
      ok: false,
      reason: `${GATEWAY_HEADER} header is ${JSON.stringify(asStr)}, expected ${JSON.stringify(GATEWAY_HEADER_VALUE)}`,
    };
  }
  return { present: true, ok: true };
}

/**
 * LOOM gate 6 entry point. Pure decision over the action object plus
 * configured gateway address. Never throws on a failed check — only
 * returns structured `{ pass: false, reasons }`.
 *
 * Non-LLM actions pass as a no-op. LLM actions must surface
 * (a) a well-formed gateway request_id, and (b) origin info that
 * resolves to 127.0.0.1:<gatewayPort>. The `x-orange-gateway` header
 * is an optional corroborator but, if present, must equal "1".
 *
 * @param {object} action
 * @param {{
 *   gatewayHost?: string,
 *   gatewayPort?: number,
 * }} [opts]
 * @returns {Promise<{ pass: boolean, reasons: string[], evidence?: object | null }>}
 */
export async function openaiGatewayGate(action, opts = {}) {
  // 0. action sanity
  if (action === null || typeof action !== "object" || Array.isArray(action)) {
    return {
      pass: false,
      reasons: [`${REASON_ACTION_INVALID}: action must be an object`],
    };
  }

  // 1. Non-LLM action → no-op pass.
  if (!declaresLlmCall(action)) {
    return { pass: true, reasons: [], evidence: null };
  }

  // 2. LLM action → evidence block required.
  const llm = extractLlmEvidence(action);
  if (!llm) {
    return {
      pass: false,
      reasons: [
        `${REASON_EVIDENCE_MISSING}: action declares LLM use ` +
        `(kind=${JSON.stringify(action.kind)}) but action.evidence.llm is missing`,
      ],
    };
  }

  const reasons = [];

  // 3. request_id presence + shape
  const rid = llm.request_id;
  if (typeof rid !== "string" || rid.length === 0) {
    reasons.push(`${REASON_REQUEST_ID_MISSING}: evidence.llm.request_id must be a non-empty string`);
  } else if (!REQUEST_ID_PATTERN.test(rid)) {
    reasons.push(
      `${REASON_REQUEST_ID_MALFORMED}: request_id ${JSON.stringify(rid)} ` +
      `does not match ${REQUEST_ID_PATTERN.source} (gateway issues ids prefixed "gw_")`,
    );
  }

  // 4. origin / host:port — must resolve to gateway
  const originCheck = isGatewayOrigin(llm, opts);
  if (!originCheck.ok) {
    // Distinguish "nothing supplied" from "supplied but wrong".
    if (originCheck.reason === "no origin/host:port present") {
      reasons.push(
        `${REASON_GATEWAY_ORIGIN_MISSING}: evidence.llm must include origin/url ` +
        `or host+port pointing at ${opts.gatewayHost || GATEWAY_HOST}:${opts.gatewayPort || GATEWAY_PORT}`,
      );
    } else {
      reasons.push(`${REASON_GATEWAY_ORIGIN_MISMATCH}: ${originCheck.reason}`);
    }
  }

  // 5. optional header corroborator
  const headerCheck = checkGatewayHeader(llm);
  if (!headerCheck.ok) {
    reasons.push(`${REASON_GATEWAY_HEADER_MISMATCH}: ${headerCheck.reason}`);
  }

  if (reasons.length > 0) {
    return { pass: false, reasons, evidence: llm };
  }
  return { pass: true, reasons: [], evidence: llm };
}

export default openaiGatewayGate;
