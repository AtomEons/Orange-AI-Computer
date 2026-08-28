// 09 — G-08 — The four lanes are immutable.
//
// Boot check. Reads `01-DOCTRINE/lanes/lanes.json` and asserts:
//   - exactly four entries
//   - canonical ids and names: builder, frontier, release, ops
//   - sha256 of the file matches the recorded value in
//     state.statusDb["G-08"].lanes_sha256 (if pinned)
//
// If the lanes file does not exist, returns pass:false with reason
// `missing_lanes_manifest` — the runtime must materialize it on first
// boot through the constitutional-amendment procedure (spec §9).

import { resolve } from "node:path";
import {
  safe,
  result,
  ORANGE5_ROOT,
  fileExists,
  readTextSafe,
  sha256OfFile,
} from "../lib/check-util.mjs";

export const id = "G-08";
export const slug = "four-lanes-immutable";
export const severity = "block";

export const CANONICAL_LANES = [
  { id: "builder", name: "builder" },
  { id: "frontier", name: "frontier" },
  { id: "release", name: "release" },
  { id: "ops", name: "ops" },
];

export const check = safe(async (state, opts) => {
  const path =
    state.lanesPath ||
    resolve(opts.scanRoot || ORANGE5_ROOT, "01-DOCTRINE", "lanes", "lanes.json");

  if (!fileExists(path)) {
    return result(false, {
      reason: "missing_lanes_manifest",
      path,
      receipt_trigger: "G08_LANE_MUTATION",
    });
  }

  const text = readTextSafe(path);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return result(false, {
      reason: "lanes_manifest_invalid_json",
      path,
      error: String(e.message),
      receipt_trigger: "G08_LANE_MUTATION",
    });
  }

  const entries = Array.isArray(parsed) ? parsed : parsed && parsed.lanes;
  if (!Array.isArray(entries)) {
    return result(false, {
      reason: "lanes_manifest_shape_invalid",
      path,
      receipt_trigger: "G08_LANE_MUTATION",
    });
  }

  if (entries.length !== 4) {
    return result(false, {
      reason: "lane_count_drift",
      observed: entries.length,
      expected: 4,
      receipt_trigger: "G08_LANE_MUTATION",
    });
  }

  for (let i = 0; i < 4; i++) {
    const got = entries[i];
    const want = CANONICAL_LANES[i];
    if (!got || got.id !== want.id || got.name !== want.name) {
      return result(false, {
        reason: "lane_identity_drift",
        index: i,
        observed: got,
        expected: want,
        receipt_trigger: "G08_LANE_MUTATION",
      });
    }
  }

  const sha = sha256OfFile(path);
  const pinned =
    (state.statusDb &&
      state.statusDb["G-08"] &&
      state.statusDb["G-08"].lanes_sha256) ||
    null;
  if (pinned && pinned !== sha) {
    return result(false, {
      reason: "lanes_manifest_sha_mismatch",
      observed_sha256: sha,
      pinned_sha256: pinned,
      receipt_trigger: "G08_LANE_MUTATION",
    });
  }

  return result(true, { path, sha256: sha, lane_count: 4 });
});

export default check;
