// 11-MIRAGE/adapters/receipts.mjs — READY (Night-1).
//
// Receipts mount. File glob over 10-RECEIPTS/orange5-build/ + 10-RECEIPTS/runtime-logs/.
// Receipts override recollection — this adapter is the canonical "what actually happened"
// surface when StateBrief needs ground truth that beats both reality and thought lanes.
//
// Read  : list / load / search receipts (markdown + JSON).
// Write : append a new dated receipt file (no overwrites, no deletes).
//
// Spec: 11-MIRAGE/SPEC.md#receipts

import { readFile, readdir, stat, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(process.env.ORANGE5_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'));

const SPEC = '11-MIRAGE/SPEC.md#receipts';

const RECEIPTS_ROOT = process.env.ORANGE5_RECEIPTS_ROOT
  || resolve(ROOT, '10-RECEIPTS');
const BUILD_DIR = join(RECEIPTS_ROOT, 'orange5-build');
const RUNTIME_DIR = join(RECEIPTS_ROOT, 'runtime-logs');

const DATE_PREFIX_RX = /^(\d{4}-\d{2}-\d{2})-/;

async function listDir(dir) {
  if (!existsSync(dir)) return [];
  const names = await readdir(dir);
  const out = [];
  for (const name of names) {
    const full = join(dir, name);
    try {
      const st = await stat(full);
      if (!st.isFile()) continue;
      const m = name.match(DATE_PREFIX_RX);
      out.push({
        name,
        path: full,
        size: st.size,
        mtime: st.mtimeMs,
        date: m ? m[1] : null,
        kind: name.endsWith('.json') ? 'json' : (name.endsWith('.md') ? 'md' : 'other'),
      });
    } catch {
      // tolerate transient stat failures
    }
  }
  return out;
}

/**
 * read(params) — receipts query.
 *
 * params.op:
 *   'list'      { dir?='build'|'runtime'|'all', since?=YYYY-MM-DD, limit?=200 }
 *   'load'      { name }   — read one receipt by file name
 *   'search'    { query, dir?='all', limit?=50, max_bytes_per_file?=200_000 }
 *   'latest'    { count?=10, dir?='build' }
 */
async function read(params = {}) {
  const op = params.op || 'list';
  const dirSel = params.dir || (op === 'latest' ? 'build' : 'all');
  const dirs = dirSel === 'build' ? [BUILD_DIR]
            : dirSel === 'runtime' ? [RUNTIME_DIR]
            : [BUILD_DIR, RUNTIME_DIR];

  try {
    switch (op) {
      case 'list': {
        let entries = [];
        for (const d of dirs) entries = entries.concat(await listDir(d));
        if (params.since) entries = entries.filter(e => (e.date || '9999') >= params.since);
        entries.sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.mtime - a.mtime);
        const limit = Math.min(params.limit || 200, 2000);
        return { ok: true, data: entries.slice(0, limit), spec: SPEC };
      }
      case 'latest': {
        let entries = [];
        for (const d of dirs) entries = entries.concat(await listDir(d));
        entries.sort((a, b) => b.mtime - a.mtime);
        const count = Math.min(params.count || 10, 100);
        return { ok: true, data: entries.slice(0, count), spec: SPEC };
      }
      case 'load': {
        if (!params.name) return { ok: false, reason: 'name_required', spec: SPEC };
        // Search both dirs for the named file. No path traversal allowed.
        if (params.name.includes('..') || params.name.includes('/') || params.name.includes('\\')) {
          return { ok: false, reason: 'illegal_name', detail: 'no path components allowed', spec: SPEC };
        }
        for (const d of dirs) {
          const full = join(d, params.name);
          if (existsSync(full)) {
            const txt = await readFile(full, 'utf8');
            const st = await stat(full);
            return { ok: true, data: { name: params.name, path: full, size: st.size, mtime: st.mtimeMs, content: txt }, spec: SPEC };
          }
        }
        return { ok: false, reason: 'not_found', detail: params.name, spec: SPEC };
      }
      case 'search': {
        if (!params.query) return { ok: false, reason: 'query_required', spec: SPEC };
        const q = String(params.query).toLowerCase();
        const limit = Math.min(params.limit || 50, 500);
        const maxBytes = Math.min(params.max_bytes_per_file || 200_000, 2_000_000);
        const hits = [];
        for (const d of dirs) {
          const entries = await listDir(d);
          for (const e of entries) {
            if (hits.length >= limit) break;
            try {
              if (e.size > maxBytes) continue;
              const txt = await readFile(e.path, 'utf8');
              const idx = txt.toLowerCase().indexOf(q);
              if (idx >= 0) {
                const start = Math.max(0, idx - 80);
                const end = Math.min(txt.length, idx + q.length + 160);
                hits.push({
                  name: e.name,
                  path: e.path,
                  date: e.date,
                  mtime: e.mtime,
                  snippet: txt.slice(start, end).replace(/\s+/g, ' ').trim(),
                });
              }
            } catch {
              // skip unreadable
            }
          }
        }
        hits.sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.mtime - a.mtime);
        return { ok: true, data: hits, spec: SPEC };
      }
      default:
        return { ok: false, reason: 'unknown_op', detail: op, spec: SPEC };
    }
  } catch (err) {
    return { ok: false, reason: 'read_failed', detail: String(err?.message || err), spec: SPEC };
  }
}

/**
 * write({ date?, slug, body, dir?='build' }) — append a new receipt.
 *   - File name: <YYYY-MM-DD>-<slug>.md   (slug must match /^[a-z0-9-]+$/)
 *   - Never overwrites. Returns ok:false with reason='exists' if collision.
 *   - No deletes (receipts are append-only by doctrine).
 */
async function write(params = {}) {
  const slug = String(params.slug || '').trim();
  if (!/^[a-z0-9][a-z0-9-]{0,80}$/.test(slug)) {
    return { ok: false, reason: 'invalid_slug', detail: 'must match /^[a-z0-9][a-z0-9-]{0,80}$/', spec: SPEC };
  }
  if (typeof params.body !== 'string' || params.body.length === 0) {
    return { ok: false, reason: 'body_required', spec: SPEC };
  }
  const date = params.date || new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { ok: false, reason: 'invalid_date', detail: 'YYYY-MM-DD required', spec: SPEC };
  }
  const dirSel = params.dir === 'runtime' ? RUNTIME_DIR : BUILD_DIR;
  if (!existsSync(dirSel)) {
    await mkdir(dirSel, { recursive: true });
  }
  const name = `${date}-${slug}.md`;
  const full = join(dirSel, name);
  if (existsSync(full)) {
    return { ok: false, reason: 'exists', detail: name, spec: SPEC };
  }
  try {
    await writeFile(full, params.body, { encoding: 'utf8', flag: 'wx' }); // wx = fail if exists
    const st = await stat(full);
    return { ok: true, receipt: { name, path: full, size: st.size, mtime: st.mtimeMs }, spec: SPEC };
  } catch (err) {
    return { ok: false, reason: 'write_failed', detail: String(err?.message || err), spec: SPEC };
  }
}

async function healthz() {
  const dirs = [
    { name: 'orange5-build', path: BUILD_DIR },
    { name: 'runtime-logs',  path: RUNTIME_DIR },
  ];
  const detail = [];
  let anyPresent = false;
  for (const d of dirs) {
    if (existsSync(d.path)) {
      anyPresent = true;
      const entries = await listDir(d.path);
      detail.push({ ...d, present: true, count: entries.length });
    } else {
      detail.push({ ...d, present: false, count: 0 });
    }
  }
  return {
    ok: anyPresent,
    status: anyPresent ? 'ready' : 'no_receipts_directory',
    root: RECEIPTS_ROOT,
    dirs: detail,
    spec: SPEC,
  };
}

export const receiptsAdapter = Object.freeze({ read, write, healthz });
export default receiptsAdapter;
