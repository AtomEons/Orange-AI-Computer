// G25 — No --no-verify or --no-gpg-sign flags in recent commit history.
//
// Bypass flags don't appear in the commit message itself, but their use is
// sometimes surfaced via reflog entries (e.g. "commit (--no-verify):"). We
// also check for a hooks-disabled marker file.

import { execSync } from "node:child_process";
import { ORANGE5_ROOT } from "../lib/paths.mjs";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

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
  const offenders = [];
  const reflog = git("reflog -n 100");
  if (reflog) {
    const re = /--no-verify|--no-gpg-sign|-c\s+commit\.gpgsign=false/;
    if (re.test(reflog)) {
      offenders.push({
        source: "reflog",
        sample: reflog.split(/\n/).filter((l) => re.test(l)).slice(0, 3),
      });
    }
  }
  const override = resolve(ORANGE5_ROOT, ".git/hooks/.disabled");
  if (existsSync(override)) {
    offenders.push({ source: "hooks_disabled_marker", path: override });
  }
  if (offenders.length > 0) {
    return {
      pass: false,
      details: { reason: "hook-skip evidence found", offenders },
    };
  }
  return {
    pass: true,
    details: { reflog_available: !!reflog, hooks_disabled_marker: false },
  };
}
