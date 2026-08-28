#!/usr/bin/env bash
# stop.sh — graceful shutdown for Æ Cobra (used outside systemd, e.g. manual ops)
set -euo pipefail

BUN_PORT="${BUN_PORT:-7419}"
LLAMA_PORT="${LLAMA_PORT:-7418}"

echo "[AE-COBRA-STOP] flushing pending writes via /shutdown"
curl -s -X POST "http://127.0.0.1:$BUN_PORT/shutdown" --max-time 5 || true

echo "[AE-COBRA-STOP] sending TERM to remaining processes on :$BUN_PORT and :$LLAMA_PORT"
for port in "$BUN_PORT" "$LLAMA_PORT"; do
  pid=$(ss -tlnp 2>/dev/null | awk -v p=":$port" '$0 ~ p {print $0}' | grep -oP 'pid=\K[0-9]+' | head -1 || true)
  if [[ -n "$pid" ]]; then
    echo "[AE-COBRA-STOP]   port $port → PID $pid"
    kill -TERM "$pid" 2>/dev/null || true
  fi
done

sleep 2
echo "[AE-COBRA-STOP] done"
