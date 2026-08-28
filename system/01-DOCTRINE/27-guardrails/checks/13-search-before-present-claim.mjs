// 13 — G-12 — Search before claim for present-day facts.
//
// Online check. An assistant turn that contains a present-day claim
// (price, version, "currently", "as of <recent year>", "today",
// "this week", "right now", a date newer than the model cutoff) MUST
// reference a `search_receipt_id` in its turn metadata.
//
// state.assistantTurn       : string
// state.turnMetadata        : { search_receipt_id?: string }
// state.modelCutoffYear     : number — defaults to 2026 (knowledge cutoff
//                                       declared in this project)
// state.priorOffenseInSession : boolean — true escalates from warn → block

import { safe, result } from "../lib/check-util.mjs";

export const id = "G-12";
export const slug = "search-before-present-claim";
export const severity = "warn"; // escalates to block on second offense

const CURRENCY_RX = /\$\s?\d|\b\d+\s?(USD|EUR|GBP)\b/i;
const CURRENT_WORDS_RX =
  /\b(today|currently|right now|as of (?:this|last) (?:week|month|year)|this (?:week|month|year)|this morning|this afternoon|just (?:released|launched|announced)|latest version|now (?:supports|costs|works))\b/i;
const VERSION_RX = /\bv?\d+\.\d+(?:\.\d+)?\b/;
const DATE_YEAR_RX = /\b(20\d{2})\b/g;

function tripsPresentDay(turn, cutoffYear) {
  if (CURRENCY_RX.test(turn)) return "currency_or_price";
  if (CURRENT_WORDS_RX.test(turn)) return "present_time_phrase";
  if (VERSION_RX.test(turn)) return "version_string";
  for (const m of turn.matchAll(DATE_YEAR_RX)) {
    const y = Number.parseInt(m[1], 10);
    if (y >= cutoffYear) return `year_${y}_at_or_past_cutoff_${cutoffYear}`;
  }
  return null;
}

export const check = safe(async (state, _opts) => {
  const turn = state.assistantTurn;
  if (typeof turn !== "string" || turn.length === 0) {
    return result(true, { reason: "no_turn_to_judge" });
  }
  const cutoff = Number.isFinite(state.modelCutoffYear)
    ? state.modelCutoffYear
    : 2026;

  const trip = tripsPresentDay(turn, cutoff);
  if (!trip) {
    return result(true, { trip: null });
  }

  const meta = state.turnMetadata || {};
  if (meta.search_receipt_id && String(meta.search_receipt_id).length > 0) {
    return result(true, {
      trip,
      search_receipt_id: meta.search_receipt_id,
    });
  }

  const escalate = Boolean(state.priorOffenseInSession);
  return result(false, {
    reason: "ungrounded_present_day_claim",
    trip,
    cutoff_year: cutoff,
    severity_now: escalate ? "block" : "warn",
    second_offense: escalate,
    receipt_trigger: "G12_UNGROUNDED_PRESENT_CLAIM",
    remedy:
      "Run web_search for the trip phrase, attach the search_receipt_id to the turn metadata, re-emit.",
  });
});

export default check;
