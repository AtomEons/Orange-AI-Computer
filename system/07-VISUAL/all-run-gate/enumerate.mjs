// AWE All-Run Gate — inventory enumerator
// Walks the checkout's 07-VISUAL/fixtures recursively and emits _inventory.json.

import { readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join, extname, resolve, sep } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const VISUAL_ROOT = resolve(process.env.ORANGE5_VISUAL_ROOT || resolve(HERE, ".."));
const ROOT = resolve(VISUAL_ROOT, "fixtures");
const OUT_DIR = resolve(VISUAL_ROOT, "all-run-gate");
const OUT_PATH = join(OUT_DIR, "_inventory.json");

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const VIDEO_EXTS = new Set([".mp4", ".mkv", ".webm", ".mov", ".avi"]);

const MIN_BYTES = 1000;
const MAX_BYTES = 500 * 1024 * 1024;

function classifySource(absPath) {
  const rel = absPath.slice(ROOT.length + 1);
  const first = rel.split(sep)[0] || "";
  if (first === "youtube-corpus") return "youtube-corpus";
  if (first === "meme-corpus") return "meme-corpus";
  return "other";
}

function walk(dir, acc) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return;
  }
  for (const ent of entries) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      walk(full, acc);
    } else if (ent.isFile()) {
      const ext = extname(ent.name).toLowerCase();
      const isImage = IMAGE_EXTS.has(ext);
      const isVideo = VIDEO_EXTS.has(ext);
      if (!isImage && !isVideo) continue;
      let st;
      try {
        st = statSync(full);
      } catch (e) {
        continue;
      }
      if (st.size < MIN_BYTES || st.size > MAX_BYTES) continue;
      acc.push({
        path: full.replace(/\\/g, "/"),
        type: isImage ? "image" : "video",
        format: ext.replace(".", ""),
        size_bytes: st.size,
        source: classifySource(full),
      });
    }
  }
}

const started = Date.now();
mkdirSync(OUT_DIR, { recursive: true });

const items = [];
walk(ROOT, items);

// deterministic order
items.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

// totals
const by_format = {};
const by_source = {};
const by_type = { image: 0, video: 0 };
let total_bytes = 0;
for (const it of items) {
  by_format[it.format] = (by_format[it.format] || 0) + 1;
  by_source[it.source] = (by_source[it.source] || 0) + 1;
  by_type[it.type] += 1;
  total_bytes += it.size_bytes;
}

const manifest = {
  version: "AWE-1.8",
  root: ROOT.replace(/\\/g, "/"),
  generated_at: new Date().toISOString(),
  wall_ms: Date.now() - started,
  filters: {
    min_bytes: MIN_BYTES,
    max_bytes: MAX_BYTES,
    image_exts: [...IMAGE_EXTS],
    video_exts: [...VIDEO_EXTS],
  },
  totals: {
    count: items.length,
    total_bytes,
    by_type,
    by_format,
    by_source,
  },
  items,
};

writeFileSync(OUT_PATH, JSON.stringify(manifest, null, 2));

// Report to stdout
const summary = {
  path: OUT_PATH.replace(/\\/g, "/"),
  count: items.length,
  total_bytes,
  by_type,
  by_format,
  by_source,
  wall_ms: manifest.wall_ms,
};
console.log(JSON.stringify(summary, null, 2));
