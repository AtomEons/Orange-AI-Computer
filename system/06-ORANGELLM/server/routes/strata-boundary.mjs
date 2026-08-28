// AE OrangeLLM — Knowledge Strata boundary allow-list
// Path: 06-ORANGELLM/server/routes/strata-boundary.mjs
//
// Purpose:
//   The main gateway boundary (server/boundary.mjs) enforces a strict
//   allow-list of {method, path} pairs. Strata routes live under /v1/strata/*
//   and must be added to that allow-list before they are reachable from
//   anywhere outside the loopback.
//
// Doctrine reminder:
//   - Knowledge Strata is the compiler loop that hardens raw operator /
//     agent input into durable, integrity-checked artifacts:
//
//         intake -> canon -> durable artifact -> integrity pass -> reuse
//
//   - intake / canonize / emit are write-shaped; query / resolve are
//     read-shaped. All five are exposed because the loop is end-to-end
//     useful from the frontier (an agent that writes a receipt and then
//     immediately cites the artifact id back).
//   - Strata storage lives on local disk under
//     06-ORANGELLM/memory/strata/, sibling to the Mirage memory cache.
//     It is NOT a Mirage DATA mount (postgres, drive, gmail, ...).
//     Mirage DATA mounts are not exposed through this gateway at all.
//   - Override flags (e.g. {allow_contradictions: true} on /emit) are
//     accepted but always logged. The frontier can mash the override
//     button; it cannot hide the press from the index.
//
// Usage (in boundary.mjs):
//
//     import { STRATA_ALLOWED } from "./routes/strata-boundary.mjs";
//     const ALLOWED = [
//       { method: "GET",  path: "/healthz" },
//       { method: "GET",  path: "/v1/models" },
//       { method: "POST", path: "/v1/chat/completions" },
//       ...MEMORY_ALLOWED,
//       ...STRATA_ALLOWED,
//       ...RECEIPTS_ALLOWED,
//       ...
//     ];
//
//   FORBIDDEN_PATH_PATTERNS in boundary.mjs already passes /v1/strata
//   because the prefix is /v1/, not /strata/. Keep it under /v1/.

export const STRATA_ALLOWED = Object.freeze([
  { method: "POST", path: "/v1/strata/intake"   },
  { method: "POST", path: "/v1/strata/canonize" },
  { method: "POST", path: "/v1/strata/emit"     },
  { method: "POST", path: "/v1/strata/query"    },
  { method: "POST", path: "/v1/strata/resolve"  },
  { method: "GET",  path: "/v1/strata/healthz"  },
]);

// Predicate form for the main boundary, mirroring memory-boundary.mjs.
export function isStrataRouteAllowed(method, pathName) {
  const m = (method || "").toUpperCase();
  return STRATA_ALLOWED.some(r => r.method === m && r.path === pathName);
}

// Namespace prefix — used for diagnostic logging and quick prefix checks
// in the main boundary before it walks the allow-list.
export const STRATA_PATH_PREFIX = "/v1/strata/";

// Headers that strata routes themselves use internally and that MUST NOT
// be forwarded from the frontier. The main boundary already blocks
// x-mirage-, x-orangebox-, x-codexa-, x-internal-. Restated here so future
// maintainers see the dependency co-located with the routes.
export const STRATA_FORBIDDEN_HEADER_PREFIXES = Object.freeze([
  "x-mirage-",
  "x-strata-",
  "x-cobra-",
  "x-codexa-",
  "x-orangebox-",
  "x-internal-",
]);
