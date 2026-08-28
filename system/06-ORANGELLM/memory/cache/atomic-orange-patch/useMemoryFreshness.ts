// useMemoryFreshness.ts
// Atomic Orange patch — Cockpit memory-freshness React hook.
//
// Polls GET /v1/memory/healthz on the OrangeLLM gateway (127.0.0.1:1337) every
// 10 seconds and returns a normalized freshness state. The gateway is the
// single read surface for memory health; it transparently reads Æ Cobra
// (127.0.0.1:7419) when the Codexa command rail (10.0.99.1:8097) is up, and
// falls back to the N150 cockpit shadow cache at
// 06-ORANGELLM/memory/cache/ when the rail is unreachable. The hook does not
// know which path served it — it only consumes the gateway's `source` field.
//
// Status semantics (Mirage doctrine: Reality > Thought, receipts > recollection):
//   - 'live'   : Codexa rail reachable, last_sync_at < 60s ago
//   - 'shadow' : N150 shadow cache serving, last_sync_at < 1h ago
//   - 'stale'  : last_sync_at >= 1h ago (any source)
//   - 'down'   : gateway unreachable or returned a non-2xx
//
// Contract (gateway response shape, /v1/memory/healthz):
//   {
//     "ok": boolean,
//     "last_sync_at": "2026-06-24T17:50:11Z" | null,
//     "source": "codexa" | "shadow" | "unknown",
//     "cobra_reachable": boolean,
//     "rail_reachable": boolean
//   }

import { useEffect, useRef, useState } from 'react';

export type MemoryFreshnessStatus = 'live' | 'shadow' | 'stale' | 'down';
export type MemoryFreshnessSource = 'codexa' | 'shadow' | 'unknown';

export interface MemoryFreshnessState {
  status: MemoryFreshnessStatus;
  last_sync_at: string | null;
  source: MemoryFreshnessSource;
  /** Milliseconds since last_sync_at. null when unknown. */
  age_ms: number | null;
  /** Last successful poll wall-clock time (cockpit-local). */
  fetched_at: string | null;
}

export interface UseMemoryFreshnessOptions {
  /** Override the gateway base URL. Defaults to http://127.0.0.1:1337. */
  gatewayUrl?: string;
  /** Poll interval in ms. Default 10_000. */
  intervalMs?: number;
  /** Per-request fetch timeout in ms. Default 3_000. */
  timeoutMs?: number;
}

interface HealthzResponse {
  ok?: boolean;
  last_sync_at?: string | null;
  source?: MemoryFreshnessSource;
  cobra_reachable?: boolean;
  rail_reachable?: boolean;
}

const ONE_MINUTE_MS = 60_000;
const ONE_HOUR_MS = 60 * ONE_MINUTE_MS;

const DEFAULT_GATEWAY = 'http://127.0.0.1:1337';
const DEFAULT_INTERVAL_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 3_000;

const DOWN_STATE: MemoryFreshnessState = {
  status: 'down',
  last_sync_at: null,
  source: 'unknown',
  age_ms: null,
  fetched_at: null,
};

function classify(
  payload: HealthzResponse,
  now: number,
): MemoryFreshnessState {
  const source: MemoryFreshnessSource = payload.source ?? 'unknown';
  const last = payload.last_sync_at ?? null;

  if (payload.ok === false) {
    return { ...DOWN_STATE, source, last_sync_at: last };
  }

  let age_ms: number | null = null;
  if (last) {
    const parsed = Date.parse(last);
    if (!Number.isNaN(parsed)) {
      age_ms = Math.max(0, now - parsed);
    }
  }

  let status: MemoryFreshnessStatus;
  if (age_ms === null) {
    // No timestamp from gateway — treat as stale rather than fabricate live.
    status = 'stale';
  } else if (age_ms >= ONE_HOUR_MS) {
    status = 'stale';
  } else if (source === 'shadow') {
    status = 'shadow';
  } else if (source === 'codexa' && age_ms < ONE_MINUTE_MS) {
    status = 'live';
  } else if (source === 'codexa') {
    // Codexa reachable but stale-ish (>1m, <1h) — surface as shadow-grade
    // freshness so the operator sees the lag honestly.
    status = 'shadow';
  } else {
    status = 'stale';
  }

  return {
    status,
    last_sync_at: last,
    source,
    age_ms,
    fetched_at: new Date(now).toISOString(),
  };
}

export function useMemoryFreshness(
  options: UseMemoryFreshnessOptions = {},
): MemoryFreshnessState {
  const {
    gatewayUrl = DEFAULT_GATEWAY,
    intervalMs = DEFAULT_INTERVAL_MS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options;

  const [state, setState] = useState<MemoryFreshnessState>(DOWN_STATE);
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;
    const url = `${gatewayUrl.replace(/\/$/, '')}/v1/memory/healthz`;

    const poll = async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(url, {
          method: 'GET',
          signal: controller.signal,
          headers: { accept: 'application/json' },
          cache: 'no-store',
        });
        if (!res.ok) {
          if (!cancelledRef.current) setState(DOWN_STATE);
          return;
        }
        const payload = (await res.json()) as HealthzResponse;
        if (cancelledRef.current) return;
        setState(classify(payload, Date.now()));
      } catch {
        if (!cancelledRef.current) setState(DOWN_STATE);
      } finally {
        clearTimeout(timer);
      }
    };

    // Fire immediately so the chip doesn't flash 'DOWN' on mount.
    void poll();
    const handle = setInterval(poll, intervalMs);

    return () => {
      cancelledRef.current = true;
      clearInterval(handle);
    };
  }, [gatewayUrl, intervalMs, timeoutMs]);

  return state;
}

export default useMemoryFreshness;
