const WEB_PROTOCOLS = new Set(["http:", "https:"]);
const WEB_HOSTS = new Set(["127.0.0.1", "::1", "localhost", "tauri.localhost"]);

export function localAppOrigin(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol === "tauri:" && parsed.hostname === "localhost") return "tauri://localhost";
    if (WEB_PROTOCOLS.has(parsed.protocol) && WEB_HOSTS.has(parsed.hostname)) return parsed.origin;
  } catch {}
  return null;
}

export function applyNodeLocalAppCors(req, res) {
  const origin = localAppOrigin(req?.headers?.origin);
  if (!origin) return null;
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization,X-Orange5-Token,X-Orange5-Actor");
  res.setHeader("Access-Control-Max-Age", "600");
  res.setHeader("Vary", "Origin");
  return origin;
}

export function withLocalAppCors(response, request) {
  const origin = localAppOrigin(request?.headers?.get?.("origin"));
  if (!origin) return response;
  response.headers.set("Access-Control-Allow-Origin", origin);
  response.headers.set("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  response.headers.set("Access-Control-Allow-Headers", "Content-Type,Authorization,X-Orange5-Token,X-Orange5-Actor");
  response.headers.set("Access-Control-Max-Age", "600");
  response.headers.set("Vary", "Origin");
  return response;
}
