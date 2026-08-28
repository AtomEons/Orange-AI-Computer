#!/usr/bin/env bun
import fs from 'node:fs';
import path from 'node:path';

const defaultRoot = path.resolve(import.meta.dir, '..');
const largeFileThreshold = 95_000_000;
const secretScanLimit = 5_000_000;

const literalSecretRules = [
  ['private_key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['openai_key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}\b/],
  ['anthropic_key', /\bsk-ant-[A-Za-z0-9_-]{20,}\b/],
  ['github_token', /\bgh[opusr]_[A-Za-z0-9]{30,}\b/],
  ['aws_access_key', /\bAKIA[0-9A-Z]{16}\b/],
];

const textExtensions = new Set([
  '.c', '.cc', '.cpp', '.css', '.go', '.h', '.html', '.ini', '.java', '.js', '.json', '.jsonl',
  '.jsx', '.md', '.mjs', '.ps1', '.py', '.rs', '.sh', '.sql', '.toml', '.ts', '.tsx', '.txt',
  '.wgsl', '.xml', '.yaml', '.yml', '.jinja', '.modelfile',
]);

function git(root, args) {
  const result = Bun.spawnSync(['git', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString() || `git ${args.join(' ')} failed`);
  }
  return result.stdout.toString().split('\0').filter(Boolean);
}

function uniqueSorted(names) {
  return [...new Set(names)].sort((left, right) => left.localeCompare(right));
}

export function collectPromotionCandidates(root = defaultRoot) {
  const staged = git(root, ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']);
  const stagedDeletions = git(root, ['diff', '--cached', '--name-only', '--diff-filter=D', '-z']);
  const unstagedTracked = git(root, ['diff', '--name-only', '--diff-filter=ACMR', '-z']);
  const unstagedTrackedDeletions = git(root, ['diff', '--name-only', '--diff-filter=D', '-z']);
  const untrackedPromotable = git(root, ['ls-files', '--others', '--exclude-standard', '-z']);

  return {
    staged: uniqueSorted(staged),
    stagedDeletions: uniqueSorted(stagedDeletions),
    unstagedTracked: uniqueSorted(unstagedTracked),
    unstagedTrackedDeletions: uniqueSorted(unstagedTrackedDeletions),
    untrackedPromotable: uniqueSorted(untrackedPromotable),
    candidates: uniqueSorted([...staged, ...unstagedTracked, ...untrackedPromotable]),
  };
}

function hasRailTokenLiteral(content) {
  const assignment = /\bORANGEBOX_RAIL_TOKEN\b["']?\s*[:=]\s*(["']?)([^\s"'`,;#}]+)/gi;
  let match;

  while ((match = assignment.exec(content)) !== null) {
    const quote = match[1];
    const value = match[2];
    if (value.length < 16) continue;
    if (/^(?:<|\$|%|process\.|Bun\.|Deno\.|env\.|undefined|null|missing)/i.test(value)) continue;

    const prefix = content.slice(Math.max(0, match.index - 64), match.index);
    const environmentTarget = /(?:process|Bun|Deno)\.env\.\s*$|\$env:\s*$|(?:^|[^A-Za-z0-9_])env\.\s*$/i.test(prefix);
    if (environmentTarget && quote === '' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) continue;
    return true;
  }

  return false;
}

export function detectSecretRules(content) {
  const findings = [];
  for (const [rule, pattern] of literalSecretRules) {
    if (pattern.test(content)) findings.push(rule);
  }
  if (hasRailTokenLiteral(content)) findings.push('rail_token_value');
  return findings;
}

function existingFileStats(root, names) {
  const result = new Map();
  for (const name of names) {
    const file = path.join(root, name);
    let stat;
    try {
      stat = fs.lstatSync(file);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    result.set(name, { file, size: stat.size });
  }
  return result;
}

export function scanPromotionRepository(root = defaultRoot) {
  const promotion = collectPromotionCandidates(root);
  const files = existingFileStats(root, promotion.candidates);
  const stagedFiles = existingFileStats(root, promotion.staged);
  const large = [];
  const secrets = [];
  let totalBytes = 0;
  let largest = null;
  const bytesByTopLevel = new Map();
  const bytesBySubsystem = new Map();

  for (const [name, { file, size }] of files) {
    totalBytes += size;
    const top = name.split('/')[0];
    bytesByTopLevel.set(top, (bytesByTopLevel.get(top) ?? 0) + size);
    const subsystem = name.split('/').slice(0, 2).join('/');
    bytesBySubsystem.set(subsystem, (bytesBySubsystem.get(subsystem) ?? 0) + size);
    if (!largest || size > largest.bytes) largest = { path: name, bytes: size };
    if (size >= largeFileThreshold) large.push({ path: name, bytes: size });
    if (size > secretScanLimit || !textExtensions.has(path.extname(name).toLowerCase())) continue;

    const content = fs.readFileSync(file, 'utf8');
    for (const rule of detectSecretRules(content)) secrets.push({ path: name, rule });
  }

  const stagedBytes = [...stagedFiles.values()].reduce((total, item) => total + item.size, 0);
  return {
    schema: 'orange5.git-promotion-preflight.v2',
    status: large.length === 0 && secrets.length === 0 ? 'VERIFIED' : 'BLOCKED',
    scanned_files: files.size,
    scanned_bytes: totalBytes,
    staged_files: promotion.staged.length,
    staged_deletions: promotion.stagedDeletions.length,
    staged_bytes: stagedBytes,
    unstaged_tracked_files: promotion.unstagedTracked.length,
    unstaged_tracked_deletions: promotion.unstagedTrackedDeletions.length,
    untracked_promotable_files: promotion.untrackedPromotable.length,
    largest,
    bytes_by_top_level: Object.fromEntries([...bytesByTopLevel.entries()].sort((a, b) => b[1] - a[1])),
    largest_subsystems: Object.fromEntries([...bytesBySubsystem.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)),
    oversized_files: large,
    secret_findings: secrets,
  };
}

if (import.meta.main) {
  try {
    const report = scanPromotionRepository();
    console.log(JSON.stringify(report, null, 2));
    if (report.status !== 'VERIFIED') process.exit(1);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
