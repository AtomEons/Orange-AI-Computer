import { organByName } from "./schema.mjs";
import { planRuntimeReconciliation, transitionRuntimeState } from "./state-machine.mjs";
import { RuntimeProfileStore } from "./store.mjs";
import { BunRuntimeLauncher } from "./launcher.mjs";

export class OrangeRuntimeSupervisor {
  constructor({
    profile,
    store = new RuntimeProfileStore(),
    launcher = new BunRuntimeLauncher(),
    clock = () => new Date(),
  }) {
    this.profile = profile;
    this.store = store;
    this.launcher = launcher;
    this.clock = clock;
    this.state = store.load(profile, clock());
    this.mutation = Promise.resolve();
  }

  snapshot() {
    return structuredClone(this.state);
  }

  setDesired(organ, desired, reason = "operator-desired-state") {
    return this.#commit({ type: "desired.changed", organ, desired, reason, at: this.clock() });
  }

  recordHealth(organ, ok, reason = ok ? "health-probe-passed" : "health-probe-failed") {
    return this.#commit({ type: ok ? "health.passed" : "health.failed", organ, reason, at: this.clock() });
  }

  async reconcile() {
    const plan = planRuntimeReconciliation(this.state, this.clock());
    const results = await Promise.all(plan.actions.map((action) => (
      action.type === "start" ? this.#start(action) : this.#stop(action)
    )));
    return { plan, results, state: this.snapshot() };
  }

  async #start(action) {
    const organ = organByName(this.profile, action.organ);
    await this.#commit({ type: "launch.requested", organ: organ.name, reason: action.reason, at: this.clock() });
    try {
      const launched = this.launcher.launch(organ);
      await this.#commit({
        type: "launch.succeeded",
        organ: organ.name,
        pid: launched.pid,
        reason: "bun-hidden-child-started",
        at: this.clock(),
      });
      launched.exited.then((exitCode) => this.#commit({
        type: "process.exited",
        organ: organ.name,
        exitCode,
        reason: "bun-child-exited",
        at: this.clock(),
      })).catch(() => {});
      return { ok: true, organ: organ.name, pid: launched.pid };
    } catch (error) {
      await this.#commit({
        type: "launch.failed",
        organ: organ.name,
        reason: String(error?.message || error),
        at: this.clock(),
      });
      return { ok: false, organ: organ.name, reason: String(error?.message || error) };
    }
  }

  async #stop(action) {
    const organ = organByName(this.profile, action.organ);
    await this.#commit({ type: "stop.requested", organ: organ.name, reason: action.reason, at: this.clock() });
    const stopped = this.launcher.stop(organ, action.pid);
    await this.#commit({
      type: stopped.ok ? "stop.completed" : "stop.failed",
      organ: organ.name,
      reason: stopped.reason || "owned-bun-child-stopped",
      at: this.clock(),
    });
    return { ...stopped, organ: organ.name };
  }

  #commit(event) {
    const operation = this.mutation.then(() => {
      const result = transitionRuntimeState(this.state, event);
      this.state = result.state;
      const [receipt] = this.store.persist(this.state, [result.receipt]);
      return { state: this.snapshot(), receipt };
    });
    this.mutation = operation.catch(() => {});
    return operation;
  }
}
