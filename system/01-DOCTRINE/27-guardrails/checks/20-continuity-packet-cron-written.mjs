// 20 — G-19 — Continuity Packet is cron-written at end of day.
//
// Online check. Looks for a `CONTINUITY_WRITTEN` receipt within the last
// `maxAgeHours` window (default 26 — gives the cron at 23:50 some slack).
//
// state.recentReceipts : Array<{ trigger, ts, ... }>
// state.maxAgeHours    : number  (override; default 26)
// state.nowMs          : number  (override "now" for tests)

import { safe, result } from "../lib/check-util.mjs";

export const id = "G-19";
export const slug = "continuity-packet-cron-written";
export const severity = "warn";

export const check = safe(async (state, _opts) => {
  const rows = Array.isArray(state.recentReceipts) ? state.recentReceipts : [];
  if (rows.length === 0) {
    return result(false, {
      reason: "no_receipt_window",
      receipt_trigger: "G19_CONTINUITY_NOT_WRITTEN",
    });
  }
  const maxHours = Number.isFinite(state.maxAgeHours) ? state.maxAgeHours : 26;
  const now = Number.isFinite(state.nowMs) ? state.nowMs : Date.now();
  const cutoff = now - maxHours * 3600 * 1000;

  const writes = rows.filter((r) => r && r.trigger === "CONTINUITY_WRITTEN");
  const recent = writes.filter((r) => Number(r.ts) >= cutoff);

  if (recent.length === 0) {
    const lastTs = writes.length
      ? Math.max(...writes.map((r) => Number(r.ts) || 0))
      : null;
    return result(false, {
      reason: "no_recent_continuity_written_receipt",
      window_hours: maxHours,
      last_written_ts: lastTs,
      total_writes_in_window: rows.length,
      receipt_trigger: "G19_CONTINUITY_NOT_WRITTEN",
      remedy:
        "Verify cron entry `04-CONTROL-PLANE/cron/continuity_packet.daily.js` is registered and running. Manually run `npm run continuity:write` to recover and emit the missing receipt.",
    });
  }

  const newest = Math.max(...recent.map((r) => Number(r.ts)));
  return result(true, {
    count: recent.length,
    newest_ts: newest,
    window_hours: maxHours,
  });
});

export default check;
