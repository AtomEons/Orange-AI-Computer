// Flow store — JSON snapshot to disk. SQLite migration lands in PR-10.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_PATH = process.env.ORANGE5_FLOW_STATE || join(__dirname, "..", "state", "flow.json");
const MAX_DELTAS = 500;

/** @type {import('./types.mjs').FlowState} */
const EMPTY_STATE = {
  currents: {},
  agents: {},
  deltas: [],
  tick: 0,
  last_tick_at: 0,
};

export function loadState() {
  if (!existsSync(STATE_PATH)) return structuredClone(EMPTY_STATE);
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf8"));
  } catch {
    return structuredClone(EMPTY_STATE);
  }
}

export function saveState(state) {
  // Trim delta tail to MAX_DELTAS
  if (state.deltas.length > MAX_DELTAS) {
    state.deltas = state.deltas.slice(-MAX_DELTAS);
  }
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

export function emptyState() {
  return structuredClone(EMPTY_STATE);
}
