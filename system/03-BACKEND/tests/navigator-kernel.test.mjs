import { describe, expect, test } from "bun:test";
import { compileDelegation } from "../navigator-kernel.mjs";
import { executeDelegation, toHermesOrder } from "../orange5-headless-core.mjs";

describe("Navigator Kernel hierarchy", () => {
  test("Hermes child packets preserve the action required by orange.order.v1", () => {
    expect(toHermesOrder({
      orderId: "child-1",
      action: "analyze.agent",
      intent: "inspect the supplied evidence",
      targetProject: "C:/AtomEons/Orange5",
      allowedActions: ["analyze.agent"],
      forbiddenActions: ["filesystem.write"],
      riskLevel: "low",
      payload: { agent: "checkmate" },
      evidence: ["receipt:abc"],
    })).toMatchObject({
      schema: "orange.order.v1",
      orderId: "child-1",
      action: "analyze.agent",
      payload: { agent: "checkmate" },
      evidence: ["receipt:abc"],
    });
  });

  test("routes code to a Little Navigator with a bounded Hermes subset", () => {
    const plan = compileDelegation({ action: "build.feature", intent: "Implement TypeScript code", riskLevel: "medium" });
    expect(plan.topNavigator.modelResident).toBe(false);
    expect(plan.littleNavigator.department).toBe("AE6_CODE");
    expect(plan.littleNavigator.agents).toEqual(["implementer", "test-engineer", "code-reviewer"]);
    expect(plan.hermesLease.allowedTools).toContain("filesystem");
    expect(plan.hermesLease.maxConcurrentAgents).toBeLessThanOrEqual(3);
  });

  test("a build order that includes tests remains a code mission", () => {
    const plan = compileDelegation({
      action: "build.feature",
      intent: "Implement Bun process supervision, crash recovery, and focused tests",
      riskLevel: "medium",
    });
    expect(plan.littleNavigator.department).toBe("AE6_CODE");
    expect(plan.route.lane).not.toBe("ae-eyes");
    expect(plan.littleNavigator.agents[0]).toBe("implementer");
  });

  test("security receives only security agents and tools", () => {
    const plan = compileDelegation({ action: "audit.security", intent: "Scan secrets and threats" });
    expect(plan.littleNavigator.department).toBe("AE11_SECURITY");
    expect(plan.hermesLease.allowedAgents).toContain("security-auditor");
    expect(plan.hermesLease.allowedTools).toContain("secret-scan");
    expect(plan.hermesLease.allowedTools).not.toContain("git");
  });

  test("forbidden tool names are removed from the lease", () => {
    const plan = compileDelegation({ action: "build.feature", forbiddenActions: ["deny git"] });
    expect(plan.hermesLease.allowedTools).not.toContain("git");
  });

  test("same plan is hash-attested and expires", () => {
    const plan = compileDelegation({ action: "test.system" });
    expect(plan.planHash).toMatch(/^[a-f0-9]{64}$/);
    expect(Date.parse(plan.hermesLease.expiresAt)).toBeGreaterThan(Date.parse(plan.hermesLease.issuedAt));
  });

  test("operator agent bound is enforced", () => {
    const plan = compileDelegation({ action: "review.system", maxAgents: 1 });
    expect(plan.littleNavigator.agents).toHaveLength(1);
    expect(plan.hermesLease.allowedAgents).toHaveLength(1);
  });

  test("payload scope and evidence survive into every mediated child order", async () => {
    const orders = [];
    const sourceEvidence = ['receipt:quality:abc123', 'probe:gateway:live'];
    const result = await executeDelegation({
      order: {
        action: 'review.system',
        payload: {
          intent: 'judge only the supplied runtime proof',
          scope: 'orange5.runtime',
          objective: 'reject unsupported claims',
          constraints: ['no fake green'],
          evidence: sourceEvidence,
        },
      },
      maxAgents: 1,
      execute: true,
    }, {
      executeOrder: async (order) => {
        orders.push(order);
        return { ok: true, result: { status: 'completed', report: { output: { evidence: order.evidence, blockers: [] } }, receipt: { receipt_id: `r-${orders.length}`, hash: 'a'.repeat(64) } } };
      },
      hermes: {
        mint: async () => ({ id: 'lease-evidence' }), authorize: async () => ({ pass: true, results: [] }), revoke: async () => true,
      },
    });
    expect(result.status).toBe('DELEGATION_COMPLETE');
    expect(orders).toHaveLength(2);
    expect(orders.every((order) => order.evidence.join('|') === sourceEvidence.join('|'))).toBe(true);
    expect(orders[0].payload.parentOrder).toMatchObject({
      scope: 'orange5.runtime', objective: 'reject unsupported claims', constraints: ['no fake green'], evidence: sourceEvidence,
    });
  });

  test("executed delegation mediates every specialist and one parent synthesis", async () => {
    const orders = [];
    const hermesEvents = [];
    const fakeHermes = {
      mint: async (spec) => { hermesEvents.push(["mint", spec]); return { id: "lease-test" }; },
      authorize: async ({ order }) => { hermesEvents.push(["authorize", order.action]); return { pass: true, misfit: { decision: "pass" }, results: Array.from({ length: 8 }, (_, i) => ({ id: `gate-${i + 1}`, pass: true })) }; },
      revoke: async () => { hermesEvents.push(["revoke"]); return true; },
    };
    const fakeRun = async (order, options) => {
      orders.push({ order, options });
      return {
        ok: true,
        result: {
          status: "completed",
          report: { schema: "orange.report.v1", status: "completed", summary: `done ${order.action}`, mediation: { memory: { consulted: true }, compression: { consulted: true } } },
          receipt: { receipt_id: `r-${orders.length}`, hash: "a".repeat(64) },
        },
      };
    };
    const result = await executeDelegation({
      order: { action: "build.feature", intent: "implement governed feature", targetProject: "OrangeFive", riskLevel: "medium" },
      maxAgents: 2,
      execute: true,
    }, { executeOrder: fakeRun, hermes: fakeHermes });
    expect(result.status).toBe("DELEGATION_COMPLETE");
    expect(result.reports).toHaveLength(2);
    expect(result.synthesis.ok).toBe(true);
    expect(orders).toHaveLength(3);
    expect(orders.slice(0, 2).every((row) => row.order.action === "analyze.agent" && row.options.learn === true && row.options.model === "orange-navigator" && row.options.maxTokens === 256)).toBe(true);
    expect(orders[2].order.action).toBe("synthesize.delegation");
    expect(orders[2].options.maxTokens).toBe(256);
    expect(orders[2].order.payload.childEvidence).toHaveLength(2);
    expect(orders[2].order.payload.childEvidence[0].receipt).toEqual({ receipt_id: 'r-1', hash: 'a'.repeat(64) });
    expect(orders[2].order.payload.childEvidence[0]).not.toHaveProperty('report');
    expect(result.governance).toMatchObject({ childOrdersMediated: true, synthesisMediated: true, receiptRequired: true });
    expect(result.governance).toMatchObject({ agentModel: "orange-navigator", synthesisModel: "orange-navigator" });
    expect(result.governance).toMatchObject({ hermesLeaseId: "lease-test", hermesAuthorizedActions: 3, hermesLeaseRevoked: true });
    expect(result.governance.hermesGateResults).toHaveLength(3);
    expect(hermesEvents.map((row) => row[0])).toEqual(["mint", "authorize", "authorize", "authorize", "revoke"]);
  });

  test("read delegation executes the parent action and gives agents governed evidence", async () => {
    const orders = [];
    let parentExecutions = 0;
    const result = await executeDelegation({
      order: {
        action: "filesystem.read",
        intent: "read the project law",
        targetProject: "OrangeFive",
        payload: { path: "00-CHARTER/ORANGE5_MASTER_PLAN.md", maxBytes: 4096 },
      },
      maxAgents: 1,
      execute: true,
    }, {
      executeGovernedTool: async () => {
        parentExecutions++;
        return {
          status: "ok",
          receiptPath: "C:/receipts/parent.json",
          evidence: [
            { type: "execution_result", action: "filesystem.read", content: "# OrangeFive Master Plan", result_hash: "b".repeat(64) },
            { type: "receipt", sha256: "c".repeat(64) },
          ],
        };
      },
      executeOrder: async (order) => {
        orders.push(order);
        return { ok: true, result: { status: "completed", report: { output: { evidence: order.evidence, blockers: [] } }, receipt: { receipt_id: `r-${orders.length}`, hash: "d".repeat(64) } } };
      },
      hermes: {
        mint: async () => ({ id: "lease-parent-execution" }),
        authorize: async () => ({ pass: true, results: [] }),
        revoke: async () => true,
      },
    });
    expect(parentExecutions).toBe(1);
    expect(result.status).toBe("DELEGATION_COMPLETE");
    expect(result.governance.parentExecutionMediated).toBe(true);
    expect(result.governance.parentExecution).toMatchObject({ action: "filesystem.read", resultHash: "b".repeat(64), receiptSha256: "c".repeat(64) });
    expect(orders[0].evidence[0]).toContain("governed:filesystem.read");
    expect(orders[0].payload.parentOrder.governedExecution.excerpt).toBe("# OrangeFive Master Plan");
  });

  test("failed child prevents synthesis and cannot report complete", async () => {
    let calls = 0;
    const fakeHermes = {
      mint: async () => ({ id: "lease-failed-child" }),
      authorize: async () => ({ pass: true, results: [] }),
      revoke: async () => true,
    };
    const result = await executeDelegation({
      order: { action: "review.system", intent: "review system" }, maxAgents: 2, execute: true,
    }, { executeOrder: async () => {
      calls++;
      return calls === 2
        ? { ok: false, result: { status: "needs_action" } }
        : { ok: true, result: { status: "completed" } };
    }, hermes: fakeHermes });
    expect(result.status).toBe("DELEGATION_ATTENTION");
    expect(result.synthesis).toBeNull();
    expect(calls).toBe(2);
  });

  test("Hermes refusal prevents execution and revoked lease cannot report complete", async () => {
    let calls = 0;
    let revoked = false;
    const result = await executeDelegation({
      order: { action: "review.system", intent: "review system" }, maxAgents: 1, execute: true,
    }, {
      executeOrder: async () => { calls++; return { ok: true, result: { status: "completed" } }; },
      hermes: {
        mint: async () => ({ id: "lease-refused" }),
        authorize: async () => { throw new Error("LOOM refused action"); },
        revoke: async () => { revoked = true; return true; },
      },
    });
    expect(result.status).toBe("DELEGATION_ATTENTION");
    expect(result.error).toContain("LOOM refused action");
    expect(result.governance.hermesLeaseRevoked).toBe(true);
    expect(revoked).toBe(true);
    expect(calls).toBe(0);
  });

  test("revoke failure prevents false complete", async () => {
    const result = await executeDelegation({
      order: { action: "review.system", intent: "review system" }, maxAgents: 1, execute: true,
    }, {
      executeOrder: async () => ({ ok: true, result: { status: "completed" } }),
      hermes: {
        mint: async () => ({ id: "lease-not-revoked" }),
        authorize: async () => ({ pass: true, results: [] }),
        revoke: async () => false,
      },
    });
    expect(result.status).toBe("DELEGATION_ATTENTION");
    expect(result.governance.hermesLeaseRevoked).toBe(false);
  });

  test("research delegation gathers evidence before any model worker runs", async () => {
    const orders = [];
    const evidence = {
      ok: true,
      status: "EVIDENCE_COLLECTED",
      sourceCount: 1,
      artifactPath: "C:/receipts/research.json",
      sha256: "b".repeat(64),
      evidenceRefs: ["source:github:123456789abc:artifact:bbbbbbbbbbbb"],
      sources: [{ provider: "github", title: "lab/tool", url: "https://github.com/lab/tool", summary: "real tool", updatedAt: null, license: "MIT" }],
    };
    const result = await executeDelegation({
      order: { action: "research.scan", intent: "find evidence-backed agent tools" }, maxAgents: 1, execute: true,
    }, {
      researchCollector: async () => evidence,
      executeOrder: async (order) => {
        orders.push(order);
        return { ok: true, result: { status: "completed", report: { output: { evidence: order.evidence, blockers: [] } }, receipt: { receipt_id: `r-${orders.length}`, hash: "c".repeat(64) } } };
      },
      hermes: {
        mint: async () => ({ id: "lease-research" }), authorize: async () => ({ pass: true, results: [] }), revoke: async () => true,
      },
    });
    expect(result.status).toBe("DELEGATION_COMPLETE");
    expect(result.governance.researchEvidence).toMatchObject({ ok: true, sourceCount: 1, sha256: "b".repeat(64) });
    expect(orders[0].payload.researchEvidence.sources[0].url).toBe("https://github.com/lab/tool");
    expect(orders.every((order) => order.evidence?.[0] === evidence.evidenceRefs[0])).toBe(true);
  });

  test("research delegation halts before Hermes and models when evidence is absent", async () => {
    let modelCalls = 0;
    let leaseCalls = 0;
    const result = await executeDelegation({ order: { action: "research.scan", intent: "unknown research" }, execute: true }, {
      researchCollector: async () => ({ ok: false, status: "NO_EVIDENCE", sourceCount: 0, artifactPath: "C:/receipts/empty.json", sha256: "d".repeat(64), evidenceRefs: [], sources: [] }),
      currentAwarenessRunner: async () => ({ status: "CURRENT_EVIDENCE_UNAVAILABLE", sourceCount: 0, candidates: [] }),
      executeOrder: async () => { modelCalls++; },
      hermes: { mint: async () => { leaseCalls++; }, authorize: async () => ({ pass: true }), revoke: async () => true },
    });
    expect(result.status).toBe("DELEGATION_ATTENTION");
    expect(result.blockers).toContain("research halted because no source evidence was collected");
    expect(modelCalls).toBe(0);
    expect(leaseCalls).toBe(0);
  });

  test("research delegation recovers from current-awareness evidence before Hermès execution", async () => {
    const orders = [];
    let leaseCalls = 0;
    const result = await executeDelegation({
      order: { action: "research.system-gap-sweep", intent: "research system gap sweep" }, maxAgents: 1, execute: true,
    }, {
      researchCollector: async () => ({ ok: false, status: "NO_EVIDENCE", sourceCount: 0, artifactPath: "C:/receipts/empty.json", sha256: "d".repeat(64), evidenceRefs: [], sources: [] }),
      currentAwarenessRunner: async () => ({
        status: "CURRENT_EVIDENCE_READY", sourceCount: 1, cacheHit: true,
        generatedAt: "2026-08-28T00:00:00Z", sha256: "e".repeat(64), evidenceArtifactPath: "C:/receipts/awareness.json",
        candidates: [{ provider: "arxiv", title: "Durable Agent Work", url: "https://arxiv.org/abs/2608.00001", summary: "Custody and replay evidence", lifecycle: "BENCHMARK_REQUIRED" }],
      }),
      executeOrder: async (order) => {
        orders.push(order);
        return { ok: true, result: { status: "completed", report: { output: { evidence: order.evidence, blockers: [] } }, receipt: { receipt_id: `r-${orders.length}`, hash: "f".repeat(64) } } };
      },
      hermes: {
        mint: async () => { leaseCalls++; return { id: "lease-awareness-recovery" }; },
        authorize: async () => ({ pass: true, results: [] }),
        revoke: async () => true,
      },
    });
    expect(result.status).toBe("DELEGATION_COMPLETE");
    expect(leaseCalls).toBe(1);
    expect(result.governance.researchEvidence).toMatchObject({ ok: true, sourceCount: 1, recoveredFromCurrentAwareness: true });
    expect(orders[0].payload.researchEvidence.sources[0].url).toBe("https://arxiv.org/abs/2608.00001");
    expect(orders[0].evidence[0]).toContain("awareness:eeeeeeeeeeee");
  });

  test('technical build delegation receives current evidence without auto-promoting it', async () => {
    const orders = [];
    const result = await executeDelegation({
      order: { action: 'build.tool', intent: 'build a new MCP tool for this project' }, maxAgents: 1, execute: true,
    }, {
      currentAwarenessRunner: async () => ({
        status: 'CURRENT_EVIDENCE_READY', sourceCount: 1, cacheHit: false, generatedAt: '2026-08-25T10:00:00Z', sha256: 'e'.repeat(64), evidenceArtifactPath: 'C:/evidence.json',
        candidates: [{ provider: 'github', title: 'lab/fresh-mcp', url: 'https://github.com/lab/fresh-mcp', summary: 'Fresh MCP tool', updatedAt: '2026-08-25T09:00:00Z', license: 'MIT', lifecycle: 'BENCHMARK_REQUIRED' }],
        opportunities: [{ title: 'lab/fresh-mcp', url: 'https://github.com/lab/fresh-mcp', score: 0.9, nextGate: 'BENCHMARK_REQUIRED' }],
      }),
      executeOrder: async (order) => {
        orders.push(order);
        return { ok: true, result: { status: 'completed', report: { output: { evidence: order.evidence || [], blockers: [] } }, receipt: { receipt_id: `r-${orders.length}`, hash: 'f'.repeat(64) } } };
      },
      hermes: { mint: async () => ({ id: 'lease-aware' }), authorize: async () => ({ pass: true, results: [] }), revoke: async () => true },
    });
    expect(result.status).toBe('DELEGATION_COMPLETE');
    expect(result.governance.currentAwareness).toMatchObject({ status: 'CURRENT_EVIDENCE_READY', sourceCount: 1, cacheHit: false });
    expect(orders[0].payload.researchEvidence.sources[0]).toMatchObject({ title: 'lab/fresh-mcp', lifecycle: 'BENCHMARK_REQUIRED' });
    expect(orders[0].evidence[0]).toContain('awareness:eeeeeeeeeeee');
  });
});
