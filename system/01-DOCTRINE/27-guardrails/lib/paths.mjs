// paths.mjs — single source for filesystem anchors used by guardrails.
//
// Every path is absolute, Windows-native. Override via env when running on
// a different machine or in CI; defaults follow the canonical Orange5 root.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

export const ORANGE5_ROOT =
  resolve(process.env.ORANGE5_ROOT || resolve(HERE, "..", "..", ".."));

export const GUARDRAILS_ROOT = resolve(
  process.env.ORANGE5_GUARDRAILS_ROOT ||
    `${ORANGE5_ROOT}/01-DOCTRINE/27-guardrails`
);

export const STATE_DIR = resolve(
  process.env.ORANGE5_GUARDRAILS_STATE || `${GUARDRAILS_ROOT}/state`
);

export const DB_PATH = resolve(
  process.env.ORANGE5_GUARDRAILS_DB || `${STATE_DIR}/guardrails.sqlite`
);

export const SOUL_GENOME_PATH = resolve(
  process.env.ORANGE5_SOUL_GENOME || `${STATE_DIR}/soul-genome.json`
);

export const CONTINUITY_DIR = resolve(
  process.env.ORANGE5_CONTINUITY_DIR || `${STATE_DIR}/continuity`
);

export const RECEIPTS_DIR = resolve(
  process.env.ORANGE5_RECEIPTS_DIR || `${ORANGE5_ROOT}/10-RECEIPTS`
);

export const APP_ROUTER = resolve(`${ORANGE5_ROOT}/02-APP/src/router.tsx`);
export const APP_LANES_DIR = resolve(`${ORANGE5_ROOT}/02-APP/src/lanes`);
export const FRONTIER_BOUNDARY_DOC = resolve(
  `${ORANGE5_ROOT}/06-ORANGELLM/FRONTIER_ISOLATION_BOUNDARY.md`
);
export const FLUX_ADAPTER = resolve(
  `${ORANGE5_ROOT}/11-MIRAGE/adapters/flux.mjs`
);

export const COBRA_BASE = process.env.AE_COBRA_BASE || "http://127.0.0.1:7419";
