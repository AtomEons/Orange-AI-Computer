// AI Box triad read-only probe. It crosses AE Phase and executes the existing
// diagnostic only on the Codexa loopback command rail.
import { requestAEPhaseTool } from '../../../03-BACKEND/ae-phase-tool-client.mjs';

export const aiBoxTriadReadonlyAdapter = {
  id: 'ai-box-triad-readonly',
  name: 'AI Box Triad (read-only)',
  lane: 'ae_phase',
  status: 'READY',
  async invoke() {
    try {
      const report = await requestAEPhaseTool({ command: 'trilane-doctor', args: ['--json'], timeoutMs: 60_000 });
      return { ...report, adapter: this.id };
    } catch (error) {
      return { ok: false, adapter: this.id, error: error.message };
    }
  },
};
