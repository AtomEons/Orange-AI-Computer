// AE OrangeLLM — N150 stock-only utility gateway routes
// Path: 06-ORANGELLM/server/routes/n150-utility.mjs
//
// Doctrine (Wave 1):
//   - The Beelink N150 (4 cores, 16 GB RAM) hosts STOCK-ONLY utility models.
//     No custom training. No fine-tunes. No LoRA adapters. The three jobs are:
//       * Origin-based lane classifier        (default stock: qwen3:0.6b)
//       * Graph Weaver embedder               (default stock: nomic-embed-text)
//       * Emergency chat fallback             (default stock: qwen3:0.6b,
//                                              served only when Codexa is
//                                              unreachable; gated by the
//                                              fallback-chat daemon itself.)
//   - "Hot-swap" in this lane means swapping STOCK MODEL TAGS without taking
//     the service down. The daemons own the model pin; this gateway just
//     surfaces a thin proxy + a read+write admin door for the operator.
//   - The N150 daemons listen on loopback only:
//       classifier      127.0.0.1:7480
//       embedder        127.0.0.1:8798
//       fallback-chat   127.0.0.1:7481
//     This gateway also lives on N150 (loopback :1337), so the proxy hops
//     are intra-host — no LAN traversal, no Mirage involvement.
//   - Mom's Law: receipts only, no theater. Daemon errors propagate with
//     their real upstream status and a slice of the upstream body. No
//     silent fall-back to "ok". No retry storm. No fabricated embeddings.
//
// Routes exposed (all under /v1/n150/*):
//   POST /v1/n150/classify       — proxy → classifier  POST /classify
//   POST /v1/n150/embed          — proxy → embedder    POST /embed
//   POST /v1/n150/embed/batch    — proxy → embedder    POST /embed/batch
//   POST /v1/n150/fallback-chat  — proxy → fallback    POST /chat
//   GET  /v1/n150/health         — fan-out probe of all three daemons
//   GET  /v1/n150/model          — read current pinned model per daemon
//   POST /v1/n150/model          — hot-swap a daemon's stock model tag
//
// What this surface does NOT do:
//   - It does not host the models. Ollama on N150 hosts the weights; the
//     daemons own the request shape and receipts; this is the gateway veneer.
//   - It does not stream. Wave 1 is one-shot JSON in/out. Streaming arrives
//     when the chat-fallback activation logic is exercised under real load.
//   - It does not bypass the fallback's activation gate. If Codexa is
//     healthy, fallback-chat returns 503 by design and we surface that 503
//     truthfully. No "soft mode" that pretends Codexa is down to test.
//
// HTTP shape (mirrors sibling routes: cobra.mjs, receipts.mjs):
//   Success: { ...payload }
//   Error:   { error: { code, message, ... }, _ae_http_status: N }

// ---------------------------------------------------------------------------
// Config — env-bound, never hardcoded secrets. All targets are loopback.
// ---------------------------------------------------------------------------

const CLASSIFIER_URL = (process.env.N150_CLASSIFIER_URL || "http://127.0.0.1:7480").replace(/\/+$/, "");
const EMBEDDER_URL   = (process.env.N150_EMBEDDER_URL   || "http://127.0.0.1:8798").replace(/\/+$/, "");
const FALLBACK_URL   = (process.env.N150_FALLBACK_URL   || "http://127.0.0.1:7481").replace(/\/+$/, "");

const CLASSIFY_TIMEOUT_MS = clampInt(process.env.N150_CLASSIFY_TIMEOUT_MS, 5_000,  500, 30_000);
const EMBED_TIMEOUT_MS    = clampInt(process.env.N150_EMBED_TIMEOUT_MS,    10_000, 500, 60_000);
const CHAT_TIMEOUT_MS     = clampInt(process.env.N150_CHAT_TIMEOUT_MS,     60_000, 1_000, 180_000);
const PROBE_TIMEOUT_MS    = clampInt(process.env.N150_PROBE_TIMEOUT_MS,    2_500,  250, 10_000);

// Body caps. Embedder batch is the only place we expect non-trivial bytes.
const CLASSIFY_MAX_BYTES = 64 * 1024;
const EMBED_MAX_BYTES    = 1 * 1024 * 1024;   // 1 MiB — fits Graph Weaver chunks
const CHAT_MAX_BYTES     = 256 * 1024;
const MODEL_MAX_BYTES    = 4 * 1024;

// Allowed daemons for the /model surface. The string keys are the operator-
// facing identifiers; everything downstream uses these to look up the daemon
// base URL and path. New daemons get added here, not via a free-text param.
const DAEMONS = Object.freeze({
  classifier: { base: CLASSIFIER_URL, healthPath: "/healthz", modelPath: "/model" },
  embedder:   { base: EMBEDDER_URL,   healthPath: "/healthz", modelPath: "/admin/swap" },
  fallback:   { base: FALLBACK_URL,   healthPath: "/healthz", modelPath: "/admin/swap" },
});

// ---------------------------------------------------------------------------
// HTTP shape helpers — mirror cobra.mjs / guardrails.mjs.
// ---------------------------------------------------------------------------

function ok(body) { return body; }

function err(status, code, message, extra = {}) {
  return {
    error: { code, message, ...extra },
    _ae_http_status: status,
  };
}

function clampInt(raw, fallback, lo, hi) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.round(n), lo), hi);
}

// ---------------------------------------------------------------------------
// Fetch with timeout — same pattern used by cobra.mjs / upstream.mjs.
// We capture elapsed_ms because the operator's activation gates measure
// latency in milliseconds, not seconds, and we never want to lose that
// signal by reading it off a wall clock after the fact.
// ---------------------------------------------------------------------------

async function fetchWithTimeout(url, options = {}, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return { res, elapsed_ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

// Proxy helper. Forwards a JSON body to the named daemon and returns either
// the parsed JSON success body OR our standard err() envelope. We never let
// a daemon failure look like a success — that would breach Mom's Law.
async function proxyJson({ daemonName, base, path, body, timeoutMs, byteCap }) {
  let raw;
  try {
    raw = JSON.stringify(body ?? {});
  } catch (e) {
    return err(400, "invalid_body_json", `Body could not be re-serialized: ${String(e?.message || e)}`);
  }
  if (raw.length > byteCap) {
    return err(413, "body_too_large",
      `${daemonName} body exceeds cap (${raw.length} > ${byteCap} bytes).`);
  }

  const url = base + path;
  let upstream;
  try {
    upstream = await fetchWithTimeout(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: raw,
    }, timeoutMs);
  } catch (e) {
    const reason = e?.name === "AbortError" ? "daemon_timeout" : "daemon_unreachable";
    return err(504, reason,
      `N150 ${daemonName} at ${base} ${reason}: ${String(e?.message || e)}`,
      { daemon: daemonName, url });
  }

  const { res, elapsed_ms } = upstream;
  const ct = res.headers.get("content-type") || "";
  const isJson = ct.toLowerCase().includes("application/json");

  if (!res.ok) {
    let upstreamBody = null;
    try {
      upstreamBody = isJson ? await res.json() : await res.text();
    } catch (_) { /* swallow — we already have the status */ }
    return err(502, "daemon_http_error",
      `${daemonName} returned ${res.status}`,
      {
        daemon: daemonName,
        upstream_status: res.status,
        upstream_body: typeof upstreamBody === "string"
          ? upstreamBody.slice(0, 500)
          : upstreamBody,
        elapsed_ms,
      });
  }

  if (!isJson) {
    const text = await res.text().catch(() => "");
    return err(502, "daemon_non_json",
      `${daemonName} responded with non-JSON content-type "${ct}". This violates the utility-lane contract.`,
      { daemon: daemonName, upstream_body: text.slice(0, 500), elapsed_ms });
  }

  let parsed;
  try {
    parsed = await res.json();
  } catch (e) {
    return err(502, "daemon_json_parse_failed",
      `${daemonName} response failed JSON parse: ${String(e?.message || e)}`,
      { daemon: daemonName, elapsed_ms });
  }

  return { ...parsed, _ae_proxy: { daemon: daemonName, elapsed_ms } };
}

// ---------------------------------------------------------------------------
// POST /v1/n150/classify
// ---------------------------------------------------------------------------
//
// Body:
//   {
//     origin: string,          // required — the lane-origin string the
//                              //   classifier prefix-matches against, e.g.
//                              //   "sensor.imu", "thought.spiral", etc.
//     event_metadata?: object  // optional — daemon-side ML hook may use it.
//   }
//
// Returns the classifier's verdict verbatim plus our proxy receipt.

export async function handleN150Classify(body) {
  if (!body || typeof body !== "object") {
    return err(400, "invalid_body", "Body must be a JSON object.");
  }
  if (typeof body.origin !== "string" || body.origin.length === 0) {
    return err(400, "missing_origin", "Body.origin must be a non-empty string.");
  }
  if (body.origin.length > 512) {
    return err(413, "origin_too_large", `origin must be <= 512 chars; got ${body.origin.length}.`);
  }
  if (body.event_metadata != null && (typeof body.event_metadata !== "object" || Array.isArray(body.event_metadata))) {
    return err(422, "invalid_event_metadata", "event_metadata, if present, must be a JSON object.");
  }

  return await proxyJson({
    daemonName: "classifier",
    base: CLASSIFIER_URL,
    path: "/classify",
    body: { origin: body.origin, event_metadata: body.event_metadata || null },
    timeoutMs: CLASSIFY_TIMEOUT_MS,
    byteCap: CLASSIFY_MAX_BYTES,
  });
}

// ---------------------------------------------------------------------------
// POST /v1/n150/embed
// POST /v1/n150/embed/batch
// ---------------------------------------------------------------------------
//
// Embed body:
//   { text: string, model?: string }
//
// Batch body:
//   { inputs: string[], chunk?: number, model?: string }
//
// We do NOT silently truncate or recover here. If the embedder rejects a
// row, the caller sees that rejection in the per-row result. Graph Weaver
// is downstream and depends on the embedder being honest about failures.

export async function handleN150Embed(body) {
  if (!body || typeof body !== "object") {
    return err(400, "invalid_body", "Body must be a JSON object.");
  }
  if (typeof body.text !== "string" || body.text.length === 0) {
    return err(400, "missing_text", "Body.text must be a non-empty string.");
  }
  if (body.text.length > 32_000) {
    return err(413, "text_too_large", `text must be <= 32000 chars; got ${body.text.length}.`);
  }
  if (body.model != null && (typeof body.model !== "string" || body.model.length > 128)) {
    return err(422, "invalid_model", "model, if present, must be a string <= 128 chars.");
  }

  return await proxyJson({
    daemonName: "embedder",
    base: EMBEDDER_URL,
    path: "/embed",
    body: { text: body.text, ...(body.model ? { model: body.model } : {}) },
    timeoutMs: EMBED_TIMEOUT_MS,
    byteCap: EMBED_MAX_BYTES,
  });
}

export async function handleN150EmbedBatch(body) {
  if (!body || typeof body !== "object") {
    return err(400, "invalid_body", "Body must be a JSON object.");
  }
  if (!Array.isArray(body.inputs) || body.inputs.length === 0) {
    return err(400, "missing_inputs", "Body.inputs must be a non-empty array of strings.");
  }
  if (body.inputs.length > 256) {
    return err(413, "too_many_inputs", `inputs.length must be <= 256; got ${body.inputs.length}.`);
  }
  for (let i = 0; i < body.inputs.length; i++) {
    const s = body.inputs[i];
    if (typeof s !== "string") {
      return err(422, "invalid_input_row", `inputs[${i}] must be a string.`);
    }
    if (s.length > 32_000) {
      return err(413, "input_row_too_large", `inputs[${i}] exceeds 32000 chars.`);
    }
  }
  const chunk = body.chunk == null ? undefined : clampInt(body.chunk, 16, 1, 64);

  return await proxyJson({
    daemonName: "embedder",
    base: EMBEDDER_URL,
    path: "/embed/batch",
    body: {
      inputs: body.inputs,
      ...(chunk !== undefined ? { chunk } : {}),
      ...(body.model ? { model: body.model } : {}),
    },
    timeoutMs: EMBED_TIMEOUT_MS,
    byteCap: EMBED_MAX_BYTES,
  });
}

// ---------------------------------------------------------------------------
// POST /v1/n150/fallback-chat
// ---------------------------------------------------------------------------
//
// Body:
//   {
//     messages: [{ role: "system"|"user"|"assistant", content: string }, ...],
//     max_tokens?: int (1..2048, default 512),
//     temperature?: float (0..2, default 0.3)
//   }
//
// Activation gate lives in the daemon itself — when Codexa is healthy the
// daemon returns 503 with a "not_activated" envelope and we surface it
// truthfully. The gateway does NOT decide whether the fallback is allowed.

export async function handleN150FallbackChat(body) {
  if (!body || typeof body !== "object") {
    return err(400, "invalid_body", "Body must be a JSON object.");
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return err(400, "missing_messages", "Body.messages must be a non-empty array.");
  }
  if (body.messages.length > 64) {
    return err(413, "too_many_messages", `messages.length must be <= 64; got ${body.messages.length}.`);
  }
  for (let i = 0; i < body.messages.length; i++) {
    const m = body.messages[i];
    if (!m || typeof m !== "object") {
      return err(422, "invalid_message", `messages[${i}] must be an object.`);
    }
    if (!["system", "user", "assistant"].includes(m.role)) {
      return err(422, "invalid_message_role",
        `messages[${i}].role must be one of: system, user, assistant.`);
    }
    if (typeof m.content !== "string" || m.content.length === 0) {
      return err(422, "invalid_message_content",
        `messages[${i}].content must be a non-empty string.`);
    }
    if (m.content.length > 32_000) {
      return err(413, "message_content_too_large",
        `messages[${i}].content exceeds 32000 chars.`);
    }
  }

  const max_tokens  = clampInt(body.max_tokens, 512, 1, 2048);
  const temperature = (() => {
    const t = Number(body.temperature);
    if (!Number.isFinite(t)) return 0.3;
    return Math.min(Math.max(t, 0), 2);
  })();

  return await proxyJson({
    daemonName: "fallback-chat",
    base: FALLBACK_URL,
    path: "/chat",
    body: { messages: body.messages, max_tokens, temperature },
    timeoutMs: CHAT_TIMEOUT_MS,
    byteCap: CHAT_MAX_BYTES,
  });
}

// ---------------------------------------------------------------------------
// GET /v1/n150/health
// ---------------------------------------------------------------------------
//
// Fans out a /healthz probe to all three daemons in parallel and reports
// each one's liveness, elapsed_ms, and payload. Roll-up status is "ok"
// only when all three daemons answered with res.ok in under PROBE_TIMEOUT_MS.

async function probeDaemon(name) {
  const cfg = DAEMONS[name];
  const url = cfg.base + cfg.healthPath;
  let live = false;
  let elapsed_ms = null;
  let payload = null;
  let probe_error = null;
  try {
    const { res, elapsed_ms: ms } = await fetchWithTimeout(url, { method: "GET" }, PROBE_TIMEOUT_MS);
    elapsed_ms = ms;
    live = res.ok;
    payload = await res.json().catch(() => null);
  } catch (e) {
    probe_error = String(e?.message || e);
  }
  return { name, base: cfg.base, live, elapsed_ms, payload, error: probe_error };
}

export async function handleN150Health() {
  const names = Object.keys(DAEMONS);
  const results = await Promise.all(names.map(probeDaemon));
  const map = {};
  for (const r of results) map[r.name] = r;
  const all_live = results.every(r => r.live);
  return ok({
    status: all_live ? "ok" : "degraded",
    service: "n150-utility-gateway",
    lane: "stock-only utility (Wave 1)",
    doctrine: "no custom training; hot-swap = stock tag swap without service restart",
    daemons: map,
    timeouts: {
      probe_ms: PROBE_TIMEOUT_MS,
      classify_ms: CLASSIFY_TIMEOUT_MS,
      embed_ms: EMBED_TIMEOUT_MS,
      chat_ms: CHAT_TIMEOUT_MS,
    },
    generated_at: new Date().toISOString(),
  });
}

// ---------------------------------------------------------------------------
// GET  /v1/n150/model?daemon=classifier|embedder|fallback
// POST /v1/n150/model  { daemon, model }    — hot-swap stock tag, no restart
// ---------------------------------------------------------------------------
//
// The classifier exposes GET/POST /model directly. The embedder and the
// fallback-chat both expose POST /admin/swap for the swap, and surface the
// current model under GET /healthz. We normalize all of that here so the
// operator can use one shape.

export async function handleN150ModelGet(url) {
  const daemon = (url.searchParams.get("daemon") || "").toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(DAEMONS, daemon)) {
    return err(422, "invalid_daemon",
      `daemon must be one of: ${Object.keys(DAEMONS).join(", ")}.`);
  }
  const cfg = DAEMONS[daemon];

  // Classifier has a real GET /model; everyone else, we read /healthz and
  // extract the model field. We always return the same shape to the caller.
  let probeUrl;
  if (daemon === "classifier") {
    probeUrl = cfg.base + "/model";
  } else {
    probeUrl = cfg.base + cfg.healthPath;
  }

  let upstream;
  try {
    upstream = await fetchWithTimeout(probeUrl, { method: "GET" }, PROBE_TIMEOUT_MS);
  } catch (e) {
    const reason = e?.name === "AbortError" ? "daemon_timeout" : "daemon_unreachable";
    return err(504, reason,
      `N150 ${daemon} at ${cfg.base} ${reason}: ${String(e?.message || e)}`,
      { daemon });
  }
  const { res, elapsed_ms } = upstream;
  if (!res.ok) {
    return err(502, "daemon_http_error",
      `${daemon} returned ${res.status} on model read`,
      { daemon, upstream_status: res.status, elapsed_ms });
  }
  const payload = await res.json().catch(() => null);
  if (!payload || typeof payload !== "object") {
    return err(502, "daemon_non_json",
      `${daemon} returned non-JSON on model read.`,
      { daemon, elapsed_ms });
  }

  // Extract a normalized model string. Different daemons phrase it slightly
  // differently; we look in the most likely places without inventing data.
  const model =
    payload.model ??
    payload.active_model ??
    payload.bound_model ??
    (payload.config && payload.config.model) ??
    null;

  return ok({
    daemon,
    base: cfg.base,
    model,
    raw: payload,
    elapsed_ms,
    note: model
      ? "Stock tag bound. Hot-swap with POST /v1/n150/model { daemon, model }."
      : "Daemon did not surface a model field; this may indicate a stale build.",
  });
}

// Light syntactic guard: stock Ollama tags look like "name" or "name:tag".
// We deliberately reject anything that looks like a path or URL — operator
// is meant to swap STOCK MODEL TAGS only, per Wave 1 doctrine.
function looksLikeStockTag(tag) {
  if (typeof tag !== "string") return false;
  if (tag.length === 0 || tag.length > 128) return false;
  if (tag.includes("/") || tag.includes("\\")) return false;
  if (tag.startsWith(".") || tag.startsWith("-")) return false;
  return /^[A-Za-z0-9._:-]+$/.test(tag);
}

export async function handleN150ModelPost(body) {
  if (!body || typeof body !== "object") {
    return err(400, "invalid_body", "Body must be a JSON object.");
  }
  const daemon = String(body.daemon || "").toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(DAEMONS, daemon)) {
    return err(422, "invalid_daemon",
      `daemon must be one of: ${Object.keys(DAEMONS).join(", ")}.`);
  }
  if (!looksLikeStockTag(body.model)) {
    return err(422, "invalid_model_tag",
      "model must be a stock Ollama tag like \"qwen3:0.6b\" or \"nomic-embed-text\". No paths, no URLs, no custom adapters.");
  }
  const cfg = DAEMONS[daemon];

  return await proxyJson({
    daemonName: daemon,
    base: cfg.base,
    path: cfg.modelPath,
    body: { model: body.model },
    timeoutMs: PROBE_TIMEOUT_MS,
    byteCap: MODEL_MAX_BYTES,
  });
}

// ---------------------------------------------------------------------------
// Route allow-list + dispatcher (called from server/index.mjs).
// ---------------------------------------------------------------------------

export const N150_ALLOWED = Object.freeze([
  { method: "POST", path: "/v1/n150/classify" },
  { method: "POST", path: "/v1/n150/embed" },
  { method: "POST", path: "/v1/n150/embed/batch" },
  { method: "POST", path: "/v1/n150/fallback-chat" },
  { method: "GET",  path: "/v1/n150/health" },
  { method: "GET",  path: "/v1/n150/model" },
  { method: "POST", path: "/v1/n150/model" },
]);

export function isN150Path(pathname) {
  return typeof pathname === "string" && pathname.startsWith("/v1/n150/");
}

export function isN150RouteAllowed(method, pathname) {
  const m = (method || "").toUpperCase();
  return N150_ALLOWED.some(r => r.method === m && r.path === pathname);
}

export async function dispatchN150(req, url, { readBody }) {
  const method = (req.method || "").toUpperCase();
  const path = url.pathname;

  if (!isN150Path(path)) return null;
  if (!isN150RouteAllowed(method, path)) {
    return err(405, "method_not_allowed",
      `N150 utility surface does not allow ${method} ${path}.`,
      { allowed: N150_ALLOWED });
  }

  if (method === "GET" && path === "/v1/n150/health") {
    return await handleN150Health();
  }
  if (method === "GET" && path === "/v1/n150/model") {
    return await handleN150ModelGet(url);
  }

  const body = await safeReadBody(req, readBody);
  if (body && body._ae_http_status) return body;

  if (method === "POST" && path === "/v1/n150/classify")      return await handleN150Classify(body);
  if (method === "POST" && path === "/v1/n150/embed")         return await handleN150Embed(body);
  if (method === "POST" && path === "/v1/n150/embed/batch")   return await handleN150EmbedBatch(body);
  if (method === "POST" && path === "/v1/n150/fallback-chat") return await handleN150FallbackChat(body);
  if (method === "POST" && path === "/v1/n150/model")         return await handleN150ModelPost(body);

  // Allow-list passed but no handler matched — this would be a bug in this
  // file's dispatcher table. Surface it as 500 so it doesn't hide.
  return err(500, "dispatcher_drift",
    `N150 route ${method} ${path} is allow-listed but unhandled. Fix dispatchN150.`);
}

async function safeReadBody(req, readBody) {
  try {
    return await readBody(req);
  } catch (e) {
    return err(400, "invalid_body", String(e?.message || e));
  }
}
