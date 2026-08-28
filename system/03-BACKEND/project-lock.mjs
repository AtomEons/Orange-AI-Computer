import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const PROJECT_LOCK_SCHEMA = 'orange.project-lock.v1';
const MAX_CAPSULE_CHARS = 9_000;
const GOVERNING_NAMES = new Set([
  'AGENTS.md', 'CLAUDE.md', 'README.md', 'README', 'package.json', 'pyproject.toml',
  'Cargo.toml', 'go.mod', 'bunfig.toml', 'ORANGE_PROJECT.md', 'PROJECT.md',
]);

export function defaultProjectLockPath(env = process.env) {
  const explicit = String(env.ORANGE5_PROJECT_LOCK_PATH || '').trim();
  if (explicit) return path.resolve(explicit);
  const home = env.USERPROFILE || env.HOME || os.homedir();
  return path.join(home, 'OrangeBox-Data', 'orange5', 'active-project.json');
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function readBounded(file, max = 120_000) {
  const handle = fs.openSync(file, 'r');
  try {
    const stat = fs.fstatSync(handle);
    const bytes = Math.min(stat.size, max);
    const buffer = Buffer.alloc(bytes);
    fs.readSync(handle, buffer, 0, bytes, 0);
    return buffer.toString('utf8');
  } finally {
    fs.closeSync(handle);
  }
}

function runGit(root, args) {
  try {
    return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 3_000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

function packageSummary(root) {
  const file = path.join(root, 'package.json');
  try {
    const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      name: pkg.name || null,
      packageManager: pkg.packageManager || (fs.existsSync(path.join(root, 'bun.lock')) || fs.existsSync(path.join(root, 'bun.lockb')) ? 'bun' : null),
      scripts: Object.keys(pkg.scripts || {}).sort().slice(0, 80),
    };
  } catch {
    return null;
  }
}

function governingFiles(root) {
  const files = [];
  for (const name of GOVERNING_NAMES) {
    const file = path.join(root, name);
    if (fs.existsSync(file) && fs.statSync(file).isFile()) files.push(file);
  }
  const charter = path.join(root, '00-CHARTER');
  if (fs.existsSync(charter) && fs.statSync(charter).isDirectory()) {
    for (const entry of fs.readdirSync(charter, { withFileTypes: true })) {
      if (!entry.isFile() || !/\.(?:md|json)$/i.test(entry.name)) continue;
      if (!/(master|operational|runtime|naming|law|not.green|how.to.use)/i.test(entry.name)) continue;
      files.push(path.join(charter, entry.name));
    }
  }
  return [...new Set(files)].sort((a, b) => {
    const rank = (file) => {
      if (/AGENTS\.md$/i.test(file)) return 0;
      if (/CLAUDE\.md$/i.test(file)) return 1;
      if (/ORANGE5_RUNTIME_AUTHORITY\.md$/i.test(file)) return 2;
      if (/ORANGE_NAMING_LAW\.md$/i.test(file)) return 3;
      if (/NAMING_CANON\.md$/i.test(file)) return 4;
      if (/ORANGE5_MASTER_PLAN\.md$/i.test(file)) return 5;
      if (/ORANGE5_OPERATIONAL_LAW\.md$/i.test(file)) return 6;
      if (/ORANGEFIVE_HOW_TO_USE\.md$/i.test(file)) return 7;
      if (/ORANGE5_NOT_GREEN_LEDGER\.md$/i.test(file)) return 8;
      if (/README/i.test(file)) return 20;
      if (/package\.json$/i.test(file)) return 30;
      return 12;
    };
    return rank(a) - rank(b) || a.localeCompare(b);
  }).slice(0, 16);
}

function selectDoctrine(text, maxChars = 1_600) {
  const lines = String(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const priority = lines.filter((line) => /\b(?:must|never|always|canonical|goal|scope|law|do not|don't|only|command|verify|receipt|root)\b/i.test(line));
  const selected = [...new Set([...priority, ...lines.slice(0, 24)])];
  let output = '';
  for (const line of selected) {
    const next = output ? `${output}\n${line}` : line;
    if (next.length > maxChars) break;
    output = next;
  }
  return output;
}

export function inspectProject(rootInput) {
  const root = path.resolve(String(rootInput || ''));
  if (!rootInput || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new TypeError(`project root is not a directory: ${rootInput}`);
  const docs = governingFiles(root).map((file) => {
    const text = readBounded(file);
    return {
      path: path.relative(root, file).replaceAll('\\', '/'),
      sha256: sha256(text),
      excerpt: selectDoctrine(text),
    };
  });
  const hasGit = fs.existsSync(path.join(root, '.git'));
  const branch = hasGit ? (runGit(root, ['branch', '--show-current']) || null) : null;
  const head = hasGit ? (runGit(root, ['rev-parse', 'HEAD']) || null) : null;
  const status = hasGit ? runGit(root, ['status', '--porcelain=v1', '--untracked-files=no']) : '';
  const remote = hasGit ? (runGit(root, ['remote', 'get-url', 'origin']) || null) : null;
  return {
    root,
    name: packageSummary(root)?.name || path.basename(root),
    package: packageSummary(root),
    git: { branch, head, remote, dirtyTrackedFiles: status ? status.split(/\r?\n/).filter(Boolean).length : 0 },
    governingDocs: docs,
  };
}

export function buildProjectCapsule(state, maxChars = MAX_CAPSULE_CHARS) {
  if (!state?.active || !state.project?.root) return null;
  const lines = [
    'ORANGE ACTIVE PROJECT LOCK',
    `schema=${PROJECT_LOCK_SCHEMA}`,
    `project=${state.project.name}`,
    `root=${state.project.root}`,
    `goal=${state.goal || 'Use the governing documents and current operator order.'}`,
    `lock_hash=${state.sha256}`,
    `git_branch=${state.project.git?.branch || 'none'}`,
    `git_head=${state.project.git?.head || 'none'}`,
    `git_dirty_tracked=${state.project.git?.dirtyTrackedFiles ?? 0}`,
    'LAW: This capsule is runtime-injected by Orange. Keep this project, goal, scope, and evidence contract active for the entire turn.',
    'LAW: Do not claim file, tool, service, or deployment work without a governed execution receipt.',
    'LAW: Governing excerpts are authority-ordered. When two excerpts conflict, the earlier excerpt wins; live probes and fresh receipts outrank all prose.',
    'GOVERNING EXCERPTS (highest authority first):',
  ];
  for (const doc of state.project.governingDocs || []) {
    lines.push(`\n[${doc.path} sha256=${doc.sha256}]\n${doc.excerpt}`);
  }
  return lines.join('\n').slice(0, Math.max(1_000, maxChars));
}

function withHash(value) {
  const base = { ...value };
  delete base.sha256;
  return { ...base, sha256: sha256(JSON.stringify(base)) };
}

export function activateProject({ root, goal = null, name = null } = {}, { statePath = defaultProjectLockPath() } = {}) {
  const project = inspectProject(root);
  if (name) project.name = String(name).trim().slice(0, 100) || project.name;
  const state = withHash({
    schema: PROJECT_LOCK_SCHEMA,
    active: true,
    activatedAt: new Date().toISOString(),
    refreshedAt: new Date().toISOString(),
    goal: goal ? String(goal).trim().slice(0, 2_000) : null,
    project,
  });
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  return { ...state, capsule: buildProjectCapsule(state) };
}

export function readProjectLock({ statePath = defaultProjectLockPath(), refresh = false } = {}) {
  try {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (!state.active) return state;
    if (!refresh) return { ...state, capsule: buildProjectCapsule(state) };
    const project = inspectProject(state.project.root);
    project.name = state.project.name || project.name;
    const next = withHash({ ...state, refreshedAt: new Date().toISOString(), project });
    fs.writeFileSync(statePath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    return { ...next, capsule: buildProjectCapsule(next) };
  } catch {
    return { schema: PROJECT_LOCK_SCHEMA, active: false, statePath, capsule: null };
  }
}

export function clearProjectLock({ statePath = defaultProjectLockPath() } = {}) {
  const previous = readProjectLock({ statePath });
  const state = withHash({ schema: PROJECT_LOCK_SCHEMA, active: false, clearedAt: new Date().toISOString(), previousProject: previous.project?.root || null });
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  return state;
}

export function injectProjectLock(messages = [], state = readProjectLock(), { maxChars = MAX_CAPSULE_CHARS } = {}) {
  if (!state?.active || !state.capsule) return { messages: structuredClone(messages), state };
  const capsule = buildProjectCapsule(state, maxChars);
  return {
    messages: [{ role: 'system', content: capsule }, ...structuredClone(messages)],
    state,
  };
}

export const __projectLockInternals = Object.freeze({ governingFiles, selectDoctrine, sha256 });
