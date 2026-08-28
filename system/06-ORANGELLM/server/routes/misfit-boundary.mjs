// AE OrangeLLM — AE Misfit boundary allow-list
// Path: 06-ORANGELLM/server/routes/misfit-boundary.mjs
//
// Purpose:
//   The main gateway boundary (server/boundary.mjs) enforces a strict
//   allow-list of {method, path} pairs. The AE Misfit gate exposes three
//   surfaces and must be added to that allow-list before they are reachable
//   from anywhere outside the loopback.
//
// Doctrine reminder (operator, 2026-06-24):
//   - AE Misfit is the adversarial second-opinion model. Trained SEPARATELY
//     from OrangeLLM-fatty on the STRONGARM + Gremlin corpora (receipt
//     #032 retired those datasets from OrangeLLM-fatty). Base:
//     unsloth/Qwen2.5-7B-Instruct-bnb-4bit (served as qwen2.5:7b in Ollama
//     after the Modelfile merges the LoRA adapter at runtime). Free Colab T4
//     sufficient.
//   - Refusal-discipline is the primary training signal. Refusing is a
//     success state.
//   - The second-opinion gate fires before high-risk Hermes actions to catch
//     fake-greens OrangeLLM-fatty might miss.
//   - The eval surface is read-only and returns the most recent bakeoff
//     report produced by 16-TRAINING/ae-misfit/eval/harness.mjs. It is
//     deliberately a separate path from the receipts plane because eval
//     output is a model artifact, not an action receipt.
//   - The preflight surface is the Hermes pre-action middleware contract:
//     it accepts a proposed Hermes action envelope, normalizes risk, runs
//     the second-opinion gate, and returns refuse|confirm. The naming
//     refuse|confirm (not refuse|approve) matches the trained model's own
//     vocabulary so the wire shape and the model's voice stay in sync.
//
// Usage (in boundary.mjs):
//
//     import { MISFIT_ALLOWED } from "./routes/misfit-boundary.mjs";
//     const ALLOWED = [
//       { method: "GET",  path: "/healthz" },
//       { method: "GET",  path: "/v1/models" },
//       { method: "POST", path: "/v1/chat/completions" },
//       ...MEMORY_ALLOWED,
//       ...ATOMSMASHER_ALLOWED,
//       ...MISFIT_ALLOWED,
//     ];
//
//   All three endpoints are literal — no parameter slots, no dynamic ids in
//   the path — so the existing literal-pair check in the main boundary is
//   enough. No predicate-style matcher is needed.
//
//   The FORBIDDEN_PATH_PATTERNS regex
//   `/^\/(mirage|codexa|orangebox|hermes|vault)\//i` does not match /v1/,
//   so no carve-out is needed even though AE Misfit gates Hermes-bound
//   actions.

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MISFIT_PATH = "/v1/misfit/second-opinion";
export const MISFIT_EVAL_PATH = "/v1/misfit/eval";
export const MISFIT_PREFLIGHT_PATH = "/v1/misfit/preflight";

export const MISFIT_ALLOWED = Object.freeze([
  { method: "POST", path: MISFIT_PATH },
  { method: "GET", path: MISFIT_EVAL_PATH },
  { method: "POST", path: MISFIT_PREFLIGHT_PATH },
]);

// Headers that AE Misfit consumes internally — must not be forwarded from
// the frontier. Restated here so future maintainers see the dependency in
// the same folder.
export const MISFIT_FORBIDDEN_HEADER_PREFIXES = Object.freeze([
  "x-misfit-",
  "x-ae-misfit-",
  "x-strongarm-",
  "x-gremlin-",
  "x-hermes-",
  "x-internal-",
]);

// ---------------------------------------------------------------------------
// Predicate (for symmetry with other boundary modules)
// ---------------------------------------------------------------------------

/**
 * Returns true iff (method, pathName) names one of the AE Misfit surfaces.
 * All three endpoints are single-shape literal paths, so this is a literal
 * match across the allow-list.
 *
 * @param {string} method
 * @param {string} pathName
 * @returns {boolean}
 */
export function isMisfitRouteAllowed(method, pathName) {
  if (typeof method !== "string" || typeof pathName !== "string") return false;
  const m = method.toUpperCase();
  for (const pair of MISFIT_ALLOWED) {
    if (pair.method === m && pair.path === pathName) return true;
  }
  return false;
}
