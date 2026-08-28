import { beforeEach, describe, expect, test } from "bun:test";
import misfitSecondOpinion, { __internals, BLOCKING_RISK_LEVELS } from "../src/pre-action/misfit-second-opinion.mjs";

const ctx = (risk) => ({
  actor: "test", actionVerb: "tool.call",
  lease: { risk_level: risk, target_project: "orange5", allowed: ["tool.call"], forbidden: [] },
  action: { risk_level: risk }, order: { intent: "run bounded test" },
});

function inventoryOnly(models = []) {
  let calls = 0;
  const fetchImpl = async (url) => {
    calls++;
    if (!url.endsWith("/v1/models")) throw new Error("chat endpoint must not run when model absence is known");
    return { ok: true, status: 200, text: async () => JSON.stringify({ data: models.map((id) => ({ id })) }) };
  };
  return { fetchImpl, calls: () => calls };
}

describe("Misfit availability fast path", () => {
  beforeEach(() => __internals.clearAvailabilityCache());

  test("read_only and low skip all network work", async () => {
    for (const risk of ["read_only", "low"]) {
      const net = inventoryOnly([]);
      const result = await misfitSecondOpinion(ctx(risk), { fetchImpl: net.fetchImpl });
      expect(result.decision).toBe("skipped");
      expect(net.calls()).toBe(0);
    }
  });

  test("known missing tag returns a cached medium warning without chat timeout", async () => {
    const net = inventoryOnly(["orange-navigator"]);
    const first = await misfitSecondOpinion(ctx("medium"), { fetchImpl: net.fetchImpl, availabilityTtlMs: 30_000 });
    const second = await misfitSecondOpinion(ctx("medium"), { fetchImpl: net.fetchImpl, availabilityTtlMs: 30_000 });
    expect(first.decision).toBe("allow-with-warning");
    expect(second.decision).toBe("allow-with-warning");
    expect(net.calls()).toBe(1);
  });

  test("missing second opinion fails closed for all dangerous tiers", async () => {
    expect([...BLOCKING_RISK_LEVELS]).toEqual(expect.arrayContaining(["high", "destructive", "production"]));
    for (const risk of ["high", "destructive", "production"]) {
      __internals.clearAvailabilityCache();
      const result = await misfitSecondOpinion(ctx(risk), { fetchImpl: inventoryOnly([]).fetchImpl });
      expect(result.decision).toBe("refuse");
    }
  });
});
