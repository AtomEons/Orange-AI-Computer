// Flowstate ext — delta batching (report-noise compression).
// Path: 05-FLOW/ext/delta-batch.mjs
//
// Raw state.deltas is a flat event log; at active cadence the operator sees
// one row per event. Batching groups a slice by kind so a tick report reads
// "agent_assigned x4 [...]" instead of four rows. createDeltaBatcher tracks
// a cursor across ticks and survives the store's tail-trim (saveState keeps
// only the last MAX_DELTAS entries).
//
// batchDeltas / formatBatches are pure. The batcher holds only its own
// cursor — it never mutates state. No imports from 05-FLOW/src needed.

/**
 * Group a delta slice by kind, preserving first-seen kind order.
 * @param {Array<{id,ts,kind,subject_id,payload}>} deltas
 * @returns {Array<{kind, count, subject_ids: string[], first_ts, last_ts}>}
 */
export function batchDeltas(deltas) {
  const byKind = new Map();
  for (const d of deltas) {
    let b = byKind.get(d.kind);
    if (!b) {
      b = { kind: d.kind, count: 0, subject_ids: [], first_ts: d.ts, last_ts: d.ts };
      byKind.set(d.kind, b);
    }
    b.count += 1;
    if (!b.subject_ids.includes(d.subject_id)) b.subject_ids.push(d.subject_id);
    if (d.ts < b.first_ts) b.first_ts = d.ts;
    if (d.ts > b.last_ts) b.last_ts = d.ts;
  }
  return [...byKind.values()];
}

/**
 * Render batches as compact operator lines.
 * `agent_assigned x4 [agent_1,agent_2,+2 more] span=120ms`
 */
export function formatBatches(batches, { max_subjects = 5 } = {}) {
  const lines = [];
  for (const b of batches) {
    const shown = b.subject_ids.slice(0, max_subjects);
    const more = b.subject_ids.length - shown.length;
    const subj = shown.join(",") + (more > 0 ? `,+${more} more` : "");
    const span = b.last_ts - b.first_ts;
    lines.push(`${b.kind} x${b.count} [${subj}]${span > 0 ? ` span=${span}ms` : ""}`);
  }
  return lines;
}

/**
 * Cursor over state.deltas. flush() returns batches of only the deltas
 * appended since the previous flush (or since creation), then advances.
 * peek() reports without advancing.
 *
 * Trim safety: the store may slice the tail of state.deltas. The cursor is
 * an id, not an index; if the cursor id has been trimmed out of the buffer,
 * flush returns the whole remaining buffer and flags trimmed:true so the
 * operator knows counts may under-report the gap.
 */
export function createDeltaBatcher(state) {
  let lastId = state.deltas.length > 0 ? state.deltas[state.deltas.length - 1].id : null;

  function pendingSlice() {
    const arr = state.deltas;
    if (lastId === null) return { slice: arr.slice(), trimmed: false };
    const idx = arr.findIndex(d => d.id === lastId);
    if (idx === -1) return { slice: arr.slice(), trimmed: true };
    return { slice: arr.slice(idx + 1), trimmed: false };
  }

  function flush() {
    const { slice, trimmed } = pendingSlice();
    if (slice.length > 0) lastId = slice[slice.length - 1].id;
    return { batches: batchDeltas(slice), raw_count: slice.length, trimmed };
  }

  function peek() {
    const { slice, trimmed } = pendingSlice();
    return { batches: batchDeltas(slice), raw_count: slice.length, trimmed };
  }

  return { flush, peek };
}
