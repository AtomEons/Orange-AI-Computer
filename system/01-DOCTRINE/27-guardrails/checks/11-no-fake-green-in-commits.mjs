// 11 — G-10 — No fake-green words in commits.
//
// Online check, normally invoked by the commit-msg hook but also runnable
// against `state.recentCommits` for an audit pass.
//
// A "fake-green" commit message contains any of the banned words AND
// does NOT reference a receipt hash (`receipt:<sha>` token with at least
// 12 hex chars).
//
// state.recentCommits : Array<{ sha: string, message: string }>
// state.commitMessage : string|null   (single-message mode, for the hook)
//
// opts.fakeGreenWords : RegExp        — override the default word list

import { safe, result } from "../lib/check-util.mjs";

export const id = "G-10";
export const slug = "no-fake-green-in-commits";
export const severity = "block";

export const DEFAULT_FAKE_GREEN =
  /\b(passed|green|verified|complete[d]?|ready|ship(?:ped|s)?|all good|works?|tested|done|production[-\s]?ready)\b/i;

const RECEIPT_REF_RX = /receipt:([0-9a-f]{12,64})/i;

function judgeMessage(msg, rx) {
  if (typeof msg !== "string" || msg.length === 0) {
    return { offender: false };
  }
  const m = msg.match(rx);
  if (!m) return { offender: false };
  if (RECEIPT_REF_RX.test(msg)) return { offender: false, hit: m[0] };
  return { offender: true, hit: m[0] };
}

export const check = safe(async (state, opts) => {
  const rx = opts.fakeGreenWords || DEFAULT_FAKE_GREEN;

  // Single-message hook mode.
  if (typeof state.commitMessage === "string") {
    const v = judgeMessage(state.commitMessage, rx);
    if (v.offender) {
      return result(false, {
        reason: "fake_green_without_receipt",
        word: v.hit,
        message_preview: state.commitMessage.slice(0, 200),
        receipt_trigger: "G10_FAKE_GREEN_COMMIT",
      });
    }
    return result(true, { mode: "hook", message_clean: true });
  }

  // Bulk audit mode.
  const commits = Array.isArray(state.recentCommits) ? state.recentCommits : [];
  const offenders = [];
  for (const c of commits) {
    const v = judgeMessage(c.message, rx);
    if (v.offender) {
      offenders.push({ sha: c.sha, word: v.hit, message: c.message });
      if (offenders.length >= 50) break;
    }
  }
  if (offenders.length > 0) {
    return result(false, {
      reason: "fake_green_commits_in_window",
      offender_count: offenders.length,
      offenders,
      commits_checked: commits.length,
      receipt_trigger: "G10_FAKE_GREEN_COMMIT",
    });
  }
  return result(true, { mode: "audit", commits_checked: commits.length });
});

export default check;
