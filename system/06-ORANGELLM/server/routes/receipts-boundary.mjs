// AE OrangeLLM — Receipts boundary allow-list
// Path: 06-ORANGELLM/server/routes/receipts-boundary.mjs
//
// Receipts surface (read-only):
//   GET /v1/receipts                    — paginated/filtered list
//   GET /v1/receipts/:id                — single receipt by id
//   GET /v1/receipts/chain-verify       — integrity report
//
// The main boundary uses exact {method, path} matches. /v1/receipts/:id
// is a dynamic path, so the main boundary delegates to isReceiptsPath()
// + isReceiptsRouteAllowed() for the receipts namespace.
//
// Doctrine:
//   - Receipts are READ-ONLY through the gateway. Markdown is the operator
//     audit lane; SQLite is the machine query lane. Both are authored by
//     internal pipelines, never by the frontier.
//   - The chain-verify endpoint exists so any operator or audit job can
//     prove integrity without touching the DB directly.

export const RECEIPTS_PATH_PREFIX = '/v1/receipts';

export const RECEIPTS_ALLOWED_EXACT = Object.freeze([
  { method: 'GET', path: '/v1/receipts' },
  { method: 'GET', path: '/v1/receipts/chain-verify' },
]);

const RECEIPT_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

export function isReceiptsPath(pathname) {
  return typeof pathname === 'string' &&
    (pathname === '/v1/receipts' || pathname.startsWith('/v1/receipts/'));
}

export function isReceiptsRouteAllowed(method, pathname) {
  const m = (method || '').toUpperCase();
  if (m !== 'GET') return false;
  if (pathname === '/v1/receipts') return true;
  if (pathname === '/v1/receipts/chain-verify') return true;
  // /v1/receipts/:id — id must be a safe slug
  const m2 = pathname.match(/^\/v1\/receipts\/([^/]+)$/);
  if (m2 && RECEIPT_ID_RE.test(m2[1]) && m2[1] !== 'chain-verify') return true;
  return false;
}

// Re-export the allow-list shape for boundary.mjs convenience.
export const RECEIPTS_ALLOWED = RECEIPTS_ALLOWED_EXACT;
