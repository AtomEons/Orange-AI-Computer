#!/usr/bin/env sh
set -eu

node /orange5/06-ORANGELLM/server/smart-skinny-adapter.mjs &
SKINNY_PID="$!"

cleanup() {
  kill "$SKINNY_PID" 2>/dev/null || true
}
trap cleanup INT TERM EXIT

node /orange5/06-ORANGELLM/server/index.mjs
