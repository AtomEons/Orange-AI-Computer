import { describe, expect, test } from "bun:test";
import { compileStaffCrew } from "../src/staff-router.mjs";

describe("AE Staff crew compiler", () => {
  test("routes software work to hands-on makers and an independent reviewer", () => {
    const crew = compileStaffCrew({ action: "build.feature", intent: "Build a Bun MCP gateway", maxAgents: 4 });
    expect(crew.roles).toContain("integration-engineer");
    expect(crew.roles).toContain("product-systems-builder");
    expect(crew.executionProfiles).toContain("builder");
    expect(crew.executionProfiles).toContain("reviewer");
    expect(crew.invariants.permanentMiddleManagers).toBe(0);
  });

  test("routes creative production to actual creative specialists", () => {
    const crew = compileStaffCrew({ action: "create.film", intent: "Storyboard and generate a cinematic video with sound and music", maxAgents: 6 });
    expect(crew.roles).toContain("video-synthesis-artist");
    expect(crew.roles).toContain("storyboard-artist");
    expect(crew.roles.some((id) => ["sound-designer", "music-composer"].includes(id))).toBeTrue();
    expect(crew.executionProfiles).toContain("visual");
  });

  test("supports explicit roles and appoints only a working lead", () => {
    const crew = compileStaffCrew({
      action: "research.current",
      intent: "Find current primary sources",
      staffRoles: ["primary-source-researcher", "evidence-auditor"],
      maxAgents: 2,
    });
    expect(crew.roles).toEqual(["primary-source-researcher", "evidence-auditor"]);
    expect(crew.roleContracts.filter((role) => role.canLead)).toHaveLength(1);
  });
});
