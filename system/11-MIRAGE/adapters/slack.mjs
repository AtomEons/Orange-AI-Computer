// 11-MIRAGE/adapters/slack.mjs — READY (Wave-2).
//
// Slack mount. External data-plane: writes_require_approval = true.
//
// Auth: bot token (operator brings creds).
//   SLACK_BOT_TOKEN  — xoxb-* bot user token (least-privilege scopes per workspace)
//
// Recommended scopes (operator grants at install time):
//   channels:read         — list_channels (public)
//   groups:read           — list private channels the bot is a member of
//   channels:history      — conversations.history for public channels
//   groups:history        — conversations.history for private channels
//   search:read           — search.messages (requires a user token in practice;
//                            see honest gap below)
//   chat:write            — chat.postMessage
//
// Honest gap: Slack's search.messages endpoint requires a user token (xoxp-*)
// and the `search:read` scope. Bot tokens cannot perform search. If the
// operator only provides SLACK_BOT_TOKEN, read({op:'search'}) returns
// ok:false with a not_authed-shaped reason — never a fake-green. To enable
// search the operator can additionally set SLACK_USER_TOKEN (xoxp-*); when
// present, search uses that token only and never leaks it to other ops.
//
// Surface (mirrors gmail.mjs READY-pattern):
//   read({ op: 'list_channels', cursor?, limit?, types?, exclude_archived? })
//   read({ op: 'history', channel, since?, oldest?, latest?, limit?, cursor? })
//   read({ op: 'search', query, count?, sort?, page? })
//   write({ op: 'post_message', channel, text?, blocks?, thread_ts?, approval_token })
//   healthz()
//
// Write discipline (Mirage law, data-family):
//   - write() MUST acquire a Hermes lease at POST {HERMES_BASE}/v1/hermes/lease
//     before calling Slack. The lease is the Sovereign's per-call
//     human-in-the-loop gate. Default gateway base: http://127.0.0.1:1337.
//   - On lease refusal the adapter returns { ok:false, reason:'hermes_lease_denied' }
//     and never posts.
//   - On Hermes unreachable the adapter refuses to write (fail-closed).
//   - NEVER auto-posts. operator_approved must be conveyed via `approval_token`
//     (Hermes forwards it as x-operator-approval).
//
// Read discipline:
//   - read() proceeds without approval (read-only is safe per Mirage manifest).
//
// Spec: 11-MIRAGE/SPEC.md#slack

const SPEC = '11-MIRAGE/SPEC.md#slack';

// Env is resolved per-call (not at module load) so tests can swap the Hermes
// target between cases without process restart.
function envCfg() {
  return {
    HERMES_BASE:    process.env.HERMES_BASE         || 'http://127.0.0.1:1337',
    HERMES_PATH:    process.env.HERMES_LEASE_PATH   || '/v1/hermes/lease',
    HERMES_TIMEOUT: parseInt(process.env.MIRAGE_HERMES_TIMEOUT_MS || '2500', 10),
    SLACK_TIMEOUT:  parseInt(process.env.MIRAGE_SLACK_TIMEOUT_MS  || '15000', 10),
  };
}

const ENV = Object.freeze({
  bot_token:  'SLACK_BOT_TOKEN',
  user_token: 'SLACK_USER_TOKEN', // optional, only used for search.messages
});

// ─── lazy @slack/web-api client ─────────────────────────────────────────────

let _slackLib   = null;
let _clientErr  = null;
let _botCache   = null;
let _userCache  = null;

async function loadSlackLib() {
  if (_slackLib) return _slackLib;
  if (_clientErr) return null;
  try {
    _slackLib = await import('@slack/web-api');
    return _slackLib;
  } catch (err) {
    _clientErr = String(err?.message || err);
    return null;
  }
}

function botTokenPresent() {
  return Boolean(process.env[ENV.bot_token]);
}

function userTokenPresent() {
  return Boolean(process.env[ENV.user_token]);
}

function missingCreds() {
  const missing = [];
  if (!process.env[ENV.bot_token]) missing.push(ENV.bot_token);
  return missing;
}

async function getBotClient() {
  if (_botCache) return { ok: true, client: _botCache };
  if (!botTokenPresent()) {
    return { ok: false, reason: 'creds_missing', missing: missingCreds() };
  }
  const lib = await loadSlackLib();
  if (!lib) {
    return { ok: false, reason: 'slack_module_missing', detail: _clientErr || 'import failed' };
  }
  const { WebClient } = lib;
  _botCache = new WebClient(process.env[ENV.bot_token], {
    timeout: envCfg().SLACK_TIMEOUT,
  });
  return { ok: true, client: _botCache };
}

async function getUserClient() {
  if (_userCache) return { ok: true, client: _userCache };
  if (!userTokenPresent()) {
    return { ok: false, reason: 'user_token_missing', missing: [ENV.user_token] };
  }
  const lib = await loadSlackLib();
  if (!lib) {
    return { ok: false, reason: 'slack_module_missing', detail: _clientErr || 'import failed' };
  }
  const { WebClient } = lib;
  _userCache = new WebClient(process.env[ENV.user_token], {
    timeout: envCfg().SLACK_TIMEOUT,
  });
  return { ok: true, client: _userCache };
}

// ─── fetch w/ timeout (for Hermes calls) ────────────────────────────────────

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
 * Acquire a Hermes lease before any Slack mutation. Fail-closed.
 *
 * @param {string} action  e.g. 'slack.post_message'
 * @param {object} ctx     { approval_token?, target?, meta? }
 */
async function acquireLease(action, ctx = {}) {
  const payload = {
    actor: 'mirage.slack',
    targetProject: 'orange5',
    riskLevel: 'high', // outbound chat is reputationally high-risk by default
    requires_approval: true,
    allowed: [action],
    ttl_ms: 60_000,
    meta: {
      adapter: 'slack',
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

// Slack channel ids look like Cxxxxx (public), Gxxxxx (private legacy),
// Dxxxxx (DMs), or workspace-shared variants. Accept the common forms and
// also a #channel-name handle (the bot client will resolve via channels.info
// at call time only if the operator passes a name — we don't auto-list).
function looksLikeChannel(s) {
  const str = String(s ?? '').trim();
  if (!str) return false;
  // ID forms.
  if (/^[CGD][A-Z0-9]{6,}$/i.test(str)) return true;
  // Handle form. Slack channel names are 1-80 chars, lowercase letters,
  // digits, hyphens, underscores, periods.
  if (/^#?[a-z0-9._-]{1,80}$/.test(str)) return true;
  return false;
}

// Convert a Date|number|string "since" to Slack's `oldest` epoch-seconds string.
// Slack ts uses dot-separated seconds.microseconds; an integer-seconds string is fine.
function toSlackTs(v) {
  if (v == null) return undefined;
  if (typeof v === 'number') {
    // assume ms if it's a 13-digit-ish timestamp, else seconds
    return (v > 1e12 ? v / 1000 : v).toFixed(6);
  }
  if (v instanceof Date) {
    return (v.getTime() / 1000).toFixed(6);
  }
  const s = String(v);
  // already a slack ts?
  if (/^\d+\.\d+$/.test(s)) return s;
  // ISO 8601 or other parseable date
  const d = new Date(s);
  if (!isNaN(d.getTime())) return (d.getTime() / 1000).toFixed(6);
  // raw integer seconds
  if (/^\d+$/.test(s)) return Number(s).toFixed(6);
  return undefined;
}

// Normalize a Slack API error into the adapter's standard shape.
function normalizeSlackErr(err, op) {
  // @slack/web-api throws WebAPIPlatformError / WebAPIRequestError with
  // structured .data.error and .code.
  const detail = err?.data?.error || err?.message || String(err);
  const code = err?.code ?? err?.data?.error ?? err?.response?.status ?? null;
  return {
    ok: false,
    reason: 'slack_api_error',
    op,
    detail: String(detail),
    code,
    spec: SPEC,
  };
}

// ─── READ ───────────────────────────────────────────────────────────────────

/**
 * read({ op, ...args })
 *   op='list_channels' → { cursor?, limit?, types?, exclude_archived? }
 *   op='history'       → { channel, since?, oldest?, latest?, limit?, cursor? }
 *   op='search'        → { query, count?, sort?, page? }   (requires SLACK_USER_TOKEN)
 */
async function read(params = {}) {
  const op = String(params.op || 'list_channels');

  if (op === 'search') {
    // Search requires a user token. Be honest about it.
    const u = await getUserClient();
    if (!u.ok) {
      return { ok: false, reason: u.reason, detail: u.detail, missing: u.missing, spec: SPEC };
    }
    if (!params.query) return { ok: false, reason: 'query_required', spec: SPEC };
    try {
      const res = await withTimeout(
        u.client.search.messages({
          query: String(params.query),
          count: Number(params.count) || 20,
          sort: params.sort === 'timestamp' ? 'timestamp' : 'score',
          page: Number(params.page) || 1,
        }),
        envCfg().SLACK_TIMEOUT,
        'slack_search',
      );
      return {
        ok: true,
        op,
        data: {
          matches: res?.messages?.matches || [],
          total: res?.messages?.total ?? null,
          paging: res?.messages?.paging ?? null,
        },
      };
    } catch (err) {
      return normalizeSlackErr(err, op);
    }
  }

  const client = await getBotClient();
  if (!client.ok) {
    return { ok: false, reason: client.reason, detail: client.detail, missing: client.missing, spec: SPEC };
  }
  const slack = client.client;

  try {
    if (op === 'list_channels') {
      const res = await withTimeout(
        slack.conversations.list({
          cursor: params.cursor || undefined,
          limit: Math.min(Number(params.limit) || 200, 1000),
          types: params.types || 'public_channel,private_channel',
          exclude_archived: params.exclude_archived !== false,
        }),
        envCfg().SLACK_TIMEOUT,
        'slack_list_channels',
      );
      return {
        ok: true,
        op,
        data: {
          channels: res.channels || [],
          next_cursor: res?.response_metadata?.next_cursor || null,
        },
      };
    }

    if (op === 'history') {
      const channel = params.channel;
      if (!channel) return { ok: false, reason: 'channel_required', spec: SPEC };
      if (!looksLikeChannel(channel)) {
        return { ok: false, reason: 'channel_malformed', detail: 'expected Cxxxx id or #name handle', spec: SPEC };
      }
      const oldest = toSlackTs(params.since ?? params.oldest);
      const latest = toSlackTs(params.latest);
      const res = await withTimeout(
        slack.conversations.history({
          channel: String(channel),
          oldest,
          latest,
          limit: Math.min(Number(params.limit) || 100, 1000),
          cursor: params.cursor || undefined,
          inclusive: params.inclusive === true,
        }),
        envCfg().SLACK_TIMEOUT,
        'slack_history',
      );
      return {
        ok: true,
        op,
        data: {
          messages: res.messages || [],
          has_more: !!res.has_more,
          next_cursor: res?.response_metadata?.next_cursor || null,
        },
      };
    }

    return {
      ok: false,
      reason: `unknown_op:${op}`,
      allowed_ops: ['list_channels', 'history', 'search'],
      spec: SPEC,
    };
  } catch (err) {
    return normalizeSlackErr(err, op);
  }
}

// ─── WRITE (Hermes-gated) ───────────────────────────────────────────────────

/**
 * write({ op: 'post_message', channel, text?, blocks?, thread_ts?, approval_token })
 *
 * approval_token is the Sovereign's per-call approval. Without it the adapter
 * returns reason:'operator_approval_required' and does not post.
 */
async function write(params = {}) {
  const op = String(params.op || 'post_message');
  if (op !== 'post_message') {
    return { ok: false, reason: `unknown_op:${op}`, allowed_ops: ['post_message'], spec: SPEC };
  }

  // Surface-level validation before paying for a Hermes round-trip.
  if (!params.channel) return { ok: false, reason: 'channel_required', spec: SPEC };
  if (!looksLikeChannel(params.channel)) {
    return { ok: false, reason: 'channel_malformed', detail: 'expected Cxxxx id or #name handle', spec: SPEC };
  }
  const hasText   = params.text != null && String(params.text).length > 0;
  const hasBlocks = Array.isArray(params.blocks) && params.blocks.length > 0;
  if (!hasText && !hasBlocks) {
    return { ok: false, reason: 'text_or_blocks_required', spec: SPEC };
  }

  // 1. Hermes lease — fail-closed.
  const action = 'slack.post_message';
  const lease = await acquireLease(action, {
    approval_token: params.approval_token,
    target: params.channel,
    meta: {
      channel: params.channel,
      thread_ts: params.thread_ts || null,
      text_preview: hasText ? String(params.text).slice(0, 120) : null,
      blocks_count: hasBlocks ? params.blocks.length : 0,
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

  // 2. Client.
  const client = await getBotClient();
  if (!client.ok) {
    return { ok: false, reason: client.reason, detail: client.detail, missing: client.missing, spec: SPEC };
  }
  const slack = client.client;

  // 3. Post.
  try {
    const args = {
      channel: String(params.channel),
    };
    if (hasText)   args.text   = String(params.text);
    if (hasBlocks) args.blocks = params.blocks;
    if (params.thread_ts) args.thread_ts = String(params.thread_ts);
    if (params.reply_broadcast === true) args.reply_broadcast = true;
    if (params.unfurl_links === false) args.unfurl_links = false;
    if (params.unfurl_media === false) args.unfurl_media = false;

    const res = await withTimeout(
      slack.chat.postMessage(args),
      envCfg().SLACK_TIMEOUT,
      'slack_post_message',
    );
    return {
      ok: true,
      op,
      lease_id: lease.lease.id,
      data: {
        channel: res.channel,
        ts: res.ts,
        message: res.message || null,
      },
    };
  } catch (err) {
    return {
      ...normalizeSlackErr(err, op),
      lease_id: lease.lease?.id || null,
    };
  }
}

// ─── HEALTHZ ────────────────────────────────────────────────────────────────

async function healthz() {
  const out = { spec: SPEC, adapter: 'slack', family: 'data', writes_require_approval: true };

  if (!botTokenPresent()) {
    return {
      ...out,
      ok: false,
      status: 'degraded_no_creds',
      detail: `set env: ${missingCreds().join(', ')}`,
    };
  }
  const lib = await loadSlackLib();
  if (!lib) {
    return {
      ...out,
      ok: false,
      status: 'degraded_no_client',
      detail: `@slack/web-api not loadable: ${_clientErr || 'unknown'}. run: bun install @slack/web-api`,
    };
  }

  try {
    const client = await getBotClient();
    if (!client.ok) {
      return { ...out, ok: false, status: 'degraded', detail: client.reason };
    }
    // auth.test is the lightest auth-validating call on Slack.
    const res = await withTimeout(
      client.client.auth.test(),
      envCfg().SLACK_TIMEOUT,
      'slack_auth_test',
    );
    return {
      ...out,
      ok: true,
      status: 'ready',
      team: res.team || null,
      team_id: res.team_id || null,
      user: res.user || null,
      user_id: res.user_id || null,
      bot_id: res.bot_id || null,
      search_enabled: userTokenPresent(),
    };
  } catch (err) {
    return {
      ...out,
      ok: false,
      status: 'degraded',
      detail: String(err?.data?.error || err?.message || err),
      code: err?.code ?? err?.data?.error ?? err?.response?.status ?? null,
    };
  }
}

// ─── exports ────────────────────────────────────────────────────────────────

export const slackAdapter = Object.freeze({ read, write, healthz });
export default slackAdapter;

// Test-only escape hatch.
export function __resetForTests() {
  _slackLib  = null;
  _clientErr = null;
  _botCache  = null;
  _userCache = null;
}

// Internals exposed for unit tests.
export const __internals = Object.freeze({
  looksLikeChannel,
  toSlackTs,
  normalizeSlackErr,
});
