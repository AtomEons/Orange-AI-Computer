// G21 — Receipts directory exists and is writable.

import {
  existsSync,
  mkdirSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { RECEIPTS_DIR } from "../lib/paths.mjs";

export async function run() {
  try {
    if (!existsSync(RECEIPTS_DIR)) {
      mkdirSync(RECEIPTS_DIR, { recursive: true });
    }
    const probe = join(RECEIPTS_DIR, `.guardrail-probe-${Date.now()}.tmp`);
    writeFileSync(probe, "ok", "utf8");
    unlinkSync(probe);
    return { pass: true, details: { path: RECEIPTS_DIR, writable: true } };
  } catch (e) {
    return {
      pass: false,
      details: { reason: "receipts dir not writable", path: RECEIPTS_DIR, err: String(e?.message || e) },
    };
  }
}
