import { describe, expect, test } from "bun:test";
import { StaffReactor, scoreRoleForEvent } from "../src/staff-reactor.mjs";

function roster() {
  return {
    roles: Array.from({ length: 50 }, (_, index) => ({
      id: index === 0 ? "navigator" : `specialist-${index}`,
      title: index === 0 ? "Navigator" : (index === 1 ? "Film and Video Director" : `Specialist ${index}`),
      studio: index === 1 ? "Creative Studio" : "Orange",
      archetype: index === 0 ? "navigator" : (index === 1 ? "visual" : "builder"),
      purpose: index === 1 ? "Create and inspect video productions" : "Produce concrete project artifacts",
      concreteOutputs: [index === 1 ? "edited video" : "verified artifact"],
      entryConditions: ["assigned Orange order"],
      completionContract: "Return an artifact, evidence, blockers, and next action.",
      forbiddenActions: ["claim completion without evidence"],
      preferredHandoffs: ["navigator"],
      canLead: index === 1,
      modelTier: "shared-navigator",
    })),
  };
}

describe("Hermes staff reactor", () => {
  test("keeps all 50 role actors live without 50 model instances", () => {
    const reactor = new StaffReactor({ roster: roster(), inferenceLimit: 8 });
    const state = reactor.start();
    expect(state.status).toBe("LIVE");
    expect(state.roleCount).toBe(50);
    expect(state.readyCount).toBe(50);
    expect(state.inferenceLimit).toBe(8);
  });

  test("broadcasts to all while preserving bounded shared inference", async () => {
    const seen = [];
    const reactor = new StaffReactor({
      roster: roster(),
      dispatch: async ({ role }) => { seen.push(role.id); return { status: "completed" }; },
    });
    const report = await reactor.publish({ topic: "video", summary: "edit and inspect the film", broadcast: true, requiresModel: false });
    expect(report.observedCount).toBe(50);
    expect(report.addressed).toHaveLength(50);
    expect(report.addressed.some((item) => item.roleId === "navigator")).toBeTrue();
    expect(report.addressed.some((item) => item.roleId === "specialist-1")).toBeTrue();
    expect(seen).toContain("specialist-1");
    expect(report.snapshot.roleCount).toBe(50);
  });

  test("unaddressed work returns to Navigator with ranked specialist candidates", async () => {
    const seen = [];
    const reactor = new StaffReactor({
      roster: roster(),
      dispatch: async ({ role }) => { seen.push(role.id); return { status: "completed" }; },
    });
    const report = await reactor.publish({ topic: "video", summary: "edit and inspect the film", requiresModel: false });
    expect(report.observedCount).toBe(50);
    expect(report.addressed.map((item) => item.roleId)).toEqual(["navigator"]);
    expect(report.candidates[0].roleId).toBe("specialist-1");
    expect(seen).toEqual(["navigator"]);
  });

  test("explicit role targeting is deterministic", () => {
    const role = roster().roles[17];
    expect(scoreRoleForEvent(role, { targetRoles: [role.id] })).toBe(1);
  });

  test("passes one canonical project-now capsule to every addressed role", async () => {
    const received = [];
    const reactor = new StaffReactor({
      roster: roster(),
      dispatch: async ({ role, projectNow }) => { received.push({ role: role.id, projectNow }); return { status: "completed" }; },
    });
    await reactor.publish({
      broadcast: true,
      projectId: "orange",
      correlationId: "mission-1",
      handoffCapsule: { schema: "orange.wave3-handoff-capsule.v1", objective: "ship" },
      commitments: ["no fake green"],
      sourceRefs: ["00-CHARTER/ORANGE5_MASTER_PLAN.md"],
      requiresModel: false,
    });
    expect(received).toHaveLength(50);
    expect(received.every((item) => item.projectNow.projectId === "orange")).toBeTrue();
    expect(received.every((item) => item.projectNow.commitments.includes("no fake green"))).toBeTrue();
  });

  test("shares one canonical order object across all 50 role dispatches", async () => {
    const received = [];
    const order = {
      schema: "orange.order.v1",
      orderId: "shared-all-50",
      action: "inspect.shared-order",
      payload: { shared: true },
    };
    const reactor = new StaffReactor({
      roster: roster(),
      dispatch: async ({ event, projectNow }) => {
        received.push({ event, projectNow });
        return { status: "completed" };
      },
    });

    const published = await reactor.publish({
      id: order.orderId,
      topic: order.action,
      order,
      broadcast: true,
      requiresModel: false,
    });

    expect(received).toHaveLength(50);
    expect(new Set(received.map((item) => item.event)).size).toBe(1);
    expect(new Set(received.map((item) => item.projectNow.order)).size).toBe(1);
    expect(received.every((item) => item.event.order === order && item.projectNow.order === order)).toBeTrue();
    expect(published.event.order).toBe(order);
  });
});
