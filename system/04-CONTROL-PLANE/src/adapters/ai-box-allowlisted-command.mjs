// Named Codexa commands cross AE Phase. The command rail remains loopback-only
// to the Codexa Phase effector and is never a client-facing transport.
import { CODEXA_COMMAND_ALLOWLIST, requestAEPhaseTool } from '../../../03-BACKEND/ae-phase-tool-client.mjs';

const ALLOWLIST = new Set(CODEXA_COMMAND_ALLOWLIST);

export const aiBoxAllowlistedCommandAdapter = {
  id: "ai-box-allowlisted-command",
  name: "AI Box Allowlisted Command",
  lane: "ae_phase",
  status: "READY",
  async invoke({ command, args = [] }) {
    if (!ALLOWLIST.has(command)) {
      return { ok: false, adapter: this.id, error: "command_not_allowlisted", command };
    }
    try {
      const report = await requestAEPhaseTool({ command, args });
      return { ...report, adapter: this.id };
    } catch (err) {
      return { ok: false, adapter: this.id, error: err.message };
    }
  },
  allowlist: Array.from(ALLOWLIST),
};
