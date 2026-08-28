// AE OrangeLLM — boundary middleware
// Enforces Frontier-Isolation Law: the frontier model can ONLY reach this gateway.
// Every rejection logs to receipt. No silent allow.

import { MEMORY_ALLOWED } from "./routes/memory-boundary.mjs";
import {
  RECEIPTS_ALLOWED,
  isReceiptsPath,
  isReceiptsRouteAllowed,
} from "./routes/receipts-boundary.mjs";
import { MISFIT_ALLOWED } from "./routes/misfit-boundary.mjs";
import { GUARDRAILS_ALLOWED } from "./routes/guardrails-boundary.mjs";
import {
  TOOLMESH_ALLOWED,
  isToolmeshPath,
  isToolmeshRouteAllowed,
} from "./routes/toolmesh-boundary.mjs";
import {
  HERMES_ALLOWED,
  isHermesRouteAllowed,
} from "./routes/hermes-boundary.mjs";
import {
  isHermesMcpPath,
  isHermesMcpRouteAllowed,
} from "./routes/hermes-mcp-boundary.mjs";
import {
  VISUAL_ALLOWED,
  isVisualRouteAllowed,
} from "./routes/visual-boundary.mjs";
import {
  isBuildRunPath,
  isBuildRunRouteAllowed,
} from "./routes/build-runs.mjs";

export const BOUNDARY_VIOLATION = "BOUNDARY_VIOLATION";

const ALLOWED = [
  { method: "GET", path: "/livez" },
  { method: "GET", path: "/healthz" },
  { method: "GET", path: "/v1/models" },
  { method: "GET", path: "/v1/ops/learning" },
  { method: "GET", path: "/v1/ops/traces" },
  { method: "GET", path: "/v1/party-line" },
  { method: "POST", path: "/v1/party-line" },
  { method: "GET", path: "/v1/party-line/stream" },
  { method: "POST", path: "/v1/party-line/hydrate" },
  { method: "POST", path: "/v1/chat/completions" },
  // M2 — AE Eyes codec translator (Path 1). Backend-only. See
  // 07-VISUAL/structural/codec-translator.mjs and AE_STRUCTURAL_TOKENS_v1.md.
  { method: "POST", path: "/v1/visual/structure" },
  // M3 — AE Eyes retinal transform (Path 2). Backend-only. See
  // 07-VISUAL/structural/retinal-transform.mjs and AE_STRUCTURAL_TOKENS_v1.md.
  { method: "POST", path: "/v1/visual/retinal" },
  // OrangeEye ingest, retrieval, description, queue, and video surfaces.
  // Dynamic queue-item paths are matched by isVisualRouteAllowed below.
  ...VISUAL_ALLOWED,
  // Mirage MEMORY plane (read-shaped triplet). DATA mounts are NOT exposed.
  ...MEMORY_ALLOWED,
  // Receipts read-only surface. Single-id route is dynamic; matched below.
  ...RECEIPTS_ALLOWED,
  // AE Misfit second-opinion gate (POST /v1/misfit/second-opinion).
  // Trained separately from OrangeLLM-fatty on STRONGARM + Gremlin for
  // refusal-discipline and fake-green detection. Fires before high-risk
  // Hermes actions.
  ...MISFIT_ALLOWED,
  // 27 Constitutional Guardrails + Soul Genome + Continuity Packet.
  // Read is open through the gateway; POST /v1/guardrails/run and
  // POST /v1/genome are operator-gated by ATOMEONS_IDENTITY_SECRET
  // inside the route handler (Guardrail #6: env-only, never hardcoded).
  ...GUARDRAILS_ALLOWED,
  // ToolMesh discovery (read-only). Surfaces the 11 capability labs and
  // their tool-cards so OrangeLLM can plan BEFORE asking the operator for
  // approval. Tool-cards are NOT permission-to-execute — execution is
  // gated by Hermes leases. The parametric labs/:lab/cards route is
  // matched by the isToolmeshRouteAllowed predicate, not by flat-list.
  ...TOOLMESH_ALLOWED,
  ...HERMES_ALLOWED,
];

const FORBIDDEN_HEADER_PREFIXES = [
  "x-mirage-",      // No Mirage mount headers — frontier never speaks Mirage
  "x-orangebox-",   // No raw Orangebox commands
  "x-codexa-",      // No direct Codexa rail
  "x-internal-",    // No internal-only routes
  "x-cobra-",       // No caller-supplied Reality-lane directives
  "x-orangeeye-",   // Reserved for trusted visual internals
];

const FORBIDDEN_PATH_PATTERNS = [
  /\.\./,           // No path traversal
  /^\/(api|admin|cmd|exec|shell|fs)/i,
  /^\/(mirage|codexa|orangebox|hermes|vault)\//i,
];

export function boundary({ method, path, headers }) {
  // Path-traversal + forbidden path patterns
  for (const re of FORBIDDEN_PATH_PATTERNS) {
    if (re.test(path)) {
      return { reject: true, reason: `forbidden path pattern: ${path}`, status: 403, code: BOUNDARY_VIOLATION };
    }
  }

  // Strict allow-list of endpoints, plus dynamic receipts + toolmesh namespaces.
  const allowed =
    ALLOWED.some(a => a.method === method && a.path === path) ||
    (isReceiptsPath(path) && isReceiptsRouteAllowed(method, path)) ||
    (isToolmeshPath(path) && isToolmeshRouteAllowed(method, path)) ||
    (isBuildRunPath(path) && isBuildRunRouteAllowed(method, path)) ||
    isHermesRouteAllowed(method, path) ||
    (isHermesMcpPath(path) && isHermesMcpRouteAllowed(method, path)) ||
    isVisualRouteAllowed(method, path);
  if (!allowed) {
    return { reject: true, reason: `endpoint not exposed: ${method} ${path}`, status: 404, code: BOUNDARY_VIOLATION };
  }

  // Forbidden header families
  for (const key of Object.keys(headers || {})) {
    const k = key.toLowerCase();
    for (const prefix of FORBIDDEN_HEADER_PREFIXES) {
      if (k.startsWith(prefix)) {
        return { reject: true, reason: `forbidden header: ${k}`, status: 403, code: BOUNDARY_VIOLATION };
      }
    }
  }

  // Authorization header: if present, must be Bearer token (BYO frontier API key passthrough)
  const auth = headers?.authorization;
  if (auth && !/^Bearer\s+\S+/i.test(auth)) {
    return { reject: true, reason: "Authorization must be Bearer token", status: 401, code: BOUNDARY_VIOLATION };
  }

  return { reject: false };
}
