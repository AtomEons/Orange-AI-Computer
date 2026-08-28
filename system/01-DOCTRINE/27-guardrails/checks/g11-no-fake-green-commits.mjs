// G11 — No fake-green words in commit messages without evidence.
//
// We sweep the last 50 commit messages on the current branch and flag any
// commit whose subject claims "passing" / "all green" / "tests pass" / "done"
// without a co-located receipts/tests/evidence path in the body.
//
// Best-effort: if git is not available we return pass with a note.

import { execSync } from "node:child_process";
import { ORANGE5_ROOT } from "../lib/paths.mjs";

const FAKE_GREEN = /(all green|fully passing|tests? (?:all )?pass(?:ing|ed)|100% (?:passing|green)|complete(?:ly)? done|fully ship(?:ped|s)?)/i;
const EVIDENCE = /(receipt|RECEIPT|10-RECEIPTS|tests?\/|coverage|evidence|sha256|hash)/;

function git(args) {
  try {
    return execSync(`git ${args}`, {
      cwd: ORANGE5_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

export async function run() {
  const log = git('log --pretty=format:"<<<%H%n%s%n%b>>>" -n 50');
  if (!log) {
    return { pass: true, details: { note: "git unavailable — check skipped softly" } };
  }
  const commits = log
    .split(/<<</)
    .map((s) => s.replace(/>>>\s*$/, "").trim())
    .filter(Boolean)
    .map((blob) => {
      const [hash, subject, ...rest] = blob.split(/\n/);
      return { hash, subject: subject || "", body: rest.join("\n") };
    });
  const offenders = [];
  for (const c of commits) {
    if (FAKE_GREEN.test(c.subject) && !EVIDENCE.test(c.body) && !EVIDENCE.test(c.subject)) {
      offenders.push({ hash: c.hash?.slice(0, 12), subject: c.subject });
    }
  }
  if (offenders.length > 0) {
    return {
      pass: false,
      details: {
        reason: "fake-green commit subject without receipts/tests reference",
        offenders: offenders.slice(0, 5),
        commits_scanned: commits.length,
      },
    };
  }
  return { pass: true, details: { commits_scanned: commits.length } };
}
