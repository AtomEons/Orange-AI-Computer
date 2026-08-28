#!/usr/bin/env bash
# start.sh — Æ Cobra Night-1 entry. Boots llama.cpp + Bun Flow Direct.
# Runs under systemd (ae-cobra.service) on Codexa WSL2.

set -euo pipefail

# Paths
ROOT="${AE_COBRA_ROOT:-/opt/atomeons/ae-cobra}"
MODEL="${AE_COBRA_MODEL:-${ROOT}/models/ae-blackmamba-2.8b-Q5_K_M.gguf}"
GRAMMAR="${ROOT}/grammar/agent_turn.gbnf"
FLUX_ROOT="${AE_FLUX_ROOT:-/mnt/ae_flux}"
LLAMA_BIN="${LLAMA_BIN:-/opt/atomeons/llama.cpp/build/bin/llama-server}"
LLAMA_PORT="${LLAMA_PORT:-7418}"
BUN_PORT="${BUN_PORT:-7419}"

# Pre-flight checks
[[ -f "$MODEL" ]]    || { echo "FATAL: model not found at $MODEL"; exit 1; }
[[ -f "$GRAMMAR" ]]  || { echo "FATAL: grammar not found at $GRAMMAR"; exit 1; }
[[ -d "$FLUX_ROOT" ]] || { echo "FATAL: flux mount missing at $FLUX_ROOT"; exit 1; }
[[ -x "$LLAMA_BIN" ]] || { echo "FATAL: llama-server not executable at $LLAMA_BIN"; exit 1; }
command -v bun >/dev/null || { echo "FATAL: bun not on PATH"; exit 1; }

# Ensure lane directories exist
mkdir -p "$FLUX_ROOT/events/reality" "$FLUX_ROOT/events/thought" "$FLUX_ROOT/events/merge" \
         "$FLUX_ROOT/state" "$FLUX_ROOT/logs"

echo "[AE-COBRA] starting llama.cpp ($MODEL, port $LLAMA_PORT, mlock + no-mmap + grammar)"

# Launch llama.cpp in background with mlock-pinned weights
"$LLAMA_BIN" \
  --model "$MODEL" \
  --host 127.0.0.1 --port "$LLAMA_PORT" \
  --mlock \
  --no-mmap \
  --ctx-size 2048 \
  --grammar-file "$GRAMMAR" \
  --threads "$(nproc)" \
  --log-disable \
  > "$FLUX_ROOT/logs/llama-server.log" 2>&1 &

LLAMA_PID=$!
echo "[AE-COBRA] llama-server PID=$LLAMA_PID"

# Trap to clean up child
trap "echo '[AE-COBRA] shutting down'; kill -TERM $LLAMA_PID 2>/dev/null || true; wait $LLAMA_PID 2>/dev/null || true; exit 0" SIGTERM SIGINT

# Wait for llama-server to be reachable (max 30s)
for i in {1..30}; do
  if curl -s -o /dev/null --max-time 1 "http://127.0.0.1:$LLAMA_PORT/health"; then
    echo "[AE-COBRA] llama-server up after ${i}s"
    break
  fi
  if ! kill -0 "$LLAMA_PID" 2>/dev/null; then
    echo "[AE-COBRA] FATAL: llama-server died during startup. See $FLUX_ROOT/logs/llama-server.log"
    exit 1
  fi
  sleep 1
done

echo "[AE-COBRA] launching Bun Flow Direct on 127.0.0.1:$BUN_PORT"

export AE_COBRA_LLAMA_URL="http://127.0.0.1:$LLAMA_PORT"
export AE_COBRA_FLUX_ROOT="$FLUX_ROOT"
export AE_COBRA_BUN_PORT="$BUN_PORT"
export AE_COBRA_LLAMA_PID="$LLAMA_PID"

# Bun runs in foreground; systemd watches this PID
exec bun "$ROOT/flow-direct/server.mjs"
