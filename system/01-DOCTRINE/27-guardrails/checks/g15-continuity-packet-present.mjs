// G15 — Continuity Packet for previous day exists by 06:00 local.
//
// MEDIUM severity: if yesterday's packet is missing AND the local clock is
// past 06:00, we flag it. Before 06:00 we hold the flag (cron may not have
// fired yet).

import { continuityForYesterdayExists, loadMostRecentContinuity } from "../lib/continuity-packet.mjs";

export async function run() {
  const now = new Date();
  const hour = now.getHours();
  const exists = continuityForYesterdayExists();
  const latest = loadMostRecentContinuity();
  if (exists) {
    return {
      pass: true,
      details: { yesterday_packet: true, latest_date: latest?.date || null },
    };
  }
  if (hour < 6) {
    return {
      pass: true,
      details: {
        note: "before 06:00 local — cron grace window",
        local_hour: hour,
        latest_date: latest?.date || null,
      },
    };
  }
  return {
    pass: false,
    details: {
      reason: "yesterday's continuity packet missing past 06:00 local",
      local_hour: hour,
      latest_date: latest?.date || null,
    },
  };
}
