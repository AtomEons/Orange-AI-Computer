// AI Box allowlisted-command adapter. Sends a NAMED command from a fixed allowlist
// through the Codexa command rail. Operator-approved verbs only.

const ENDPOINT = `${(process.env.ORANGE5_CODEXA_RAIL_URL || "http://10.0.0.4:8097").replace(/\/$/, '')}/api/codexa/command`;
const TIMEOUT_MS = 30_000;

const ALLOWLIST = new Set([
  "ops-readiness",
  "system-check",
  "health-report",
  "project-report",
  "reality-watch",
  "model-inventory",
  "trilane-doctor",
  "ipi-doctor",
  "memory-doctor",
  "mcp-doctor",
]);

export const aiBoxAllowlistedCommandAdapter = {
  id: "ai-box-allowlisted-command",
  name: "AI Box Allowlisted Command",
  lane: "local_endpoint",
  status: "PLANNED",
  async invoke({ command, args = [] }) {
    if (!ALLOWLIST.has(command)) {
      return { ok: false, adapter: this.id, error: "command_not_allowlisted", command };
    }
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
      const headers = { "Content-Type": "application/json" };
      if (process.env.ORANGEBOX_RAIL_TOKEN) headers["X-Orangebox-Token"] = process.env.ORANGEBOX_RAIL_TOKEN;
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers,
        body: JSON.stringify({ command, args }),
        signal: ctrl.signal,
      });
      clearTimeout(t);
      return { ok: res.ok, adapter: this.id, status: res.status, body: await res.json().catch(() => null) };
    } catch (err) {
      return { ok: false, adapter: this.id, error: err.message };
    }
  },
  allowlist: Array.from(ALLOWLIST),
};
