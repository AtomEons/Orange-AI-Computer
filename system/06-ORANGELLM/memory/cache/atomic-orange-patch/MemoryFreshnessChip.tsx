// MemoryFreshnessChip.tsx
// Atomic Orange patch — small Cockpit chip that surfaces memory-plane freshness.
//
// Renders one of four states using the Atom Standard palette:
//   - LIVE                 green dot   (--green)   source=codexa, age<60s
//   - SHADOW (Nm ago)      amber dot   (--amber)   source=shadow OR codexa-with-lag, age<1h
//   - STALE (Nh ago)       red dot     (--red)     age>=1h
//   - DOWN                 red X       (--red)     gateway unreachable
//
// Splice next to the existing SYNC indicator slot in ChromeBar.tsx. See README.

import React from 'react';
import {
  useMemoryFreshness,
  type MemoryFreshnessState,
  type UseMemoryFreshnessOptions,
} from './useMemoryFreshness';

export interface MemoryFreshnessChipProps extends UseMemoryFreshnessOptions {
  /** Optional className for layout (e.g. spacing in ChromeBar). */
  className?: string;
  /** Click handler — wire to opening the Mirage memory diagnostics panel. */
  onClick?: (state: MemoryFreshnessState) => void;
}

function formatAge(age_ms: number | null): string {
  if (age_ms === null || age_ms < 0) return '—';
  const seconds = Math.floor(age_ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function labelFor(state: MemoryFreshnessState): string {
  switch (state.status) {
    case 'live':
      return 'LIVE';
    case 'shadow':
      return `SHADOW (${formatAge(state.age_ms)} ago)`;
    case 'stale':
      return `STALE (${formatAge(state.age_ms)} ago)`;
    case 'down':
    default:
      return 'DOWN';
  }
}

function titleFor(state: MemoryFreshnessState): string {
  const parts: string[] = [];
  parts.push(`Mirage memory: ${state.status.toUpperCase()}`);
  parts.push(`source: ${state.source}`);
  if (state.last_sync_at) parts.push(`last sync: ${state.last_sync_at}`);
  if (state.fetched_at) parts.push(`polled: ${state.fetched_at}`);
  return parts.join(' · ');
}

const baseStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '2px 8px',
  borderRadius: 999,
  border: '1px solid var(--chrome-border, rgba(255,255,255,0.08))',
  background: 'var(--chrome-chip-bg, rgba(255,255,255,0.04))',
  fontFamily:
    'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
  fontSize: 11,
  letterSpacing: 0.4,
  lineHeight: '16px',
  color: 'var(--chrome-fg, rgba(255,255,255,0.85))',
  cursor: 'default',
  userSelect: 'none',
  whiteSpace: 'nowrap',
};

const dotBase: React.CSSProperties = {
  width: 8,
  height: 8,
  borderRadius: '50%',
  display: 'inline-block',
  flex: '0 0 auto',
};

function Indicator({ state }: { state: MemoryFreshnessState }) {
  switch (state.status) {
    case 'live':
      return (
        <span
          aria-hidden="true"
          style={{
            ...dotBase,
            background: 'var(--green, #2ecc71)',
            boxShadow: '0 0 6px var(--green, #2ecc71)',
          }}
        />
      );
    case 'shadow':
      return (
        <span
          aria-hidden="true"
          style={{
            ...dotBase,
            background: 'var(--amber, #f5a623)',
            boxShadow: '0 0 6px var(--amber, #f5a623)',
          }}
        />
      );
    case 'stale':
      return (
        <span
          aria-hidden="true"
          style={{
            ...dotBase,
            background: 'var(--red, #e74c3c)',
          }}
        />
      );
    case 'down':
    default:
      return (
        <span
          aria-hidden="true"
          aria-label="down"
          style={{
            width: 10,
            height: 10,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--red, #e74c3c)',
            fontWeight: 700,
            lineHeight: 1,
            flex: '0 0 auto',
          }}
        >
          {'✕'}
        </span>
      );
  }
}

export function MemoryFreshnessChip(props: MemoryFreshnessChipProps) {
  const { className, onClick, gatewayUrl, intervalMs, timeoutMs } = props;
  const state = useMemoryFreshness({ gatewayUrl, intervalMs, timeoutMs });

  const interactive = typeof onClick === 'function';
  const style: React.CSSProperties = interactive
    ? { ...baseStyle, cursor: 'pointer' }
    : baseStyle;

  return (
    <div
      className={className}
      role={interactive ? 'button' : 'status'}
      tabIndex={interactive ? 0 : -1}
      aria-live="polite"
      aria-label={`Memory plane ${state.status}`}
      title={titleFor(state)}
      style={style}
      onClick={interactive ? () => onClick!(state) : undefined}
      onKeyDown={
        interactive
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onClick!(state);
              }
            }
          : undefined
      }
      data-mirage-status={state.status}
      data-mirage-source={state.source}
    >
      <Indicator state={state} />
      <span>{labelFor(state)}</span>
    </div>
  );
}

export default MemoryFreshnessChip;
