// Flowstate ext — deterministic session replay.
// Path: 05-FLOW/ext/flow-replay.mjs
//
// Reproduce a flow session from a seed: a seeded PRNG generates an op script
// (register/push/close/tick), runScript executes it on a fresh emptyState
// with persistence disabled, and the trace records the field after every
// tick using ORDINALS (creation order), never raw ids or timestamps —
// the core runtime stamps Date.now() into ids/ts, so raw values differ
// between runs while the *behavior* is identical. Same seed => same trace
// => same fingerprint, across runs and machines.
//
// Imports 05-FLOW/src read-only; modifies nothing there. No disk writes:
// every tick gets a no-persist gate.

import { emptyState } from "../src/store.mjs";
import { pushCurrent, registerAgent, tick, closeCurrent } from "../src/flow.mjs";

/** Deterministic 32-bit PRNG (mulberry32). Returns () => float in [0,1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Persist gate that never saves — keeps replay off the live state file. */
export function noPersistGate() {
  return {
    shouldPersist: () => ({ persist: false, reason: "replay" }),
    markSaved() {},
    markSkipped() {},
    snapshot: () => null,
  };
}

const STATUS_LETTER = {
  pending: "p",
  in_progress: "r",
  awaiting_approval: "w",
  closed: "c",
  blocked: "b",
  escalated: "e",
};

/**
 * Generate a deterministic op script from a seed.
 * Ops: {op:"register", role} | {op:"push", title, pressure}
 *    | {op:"close", current:<ordinal>, receipt_path} | {op:"tick"}
 */
export function scriptFromSeed(seed, {
  ticks = 8,
  agents = 2,
  max_new_per_tick = 2,
  close_prob = 0.35,
} = {}) {
  if (!Number.isInteger(ticks) || ticks < 1) throw new TypeError(`ticks must be int >= 1: ${ticks}`);
  if (!Number.isInteger(agents) || agents < 1) throw new TypeError(`agents must be int >= 1: ${agents}`);
  const rng = mulberry32(seed >>> 0);
  const script = [];
  for (let a = 0; a < agents; a++) {
    script.push({ op: "register", role: `replay-agent-${a}` });
  }
  let created = 0;
  const open = new Set();
  for (let t = 0; t < ticks; t++) {
    const n = Math.floor(rng() * (max_new_per_tick + 1)); // 0..max_new_per_tick
    for (let i = 0; i < n; i++) {
      const pressure = Math.round(rng() * 100) / 100;
      script.push({ op: "push", title: `replay-c${created}`, pressure });
      open.add(created);
      created += 1;
    }
    if (open.size > 0 && rng() < close_prob) {
      const arr = [...open].sort((a, b) => a - b);
      const pick = arr[Math.floor(rng() * arr.length)];
      script.push({ op: "close", current: pick, receipt_path: `replay://${seed}/t${t}/c${pick}` });
      open.delete(pick);
    }
    script.push({ op: "tick" });
  }
  return script;
}

function snapshotLine(state, currentIds, agentIds) {
  const cs = currentIds.map(id => STATUS_LETTER[state.currents[id].status] ?? "?").join("");
  const as = agentIds
    .map(id => {
      const a = state.agents[id];
      if (a.state === "riding" && a.current_id) {
        const ord = currentIds.indexOf(a.current_id);
        return ord >= 0 ? `c${ord}` : "?";
      }
      return "-";
    })
    .join(",");
  return `t${state.tick}|c:${cs}|a:${as}`;
}

/**
 * Execute a script on a fresh emptyState (never the live store).
 * @returns {{state, trace: string[], currentIds: string[], agentIds: string[]}}
 */
export function runScript(script, { concurrency_cap = 3 } = {}) {
  const state = emptyState();
  const gate = noPersistGate();
  const currentIds = [];
  const agentIds = [];
  const trace = [];
  for (const step of script) {
    if (step.op === "register") {
      agentIds.push(registerAgent(state, { role: step.role }).id);
    } else if (step.op === "push") {
      currentIds.push(pushCurrent(state, { title: step.title, pressure: step.pressure }).id);
    } else if (step.op === "close") {
      const id = currentIds[step.current];
      if (id === undefined) throw new Error(`close references unknown ordinal ${step.current}`);
      closeCurrent(state, id, { receipt_path: step.receipt_path });
    } else if (step.op === "tick") {
      tick(state, { concurrency_cap, persistGate: gate });
      trace.push(snapshotLine(state, currentIds, agentIds));
    } else {
      throw new Error(`unknown script op: ${step.op}`);
    }
  }
  return { state, trace, currentIds, agentIds };
}

/** FNV-1a 32-bit over the joined trace — stable 8-hex fingerprint. */
export function traceFingerprint(trace) {
  const text = Array.isArray(trace) ? trace.join("\n") : String(trace);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * Full deterministic replay: seed -> script -> run -> fingerprint.
 * @returns {{state, trace, script, currentIds, agentIds, fingerprint}}
 */
export function replayFromSeed(seed, opts = {}) {
  const script = scriptFromSeed(seed, opts);
  const run = runScript(script, opts);
  return { ...run, script, fingerprint: traceFingerprint(run.trace) };
}
