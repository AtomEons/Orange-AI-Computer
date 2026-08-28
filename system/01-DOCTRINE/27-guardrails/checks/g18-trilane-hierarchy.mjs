// G18 — GPT > Gemini on trilane conflict.
//
// If a trilane config file exists, it must declare a priority list and the
// position of "gpt" must be strictly less than the position of "gemini".

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ORANGE5_ROOT } from "../lib/paths.mjs";

const CANDIDATES = [
  resolve(ORANGE5_ROOT, "13-TOOLMESH/trilane.config.json"),
  resolve(ORANGE5_ROOT, "13-TOOLMESH/trilane.json"),
  resolve(ORANGE5_ROOT, "06-ORANGELLM/trilane.config.json"),
  resolve(ORANGE5_ROOT, "trilane.config.json"),
];

export async function run() {
  const path = CANDIDATES.find((p) => existsSync(p));
  if (!path) {
    return { pass: true, details: { note: "no trilane config yet" } };
  }
  let cfg;
  try { cfg = JSON.parse(readFileSync(path, "utf8")); } catch (e) {
    return { pass: false, details: { reason: "trilane config not JSON", path, err: String(e?.message || e) } };
  }
  const priority = cfg.priority || cfg.order || cfg.hierarchy;
  if (!Array.isArray(priority)) {
    return {
      pass: false,
      details: { reason: "trilane config missing priority array", path },
    };
  }
  const lower = priority.map((s) => String(s).toLowerCase());
  const gpt = lower.indexOf("gpt");
  const gemini = lower.indexOf("gemini");
  if (gpt === -1 || gemini === -1) {
    return {
      pass: false,
      details: { reason: "priority missing gpt or gemini", priority },
    };
  }
  if (gpt > gemini) {
    return {
      pass: false,
      details: { reason: "gemini ranked above gpt — hierarchy violated", priority },
    };
  }
  return { pass: true, details: { priority, path } };
}
