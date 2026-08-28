// N150 llama.cpp / Smart Skinny adapter. Probes :8797 with short timeout.
// status flips to READY when alive; MISSING when unreachable.

const HEALTH_URL = "http://127.0.0.1:8797/healthz";
const PROBE_TIMEOUT_MS = 3_000;

async function probe() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
    const res = await fetch(HEALTH_URL, { signal: ctrl.signal });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

export const localLlamaCppAdapter = {
  id: "local-llama-cpp-listener",
  name: "Local llama.cpp / Smart Skinny",
  lane: "local_endpoint",
  status: "PLANNED",
  async invoke({ messages, model }) {
    const live = await probe();
    if (!live) {
      return { ok: false, adapter: this.id, error: "upstream_unreachable", health_url: HEALTH_URL };
    }
    const res = await fetch("http://127.0.0.1:8797/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages, model }),
    });
    return { ok: res.ok, adapter: this.id, status: res.status, body: await res.json() };
  },
};
