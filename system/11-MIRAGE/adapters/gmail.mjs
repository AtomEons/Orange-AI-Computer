// 11-MIRAGE/adapters/gmail.mjs — READY (Wave-2).
//
// Gmail mount. External data-plane: writes_require_approval = true.
//
// Auth: OAuth2 refresh-token flow (operator brings creds).
//   GMAIL_REFRESH_TOKEN     — primary credential called out by the spec
//   GMAIL_CLIENT_ID         — OAuth2 client id (required by Google's token endpoint)
//   GMAIL_CLIENT_SECRET     — OAuth2 client secret
//
// Honest gap: the spec names GMAIL_REFRESH_TOKEN as the auth, but Google's
// OAuth2 server will not refresh without the issuing client_id + secret. The
// adapter requires all three; healthz() lists which are missing instead of
// throwing. Mom's Law: state shortcuts in the open.
//
// Scopes (set by operator at consent time, least-privilege recommended):
//   https://www.googleapis.com/auth/gmail.readonly    — list/get/search
//   https://www.googleapis.com/auth/gmail.send        — send mail
//
// Surface (mirrors drive.mjs READY-pattern):
//   read({ op: 'list_threads', query?, max_results?, page_token?, label_ids? })
//   read({ op: 'get_thread',   id, format? })
//   read({ op: 'search',       q,  max_results?, page_token? })  // alias of list_threads
//   write({ op: 'send', to, subject, body, cc?, bcc?, from?, mime?, approval_token })
//   healthz()
//
// Write discipline (Mirage law, data-family):
//   - write() MUST acquire a Hermes lease at POST {HERMES_BASE}/v1/hermes/lease
//     before calling googleapis. The lease is the Sovereign's per-call
//     human-in-the-loop gate.
//     Default gateway base: http://127.0.0.1:1337  (loopback, gateway-mediated).
//     Direct-daemon override: HERMES_BASE=http://127.0.0.1:7430 + HERMES_LEASE_PATH=/lease.
//   - On lease refusal the adapter returns { ok:false, reason:'hermes_lease_denied' }
//     and never sends mail.
//   - On Hermes unreachable the adapter refuses to write (fail-closed).
//   - NEVER auto-sends. operator_approved must be conveyed via `approval_token`
//     (Hermes forwards it as x-operator-approval).
//
// Read discipline:
//   - read() proceeds without approval (read-only is safe per Mirage manifest).
//
// Spec: 11-MIRAGE/SPEC.md#gmail

const SPEC = '11-MIRAGE/SPEC.md#gmail';

// Env is resolved per-call (not at module load) so tests can swap the Hermes
// target between cases without process restart, and so the operator can rotate
// gateway endpoints at runtime.
function envCfg() {
  return {
    HERMES_BASE:    process.env.HERMES_BASE         || 'http://127.0.0.1:1337',
    HERMES_PATH:    process.env.HERMES_LEASE_PATH   || '/v1/hermes/lease',
    HERMES_TIMEOUT: parseInt(process.env.MIRAGE_HERMES_TIMEOUT_MS || '2500', 10),
    GMAIL_TIMEOUT:  parseInt(process.env.MIRAGE_GMAIL_TIMEOUT_MS  || '15000', 10),
  };
}

const ENV = Object.freeze({
  refresh_token: 'GMAIL_REFRESH_TOKEN',
  client_id:     'GMAIL_CLIENT_ID',
  client_secret: 'GMAIL_CLIENT_SECRET',
});

// ─── lazy googleapis client ─────────────────────────────────────────────────

let _googleapis  = null;
let _clientErr   = null;
let _gmailCache  = null;

async function loadGoogleapis() {
  if (_googleapis) return _googleapis;
  if (_clientErr) return null;
  try {
    _googleapis = await import('googleapis');
    return _googleapis;
  } catch (err) {
    _clientErr = String(err?.message || err);
    return null;
  }
}

function credsPresent() {
  return Boolean(
    process.env[ENV.refresh_token] &&
    process.env[ENV.client_id] &&
    process.env[ENV.client_secret]
  );
}

function missingCreds() {
  const missing = [];
  if (!process.env[ENV.refresh_token]) missing.push(ENV.refresh_token);
  if (!process.env[ENV.client_id])     missing.push(ENV.client_id);
  if (!process.env[ENV.client_secret]) missing.push(ENV.client_secret);
  return missing;
}

async function getGmailClient() {
  if (_gmailCache) return { ok: true, gmail: _gmailCache };
  if (!credsPresent()) {
    return { ok: false, reason: 'creds_missing', missing: missingCreds() };
  }
  const gx = await loadGoogleapis();
  if (!gx) {
    return { ok: false, reason: 'googleapis_module_missing', detail: _clientErr || 'import failed' };
  }
  const { google } = gx;
  const oauth2 = new google.auth.OAuth2(
    process.env[ENV.client_id],
    process.env[ENV.client_secret],
  );
  oauth2.setCredentials({ refresh_token: process.env[ENV.refresh_token] });
  _gmailCache = google.gmail({ version: 'v1', auth: oauth2 });
  return { ok: true, gmail: _gmailCache };
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
 * Acquire a Hermes lease before any Gmail mutation. Fail-closed.
 *
 * @param {string} action  e.g. 'gmail.send'
 * @param {object} ctx     { approval_token?, target?, meta? }
 */
async function acquireLease(action, ctx = {}) {
  const payload = {
    actor: 'mirage.gmail',
    targetProject: 'orange5',
    riskLevel: 'high', // outbound mail is reputationally high-risk by default
    requires_approval: true,
    allowed: [action],
    ttl_ms: 60_000,
    meta: {
      adapter: 'gmail',
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

// RFC 5322 line-folded headers; body as utf8. Encoded base64url for Gmail's raw API.
function buildRfc822({ to, subject, body, cc, bcc, from, mime }) {
  const lines = [];
  if (from) lines.push(`From: ${from}`);
  lines.push(`To: ${to}`);
  if (cc)  lines.push(`Cc: ${cc}`);
  if (bcc) lines.push(`Bcc: ${bcc}`);
  lines.push(`Subject: ${rfc2047encodeIfNeeded(subject)}`);
  lines.push('MIME-Version: 1.0');
  const isHtml = mime === 'text/html' || mime === 'html';
  lines.push(`Content-Type: ${isHtml ? 'text/html' : 'text/plain'}; charset="UTF-8"`);
  lines.push('Content-Transfer-Encoding: 7bit');
  lines.push('');
  lines.push(String(body ?? ''));
  return lines.join('\r\n');
}

// If the subject is non-ASCII, encoded-word it. Cheap, correct enough.
function rfc2047encodeIfNeeded(s) {
  const str = String(s ?? '');
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(str)) return str;
  return `=?UTF-8?B?${Buffer.from(str, 'utf8').toString('base64')}?=`;
}

function toBase64Url(s) {
  return Buffer.from(s, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// Cheap address validator — refuses obvious garbage before paying for Hermes.
function looksLikeEmailList(s) {
  const str = String(s ?? '').trim();
  if (!str) return false;
  // Split on commas, require each piece to contain "<addr@host>" or "addr@host".
  return str.split(',').every(part => {
    const p = part.trim();
    const bare = p.match(/<([^>]+)>/)?.[1] || p;
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(bare);
  });
}

// ─── READ ───────────────────────────────────────────────────────────────────

/**
 * read({ op, ...args })
 *   op='list_threads' → { query?, max_results?, page_token?, label_ids? }
 *   op='get_thread'   → { id, format? }   // format: 'full' | 'metadata' | 'minimal'
 *   op='search'       → { q,   max_results?, page_token? }  // alias of list_threads
 */
async function read(params = {}) {
  const op = String(params.op || 'list_threads');
  const client = await getGmailClient();
  if (!client.ok) {
    return { ok: false, reason: client.reason, detail: client.detail, missing: client.missing, spec: SPEC };
  }
  const gmail = client.gmail;

  try {
    if (op === 'list_threads' || op === 'search') {
      const q = op === 'search' ? params.q : params.query;
      const res = await withTimeout(
        gmail.users.threads.list({
          userId: 'me',
          q: q ? String(q) : undefined,
          maxResults: params.max_results || 25,
          pageToken: params.page_token || undefined,
          labelIds: Array.isArray(params.label_ids) ? params.label_ids : undefined,
        }),
        envCfg().GMAIL_TIMEOUT,
        'gmail_list_threads',
      );
      return {
        ok: true,
        op,
        data: {
          threads: res.data.threads || [],
          next_page_token: res.data.nextPageToken || null,
          result_size_estimate: res.data.resultSizeEstimate ?? null,
        },
      };
    }

    if (op === 'get_thread') {
      const id = params.id;
      if (!id) return { ok: false, reason: 'id_required', spec: SPEC };
      const format = ['full', 'metadata', 'minimal'].includes(params.format) ? params.format : 'full';
      const res = await withTimeout(
        gmail.users.threads.get({ userId: 'me', id: String(id), format }),
        envCfg().GMAIL_TIMEOUT,
        'gmail_get_thread',
      );
      return {
        ok: true,
        op,
        data: {
          id: res.data.id,
          history_id: res.data.historyId,
          snippet: res.data.snippet,
          messages: res.data.messages || [],
        },
      };
    }

    return {
      ok: false,
      reason: `unknown_op:${op}`,
      allowed_ops: ['list_threads', 'get_thread', 'search'],
      spec: SPEC,
    };
  } catch (err) {
    return {
      ok: false,
      reason: 'gmail_api_error',
      op,
      detail: String(err?.message || err),
      code: err?.code ?? err?.response?.status ?? null,
      spec: SPEC,
    };
  }
}

// ─── WRITE (Hermes-gated) ───────────────────────────────────────────────────

/**
 * write({ op: 'send', to, subject, body, cc?, bcc?, from?, mime?, approval_token })
 *
 * approval_token is the Sovereign's per-call approval. Without it the adapter
 * returns reason:'operator_approval_required' and does not send.
 */
async function write(params = {}) {
  const op = String(params.op || 'send');
  if (op !== 'send') {
    return { ok: false, reason: `unknown_op:${op}`, allowed_ops: ['send'], spec: SPEC };
  }

  // Surface-level validation before paying for a Hermes round-trip.
  if (!params.to)      return { ok: false, reason: 'to_required',      spec: SPEC };
  if (params.subject == null) return { ok: false, reason: 'subject_required', spec: SPEC };
  if (params.body == null)    return { ok: false, reason: 'body_required',    spec: SPEC };
  if (!looksLikeEmailList(params.to)) {
    return { ok: false, reason: 'to_malformed', detail: 'expected RFC-5322 address or comma list', spec: SPEC };
  }
  if (params.cc  && !looksLikeEmailList(params.cc))  return { ok: false, reason: 'cc_malformed',  spec: SPEC };
  if (params.bcc && !looksLikeEmailList(params.bcc)) return { ok: false, reason: 'bcc_malformed', spec: SPEC };

  // 1. Hermes lease — fail-closed.
  const action = 'gmail.send';
  const lease = await acquireLease(action, {
    approval_token: params.approval_token,
    target: params.to,
    meta: {
      to: params.to,
      cc: params.cc || null,
      bcc: params.bcc || null,
      subject_preview: String(params.subject).slice(0, 120),
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
  const client = await getGmailClient();
  if (!client.ok) {
    return { ok: false, reason: client.reason, detail: client.detail, missing: client.missing, spec: SPEC };
  }
  const gmail = client.gmail;

  // 3. Compose and send.
  try {
    const rfc822 = buildRfc822({
      to: params.to,
      subject: params.subject,
      body: params.body,
      cc: params.cc,
      bcc: params.bcc,
      from: params.from,
      mime: params.mime,
    });
    const raw = toBase64Url(rfc822);
    const res = await withTimeout(
      gmail.users.messages.send({ userId: 'me', requestBody: { raw } }),
      envCfg().GMAIL_TIMEOUT,
      'gmail_send',
    );
    return {
      ok: true,
      op,
      lease_id: lease.lease.id,
      data: {
        id: res.data.id,
        thread_id: res.data.threadId,
        label_ids: res.data.labelIds || [],
      },
    };
  } catch (err) {
    return {
      ok: false,
      reason: 'gmail_api_error',
      op,
      lease_id: lease.lease?.id || null,
      detail: String(err?.message || err),
      code: err?.code ?? err?.response?.status ?? null,
      spec: SPEC,
    };
  }
}

// ─── HEALTHZ ────────────────────────────────────────────────────────────────

async function healthz() {
  const out = { spec: SPEC, adapter: 'gmail', family: 'data', writes_require_approval: true };

  if (!credsPresent()) {
    return {
      ...out,
      ok: false,
      status: 'degraded_no_creds',
      detail: `set env: ${missingCreds().join(', ')}`,
    };
  }
  const gx = await loadGoogleapis();
  if (!gx) {
    return {
      ...out,
      ok: false,
      status: 'degraded_no_client',
      detail: `googleapis not loadable: ${_clientErr || 'unknown'}. run: bun install googleapis`,
    };
  }

  try {
    const client = await getGmailClient();
    if (!client.ok) {
      return { ...out, ok: false, status: 'degraded', detail: client.reason };
    }
    // getProfile is the lightest auth-validating call on Gmail.
    const res = await withTimeout(
      client.gmail.users.getProfile({ userId: 'me' }),
      envCfg().GMAIL_TIMEOUT,
      'gmail_profile',
    );
    return {
      ...out,
      ok: true,
      status: 'ready',
      user: res.data.emailAddress || null,
      messages_total: res.data.messagesTotal ?? null,
      threads_total: res.data.threadsTotal ?? null,
    };
  } catch (err) {
    return {
      ...out,
      ok: false,
      status: 'degraded',
      detail: String(err?.message || err),
      code: err?.code ?? err?.response?.status ?? null,
    };
  }
}

// ─── exports ────────────────────────────────────────────────────────────────

export const gmailAdapter = Object.freeze({ read, write, healthz });
export default gmailAdapter;

// Test-only escape hatch.
export function __resetForTests() {
  _googleapis = null;
  _clientErr  = null;
  _gmailCache = null;
}

// Internals exposed for unit tests.
export const __internals = Object.freeze({
  buildRfc822,
  toBase64Url,
  looksLikeEmailList,
  rfc2047encodeIfNeeded,
});
