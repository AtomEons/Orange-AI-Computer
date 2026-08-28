import http from "node:http";

const HOST = process.env.ORANGE5_CODEXA_PROXY_HOST || "127.0.0.1";
const PORT = Number(process.env.ORANGE5_CODEXA_PROXY_PORT || 11435);
const TARGET = process.env.ORANGE5_CODEXA_PROXY_TARGET || "http://CODEXA.local:11434";

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

const server = http.createServer(async (req, res) => {
  if (req.url === "/healthz") {
    try {
      const probe = await fetch(`${TARGET}/api/tags`, { signal: AbortSignal.timeout(5000) });
      sendJson(res, probe.ok ? 200 : 502, {
        ok: probe.ok,
        service: "orange5-codexa-ollama-host-proxy",
        target: TARGET,
        status: probe.status,
      });
    } catch (error) {
      sendJson(res, 502, {
        ok: false,
        service: "orange5-codexa-ollama-host-proxy",
        target: TARGET,
        error: error.message,
      });
    }
    return;
  }

  const targetUrl = new URL(req.url || "/", TARGET);
  const body = await readBody(req);
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (!["host", "connection", "content-length"].includes(key.toLowerCase()) && value !== undefined) {
      headers[key] = Array.isArray(value) ? value.join(", ") : value;
    }
  }

  try {
    const upstream = await fetch(targetUrl, {
      method: req.method,
      headers,
      body: body.length ? body : undefined,
      signal: AbortSignal.timeout(Number(process.env.ORANGE5_CODEXA_PROXY_TIMEOUT_MS || 120000)),
    });
    const upstreamBody = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(upstream.status, Object.fromEntries(upstream.headers.entries()));
    res.end(upstreamBody);
  } catch (error) {
    sendJson(res, 502, {
      ok: false,
      service: "orange5-codexa-ollama-host-proxy",
      target: TARGET,
      path: req.url,
      error: error.message,
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[codexa-ollama-proxy] listening on http://${HOST}:${PORT}`);
  console.log(`[codexa-ollama-proxy] forwarding to ${TARGET}`);
});
