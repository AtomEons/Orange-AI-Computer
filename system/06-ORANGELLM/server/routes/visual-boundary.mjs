// AE OrangeLLM — Visual route boundary allow-list
// Path: 06-ORANGELLM/server/routes/visual-boundary.mjs
//
// Purpose:
//   The main gateway boundary (server/boundary.mjs) enforces a strict
//   allow-list of {method, path} pairs. Visual routes live under /v1/visual/*
//   and must be added to that allow-list before they are reachable from
//   anywhere outside the loopback.
//
// Doctrine reminder:
//   - Visual routes are part of OrangeEye Phase-1 (see
//     07-VISUAL/AE_ORANGEEYE_FOUNDATION_SPEC.md).
//   - Ingest writes to Qdrant 'orange5-vision' and to the Reality lane via
//     the Æ Cobra Flux writer. The frontier model NEVER touches either path
//     directly; it can only call /v1/visual/* on the gateway.
//   - /v1/visual/describe may internally offload to a frontier model. It does
//     so by self-calling /v1/chat/completions on this same gateway, so the
//     Frontier-Isolation Law is preserved by construction (one door only).
//   - Multipart bodies on /v1/visual/ingest are larger than JSON limits;
//     the gateway must NOT clamp them via the existing 1 MB JSON cap.
//     visual.mjs handles its own body-cap (ORANGE5_VISUAL_MAX_BYTES, default 50 MB).
//
// Usage (in boundary.mjs):
//
//     import { VISUAL_ALLOWED } from "./routes/visual-boundary.mjs";
//     const ALLOWED = [
//       { method: "GET",  path: "/healthz" },
//       { method: "GET",  path: "/v1/models" },
//       { method: "POST", path: "/v1/chat/completions" },
//       ...MEMORY_ALLOWED,
//       ...VISUAL_ALLOWED,
//     ];
//
//   The existing FORBIDDEN_PATH_PATTERNS regex
//   `/^\/(api|admin|cmd|exec|shell|fs)/i` and
//   `/^\/(mirage|codexa|orangebox|hermes|vault)\//i`
//   already pass /v1/visual/ because the prefix is /v1/. Keep visual routes
//   under /v1/ to stay OpenAI-shape-adjacent and to inherit that pass.

export const VISUAL_ALLOWED = Object.freeze([
  { method: "POST", path: "/v1/visual/ingest"        },
  { method: "POST", path: "/v1/visual/ingest/batch"  },
  { method: "POST", path: "/v1/visual/query"         },
  { method: "POST", path: "/v1/visual/describe"      },
  { method: "GET",  path: "/v1/visual/queue"         },
  // /v1/visual/queue/:id is matched by prefix below.
  { method: "POST", path: "/v1/visual/video/ingest"  },
]);

// Visual queue item lookup uses a path param (/v1/visual/queue/:id). The flat
// allow-list above only stores fixed paths, so we expose a prefix predicate the
// main boundary can OR in alongside the exact-match check.
export const VISUAL_PREFIX_ALLOWED = Object.freeze([
  { method: "GET",    prefix: "/v1/visual/queue/" },
  { method: "DELETE", prefix: "/v1/visual/queue/" },
]);

// Helper predicate for callers that prefer a function over a flat join.
export function isVisualRouteAllowed(method, pathName) {
  const m = (method || "").toUpperCase();
  if (VISUAL_ALLOWED.some((r) => r.method === m && r.path === pathName)) return true;
  return VISUAL_PREFIX_ALLOWED.some(
    (r) => r.method === m && pathName.startsWith(r.prefix) && pathName.length > r.prefix.length
  );
}

// Visual namespace prefix — useful for diagnostic logging and for the main
// boundary to recognize "this looks like a visual route" before deciding.
export const VISUAL_PATH_PREFIX = "/v1/visual/";

// Headers the visual routes consume internally. The main boundary already
// blocks x-mirage-, x-orangebox-, x-codexa-, x-internal-. The visual routes
// add no new forbidden header families. Authorization is still validated by
// the main boundary (Bearer-shape) and is passed through to the gateway's
// own /v1/chat/completions when describe() offloads to a frontier model.
export const VISUAL_FORBIDDEN_HEADER_PREFIXES = Object.freeze([
  "x-mirage-",
  "x-cobra-",
  "x-codexa-",
  "x-orangebox-",
  "x-internal-",
  "x-orangeeye-", // reserve this namespace so the frontier can't smuggle internal directives
]);

// Body-size cap notes for the main boundary:
//   - JSON cap for /v1/visual/query and /v1/visual/describe is small (~1 MB).
//   - Multipart cap for /v1/visual/ingest is large (default 50 MB,
//     overridable via ORANGE5_VISUAL_MAX_BYTES). The handler enforces this
//     itself; do not pre-read or pre-cap in index.mjs for ingest.
export const VISUAL_BODY_CAPS = Object.freeze({
  "POST /v1/visual/ingest":        50 * 1024 * 1024, // multipart binary
  "POST /v1/visual/ingest/batch":   1 * 1024 * 1024, // JSON: paths[], small
  "POST /v1/visual/query":          1 * 1024 * 1024, // small JSON
  "POST /v1/visual/describe":       1 * 1024 * 1024, // small JSON
  "POST /v1/visual/video/ingest":   1 * 1024 * 1024, // JSON: {path, interval_sec}
  "GET /v1/visual/queue":           0,               // no body
});
