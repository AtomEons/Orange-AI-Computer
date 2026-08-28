// Always-ready deterministic mock. Used by tests + mock-mode runs.
export const mockAdapter = {
  id: "mock-local-deterministic",
  name: "Mock (deterministic)",
  lane: "mock",
  status: "READY",
  async invoke(input) {
    return {
      ok: true,
      adapter: "mock-local-deterministic",
      echo: input,
      ts: Date.now(),
    };
  },
};
