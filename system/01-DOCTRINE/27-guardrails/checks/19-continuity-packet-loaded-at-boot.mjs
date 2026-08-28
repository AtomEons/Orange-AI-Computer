// 19 — G-18 — Continuity Packet auto-loaded at session boot.
//
// Boot check. Walks back up to 7 days looking for
// `01-DOCTRINE/continuity/continuity_YYYY-MM-DD.json`. If found, parses
// it and asserts the required fields. Missing → warn; malformed → block.
//
// state.todayISO : "YYYY-MM-DD" — override "today" for tests
// state.maxLookbackDays : number (default 7)

import { resolve } from "node:path";
import {
  safe,
  result,
  ORANGE5_ROOT,
  CONTINUITY_DIR,
  fileExists,
  readTextSafe,
} from "../lib/check-util.mjs";

export const id = "G-18";
export const slug = "continuity-packet-loaded-at-boot";
export const severity = "warn"; // block when malformed

const REQUIRED_FIELDS = [
  "schema_version",
  "date",
  "today_progress",
  "open_blockers",
  "tomorrows_first_action",
];

function todayISO(state) {
  if (typeof state.todayISO === "string") return state.todayISO;
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function dayShift(iso, days) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

export const check = safe(async (state, opts) => {
  const today = todayISO(state);
  const maxBack = Number.isFinite(state.maxLookbackDays)
    ? state.maxLookbackDays
    : 7;

  const dirCandidates = [
    resolve(
      opts.scanRoot || ORANGE5_ROOT,
      "01-DOCTRINE",
      "continuity"
    ),
    CONTINUITY_DIR,
  ];

  for (let i = 0; i <= maxBack; i++) {
    const iso = dayShift(today, -i);
    for (const dir of dirCandidates) {
      const p = resolve(dir, `continuity_${iso}.json`);
      if (!fileExists(p)) continue;
      const text = readTextSafe(p);
      let body;
      try {
        body = JSON.parse(text);
      } catch (e) {
        return result(false, {
          reason: "continuity_packet_malformed_json",
          path: p,
          error: String(e.message),
          severity_now: "block",
          receipt_trigger: "G18_CONTINUITY_MALFORMED",
        });
      }
      const missing = REQUIRED_FIELDS.filter((k) => !(k in body));
      if (missing.length > 0) {
        return result(false, {
          reason: "continuity_packet_missing_fields",
          path: p,
          missing,
          severity_now: "block",
          receipt_trigger: "G18_CONTINUITY_MALFORMED",
        });
      }
      return result(true, {
        path: p,
        date: body.date,
        days_back: i,
        open_blocker_count: Array.isArray(body.open_blockers)
          ? body.open_blockers.length
          : null,
      });
    }
  }

  return result(false, {
    reason: "no_continuity_packet_in_lookback_window",
    today,
    max_lookback_days: maxBack,
    searched_dirs: dirCandidates,
    severity_now: "warn",
    receipt_trigger: "G18_CONTINUITY_MISSING",
  });
});

export default check;
