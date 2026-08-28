// 12 — G-11 — No simulation of real persons.
//
// Online check on an emitted assistant turn. Inputs:
//   state.assistantTurn : string — the text to scan
//   state.protectedIdentities : string[] — drawn from Soul Genome
//   state.soulGenomePath : string|null — fallback source for the list
//
// Patterns flagged (first-person impersonation):
//   - "as <Name> would say"
//   - "speaking as <Name>"
//   - "<Name>: \"" / "<Name> said: \""
//   - quoted block headed by "— <Name>" where Name is in the protected list
//
// We only flag NAMED real persons (those in the protected list). Generic
// "a doctor would say" is fine — the breach is impersonation of a real
// individual.

import {
  safe,
  result,
  SOUL_GENOME_PATH,
  readTextSafe,
} from "../lib/check-util.mjs";

export const id = "G-11";
export const slug = "no-real-person-simulation";
export const severity = "block";

function loadProtected(state) {
  if (Array.isArray(state.protectedIdentities)) return state.protectedIdentities;
  const txt = readTextSafe(state.soulGenomePath || SOUL_GENOME_PATH);
  if (!txt) return [];
  try {
    const j = JSON.parse(txt);
    if (Array.isArray(j.protected_identities)) return j.protected_identities;
  } catch {}
  return [];
}

function escapeRx(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const check = safe(async (state, _opts) => {
  const turn = state.assistantTurn;
  if (typeof turn !== "string") {
    return result(false, {
      reason: "no_assistant_turn",
      receipt_trigger: "G11_PERSON_SIMULATION",
      remedy:
        "Pass state.assistantTurn to scan. The witness needs the text to scrutinize.",
    });
  }

  const names = loadProtected(state);
  if (names.length === 0) {
    return result(true, {
      note: "no_protected_identities_configured",
      turn_length: turn.length,
    });
  }

  const offenders = [];
  for (const name of names) {
    const n = escapeRx(name);
    const patterns = [
      new RegExp(`\\bas\\s+${n}\\s+would\\s+say\\b`, "i"),
      new RegExp(`\\bspeaking\\s+as\\s+${n}\\b`, "i"),
      new RegExp(`\\b${n}\\s*:\\s*["“]`, "i"),
      new RegExp(`\\b${n}\\s+(said|says|writes|tweeted|wrote):?\\s+["“]`, "i"),
      new RegExp(`["”]\\s*[—–-]\\s*${n}\\b`, "i"),
      new RegExp(`\\bin\\s+${n}'s\\s+voice\\b`, "i"),
      new RegExp(`\\bchannel(?:ing|ling)\\s+${n}\\b`, "i"),
    ];
    for (const rx of patterns) {
      const m = turn.match(rx);
      if (m) {
        offenders.push({
          identity: name,
          pattern: rx.source,
          match: m[0],
          index: m.index,
        });
      }
    }
  }

  if (offenders.length > 0) {
    return result(false, {
      reason: "first_person_simulation_of_real_named_person",
      offenders,
      protected_count: names.length,
      receipt_trigger: "G11_PERSON_SIMULATION",
      remedy:
        "Cite the framework / result / technique. Do not put words in a named real person's mouth.",
    });
  }

  return result(true, {
    protected_count: names.length,
    turn_length: turn.length,
  });
});

export default check;
