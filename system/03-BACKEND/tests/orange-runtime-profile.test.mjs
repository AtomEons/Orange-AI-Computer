import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BunRuntimeLauncher,
  OrangeRuntimeSupervisor,
  RuntimeProfileStore,
  canonicalRuntimeProfileRoot,
  computeCrashBackoffMs,
  createRuntimeProfile,
  createRuntimeState,
  planRuntimeReconciliation,
  transitionRuntimeState,
} from "../runtime/index.mjs";

const temporaryRoots = [];
afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orange-runtime-profile-"));
  temporaryRoots.push(root);
  return root;
}

function profile(overrides = {}) {
  return createRuntimeProfile({
    id: "orange-primary",
    limits: { maxConcurrentStarts: 2, maxWorkerConcurrency: 4, maxMemoryMb: 1_024, maxCpuUnits: 4 },
    backoff: { baseMs: 100, maxMs: 800 },
    organs: [
      {
        name: "navigator",
        command: ["bun", "navigator.mjs"],
        priority: 100,
        resources: { memoryMb: 400, cpuUnits: 1, workerConcurrency: 2 },
      },
      {
        name: "memory",
        command: ["bun", "memory.mjs"],
        priority: 90,
        resources: { memoryMb: 300, cpuUnits: 1, workerConcurrency: 1 },
      },
      {
        name: "research",
        command: ["bun", "research.mjs"],
        priority: 10,
        resources: { memoryMb: 500, cpuUnits: 2, workerConcurrency: 2 },
      },
    ],
    ...overrides,
  });
}

describe("Orange Runtime Profile pure state machine", () => {
  test("emits a receipt for every lifecycle transition", () => {
    let state = createRuntimeState(profile(), 0);
    const events = [
      { type: "launch.requested", organ: "navigator", at: 1 },
      { type: "launch.succeeded", organ: "navigator", pid: 4242, at: 2 },
      { type: "health.passed", organ: "navigator", at: 3 },
      { type: "desired.changed", organ: "navigator", desired: "stopped", at: 4 },
      { type: "stop.requested", organ: "navigator", at: 5 },
      { type: "stop.completed", organ: "navigator", at: 6 },
    ];
    const receipts = [];
    for (const event of events) {
      const result = transitionRuntimeState(state, event);
      state = result.state;
      receipts.push(result.receipt);
    }
    expect(state.observed.navigator.status).toBe("stopped");
    expect(receipts).toHaveLength(events.length);
    expect(receipts.every((receipt) => receipt.schema === "orange.runtime-lifecycle-receipt.v1")).toBe(true);
    expect(new Set(receipts.map((receipt) => receipt.receiptId)).size).toBe(receipts.length);
    expect(receipts[1].resources).toEqual({ memoryMb: 400, cpuUnits: 1, workerConcurrency: 2 });
  });

  test("uses capped exponential crash-loop backoff", () => {
    const backoff = { baseMs: 100, maxMs: 800 };
    expect([1, 2, 3, 4, 5].map((attempt) => computeCrashBackoffMs(attempt, backoff)))
      .toEqual([100, 200, 400, 800, 800]);

    let state = createRuntimeState(profile(), 0);
    ({ state } = transitionRuntimeState(state, { type: "launch.requested", organ: "navigator", at: 1_000 }));
    const failed = transitionRuntimeState(state, { type: "launch.failed", organ: "navigator", at: 1_001 });
    state = failed.state;
    expect(state.observed.navigator.status).toBe("backoff");
    expect(new Date(state.observed.navigator.nextEligibleAt).getTime()).toBe(1_101);
    expect(failed.receipt).toMatchObject({
      event: "launch.failed",
      failureCount: 1,
      nextEligibleAt: new Date(1_101).toISOString(),
    });
    expect(planRuntimeReconciliation(state, 1_050).waits[0].reason).toBe("crash-backoff");
    expect(planRuntimeReconciliation(state, 1_101).actions[0]).toMatchObject({ type: "start", organ: "navigator" });
  });

  test("reserves resource budgets and bounds simultaneous starts", () => {
    const state = createRuntimeState(profile(), 0);
    const plan = planRuntimeReconciliation(state, 0);
    expect(plan.actions.map((action) => action.organ)).toEqual(["navigator", "memory"]);
    expect(plan.waits).toContainEqual({ organ: "research", reason: "start-concurrency-limit" });
    expect(plan.reserved).toEqual({ memoryMb: 700, cpuUnits: 2, workerConcurrency: 3 });
  });
});

describe("Orange Runtime Profile durable state", () => {
  test("persists desired and observed truth with a valid receipt chain", () => {
    const root = tempRoot();
    const store = new RuntimeProfileStore(root);
    let state = createRuntimeState(profile(), 0);
    const first = transitionRuntimeState(state, {
      type: "desired.changed", organ: "research", desired: "stopped", reason: "operator", at: 1,
    });
    state = first.state;
    store.persist(state, [first.receipt]);
    const second = transitionRuntimeState(state, { type: "launch.requested", organ: "navigator", at: 2 });
    store.persist(second.state, [second.receipt]);

    expect(fs.existsSync(path.join(root, "desired.json"))).toBe(true);
    expect(fs.existsSync(path.join(root, "observed.json"))).toBe(true);
    expect(store.load(profile(), 3).desired.research).toBe("stopped");
    expect(store.verifyReceiptChain()).toMatchObject({ ok: true, count: 2 });
    expect(store.readReceipts()[1].previousReceiptHash).toBe(store.readReceipts()[0].receiptHash);
  });

  test("uses the OrangeBox-Data orange5 canonical disk root", () => {
    expect(canonicalRuntimeProfileRoot()).toContain(path.join("OrangeBox-Data", "orange5", "runtime-profile"));
  });
});

describe("Bun-native process ownership", () => {
  test("launches a hidden detached child without PowerShell", async () => {
    let observedCommand;
    let observedOptions;
    const child = {
      pid: 77,
      exited: Promise.resolve(0),
      unrefCalled: false,
      unref() { this.unrefCalled = true; },
      kill() {},
    };
    const launcher = new BunRuntimeLauncher({
      spawn(command, options) {
        observedCommand = command;
        observedOptions = options;
        return child;
      },
    });
    const navigator = profile().organs[0];
    const launched = launcher.launch(navigator);
    expect(observedCommand).toEqual(["bun", "navigator.mjs"]);
    expect(observedCommand.join(" ").toLowerCase()).not.toContain("powershell");
    expect(observedOptions).toMatchObject({
      windowsHide: true,
      detached: true,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    expect(observedOptions.env.ORANGE_RUNTIME_WORKER_CONCURRENCY).toBe("2");
    expect(child.unrefCalled).toBe(true);
    expect(await launched.exited).toBe(0);
  });

  test("supervisor starts only the bounded plan and persists lifecycle receipts", async () => {
    const root = tempRoot();
    const store = new RuntimeProfileStore(root);
    const exits = [];
    const launches = [];
    const launcher = {
      launch(organ) {
        launches.push(organ.name);
        let resolve;
        const exited = new Promise((done) => { resolve = done; });
        exits.push(resolve);
        return { pid: 100 + launches.length, exited };
      },
      stop() { return { ok: true }; },
    };
    let tick = 10;
    const supervisor = new OrangeRuntimeSupervisor({
      profile: profile(),
      store,
      launcher,
      clock: () => new Date(tick++),
    });
    const result = await supervisor.reconcile();
    expect(launches).toEqual(["navigator", "memory"]);
    expect(result.state.observed.navigator.status).toBe("running");
    expect(result.state.observed.memory.status).toBe("running");
    expect(result.plan.waits[0]).toMatchObject({ organ: "research", reason: "start-concurrency-limit" });
    expect(store.verifyReceiptChain()).toMatchObject({ ok: true, count: 4 });
    expect(store.readReceipts().map((receipt) => receipt.event)).toEqual([
      "launch.requested", "launch.requested", "launch.succeeded", "launch.succeeded",
    ]);
    expect(exits).toHaveLength(2);
  });
});
