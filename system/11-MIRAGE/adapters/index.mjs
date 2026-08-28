// 11-MIRAGE/adapters/index.mjs — Mirage Adapter Registry (Night-1 skeleton).
//
// Mirage is the data + memory plane for Orange5. Two families:
//   mirage/data/*   — external mounts (per-write operator approval required)
//   mirage/memory/* — internal stores (Sovereign read-write)
//
// Reality always overrides Thought on conflict. Receipts override recollection.
//
// Night-1 status:
//   READY  : flux, graph, receipts, postgres, drive, gmail, slack, atoms, redis, cache
//   STUB   : github
//
// Spec source: 11-MIRAGE/SPEC.md (pending) — until then, see 06-ORANGELLM/PR-02-SPEC.md
// and 06-ORANGELLM/memory/ae-cobra/README.md for memory-plane shape.

import { postgresAdapter } from './postgres.mjs';
import { driveAdapter }    from './drive.mjs';
import { gmailAdapter }    from './gmail.mjs';
import { slackAdapter }    from './slack.mjs';
import { githubAdapter }   from './github.mjs';
import { redisAdapter }    from './redis.mjs';
import { fluxAdapter }     from './flux.mjs';
import { graphAdapter }    from './graph.mjs';
import { receiptsAdapter } from './receipts.mjs';
import { atomsAdapter }    from './atoms.mjs';
import { cacheAdapter }    from './cache.mjs';

// Manifest of the 11 mounts. Ordered by family then alphabetical.
// `writes_require_approval` is the per-call human-in-the-loop gate for external data.
export const MIRAGE_MOUNTS = Object.freeze([
  // mirage/data/* — external (write requires per-call operator approval)
  { name: 'postgres', family: 'data',   status: 'ready', writes_require_approval: true,  spec: '11-MIRAGE/SPEC.md#postgres', client: 'pg npm (lazy import) @ ATOMEONS_PG_URL' },
  { name: 'drive',    family: 'data',   status: 'ready', writes_require_approval: true,  spec: '11-MIRAGE/SPEC.md#drive', client: 'googleapis npm (lazy import) @ GOOGLE_DRIVE_REFRESH_TOKEN + GOOGLE_DRIVE_CLIENT_ID/SECRET, gated by Hermes /v1/hermes/lease' },
  { name: 'gmail',    family: 'data',   status: 'ready', writes_require_approval: true,  spec: '11-MIRAGE/SPEC.md#gmail', client: 'googleapis npm (lazy import) @ GMAIL_REFRESH_TOKEN + GMAIL_CLIENT_ID/SECRET' },
  { name: 'slack',    family: 'data',   status: 'ready', writes_require_approval: true,  spec: '11-MIRAGE/SPEC.md#slack', client: '@slack/web-api npm (lazy import) @ SLACK_BOT_TOKEN (+ optional SLACK_USER_TOKEN for search), gated by Hermes /v1/hermes/lease' },
  { name: 'github',   family: 'data',   status: 'stub',  writes_require_approval: true,  spec: '11-MIRAGE/SPEC.md#github' },
  { name: 'redis',    family: 'data',   status: 'stub',  writes_require_approval: true,  spec: '11-MIRAGE/SPEC.md#redis' },

  // mirage/memory/* — internal (Sovereign read-write)
  { name: 'flux',     family: 'memory', status: 'ready', writes_require_approval: false, spec: '11-MIRAGE/SPEC.md#flux',     proxies: 'ae-cobra @ 127.0.0.1:7419' },
  { name: 'graph',    family: 'memory', status: 'ready', writes_require_approval: false, spec: '11-MIRAGE/SPEC.md#graph',    proxies: 'graph-weaver SQLite (06-ORANGELLM/memory/graph.db)' },
  { name: 'receipts', family: 'memory', status: 'ready', writes_require_approval: false, spec: '11-MIRAGE/SPEC.md#receipts', proxies: '10-RECEIPTS/orange5-build/ glob' },
  { name: 'atoms',    family: 'memory', status: 'ready', writes_require_approval: false, spec: '11-MIRAGE/SPEC.md#atoms', proxies: '12-ATOMSMASHER/commitment-atoms (Flux Reality lane canonical, SQLite index derived)' },
  { name: 'cache',    family: 'memory', status: 'ready', writes_require_approval: false, spec: '11-MIRAGE/SPEC.md#cache', proxies: 'N150 shadow cache (06-ORANGELLM/memory/cache/, read-only; writes redirect to flux)' },
]);

const ADAPTERS = Object.freeze({
  postgres: postgresAdapter,
  drive:    driveAdapter,
  gmail:    gmailAdapter,
  slack:    slackAdapter,
  github:   githubAdapter,
  redis:    redisAdapter,
  flux:     fluxAdapter,
  graph:    graphAdapter,
  receipts: receiptsAdapter,
  atoms:    atomsAdapter,
  cache:    cacheAdapter,
});

/**
 * Resolve an adapter by mount name.
 * Returns { read, write, healthz, name, family, status } or throws.
 *
 * Every adapter exposes the same three async methods:
 *   read(params)    -> { ok, data?, reason?, spec? }
 *   write(params)   -> { ok, receipt?, reason?, spec? }   (gated by approval for data/*)
 *   healthz()       -> { ok, status, detail? }
 */
export function getAdapter(name) {
  const adapter = ADAPTERS[name];
  if (!adapter) {
    const known = Object.keys(ADAPTERS).join(', ');
    throw new Error(`mirage: unknown adapter '${name}'. Known mounts: ${known}`);
  }
  const manifest = MIRAGE_MOUNTS.find(m => m.name === name);
  return Object.freeze({
    name,
    family: manifest.family,
    status: manifest.status,
    writes_require_approval: manifest.writes_require_approval,
    spec: manifest.spec,
    read:    adapter.read,
    write:   adapter.write,
    healthz: adapter.healthz,
  });
}

/**
 * Health-check every adapter in parallel. Used by /healthz on OrangeLLM gateway
 * and the AEC1 command center status pane.
 */
export async function healthAll() {
  const results = await Promise.allSettled(
    MIRAGE_MOUNTS.map(async m => {
      const a = ADAPTERS[m.name];
      try {
        const h = await a.healthz();
        return { name: m.name, family: m.family, status: m.status, health: h };
      } catch (err) {
        return { name: m.name, family: m.family, status: m.status, health: { ok: false, status: 'threw', detail: String(err?.message || err) } };
      }
    })
  );
  return results.map(r => r.status === 'fulfilled' ? r.value : { name: 'unknown', health: { ok: false, status: 'rejected', detail: String(r.reason) } });
}

export default { MIRAGE_MOUNTS, getAdapter, healthAll };
