// AE Orange5 Control Plane — adapter registry.
// In-memory for PR-10. SQLite migration when better-sqlite3 lands as a sanctioned dep.

import { mockAdapter } from "./adapters/mock.mjs";
import { localLlamaCppAdapter } from "./adapters/local-llama-cpp.mjs";
import { aiBoxTriadReadonlyAdapter } from "./adapters/ai-box-triad-readonly.mjs";
import { aiBoxAllowlistedCommandAdapter } from "./adapters/ai-box-allowlisted-command.mjs";

/**
 * @typedef {Object} Adapter
 * @property {string} id
 * @property {string} name
 * @property {string} lane         — 'mock'|'subscription_cli'|'local_endpoint'|'disabled'
 * @property {'READY'|'PLANNED'|'MISSING'|'DISABLED'} status
 * @property {(input: any) => Promise<any>} invoke
 */

const REGISTRY = new Map();

export function register(adapter) {
  if (!adapter.id) throw new Error("adapter must have id");
  REGISTRY.set(adapter.id, adapter);
  return adapter;
}

export function get(id) {
  return REGISTRY.get(id);
}

export function list() {
  return Array.from(REGISTRY.values()).map(a => ({
    id: a.id, name: a.name, lane: a.lane, status: a.status,
  }));
}

export function createDefaultRegistry() {
  register(mockAdapter);
  register(localLlamaCppAdapter);
  register(aiBoxTriadReadonlyAdapter);
  register(aiBoxAllowlistedCommandAdapter);
  return list();
}

export const REAL_NODES_ENABLED = process.env.ORANGEBOX_CONTROL_PLANE_REAL_NODES === "1";
