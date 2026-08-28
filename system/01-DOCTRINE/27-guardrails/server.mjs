// server.mjs — Bun-native (also Node-compatible) daemon for the 27 guardrails.
//
// Endpoints:
//   GET  /healthz           - liveness + last run summary
//   GET  /run               - run all 27 checks, return result, persist + flux
//   GET  /run?write=0       - run but skip Flux write (dry)
//   GET  /latest            - latest persisted run from SQLite
//   GET  /continuity        - most recent continuity packet
//   POST /continuity/write  - write today's continuity packet (body = packet)
//   GET  /soul-genome       - current Soul Genome
//
// Binds to 127.0.0.1:7460 by default. Loopback-only per frontier discipline.

import { runGuardrails } from "./runtime.mjs";
import { latestRun } from "./lib/db.mjs";
import {
  ensureSoulGenome,
  readSoulGenome,
  writeSoulGenome,
} from "./lib/soul-genome.mjs";
import {
  writeContinuity,
  loadMostRecentContinuity,
} from "./lib/continuity-packet.mjs";

const HOST = process.env.GUARDRAILS_HOST || "127.0.0.1";
const PORT = parseInt(process.env.GUARDRAILS_PORT || "7460", 10);

function json(body, init = {}) {
  return new Response(JSON.stringify(body, null, 2), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers || {}) },
  });
}

async function handle(req) {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method.toUpperCase();

  if (method === "GET" && path === "/healthz") {
    const last = await latestRun().catch(() => null);
    return json({
      ok: true,
      service: "orange5-guardrails",
      version: "1.0.0",
      bound: `${HOST}:${PORT}`,
      now: Date.now(),
      last_run: last
        ? {
            run_id: last.run_id,
            ok: !!last.ok,
            finished_at: last.finished_at,
            violations:
              (last.results || []).filter((r) => !r.pass).length,
          }
        : null,
    });
  }

  if (method === "GET" && path === "/run") {
    const writeFlux = url.searchParams.get("write") !== "0";
    const out = await runGuardrails({ write_to_flux: writeFlux });
    return json(out, { status: out.stop ? 207 : 200 });
  }

  if (method === "GET" && path === "/latest") {
    const last = await latestRun();
    return json(last ?? { ok: true, last_run: null });
  }

  if (method === "GET" && path === "/continuity") {
    const c = loadMostRecentContinuity();
    return json(c ?? { ok: true, latest: null });
  }

  if (method === "POST" && path === "/continuity/write") {
    let body = {};
    try {
      const text = await req.text();
      if (text) body = JSON.parse(text);
    } catch (e) {
      return json({ ok: false, reason: "body not JSON", err: String(e?.message || e) }, { status: 400 });
    }
    const r = await writeContinuity(body);
    return json({ ok: true, ...r });
  }

  if (method === "GET" && path === "/soul-genome") {
    return json(ensureSoulGenome());
  }

  if (method === "POST" && path === "/soul-genome") {
    let body = {};
    try {
      body = JSON.parse(await req.text());
    } catch (e) {
      return json({ ok: false, reason: "body not JSON" }, { status: 400 });
    }
    const existing = readSoulGenome() || {};
    const merged = { ...existing, ...body };
    const r = writeSoulGenome(merged);
    return json({ ok: true, ...r });
  }

  return json({ ok: false, reason: "not_found", path }, { status: 404 });
}

// Bun.serve when on Bun; otherwise node:http
const isBun = typeof globalThis.Bun !== "undefined";

if (isBun) {
  // @ts-ignore -- Bun global
  const srv = Bun.serve({
    hostname: HOST,
    port: PORT,
    fetch: handle,
  });
  // eslint-disable-next-line no-console
  console.log(`[guardrails] bun listening on http://${srv.hostname}:${srv.port}`);
} else {
  const { createServer } = await import("node:http");
  const server = createServer(async (req, res) => {
    try {
      const body = await new Promise((resolve, reject) => {
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        req.on("error", reject);
      });
      const reqLike = new Request(`http://${req.headers.host || HOST}${req.url}`, {
        method: req.method,
        headers: req.headers,
        body: ["GET", "HEAD"].includes((req.method || "GET").toUpperCase()) ? undefined : body,
      });
      const r = await handle(reqLike);
      res.statusCode = r.status;
      r.headers.forEach((v, k) => res.setHeader(k, v));
      res.end(await r.text());
    } catch (err) {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: false, err: String(err?.message || err) }));
    }
  });
  server.listen(PORT, HOST, () => {
    // eslint-disable-next-line no-console
    console.log(`[guardrails] node listening on http://${HOST}:${PORT}`);
  });
}
