// 18 — G-17 — Soul Genome is the single source of operator continuity.
//
// Boot + online:
//   (a) exactly one soul_genome.json at the canonical path (default
//       01-DOCTRINE/soul-genome/soul_genome.json, but the lib/paths.mjs
//       default `STATE_DIR/soul-genome.json` is also recognized — the
//       runtime configures which is authoritative).
//   (b) parses as JSON with `schema_version` and `operator` keys.
//   (c) sha256 matches state.statusDb["G-17"].sha256 (when pinned).
//   (d) no competing identity files: grep ORANGE5_ROOT for siblings
//       named soul_genome*.json outside the canonical path.

import { resolve, dirname } from "node:path";
import {
  safe,
  result,
  ORANGE5_ROOT,
  SOUL_GENOME_PATH,
  fileExists,
  readTextSafe,
  sha256OfFile,
  walkGrep,
} from "../lib/check-util.mjs";

export const id = "G-17";
export const slug = "soul-genome-single-source";
export const severity = "block";

const FILENAME_RX = /soul[_\-]?genome[^\\/]*\.json$/i;

export const check = safe(async (state, opts) => {
  const canonical =
    state.soulGenomePath ||
    resolve(
      opts.scanRoot || ORANGE5_ROOT,
      "01-DOCTRINE",
      "soul-genome",
      "soul_genome.json"
    );
  const fallback = SOUL_GENOME_PATH;

  // Which one exists?
  const candidates = [];
  if (fileExists(canonical)) candidates.push(canonical);
  if (fileExists(fallback) && fallback !== canonical) candidates.push(fallback);

  if (candidates.length === 0) {
    return result(false, {
      reason: "missing_soul_genome",
      checked: [canonical, fallback],
      receipt_trigger: "G17_SOUL_GENOME_FORK",
    });
  }

  const authoritative = candidates[0];

  // Validate shape.
  const txt = readTextSafe(authoritative);
  let body;
  try {
    body = JSON.parse(txt);
  } catch (e) {
    return result(false, {
      reason: "soul_genome_invalid_json",
      path: authoritative,
      error: String(e.message),
      receipt_trigger: "G17_SOUL_GENOME_FORK",
    });
  }
  if (!body || !body.schema_version || !body.operator) {
    return result(false, {
      reason: "soul_genome_shape_invalid",
      path: authoritative,
      missing: ["schema_version", "operator"].filter((k) => !body || !body[k]),
      receipt_trigger: "G17_SOUL_GENOME_FORK",
    });
  }

  // Check pinned sha.
  const sha = sha256OfFile(authoritative);
  const pinned =
    (state.statusDb &&
      state.statusDb["G-17"] &&
      state.statusDb["G-17"].sha256) ||
    null;
  if (pinned && pinned !== sha) {
    return result(false, {
      reason: "soul_genome_sha_changed_without_ack",
      observed_sha256: sha,
      pinned_sha256: pinned,
      receipt_trigger: "G17_SOUL_GENOME_FORK",
      remedy:
        "Soul Genome changed without an operator_ack token. Acknowledge via the boot prompt, then re-pin sha in status.db.",
    });
  }

  // Static scan for forks.
  const forks = [];
  for await (const m of walkGrep(opts.scanRoot || ORANGE5_ROOT, FILENAME_RX, {
    extensions: [".json"],
    maxFiles: 200,
  })) {
    // walkGrep matches lines; we want filenames — derive from match file.
    const f = m.file.replace(/\\/g, "/");
    if (!FILENAME_RX.test(f)) continue;
    if (
      f === authoritative.replace(/\\/g, "/") ||
      f === fallback.replace(/\\/g, "/")
    ) {
      continue;
    }
    forks.push(m.file);
    if (forks.length >= 20) break;
  }
  // Dedup file list.
  const uniqueForks = Array.from(new Set(forks));

  if (uniqueForks.length > 0) {
    return result(false, {
      reason: "competing_soul_genome_files",
      authoritative,
      forks: uniqueForks,
      receipt_trigger: "G17_SOUL_GENOME_FORK",
    });
  }

  return result(true, {
    path: authoritative,
    sha256: sha,
    schema_version: body.schema_version,
    operator_name: body.operator && body.operator.name,
    dir: dirname(authoritative),
  });
});

export default check;
