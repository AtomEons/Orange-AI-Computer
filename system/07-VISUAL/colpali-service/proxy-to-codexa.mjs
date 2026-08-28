const UPSTREAM = (process.env.ORANGE5_EYES_UPSTREAM || "http://10.0.99.1:7440").replace(/\/$/, "");
const HOST = "127.0.0.1";
const PORT = Number(process.env.COLPALI_PORT || 7440);

const server = Bun.serve({
  hostname: HOST,
  port: PORT,
  idleTimeout: 255,
  async fetch(request) {
    const incoming = new URL(request.url);
    const target = `${UPSTREAM}${incoming.pathname}${incoming.search}`;
    try {
      const headers = new Headers(request.headers);
      headers.delete("host");
      const response = await fetch(target, {
        method: request.method,
        headers,
        body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
        redirect: "manual",
      });
      const outHeaders = new Headers(response.headers);
      outHeaders.set("x-orange5-eyes-facade", "n150-to-codexa");
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: outHeaders,
      });
    } catch (error) {
      return Response.json({
        ok: false,
        service: "orange5-eyes-facade",
        upstream: UPSTREAM,
        error: error.message,
      }, { status: 502 });
    }
  },
});

console.log(JSON.stringify({
  status: "VERIFIED",
  service: "orange5-eyes-facade",
  listen: server.url.href,
  upstream: UPSTREAM,
}));
