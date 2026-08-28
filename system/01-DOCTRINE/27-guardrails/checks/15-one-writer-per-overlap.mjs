// 15 — G-14 — One writer per overlapping file (path prefix).
//
// Online check. The runtime maintains a write-lock table:
//   state.writeLocks : Array<{ prefix: string, holder: string, ts: number }>
// A second writer for a path covered by an existing prefix is a breach.
//
// state.pendingWrite : { path: string, requester: string } — optional,
//   to evaluate a single request rather than the whole table.

import { safe, result } from "../lib/check-util.mjs";

export const id = "G-14";
export const slug = "one-writer-per-overlap";
export const severity = "block";

function norm(p) {
  return String(p).replace(/\\/g, "/").replace(/\/+$/, "");
}
function covers(prefix, path) {
  const a = norm(prefix);
  const b = norm(path);
  return b === a || b.startsWith(a + "/");
}

export const check = safe(async (state, _opts) => {
  const locks = Array.isArray(state.writeLocks) ? state.writeLocks : [];

  // 1) Audit existing locks for overlapping prefixes with different holders.
  const conflicts = [];
  for (let i = 0; i < locks.length; i++) {
    for (let j = i + 1; j < locks.length; j++) {
      const a = locks[i];
      const b = locks[j];
      if (!a || !b) continue;
      if (a.holder === b.holder) continue;
      if (covers(a.prefix, b.prefix) || covers(b.prefix, a.prefix)) {
        conflicts.push({ a, b });
      }
    }
  }

  // 2) If a pending write was supplied, judge it against the lock table.
  if (state.pendingWrite) {
    const { path, requester } = state.pendingWrite;
    const holder = locks.find(
      (l) => covers(l.prefix, path) && l.holder !== requester
    );
    if (holder) {
      return result(false, {
        reason: "write_collision",
        pending: state.pendingWrite,
        holder,
        receipt_trigger: "G14_WRITE_COLLISION",
      });
    }
  }

  if (conflicts.length > 0) {
    return result(false, {
      reason: "overlapping_locks_with_distinct_holders",
      conflicts,
      lock_count: locks.length,
      receipt_trigger: "G14_WRITE_COLLISION",
    });
  }

  return result(true, { lock_count: locks.length });
});

export default check;
