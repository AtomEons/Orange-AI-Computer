// rail-token-watcher.mjs
// Codexa rail-token hot-reload watcher.
//
// Doctrine (excerpt — full law lives in 06-ORANGELLM/docs/RAIL_TOKEN_ROTATION.md):
//   - The rail token authorizes Codexa-side calls into the Orange5 gateway.
//   - Source of truth on disk: the file pointed to by env ORANGEBOX_RAIL_TOKEN_FILE
//     (default: <repo>/.rail-token).
//   - Rotation is performed by an external ceremony (Windows Task Scheduler +
//     Codexa systemd timer). This watcher's only job is: when the file changes,
//     swap the in-memory token reference WITHOUT restarting the gateway.
//   - Mom's Law: tokens never appear in logs. We log only sha256 fingerprints
//     (first 12 hex chars) of prior and new tokens, plus a Reality-lane event.
//   - Kill-switch: if env ORANGEBOX_RAIL_DISABLED === "1", the watcher refuses
//     to expose any token (getToken() returns null) and every reload is
//     recorded as a refusal. The gateway's auth middleware must check
//     isDisabled() before honoring the token.
//
// This module is a singleton. Import { startRailTokenWatcher, getToken,
// getTokenFingerprint, isDisabled, stopRailTokenWatcher } from it.

import { createHash } from "node:crypto";
import { readFileSync, statSync, watch as watchFs } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { EventEmitter } from "node:events";

// ---------------------------------------------------------------------------
// Module state. Kept in closure (not exported) so the token string itself
// cannot be read except via getToken(). Fingerprint is safe to expose.
// ---------------------------------------------------------------------------

let _token = null;            // string | null — raw token, never logged
let _fingerprint = null;      // string | null — sha256 hex, first 12 chars
let _fullSha = null;          // string | null — full sha256, for receipts
let _tokenPath = null;        // string | null — resolved absolute path
let _watcher = null;          // native fs.FSWatcher | null
let _reloadTimer = null;      // debounce timer for atomic replace bursts
let _disabled = false;        // boolean — kill-switch latched at start
let _started = false;         // guard against double-start

export const railTokenEvents = new EventEmitter();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256Hex(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function fingerprintOf(token) {
  if (token == null) return null;
  return sha256Hex(token).slice(0, 12);
}

function readTokenFromDisk(path) {
  // Tokens are base64url-encoded HS256 secrets emitted by the rotation
  // ceremony. They are ASCII and must be trimmed of trailing whitespace
  // (rsync/Windows line endings) before use. We do NOT log the contents.
  const raw = readFileSync(path, { encoding: "utf8" });
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new Error("rail token file is empty");
  }
  if (trimmed.length < 32) {
    // 256-bit base64url is 43 chars. Anything substantially shorter is
    // either a placeholder, a stale stub, or a leak-and-truncate. Refuse.
    throw new Error("rail token file is too short to be a 256-bit token");
  }
  return trimmed;
}

function logReality(level, event, payload) {
  // Reality-lane logger. In the Orange5 server this is wired to the
  // structured logger; here we emit on a plain stream and also fire an
  // event so the gateway's audit pipeline can pick it up.
  const record = {
    ts: new Date().toISOString(),
    lane: "Reality",
    component: "rail-token-watcher",
    level,
    event,
    ...payload,
  };
  // Use stderr for the watcher's own diagnostics so it cannot accidentally
  // pollute stdout pipelines. Tokens never appear here — only fingerprints.
  try {
    process.stderr.write(JSON.stringify(record) + "\n");
  } catch {
    // best-effort; never throw from a log call
  }
  railTokenEvents.emit("reality", record);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns the in-memory rail token, or null if disabled / unloaded.
 * The auth middleware MUST call this on every request — it MUST NOT cache.
 */
export function getToken() {
  if (_disabled) return null;
  return _token;
}

/**
 * Returns the 12-char sha256 fingerprint of the current token, or null.
 * Safe to log. Used in receipts and audit lines.
 */
export function getTokenFingerprint() {
  return _fingerprint;
}

/**
 * Returns the full sha256 hex of the current token. Safe to log but
 * conventionally only emitted into the Reality-lane audit, not into
 * request logs.
 */
export function getTokenSha256() {
  return _fullSha;
}

/**
 * True iff the kill-switch is engaged (ORANGEBOX_RAIL_DISABLED=1 at
 * watcher start). The gateway's auth middleware MUST consult this and
 * refuse all Codexa-side calls with 503 when true.
 */
export function isDisabled() {
  return _disabled;
}

/**
 * Start the watcher. Idempotent; safe to call once at server boot.
 * Throws if the token file is missing at boot — fail loud rather than
 * silently come up with no token (which would 401 every Codexa call
 * and look identical to a real outage).
 *
 * options.tokenPath  — explicit path, otherwise read from
 *                      ORANGEBOX_RAIL_TOKEN_FILE then default.
 * options.disabled   — force disabled (for tests).
 */
export async function startRailTokenWatcher(options = {}) {
  if (_started) {
    return { tokenPath: _tokenPath, fingerprint: _fingerprint, disabled: _disabled };
  }

  _disabled =
    options.disabled === true ||
    process.env.ORANGEBOX_RAIL_DISABLED === "1";

  _tokenPath = resolve(
    options.tokenPath ||
      process.env.ORANGEBOX_RAIL_TOKEN_FILE ||
      ".rail-token",
  );

  if (_disabled) {
    logReality("warn", "rail_token_watcher_disabled", {
      tokenPath: _tokenPath,
      reason: options.disabled
        ? "options.disabled"
        : "ORANGEBOX_RAIL_DISABLED=1",
    });
    _started = true;
    return { tokenPath: _tokenPath, fingerprint: null, disabled: true };
  }

  // Initial load. If the file is missing we refuse to start — the operator
  // must run the rotation ceremony first. This matches the Wave 2 close
  // receipt: "missing rail token" is a real outage, not a degraded mode.
  let initialToken;
  try {
    initialToken = readTokenFromDisk(_tokenPath);
  } catch (err) {
    logReality("error", "rail_token_initial_load_failed", {
      tokenPath: _tokenPath,
      error: err.message,
    });
    throw new Error(
      `rail-token-watcher: cannot start without a valid token at ${_tokenPath}: ${err.message}`,
    );
  }

  _token = initialToken;
  _fullSha = sha256Hex(initialToken);
  _fingerprint = _fullSha.slice(0, 12);

  logReality("info", "rail_token_loaded", {
    tokenPath: _tokenPath,
    fingerprint: _fingerprint,
    sha256: _fullSha,
    // Best-effort mtime for audit; not security-critical.
    mtime: safeMtime(_tokenPath),
  });

  // Watch the parent directory so atomic token replacement remains visible on
  // Windows. Debouncing gives a writer time to finish rename/write bursts.
  const watchedName = basename(_tokenPath).toLowerCase();
  _watcher = watchFs(dirname(_tokenPath), { persistent: true }, (_event, filename) => {
    if (filename && String(filename).toLowerCase() !== watchedName) return;
    if (_reloadTimer) clearTimeout(_reloadTimer);
    _reloadTimer = setTimeout(() => {
      _reloadTimer = null;
      handleTokenFileChange(_tokenPath).catch((err) => {
        logReality("error", "rail_token_reload_handler_threw", {
          error: err.message,
        });
      });
    }, 200);
  });
  _watcher.on("error", (err) => {
    logReality("error", "rail_token_watcher_error", {
      error: err && err.message ? err.message : String(err),
    });
  });

  _started = true;
  return { tokenPath: _tokenPath, fingerprint: _fingerprint, disabled: false };
}

/**
 * Stop the watcher. Used in tests and on graceful shutdown.
 * Does NOT clear the in-memory token — the gateway may still be serving
 * in-flight requests; the operator is expected to drain before exit.
 */
export async function stopRailTokenWatcher() {
  if (_reloadTimer) {
    clearTimeout(_reloadTimer);
    _reloadTimer = null;
  }
  if (_watcher) {
    try {
      _watcher.close();
    } catch (err) {
      logReality("warn", "rail_token_watcher_close_failed", {
        error: err.message,
      });
    }
    _watcher = null;
  }
  _started = false;
}

/**
 * Force a reload from disk. Exposed for the rotation ceremony to call
 * via an admin signal when fs-watch is unreliable (e.g. network mounts).
 */
export async function forceReload() {
  if (_disabled) {
    logReality("warn", "rail_token_force_reload_refused", {
      reason: "watcher disabled",
    });
    return { reloaded: false, reason: "disabled" };
  }
  if (!_tokenPath) {
    throw new Error("rail-token-watcher: not started");
  }
  return handleTokenFileChange(_tokenPath, { source: "force" });
}

// ---------------------------------------------------------------------------
// Internal: the actual swap.
// ---------------------------------------------------------------------------

async function handleTokenFileChange(path, ctx = {}) {
  if (_disabled) {
    // Should not normally fire because we don't start a watcher when
    // disabled, but guard anyway.
    logReality("warn", "rail_token_change_while_disabled", { path });
    return { reloaded: false, reason: "disabled" };
  }

  let next;
  try {
    next = readTokenFromDisk(path);
  } catch (err) {
    // Read failed — keep the old token in memory rather than blanking it.
    // A bad rotation should not take the gateway down; the operator gets
    // an audit event and the gateway keeps honoring the previous token
    // until the next valid write.
    logReality("error", "rail_token_reload_read_failed", {
      tokenPath: path,
      error: err.message,
      currentFingerprint: _fingerprint,
    });
    return { reloaded: false, reason: "read_failed", error: err.message };
  }

  if (next === _token) {
    // chokidar can fire on mtime changes that don't change contents
    // (e.g. `touch`). Don't burn an audit row for a no-op.
    return { reloaded: false, reason: "no_change" };
  }

  const prevFingerprint = _fingerprint;
  const prevSha = _fullSha;
  const nextSha = sha256Hex(next);
  const nextFingerprint = nextSha.slice(0, 12);

  // Atomic swap of the in-memory reference. Node single-threaded model
  // guarantees no torn read for getToken() callers.
  _token = next;
  _fullSha = nextSha;
  _fingerprint = nextFingerprint;

  logReality("info", "rail_token_rotated", {
    tokenPath: path,
    source: ctx.source || "fs",
    priorFingerprint: prevFingerprint,
    priorSha256: prevSha,
    newFingerprint: nextFingerprint,
    newSha256: nextSha,
    mtime: safeMtime(path),
  });
  railTokenEvents.emit("rotated", {
    priorFingerprint: prevFingerprint,
    newFingerprint: nextFingerprint,
    priorSha256: prevSha,
    newSha256: nextSha,
  });

  return {
    reloaded: true,
    priorFingerprint: prevFingerprint,
    newFingerprint: nextFingerprint,
  };
}

function safeMtime(path) {
  try {
    return statSync(path).mtime.toISOString();
  } catch {
    return null;
  }
}

// Re-export the resolved watched directory for diagnostics (the rotation
// ceremony's smoke test prints this to confirm it wrote to the right path).
export function getWatchedTokenPath() {
  return _tokenPath;
}

export function getWatchedTokenDir() {
  return _tokenPath ? dirname(_tokenPath) : null;
}
