// 16 — G-15 — Read before broad edits.
//
// Online check. For every `edit` call we see in `state.editEvents`, there
// must be a prior `read` event in `state.readEvents` for the same path
// inside the same session.
//
// state.editEvents : Array<{ id, session_id, path, ts, read_ref_id? }>
// state.readEvents : Array<{ id, session_id, path, ts }>

import { safe, result } from "../lib/check-util.mjs";

export const id = "G-15";
export const slug = "read-before-broad-edits";
export const severity = "block";

function norm(p) {
  return String(p).replace(/\\/g, "/");
}

export const check = safe(async (state, _opts) => {
  const edits = Array.isArray(state.editEvents) ? state.editEvents : [];
  const reads = Array.isArray(state.readEvents) ? state.readEvents : [];

  // Index reads by (session_id, path) for fast lookup.
  const readIndex = new Map();
  for (const r of reads) {
    if (!r || !r.session_id || !r.path) continue;
    const k = `${r.session_id}|${norm(r.path)}`;
    const list = readIndex.get(k) || [];
    list.push(r);
    readIndex.set(k, list);
  }

  const blind = [];
  for (const e of edits) {
    if (!e || !e.session_id || !e.path) {
      blind.push({ edit: e, reason: "edit_event_malformed" });
      continue;
    }
    const k = `${e.session_id}|${norm(e.path)}`;
    const prior = readIndex.get(k) || [];
    const ok = prior.some((r) => r.ts <= e.ts);
    if (!ok) {
      blind.push({
        edit_id: e.id,
        session_id: e.session_id,
        path: e.path,
        ts: e.ts,
        reason: "no_prior_read_in_session",
      });
    }
  }

  if (blind.length > 0) {
    return result(false, {
      reason: "blind_edits_detected",
      offender_count: blind.length,
      offenders: blind.slice(0, 50),
      edits_checked: edits.length,
      reads_indexed: reads.length,
      receipt_trigger: "G15_BLIND_EDIT",
    });
  }

  return result(true, {
    edits_checked: edits.length,
    reads_indexed: reads.length,
  });
});

export default check;
