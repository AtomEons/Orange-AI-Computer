// scan.mjs — bounded filesystem helpers used by multiple check modules.
//
// We deliberately walk the tree ourselves (rather than shelling out to
// ripgrep) so the checker runs identically on N150, Codexa, and Bun
// without external binaries. Walks are depth-capped and skip noisy dirs.

import { readdirSync, statSync, readFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { spawnSync } from "node:child_process";

const DEFAULT_SKIP = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "target",
  ".turbo",
  ".venv",
  "venv",
  "__pycache__",
  ".cache",
  ".pnpm",
  "coverage",
]);

const WALK_CACHE = new Map();
const READ_CACHE = new Map();

export function walk(root, {
  exts = null,
  skip = DEFAULT_SKIP,
  maxFiles = 5000,
  maxDepth = 12,
} = {}) {
  const cacheKey = JSON.stringify({ root, exts, skip: [...skip], maxFiles, maxDepth });
  if (WALK_CACHE.has(cacheKey)) return [...WALK_CACHE.get(cacheKey)];
  const out = [];
  if (!existsSync(root)) return out;

  // Ripgrep's directory walker is dramatically faster on the N150 and
  // already handles Windows junctions safely. Keep the JS walker below as
  // the dependency-free fallback used when rg is unavailable.
  const args = ['--files', '--hidden'];
  for (const name of skip) args.push('-g', `!**/${name}/**`);
  const fast = spawnSync('rg', args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (fast.status === 0 || (fast.status === 1 && !fast.error)) {
    for (const relative of String(fast.stdout || '').split(/\r?\n/).filter(Boolean)) {
      if (relative.split(/[\\/]/).length - 1 > maxDepth) continue;
      if (exts && !exts.includes(extname(relative).toLowerCase())) continue;
      out.push(join(root, relative));
      if (out.length >= maxFiles) break;
    }
    WALK_CACHE.set(cacheKey, [...out]);
    return out;
  }

  function visit(dir, depth) {
    if (depth > maxDepth) return;
    if (out.length >= maxFiles) return;
    let entries;
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      if (skip.has(name)) continue;
      const p = join(dir, name);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) {
        visit(p, depth + 1);
      } else if (st.isFile()) {
        if (!exts || exts.includes(extname(name).toLowerCase())) {
          out.push(p);
          if (out.length >= maxFiles) return;
        }
      }
    }
  }
  visit(root, 0);
  WALK_CACHE.set(cacheKey, [...out]);
  return out;
}

export function readSafe(p) {
  if (READ_CACHE.has(p)) return READ_CACHE.get(p);
  try {
    // Guardrails inspect source/config, not generated corpora. Large JSON
    // fixtures and tokenizer payloads can exceed 100 MB and made a single
    // constitutional sweep stall the N150 for minutes.
    if (extname(p).toLowerCase() === ".json" && statSync(p).size > 2 * 1024 * 1024) {
      READ_CACHE.set(p, null);
      return null;
    }
    const body = readFileSync(p, "utf8");
    READ_CACHE.set(p, body);
    return body;
  } catch {
    READ_CACHE.set(p, null);
    return null;
  }
}

export function matchingFiles(root, pattern, {
  exts = null,
  skip = DEFAULT_SKIP,
  maxFiles = 5000,
  maxDepth = 12,
  caseInsensitive = false,
} = {}) {
  if (!existsSync(root)) return [];
  const args = ['--files-with-matches', '--hidden', '--no-messages'];
  if (caseInsensitive) args.push('-i');
  for (const name of skip) args.push('-g', `!**/${name}/**`);
  if (exts) {
    for (const ext of exts) args.push('-g', `*${ext}`);
  }
  args.push('-e', pattern, '.');
  const found = spawnSync('rg', args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (found.status !== 0 && found.status !== 1) return [];
  const out = [];
  for (const relative of String(found.stdout || '').split(/\r?\n/).filter(Boolean)) {
    if (relative.split(/[\\/]/).length - 1 > maxDepth) continue;
    out.push(join(root, relative));
    if (out.length >= maxFiles) break;
  }
  return out;
}

export function grep(files, pattern, { caseInsensitive = false, maxHits = 50 } = {}) {
  const re = pattern instanceof RegExp
    ? pattern
    : new RegExp(pattern, caseInsensitive ? "i" : "");
  const hits = [];
  for (const f of files) {
    const body = readSafe(f);
    if (body == null) continue;
    if (re.test(body)) {
      hits.push(f);
      if (hits.length >= maxHits) break;
    }
  }
  return hits;
}
