// G04 — Human Final Stop is reachable from any autonomous-action path.
//
// We check that the doctrine references HUMAN_FINAL_STOP / human_final_stop /
// "human final stop authority" in autonomous code, and that any module that
// declares itself autonomous (export const AUTONOMOUS = true) ALSO references
// the stop hook.

import { ORANGE5_ROOT } from "../lib/paths.mjs";
import { walk, readSafe } from "../lib/scan.mjs";

const AUTONOMOUS_MARK = /(AUTONOMOUS\s*[:=]\s*true|@autonomous\b|autonomous:\s*true)/i;
const STOP_REF = /(HUMAN_FINAL_STOP|human_final_stop|humanFinalStop|"human final stop"|Final\s+Stop\s+Authority)/i;

export async function run() {
  const files = walk(ORANGE5_ROOT, {
    exts: [".mjs", ".js", ".ts", ".tsx", ".py"],
    maxFiles: 5000,
  });
  const autonomousFiles = [];
  for (const f of files) {
    const body = readSafe(f);
    if (!body) continue;
    if (AUTONOMOUS_MARK.test(body)) autonomousFiles.push({ f, body });
  }
  const noStop = autonomousFiles.filter(({ body }) => !STOP_REF.test(body)).map(({ f }) => f);
  if (noStop.length > 0) {
    return {
      pass: false,
      details: {
        reason: "autonomous module without Human Final Stop reference",
        files: noStop.slice(0, 5),
      },
    };
  }
  return {
    pass: true,
    details: {
      autonomous_modules: autonomousFiles.length,
      all_reference_final_stop: true,
    },
  };
}
