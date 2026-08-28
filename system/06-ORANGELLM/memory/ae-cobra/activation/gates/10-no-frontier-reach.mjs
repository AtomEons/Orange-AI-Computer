// 10-no-frontier-reach.mjs — Cobra must NOT touch frontier model providers.
//
// Static scan of the daemon source for forbidden hostnames (Anthropic, OpenAI,
// Google AI, Mistral, Cohere, Together, etc.) and forbidden env-var reads
// (ANTHROPIC_API_KEY, OPENAI_API_KEY, etc.). Anything found → red with evidence.
//
// Allowed exceptions: comments, this file itself, and any file under tests/.
// Also: a documented denylist literal in code (e.g. an array of blocked hosts)
// is allowed when the file path includes 'denylist' or 'firewall'.

import { run, defaultEnv } from './_lib.mjs';
import { readFile, readdir } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const GATE = '10-no-frontier-reach';

const FORBIDDEN_HOSTS = [
  'api.anthropic.com',
  'api.openai.com',
  'oai.azure.com',
  'generativelanguage.googleapis.com',
  'api.mistral.ai',
  'api.cohere.ai',
  'api.together.xyz',
  'api.groq.com',
  'api.perplexity.ai',
  'api.deepseek.com',
  'api.fireworks.ai',
];

const FORBIDDEN_ENV = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'OPENAI_ORG_ID',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'MISTRAL_API_KEY',
  'COHERE_API_KEY',
  'GROQ_API_KEY',
  'TOGETHER_API_KEY',
  'PERPLEXITY_API_KEY',
];

const ROOT_REL = ['flow-direct', 'mirage', 'clr', 'flux', 'activation', 'bin'];

async function walk(dir, acc) {
  let ents;
  try { ents = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      await walk(p, acc);
    } else if (/\.(mjs|js|cjs|ts|sh|service|json|md)$/i.test(e.name)) {
      acc.push(p);
    }
  }
}

function isException(path) {
  const p = path.replace(/\\/g, '/');
  if (/\/tests?\//.test(p)) return true;
  if (/denylist|firewall|frontier-block/i.test(p)) return true;
  if (/10-no-frontier-reach\.mjs$/.test(p)) return true;
  return false;
}

function scanLine(line) {
  // Strip line comments
  const noLine = line.replace(/(^|[^:])\/\/.*$/, '$1').replace(/#.*$/, '');
  const hits = [];
  for (const h of FORBIDDEN_HOSTS) {
    if (noLine.includes(h)) hits.push({ kind: 'host', match: h });
  }
  for (const v of FORBIDDEN_ENV) {
    const re = new RegExp(`\\b${v}\\b`);
    if (re.test(noLine)) hits.push({ kind: 'env', match: v });
  }
  return hits;
}

export async function check(env = {}, opts = {}) {
  const E = { ...defaultEnv(), ...env };
  return run(GATE, E, opts, async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const daemonRoot = resolve(here, '..', '..');

    const files = [];
    for (const d of ROOT_REL) await walk(join(daemonRoot, d), files);
    // Also the top-level files
    try {
      const topEnts = await readdir(daemonRoot, { withFileTypes: true });
      for (const e of topEnts) {
        if (e.isFile() && /\.(mjs|js|cjs|ts|sh|service|json|md)$/i.test(e.name)) {
          files.push(join(daemonRoot, e.name));
        }
      }
    } catch {}

    const findings = [];
    let scanned = 0;
    for (const f of files) {
      if (isException(f)) continue;
      let src;
      try { src = await readFile(f, 'utf8'); } catch { continue; }
      scanned++;
      const lines = src.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const hits = scanLine(lines[i]);
        for (const h of hits) {
          findings.push({
            file: f.replace(daemonRoot + '/', '').replace(daemonRoot + '\\', ''),
            line: i + 1,
            kind: h.kind,
            match: h.match,
            context: lines[i].trim().slice(0, 200),
          });
        }
      }
    }

    const pass = findings.length === 0;
    return {
      pass,
      details: {
        reason: pass ? 'no frontier hosts or keys referenced in daemon source'
                     : `${findings.length} forbidden reference(s) found`,
        scanned_files: scanned,
        forbidden_hosts: FORBIDDEN_HOSTS,
        forbidden_env: FORBIDDEN_ENV,
        findings,
      },
    };
  });
}
