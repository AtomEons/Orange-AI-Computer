// 11-MIRAGE/adapters/drive.mjs — READY (Wave-2).
//
// Google Drive mount. External data-plane: writes_require_approval = true.
//
// Auth: OAuth2 refresh-token flow (operator brings creds).
//   GOOGLE_DRIVE_CLIENT_ID
//   GOOGLE_DRIVE_CLIENT_SECRET
//   GOOGLE_DRIVE_REFRESH_TOKEN
//
// Scopes (recommend least-privilege at the operator's OAuth consent):
//   https://www.googleapis.com/auth/drive.file        — files this app creates/opens
//   https://www.googleapis.com/auth/drive.readonly    — for broad list/read
//
// Surface (mirrors flux.mjs READY-pattern):
//   read({ op: 'list_files',  folder_id, page_size?, page_token?, q? })
//   read({ op: 'read_file',   file_id, export_mime? })
//   write({ op: 'create_file', name, parents?, mime_type?, content, content_encoding?, approval_token })
//   write({ op: 'update_file', file_id, content?, content_encoding?, name?, approval_token })
//   healthz()
//
// Write discipline (Mirage law, data-family):
//   - write() MUST acquire a Hermes lease at POST {HERMES_BASE}/v1/hermes/lease before
//     calling googleapis. The lease is the Sovereign's per-call human-in-the-loop gate.
//     Default gateway base: http://127.0.0.1:1337  (loopback, gateway-mediated).
//     Direct-daemon override: HERMES_BASE=http://127.0.0.1:7430 with HERMES_PATH=/lease.
//   - On lease refusal the adapter returns { ok:false, reason:'hermes_lease_denied', ... }
//     and never touches Drive.
//   - On Hermes unreachable the adapter refuses to write (fail-closed).
//
// Read discipline:
//   - read() proceeds without approval (read-only is safe per Mirage manifest).
//
// Honest gaps:
//   - The `googleapis` npm package is a hard dep at runtime. Until `bun install`
//     (or `npm install`) lands it in node_modules, every call returns
//     { ok:false, reason:'googleapis_module_missing' }. healthz() reports this
//     honestly as status:'degraded_no_client' rather than throwing.
//   - When the three GOOGLE_DRIVE_* env vars are unset, healthz() reports
//     status:'degraded_no_creds' rather than throwing.
//   - Token refresh is delegated to the googleapis OAuth2 client; if the
//     refresh token is revoked, the next call will surface the upstream error
//     verbatim in `detail`.
//
// Spec: 11-MIRAGE/SPEC.md#drive

import { Readable } from 'node:stream';

const SPEC = '11-MIRAGE/SPEC.md#drive';

// Env is resolved per-call (not at module load) so tests can swap the Hermes
// target between cases without process restart, and so the operator can rotate
// gateway endpoints at runtime.
function envCfg() {
  return {
    HERMES_BASE:    process.env.HERMES_BASE         || 'http://127.0.0.1:1337',
    HERMES_PATH:    process.env.HERMES_LEASE_PATH   || '/v1/hermes/lease',
    HERMES_TIMEOUT: parseInt(process.env.MIRAGE_HERMES_TIMEOUT_MS || '2500', 10),
    DRIVE_TIMEOUT:  parseInt(process.env.MIRAGE_DRIVE_TIMEOUT_MS  || '15000', 10),
  };
}

const ENV = Object.freeze({
  client_id:     'GOOGLE_DRIVE_CLIENT_ID',
  client_secret: 'GOOGLE_DRIVE_CLIENT_SECRET',
  refresh_token: 'GOOGLE_DRIVE_REFRESH_TOKEN',
});

// ─── lazy googleapis client ─────────────────────────────────────────────────

let _googleapis = null;          // cached module
let _clientErr  = null;          // load error, if any
let _driveCache = null;          // cached drive('v3') client (per-creds)

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
    process.env[ENV.client_id] &&
    process.env[ENV.client_secret] &&
    process.env[ENV.refresh_token]
  );
}

function missingCreds() {
  const missing = [];
  if (!process.env[ENV.client_id])     missing.push(ENV.client_id);
  if (!process.env[ENV.client_secret]) missing.push(ENV.client_secret);
  if (!process.env[ENV.refresh_token]) missing.push(ENV.refresh_token);
  return missing;
}

async function getDriveClient() {
  if (_driveCache) return { ok: true, drive: _driveCache };
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
  _driveCache = google.drive({ version: 'v3', auth: oauth2 });
  return { ok: true, drive: _driveCache };
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
 * Acquire (or verify) a Hermes lease before any Drive mutation.
 * The adapter is fail-closed: no lease → no write.
 *
 * @param {string} action  e.g. 'drive.create_file' | 'drive.update_file'
 * @param {object} ctx     { approval_token?, target?, meta? }
 */
async function acquireLease(action, ctx = {}) {
  const payload = {
    actor: 'mirage.drive',
    targetProject: 'orange5',
    riskLevel: 'medium',
    requires_approval: true,
    allowed: [action],
    ttl_ms: 60_000,
    meta: {
      adapter: 'drive',
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
  // Expect { id, allowed, expires_at, requires_approval, ... }
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

function bufFromContent(content, encoding) {
  if (content == null) return null;
  if (Buffer.isBuffer(content)) return content;
  if (encoding === 'base64')  return Buffer.from(String(content), 'base64');
  if (encoding === 'utf8' || encoding === 'utf-8' || encoding == null) {
    return Buffer.from(String(content), 'utf8');
  }
  // Unknown encoding — treat literally as utf8 and surface the assumption.
  return Buffer.from(String(content), 'utf8');
}

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

// ─── READ ───────────────────────────────────────────────────────────────────

/**
 * read({ op, ...args })
 *   op='list_files' → { folder_id, page_size?, page_token?, q? }
 *   op='read_file'  → { file_id, export_mime? }
 */
async function read(params = {}) {
  const op = String(params.op || 'list_files');
  const client = await getDriveClient();
  if (!client.ok) {
    return { ok: false, reason: client.reason, detail: client.detail, missing: client.missing, spec: SPEC };
  }
  const drive = client.drive;

  try {
    if (op === 'list_files') {
      const folder_id  = params.folder_id;
      if (!folder_id) return { ok: false, reason: 'folder_id_required', spec: SPEC };
      const qParts = [`'${String(folder_id).replace(/'/g, "\\'")}' in parents`, 'trashed = false'];
      if (params.q) qParts.push(String(params.q));
      const res = await withTimeout(
        drive.files.list({
          q: qParts.join(' and '),
          pageSize: params.page_size || 100,
          pageToken: params.page_token || undefined,
          fields: 'nextPageToken, files(id, name, mimeType, size, modifiedTime, parents)',
        }),
        envCfg().DRIVE_TIMEOUT,
        'drive_list_files',
      );
      return {
        ok: true,
        op,
        data: {
          files: res.data.files || [],
          next_page_token: res.data.nextPageToken || null,
        },
      };
    }

    if (op === 'read_file') {
      const file_id = params.file_id;
      if (!file_id) return { ok: false, reason: 'file_id_required', spec: SPEC };

      // First fetch metadata to learn mimeType.
      const meta = await withTimeout(
        drive.files.get({ fileId: file_id, fields: 'id, name, mimeType, size, modifiedTime' }),
        envCfg().DRIVE_TIMEOUT,
        'drive_read_meta',
      );

      // Google-native types (Docs, Sheets, etc.) require export, not get(alt=media).
      const isGoogleNative = String(meta.data.mimeType || '').startsWith('application/vnd.google-apps.');
      let bodyRes;
      if (isGoogleNative) {
        const export_mime = params.export_mime || 'text/plain';
        bodyRes = await withTimeout(
          drive.files.export({ fileId: file_id, mimeType: export_mime }, { responseType: 'arraybuffer' }),
          envCfg().DRIVE_TIMEOUT,
          'drive_read_export',
        );
      } else {
        bodyRes = await withTimeout(
          drive.files.get({ fileId: file_id, alt: 'media' }, { responseType: 'arraybuffer' }),
          envCfg().DRIVE_TIMEOUT,
          'drive_read_media',
        );
      }
      const buf = Buffer.from(bodyRes.data);
      return {
        ok: true,
        op,
        data: {
          id: meta.data.id,
          name: meta.data.name,
          mime_type: meta.data.mimeType,
          size: meta.data.size ? Number(meta.data.size) : buf.length,
          modified_time: meta.data.modifiedTime,
          content_base64: buf.toString('base64'),
        },
      };
    }

    return { ok: false, reason: `unknown_op:${op}`, allowed_ops: ['list_files', 'read_file'], spec: SPEC };
  } catch (err) {
    return {
      ok: false,
      reason: 'drive_api_error',
      op,
      detail: String(err?.message || err),
      code: err?.code ?? err?.response?.status ?? null,
      spec: SPEC,
    };
  }
}

// ─── WRITE (Hermes-gated) ───────────────────────────────────────────────────

/**
 * write({ op, ...args, approval_token })
 *   op='create_file' → { name, parents?, mime_type?, content, content_encoding? }
 *   op='update_file' → { file_id, name?, content?, content_encoding? }
 *
 * approval_token is the Sovereign's per-call approval. Without it the adapter
 * returns reason:'operator_approval_required' and does not touch Drive.
 */
async function write(params = {}) {
  const op = String(params.op || '');
  if (!op) return { ok: false, reason: 'op_required', allowed_ops: ['create_file', 'update_file'], spec: SPEC };
  if (op !== 'create_file' && op !== 'update_file') {
    return { ok: false, reason: `unknown_op:${op}`, allowed_ops: ['create_file', 'update_file'], spec: SPEC };
  }

  // 1. Hermes lease (per-call human-in-the-loop gate) — fail-closed.
  const action = `drive.${op}`;
  const lease = await acquireLease(action, {
    approval_token: params.approval_token,
    target: params.file_id || params.parents || params.name || null,
    meta: { name: params.name || null, file_id: params.file_id || null },
  });
  if (!lease.ok) {
    return { ok: false, reason: lease.reason, detail: lease.detail, lease: lease.lease, status: lease.status, spec: SPEC };
  }

  // 2. Client.
  const client = await getDriveClient();
  if (!client.ok) {
    return { ok: false, reason: client.reason, detail: client.detail, missing: client.missing, spec: SPEC };
  }
  const drive = client.drive;

  // 3. Mutate.
  try {
    if (op === 'create_file') {
      if (!params.name) return { ok: false, reason: 'name_required', spec: SPEC };
      const buf = bufFromContent(params.content, params.content_encoding);
      const requestBody = {
        name: params.name,
        parents: Array.isArray(params.parents) ? params.parents : (params.parents ? [params.parents] : undefined),
      };
      const media = buf ? {
        mimeType: params.mime_type || 'application/octet-stream',
        body: bufToStream(buf),
      } : undefined;
      const res = await withTimeout(
        drive.files.create({
          requestBody,
          media,
          fields: 'id, name, mimeType, size, parents, modifiedTime',
        }),
        envCfg().DRIVE_TIMEOUT,
        'drive_create_file',
      );
      return { ok: true, op, lease_id: lease.lease.id, data: res.data };
    }

    // update_file
    if (!params.file_id) return { ok: false, reason: 'file_id_required', spec: SPEC };
    const buf = bufFromContent(params.content, params.content_encoding);
    const requestBody = {};
    if (params.name) requestBody.name = params.name;
    const media = buf ? {
      mimeType: params.mime_type || 'application/octet-stream',
      body: bufToStream(buf),
    } : undefined;
    const res = await withTimeout(
      drive.files.update({
        fileId: params.file_id,
        requestBody,
        media,
        fields: 'id, name, mimeType, size, parents, modifiedTime',
      }),
      envCfg().DRIVE_TIMEOUT,
      'drive_update_file',
    );
    return { ok: true, op, lease_id: lease.lease.id, data: res.data };
  } catch (err) {
    return {
      ok: false,
      reason: 'drive_api_error',
      op,
      lease_id: lease.lease?.id || null,
      detail: String(err?.message || err),
      code: err?.code ?? err?.response?.status ?? null,
      spec: SPEC,
    };
  }
}

// Convert a Buffer into a Readable stream — what googleapis media.body expects.
function bufToStream(buf) {
  return Readable.from(buf);
}

// ─── HEALTHZ ────────────────────────────────────────────────────────────────

async function healthz() {
  const out = { spec: SPEC, adapter: 'drive', family: 'data', writes_require_approval: true };

  // Honest stub: creds missing.
  if (!credsPresent()) {
    return {
      ...out,
      ok: false,
      status: 'degraded_no_creds',
      detail: `set env: ${missingCreds().join(', ')}`,
    };
  }
  // Honest stub: googleapis not installed.
  const gx = await loadGoogleapis();
  if (!gx) {
    return {
      ...out,
      ok: false,
      status: 'degraded_no_client',
      detail: `googleapis not loadable: ${_clientErr || 'unknown'}. run: bun install googleapis`,
    };
  }

  // Smoke ping: about.get is the lightest auth-validating call.
  try {
    const client = await getDriveClient();
    if (!client.ok) {
      return { ...out, ok: false, status: 'degraded', detail: client.reason };
    }
    const res = await withTimeout(
      client.drive.about.get({ fields: 'user(emailAddress), storageQuota(limit,usage)' }),
      envCfg().DRIVE_TIMEOUT,
      'drive_about',
    );
    return {
      ...out,
      ok: true,
      status: 'ready',
      user: res.data.user?.emailAddress || null,
      quota: res.data.storageQuota || null,
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

export const driveAdapter = Object.freeze({ read, write, healthz });
export default driveAdapter;

// Test-only escape hatch: lets tests reset the cached module/client between cases
// without forcing a process restart. Not part of the public surface.
export function __resetForTests() {
  _googleapis = null;
  _clientErr  = null;
  _driveCache = null;
}
