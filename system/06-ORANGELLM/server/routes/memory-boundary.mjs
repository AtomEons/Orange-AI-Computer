// AE OrangeLLM — Mirage memory boundary allow-list
// Path: 06-ORANGELLM/server/routes/memory-boundary.mjs
//
// Purpose:
//   The main gateway boundary (server/boundary.mjs) enforces a strict
//   allow-list of {method, path} pairs. Memory routes live under /v1/memory/*
//   and must be added to that allow-list before they are reachable from
//   anywhere outside the loopback.
//
// Doctrine reminder:
//   - Memory routes are part of the Mirage MEMORY plane (Æ Cobra Flux ledgers,
//     Graph Weaver SQLite, receipts). They are NOT Mirage DATA mounts.
//   - Mirage DATA mounts (postgres, drive, gmail, slack, github, redis, ...)
//     are not exposed through OrangeLLM gateway at all. Do not add them here.
//   - Write ops on /v1/memory/* are Sovereign-only by upstream policy
//     (Æ Cobra enforces). The gateway exposes only the read-shaped
//     state-brief / recall / healthz triplet.
//
// Usage (in boundary.mjs):
//
//     import { MEMORY_ALLOWED } from "./routes/memory-boundary.mjs";
//     const ALLOWED = [
//       { method: "GET",  path: "/healthz" },
//       { method: "GET",  path: "/v1/models" },
//       { method: "POST", path: "/v1/chat/completions" },
//       ...MEMORY_ALLOWED,
//     ];
//
//   And update FORBIDDEN_PATH_PATTERNS to NOT block /v1/memory/* — the regex
//   `/^\/(mirage|codexa|orangebox|hermes|vault)\//i` already passes /v1/memory
//   because the prefix is /v1/, not /mirage/. The memory namespace deliberately
//   lives under /v1/ to stay OpenAI-shape-adjacent. Keep it that way.

export const MEMORY_ALLOWED = Object.freeze([
  { method: "POST", path: "/v1/memory/state-brief" },
  { method: "POST", path: "/v1/memory/recall"      },
  { method: "GET",  path: "/v1/memory/healthz"     },
]);

// Exported helper for the main boundary to call if it prefers a predicate
// shape over a flat allow-list join.
export function isMemoryRouteAllowed(method, pathName) {
  const m = (method || "").toUpperCase();
  return MEMORY_ALLOWED.some(r => r.method === m && r.path === pathName);
}

// Memory namespace prefix — useful for diagnostic logging and for the main
// boundary to recognize "this looks like a memory route" before deciding.
export const MEMORY_PATH_PREFIX = "/v1/memory/";

// Headers that the memory routes themselves consume internally and that
// MUST NOT be forwarded from the frontier. The main boundary already blocks
// x-mirage-, x-orangebox-, x-codexa-, x-internal-. We restate here so that
// future maintainers see the dependency in the same folder.
export const MEMORY_FORBIDDEN_HEADER_PREFIXES = Object.freeze([
  "x-mirage-",
  "x-cobra-",
  "x-codexa-",
  "x-orangebox-",
  "x-internal-",
]);
