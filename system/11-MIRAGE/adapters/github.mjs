// 11-MIRAGE/adapters/github.mjs — READY (Wave-2).
//
// GitHub mount. External data-plane: writes_require_approval = true.
//
// Auth (operator brings creds; first-found wins):
//   1. GITHUB_TOKEN              — preferred (fine-grained PAT, repo-scoped)
//   2. GH_TOKEN                  — gh CLI's conventional env var
//   3. `gh auth token` (CLI)     — last-ditch fallback when env is empty
//
// Read surface (no approval required):
//   read({ op: 'list_repos',  affiliation?, visibility?, per_page?, page? })
//   read({ op: 'get_file',    owner, repo, path, ref? })
//   read({ op: 'list_prs',    owner, repo, state?, per_page?, page? })
//   read({ op: 'list_issues', owner, repo, state?, labels?, per_page?, page? })
//
// Write surface (Hermes-leased, fail-closed):
//   write({ op: 'create_issue',  owner, repo, title, body?, labels?, assignees?, approval_token })
//   write({ op: 'create_comment', owner, repo, issue_number, body, approval_token })
//   write({ op: 'create_pr',     owner, repo, title, head, base, body?, draft?, approval_token })
//
// Discipline:
//   - read() proceeds without Hermes.
//   - write() MUST acquire a Hermes lease at POST {HERMES_BASE}/v1/hermes/lease
//     before any mutation. Without an operator approval_token the adapter
//     returns reason:'operator_approval_required' and never mutates.
//   - NEVER force-push or rewrite history. The adapter exposes no such ops.
//   - Honest stubs in healthz when creds/octokit are missing (no throws).
//
// Spec: 11-MIRAGE/SPEC.md#github

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

const SPEC = '11-MIRAGE/SPEC.md#github';

// Env is resolved per-call so the operator can rotate Hermes targets at runtime
// and tests can swap them between cases without process restart.
function envCfg() {
  return {
    HERMES_BASE:    process.env.HERMES_BASE         || 'http://127.0.0.1:1337',
    HERMES_PATH:    process.env.HERMES_LEASE_PATH   || '/v1/hermes/lease',
    HERMES_TIMEOUT: parseInt(process.env.MIRAGE_HERMES_TIMEOUT_MS || '2500', 10),
    GH_TIMEOUT:     parseInt(process.env.MIRAGE_GITHUB_TIMEOUT_MS || '15000', 10),
    GH_CLI_TIMEOUT: parseInt(process.env.MIRAGE_GH_CLI_TIMEOUT_MS || '2500',  10),
  };
}

// ─── auth resolution ────────────────────────────────────────────────────────

let _tokenCache = null;     // resolved bearer token (env or gh CLI)
let _tokenSource = null;    // 'GITHUB_TOKEN' | 'GH_TOKEN' | 'gh_cli' | null
let _tokenLookupErr = null; // last error from gh CLI lookup (if any)

async function resolveToken() {
  // Re-check env on every call so test cases that mutate env do not get
  // pinned to a stale cache. Only the gh-CLI fallback is sticky.
  if (process.env.GITHUB_TOKEN) {
    _tokenCache = process.env.GITHUB_TOKEN;
    _tokenSource = 'GITHUB_TOKEN';
    return { ok: true, token: _tokenCache, source: _tokenSource };
  }
  if (process.env.GH_TOKEN) {
    _tokenCache = process.env.GH_TOKEN;
    _tokenSource = 'GH_TOKEN';
    return { ok: true, token: _tokenCache, source: _tokenSource };
  }
  if (_tokenCache && _tokenSource === 'gh_cli') {
    return { ok: true, token: _tokenCache, source: _tokenSource };
  }
  // Last-ditch: `gh auth token`. Honest: this is a subprocess, not a typed env.
  try {
    const { stdout } = await exec('gh', ['auth', 'token'], {
      timeout: envCfg().GH_CLI_TIMEOUT,
      windowsHide: true,
    });
    const tok = String(stdout || '').trim();
    if (tok) {
      _tokenCache = tok;
      _tokenSource = 'gh_cli';
      return { ok: true, token: tok, source: 'gh_cli' };
    }
    _tokenLookupErr = 'gh_cli_empty_token';
  } catch (err) {
    _tokenLookupErr = String(err?.message || err);
  }
  return { ok: false, reason: 'no_token', detail: _tokenLookupErr || 'no env, no gh CLI' };
}

// ─── lazy @octokit/rest client ──────────────────────────────────────────────

let _octokitMod = null;
let _octokitErr = null;
let _octokitCache = null;

async function loadOctokit() {
  if (_octokitMod) return _octokitMod;
  if (_octokitErr) return null;
  try {
    _octokitMod = await import('@octokit/rest');
    return _octokitMod;
  } catch (err) {
    _octokitErr = String(err?.message || err);
    return null;
  }
}

async function getClient() {
  if (_octokitCache) return { ok: true, octokit: _octokitCache };
  const tok = await resolveToken();
  if (!tok.ok) return { ok: false, reason: 'creds_missing', detail: tok.detail };
  const mod = await loadOctokit();
  if (!mod) {
    return { ok: false, reason: 'octokit_module_missing', detail: _octokitErr || 'import failed' };
  }
  const { Octokit } = mod;
  _octokitCache = new Octokit({
    auth: tok.token,
    userAgent: 'mirage-github/1 (orange5)',
    request: { timeout: envCfg().GH_TIMEOUT },
  });
  return { ok: true, octokit: _octokitCache, token_source: tok.source };
}

// ─── fetch w/ timeout (for Hermes only — octokit handles its own HTTP) ──────

async function tryFetch(url, init = {}, timeout_ms = envCfg().HERMES_TIMEOUT) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout_ms);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const txt = await res.text();
    let body;
    try { body = JSON.parse(txt); } catch { body = txt; }
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    return { ok: false, status: 0, err: String(err?.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

// ─── Hermes lease (the data-plane approval gate) ────────────────────────────

/**
 * Acquire a Hermes lease before any GitHub mutation. Fail-closed.
 *
 * @param {string} action  e.g. 'github.create_issue'
 * @param {object} ctx     { approval_token?, target?, meta?, riskLevel? }
 */
async function acquireLease(action, ctx = {}) {
  const payload = {
    actor: 'mirage.github',
    targetProject: 'orange5',
    riskLevel: ctx.riskLevel || 'medium',
    requires_approval: true,
    allowed: [action],
    ttl_ms: 60_000,
    meta: {
      adapter: 'github',
      action,
      target: ctx.target ?? null,
      ...(ctx.meta || {}),
    },
  };
  const headers = { 'content-type': 'application/json' };
  if (ctx.approval_token) headers['x-operator-approval'] = ctx.approval_token;

  const cfg = envCfg();
  const r = await tryFetch(`${cfg.HERMES_BASE}${cfg.HERMES_PATH}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  }, cfg.HERMES_TIMEOUT);

  if (!r.ok) {
    return {
      ok: false,
      reason: r.status === 0 ? 'hermes_unreachable' : 'hermes_lease_denied',
      status: r.status,
      detail: r.err || (typeof r.body === 'object' ? JSON.stringify(r.body) : String(r.body)),
    };
  }
  const lease = r.body && typeof r.body === 'object' ? r.body : null;
  if (!lease || !lease.id) {
    return { ok: false, reason: 'hermes_lease_malformed', detail: String(r.body) };
  }
  if (lease.requires_approval && !ctx.approval_token) {
    return { ok: false, reason: 'operator_approval_required', lease };
  }
  return { ok: true, lease };
}

// ─── helpers ────────────────────────────────────────────────────────────────

async function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(`${label}_timeout_${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function requireFields(params, fields) {
  for (const f of fields) {
    if (params[f] == null || params[f] === '') {
      return { ok: false, reason: `${f}_required`, spec: SPEC };
    }
  }
  return { ok: true };
}

function shapeApiError(err, op) {
  return {
    ok: false,
    reason: 'github_api_error',
    op,
    detail: String(err?.message || err),
    code: err?.status ?? err?.code ?? err?.response?.status ?? null,
    spec: SPEC,
  };
}

// ─── READ ───────────────────────────────────────────────────────────────────

/**
 * read({ op, ...args })
 *   op='list_repos'  → { affiliation?, visibility?, per_page?, page? }
 *   op='get_file'    → { owner, repo, path, ref? }
 *   op='list_prs'    → { owner, repo, state?, per_page?, page? }
 *   op='list_issues' → { owner, repo, state?, labels?, per_page?, page? }
 */
async function read(params = {}) {
  const op = String(params.op || 'list_repos');
  const allowedOps = ['list_repos', 'get_file', 'list_prs', 'list_issues'];
  if (!allowedOps.includes(op)) {
    return { ok: false, reason: `unknown_op:${op}`, allowed_ops: allowedOps, spec: SPEC };
  }

  const client = await getClient();
  if (!client.ok) {
    return { ok: false, reason: client.reason, detail: client.detail, spec: SPEC };
  }
  const oct = client.octokit;
  const cfg = envCfg();

  try {
    if (op === 'list_repos') {
      const res = await withTimeout(
        oct.repos.listForAuthenticatedUser({
          affiliation: params.affiliation || 'owner,collaborator,organization_member',
          visibility:  params.visibility  || 'all',
          per_page:    Math.min(parseInt(params.per_page || 30, 10), 100),
          page:        parseInt(params.page || 1, 10),
        }),
        cfg.GH_TIMEOUT, 'github_list_repos',
      );
      return {
        ok: true, op,
        data: {
          repos: (res.data || []).map((r) => ({
            id:           r.id,
            full_name:    r.full_name,
            name:         r.name,
            owner:        r.owner?.login || null,
            private:      r.private,
            description:  r.description,
            default_branch: r.default_branch,
            html_url:     r.html_url,
            updated_at:   r.updated_at,
          })),
          count: (res.data || []).length,
        },
      };
    }

    if (op === 'get_file') {
      const need = requireFields(params, ['owner', 'repo', 'path']);
      if (!need.ok) return need;
      const res = await withTimeout(
        oct.repos.getContent({
          owner: String(params.owner),
          repo:  String(params.repo),
          path:  String(params.path),
          ref:   params.ref ? String(params.ref) : undefined,
        }),
        cfg.GH_TIMEOUT, 'github_get_file',
      );
      const d = res.data;
      if (Array.isArray(d)) {
        // path resolved to a directory listing
        return {
          ok: true, op,
          data: {
            type: 'directory',
            path: params.path,
            entries: d.map((e) => ({ name: e.name, type: e.type, size: e.size, path: e.path, sha: e.sha })),
          },
        };
      }
      // Single file. Octokit returns base64 content for files <= 1MB.
      const content = d.content && d.encoding === 'base64'
        ? Buffer.from(d.content, 'base64').toString('utf8')
        : null;
      return {
        ok: true, op,
        data: {
          type:     'file',
          path:     d.path,
          sha:      d.sha,
          size:     d.size,
          encoding: d.encoding,
          content,                      // utf8 (null if binary/too-large)
          raw_b64:  d.content || null,  // base64 (passthrough)
          html_url: d.html_url,
          download_url: d.download_url,
        },
      };
    }

    if (op === 'list_prs') {
      const need = requireFields(params, ['owner', 'repo']);
      if (!need.ok) return need;
      const res = await withTimeout(
        oct.pulls.list({
          owner: String(params.owner),
          repo:  String(params.repo),
          state: ['open', 'closed', 'all'].includes(params.state) ? params.state : 'open',
          per_page: Math.min(parseInt(params.per_page || 30, 10), 100),
          page:     parseInt(params.page || 1, 10),
        }),
        cfg.GH_TIMEOUT, 'github_list_prs',
      );
      return {
        ok: true, op,
        data: {
          prs: (res.data || []).map((p) => ({
            number:      p.number,
            title:       p.title,
            state:       p.state,
            draft:       p.draft,
            user:        p.user?.login || null,
            head:        p.head?.ref || null,
            base:        p.base?.ref || null,
            html_url:    p.html_url,
            created_at:  p.created_at,
            updated_at:  p.updated_at,
            merged_at:   p.merged_at,
          })),
          count: (res.data || []).length,
        },
      };
    }

    if (op === 'list_issues') {
      const need = requireFields(params, ['owner', 'repo']);
      if (!need.ok) return need;
      const res = await withTimeout(
        oct.issues.listForRepo({
          owner: String(params.owner),
          repo:  String(params.repo),
          state: ['open', 'closed', 'all'].includes(params.state) ? params.state : 'open',
          labels: Array.isArray(params.labels) ? params.labels.join(',') : params.labels || undefined,
          per_page: Math.min(parseInt(params.per_page || 30, 10), 100),
          page:     parseInt(params.page || 1, 10),
        }),
        cfg.GH_TIMEOUT, 'github_list_issues',
      );
      // GitHub's issues endpoint also returns PRs; filter them out for clarity.
      const issues = (res.data || []).filter((i) => !i.pull_request);
      return {
        ok: true, op,
        data: {
          issues: issues.map((i) => ({
            number:     i.number,
            title:      i.title,
            state:      i.state,
            user:       i.user?.login || null,
            labels:     (i.labels || []).map((l) => (typeof l === 'string' ? l : l.name)),
            assignees:  (i.assignees || []).map((a) => a.login),
            comments:   i.comments,
            html_url:   i.html_url,
            created_at: i.created_at,
            updated_at: i.updated_at,
            closed_at:  i.closed_at,
          })),
          count: issues.length,
        },
      };
    }

    return { ok: false, reason: `unknown_op:${op}`, allowed_ops: allowedOps, spec: SPEC };
  } catch (err) {
    return shapeApiError(err, op);
  }
}

// ─── WRITE (Hermes-gated) ───────────────────────────────────────────────────

/**
 * write({ op, ...args, approval_token })
 *   op='create_issue'   → { owner, repo, title, body?, labels?, assignees? }
 *   op='create_comment' → { owner, repo, issue_number, body }
 *   op='create_pr'      → { owner, repo, title, head, base, body?, draft? }
 *
 * approval_token is the Sovereign's per-call approval. Without it the adapter
 * returns reason:'operator_approval_required' and does not mutate.
 */
async function write(params = {}) {
  const op = String(params.op || '');
  const allowedOps = ['create_issue', 'create_comment', 'create_pr'];
  if (!allowedOps.includes(op)) {
    return { ok: false, reason: `unknown_op:${op}`, allowed_ops: allowedOps, spec: SPEC };
  }

  // ── 1. Surface-level validation before paying for a Hermes round-trip.
  let need;
  if (op === 'create_issue') {
    need = requireFields(params, ['owner', 'repo', 'title']);
  } else if (op === 'create_comment') {
    need = requireFields(params, ['owner', 'repo', 'issue_number', 'body']);
    if (need.ok && !Number.isInteger(Number(params.issue_number))) {
      return { ok: false, reason: 'issue_number_invalid', spec: SPEC };
    }
  } else if (op === 'create_pr') {
    need = requireFields(params, ['owner', 'repo', 'title', 'head', 'base']);
  }
  if (need && !need.ok) return need;

  // ── 2. Hermes lease — fail-closed.
  const action = `github.${op}`;
  // PRs touch shipping branches → escalate riskLevel; issues/comments medium.
  const riskLevel = op === 'create_pr' ? 'high' : 'medium';
  const target = `${params.owner}/${params.repo}` +
    (op === 'create_comment' ? `#${params.issue_number}` :
     op === 'create_pr'      ? ` ${params.head}->${params.base}` : '');

  const lease = await acquireLease(action, {
    approval_token: params.approval_token,
    riskLevel,
    target,
    meta: {
      op,
      owner: params.owner,
      repo: params.repo,
      title_preview: params.title ? String(params.title).slice(0, 120) : null,
      head: params.head || null,
      base: params.base || null,
      issue_number: params.issue_number || null,
    },
  });
  if (!lease.ok) {
    return {
      ok: false,
      reason: lease.reason,
      detail: lease.detail,
      lease: lease.lease,
      status: lease.status,
      spec: SPEC,
    };
  }

  // ── 3. Client.
  const client = await getClient();
  if (!client.ok) {
    return { ok: false, reason: client.reason, detail: client.detail, spec: SPEC };
  }
  const oct = client.octokit;
  const cfg = envCfg();

  // ── 4. Mutate.
  try {
    if (op === 'create_issue') {
      const res = await withTimeout(
        oct.issues.create({
          owner: String(params.owner),
          repo:  String(params.repo),
          title: String(params.title),
          body:  params.body  ? String(params.body)  : undefined,
          labels:    Array.isArray(params.labels)    ? params.labels    : undefined,
          assignees: Array.isArray(params.assignees) ? params.assignees : undefined,
        }),
        cfg.GH_TIMEOUT, 'github_create_issue',
      );
      return {
        ok: true, op, lease_id: lease.lease.id,
        data: {
          number:   res.data.number,
          id:       res.data.id,
          html_url: res.data.html_url,
          state:    res.data.state,
        },
      };
    }

    if (op === 'create_comment') {
      const res = await withTimeout(
        oct.issues.createComment({
          owner: String(params.owner),
          repo:  String(params.repo),
          issue_number: Number(params.issue_number),
          body:  String(params.body),
        }),
        cfg.GH_TIMEOUT, 'github_create_comment',
      );
      return {
        ok: true, op, lease_id: lease.lease.id,
        data: {
          id:       res.data.id,
          html_url: res.data.html_url,
          issue_number: Number(params.issue_number),
        },
      };
    }

    if (op === 'create_pr') {
      const res = await withTimeout(
        oct.pulls.create({
          owner: String(params.owner),
          repo:  String(params.repo),
          title: String(params.title),
          head:  String(params.head),
          base:  String(params.base),
          body:  params.body ? String(params.body) : undefined,
          draft: params.draft === true || undefined,
        }),
        cfg.GH_TIMEOUT, 'github_create_pr',
      );
      return {
        ok: true, op, lease_id: lease.lease.id,
        data: {
          number:   res.data.number,
          id:       res.data.id,
          html_url: res.data.html_url,
          state:    res.data.state,
          draft:    res.data.draft,
          head:     res.data.head?.ref,
          base:     res.data.base?.ref,
        },
      };
    }

    return { ok: false, reason: `unknown_op:${op}`, allowed_ops: allowedOps, spec: SPEC };
  } catch (err) {
    return shapeApiError(err, op);
  }
}

// ─── HEALTHZ ────────────────────────────────────────────────────────────────

async function healthz() {
  const out = { spec: SPEC, adapter: 'github', family: 'data', writes_require_approval: true };

  const tok = await resolveToken();
  if (!tok.ok) {
    return {
      ...out,
      ok: false,
      status: 'degraded_no_creds',
      detail: 'set env GITHUB_TOKEN (or GH_TOKEN), or `gh auth login`',
      token_lookup_detail: tok.detail,
    };
  }

  const mod = await loadOctokit();
  if (!mod) {
    return {
      ...out,
      ok: false,
      status: 'degraded_no_client',
      token_source: tok.source,
      detail: `@octokit/rest not loadable: ${_octokitErr || 'unknown'}. run: bun add @octokit/rest`,
    };
  }

  try {
    const client = await getClient();
    if (!client.ok) {
      return { ...out, ok: false, status: 'degraded', detail: client.reason, token_source: tok.source };
    }
    // /user is the lightest auth-validating call on GitHub.
    const res = await withTimeout(
      client.octokit.users.getAuthenticated(),
      envCfg().GH_TIMEOUT, 'github_get_user',
    );
    return {
      ...out,
      ok: true,
      status: 'ready',
      token_source: tok.source,
      user: res.data.login || null,
      user_id: res.data.id ?? null,
      plan: res.data.plan?.name || null,
    };
  } catch (err) {
    return {
      ...out,
      ok: false,
      status: 'degraded',
      token_source: tok.source,
      detail: String(err?.message || err),
      code: err?.status ?? err?.code ?? err?.response?.status ?? null,
    };
  }
}

// ─── exports ────────────────────────────────────────────────────────────────

export const githubAdapter = Object.freeze({ read, write, healthz });
export default githubAdapter;

// Test-only escape hatch.
export function __resetForTests() {
  _octokitMod   = null;
  _octokitErr   = null;
  _octokitCache = null;
  _tokenCache   = null;
  _tokenSource  = null;
  _tokenLookupErr = null;
}

// Internals exposed for unit tests.
export const __internals = Object.freeze({
  requireFields,
  shapeApiError,
});
