// 17 — G-16 — Scope before implementation.
//
// Online check. The orchestrator records tasks with a `coded` flag and an
// optional `scope_artifact` (path or id). A task that has `coded:true` and
// no scope_artifact is a warn-level breach.
//
// state.tasks : Array<{
//   id, coded: boolean, scope_artifact: string|null,
//   started_at?: number, lane?: string
// }>

import { safe, result } from "../lib/check-util.mjs";

export const id = "G-16";
export const slug = "scope-before-implementation";
export const severity = "warn";

export const check = safe(async (state, _opts) => {
  const tasks = Array.isArray(state.tasks) ? state.tasks : [];
  const offenders = [];
  for (const t of tasks) {
    if (!t) continue;
    if (!t.coded) continue;
    if (
      !t.scope_artifact ||
      (typeof t.scope_artifact === "string" && t.scope_artifact.length === 0)
    ) {
      offenders.push({
        task_id: t.id,
        lane: t.lane || null,
        started_at: t.started_at || null,
      });
    }
  }
  if (offenders.length > 0) {
    return result(false, {
      reason: "coded_without_scope_artifact",
      offender_count: offenders.length,
      offenders: offenders.slice(0, 50),
      tasks_checked: tasks.length,
      receipt_trigger: "G16_NO_SCOPE_ARTIFACT",
    });
  }
  return result(true, { tasks_checked: tasks.length });
});

export default check;
