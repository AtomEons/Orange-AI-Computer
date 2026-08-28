// G08 — The 4 operator lanes (Chat / Cockpit / Vault / Settings) are immutable.
//
// We read 02-APP/src/router.tsx and 02-APP/src/lanes/ and assert exactly those
// four lane names, no more, no fewer.

import { resolve } from "node:path";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { APP_ROUTER, APP_LANES_DIR } from "../lib/paths.mjs";

const REQUIRED = ["Chat", "Cockpit", "Vault", "Settings"];

export async function run() {
  const issues = [];

  if (existsSync(APP_LANES_DIR)) {
    const files = readdirSync(APP_LANES_DIR);
    const lanes = REQUIRED.filter((lane) =>
      files.some((file) => new RegExp(`^${lane}\\.(tsx|jsx|ts|js)$`).test(file))
    );
    const missing = REQUIRED.filter((l) => !lanes.includes(l));
    if (missing.length > 0) issues.push({ kind: "missing_lane_file", lanes: missing });
  } else {
    issues.push({ kind: "lanes_dir_missing", path: APP_LANES_DIR });
  }

  if (existsSync(APP_ROUTER)) {
    const body = readFileSync(APP_ROUTER, "utf8");
    const requiredRoutes = ["/chat", "/cockpit", "/vault", "/settings"];
    const missing = requiredRoutes.filter((r) => !body.includes(`path="${r}"`));
    if (missing.length > 0) issues.push({ kind: "missing_route", routes: missing });
    // Any other top-level path="/foo" we don't expect (excluding "/" navigate)
    const allPaths = [...body.matchAll(/path="(\/[a-z][a-z0-9-]*)"/g)].map((m) => m[1]);
    const extra = allPaths.filter((p) => !requiredRoutes.includes(p));
    if (extra.length > 0) issues.push({ kind: "extra_route", routes: extra });
  } else {
    issues.push({ kind: "router_missing", path: APP_ROUTER });
  }

  if (issues.length > 0) {
    return { pass: false, details: { reason: "4-lane invariant breached", issues } };
  }
  return { pass: true, details: { lanes: REQUIRED } };
}
