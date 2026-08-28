// AI Box (Codexa) triad — READ-ONLY probe. Never mutates state.
// Routes through the Orangebox command rail at 10.0.99.1:8097.

const PROBE_URL = process.env.ORANGE5_CODEXA_RAIL_URL
  ? `${process.env.ORANGE5_CODEXA_RAIL_URL.replace(/\/$/, '')}/api/triad?project=orange5&probe=1`
  : "http://10.0.0.4:8097/api/triad?project=orange5&probe=1";
const PROBE_TIMEOUT_MS = 5_000;

export const aiBoxTriadReadonlyAdapter = {
  id: "ai-box-triad-readonly",
  name: "AI Box Triad (read-only)",
  lane: "local_endpoint",
  status: "PLANNED",   // operator token wiring lifts this to READY
  async invoke() {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
      const headers = {};
      if (process.env.ORANGEBOX_RAIL_TOKEN) headers["X-Orangebox-Token"] = process.env.ORANGEBOX_RAIL_TOKEN;
      const res = await fetch(PROBE_URL, { headers, signal: ctrl.signal });
      clearTimeout(t);
      if (res.status === 401) return { ok: false, adapter: this.id, error: "auth_required", hint: "set ORANGEBOX_RAIL_TOKEN env" };
      return { ok: res.ok, adapter: this.id, status: res.status, body: await res.json().catch(() => null) };
    } catch (err) {
      return { ok: false, adapter: this.id, error: err.message };
    }
  },
};
