// AE OrangeLLM — Guardrails / Soul Genome / Continuity Packet boundary allow-list
// Path: 06-ORANGELLM/server/routes/guardrails-boundary.mjs
//
// Doctrine reminder:
//   - The frontier gateway at 127.0.0.1:1337 is the ONLY legal door from a
//     frontier model into Orange5. Every endpoint must be on a strict
//     allow-list. Nothing reachable by accident.
//   - The 27 Constitutional Guardrails (01-DOCTRINE/27-guardrails) are the
//     invariants this system MUST preserve. The standalone daemon at :7460
//     exists for the doctrine layer; these gateway routes exist so the
//     frontier-bounded surface (cockpit, AECommand Center, frontier model)
//     can READ status and (operator-gated) kick a fresh run without ever
//     touching the doctrine daemon directly.
//   - Soul Genome is the operator continuity config (z_0 anchor for Spiral
//     Reasoning). READ is open through the gateway; WRITE is operator-gated
//     by env-bound token (Guardrail #6: ATOMEONS_IDENTITY_SECRET env-only,
//     never hardcoded). The token is also the only way to kick a fresh run.
//   - Continuity Packet is forward-looking JSON: today's progress, open
//     blockers, tomorrow's first action. READ surfaces the most recent
//     packet so a fresh frontier session loads it as first context.
//     Writes happen via cron (lib/continuity-packet.mjs writeContinuity),
//     never through the gateway — by design.
//
// Routes exposed:
//   GET  /v1/guardrails/status        — last run summary + violations
//   POST /v1/guardrails/run           — kick a fresh sweep (operator-gated)
//   GET  /v1/genome                   — current Soul Genome
//   POST /v1/genome                   — update Soul Genome (operator-gated)
//   GET  /v1/continuity-packet        — most recent continuity packet

export const GUARDRAILS_ALLOWED = Object.freeze([
  { method: "GET",  path: "/v1/guardrails/status" },
  { method: "POST", path: "/v1/guardrails/run"    },
  { method: "GET",  path: "/v1/genome"            },
  { method: "POST", path: "/v1/genome"            },
  { method: "GET",  path: "/v1/continuity-packet" },
]);

export function isGuardrailsRouteAllowed(method, pathname) {
  const m = (method || "").toUpperCase();
  return GUARDRAILS_ALLOWED.some(r => r.method === m && r.path === pathname);
}

// Header name carrying the operator token for guarded POSTs. The value is
// compared against ATOMEONS_IDENTITY_SECRET, which Guardrail #6 requires to
// be env-bound and never hardcoded. This header name is intentionally NOT
// prefixed with any of the forbidden families (x-mirage-, x-orangebox-,
// x-codexa-, x-internal-) so the main boundary lets it through.
export const OPERATOR_TOKEN_HEADER = "x-ae-operator-token";
