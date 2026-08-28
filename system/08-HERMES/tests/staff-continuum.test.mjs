import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StaffContinuum } from "../src/staff-continuum.mjs";

const roots = [];
afterEach(() => { while (roots.length) rmSync(roots.pop(), { recursive: true, force: true }); });

function makeStore() {
  const root = mkdtempSync(join(tmpdir(), "ae-staff-continuum-"));
  roots.push(root);
  return { root, store: new StaffContinuum({ root }) };
}

describe("AE Staff Continuum", () => {
  test("hydrates once and sends signed deltas afterward", () => {
    const { store } = makeStore();
    const first = store.observe({ projectId: "orange", id: "event-1", summary: "build staff", commitments: ["no fake green"] });
    const firstView = store.viewForProfile(first, "builder");
    expect(firstView.mode).toBe("hydrate");
    const second = store.observe({ projectId: "orange", id: "event-2", summary: "review staff", sourceRefs: ["receipt:one"] });
    const secondView = store.viewForProfile(second, "builder");
    expect(secondView.mode).toBe("delta");
    expect(second.previousHash).toBe(first.headHash);
    expect(secondView.context.eventId).toBe("event-2");
  });

  test("restores project and profile cursors from disk after restart", () => {
    const { root, store } = makeStore();
    const crystal = store.observe({ projectId: "orange", id: "event-1", summary: "persist truth" });
    store.viewForProfile(crystal, "reviewer");
    const restarted = new StaffContinuum({ root });
    expect(restarted.viewForProfile(crystal, "reviewer").mode).toBe("reference");
    expect(restarted.status().projects).toBe(1);
  });
});
