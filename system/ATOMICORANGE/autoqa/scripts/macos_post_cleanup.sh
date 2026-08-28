#!/usr/bin/env bash
# macOS post-test cleanup script for Atomic Chat.

set -euo pipefail

confirmed=false
for argument in "$@"; do
  case "$argument" in
    --confirm-destruction) confirmed=true ;;
    --dry-run) ;;
    *) echo "Unknown argument: $argument" >&2; exit 64 ;;
  esac
done

if [[ -z "${HOME:-}" || "$HOME" != /* || "$HOME" == "/" ]]; then
  echo "Refusing cleanup: HOME must be an absolute non-root directory." >&2
  exit 1
fi

home_root="$(cd -P -- "$HOME" 2>/dev/null && pwd)" || {
  echo "Refusing cleanup: HOME cannot be resolved." >&2
  exit 1
}
if [[ "$home_root" == "/" ]]; then
  echo "Refusing cleanup: HOME resolved to the filesystem root." >&2
  exit 1
fi

assert_allowed_target() {
  local target="$1"
  case "$target" in
    /Applications/Jan.app|/Applications/Jan-nightly.app) ;;
    "$home_root/Applications/Jan.app"|"$home_root/Applications/Jan-nightly.app") ;;
    "$home_root/Library/Application Support/Jan"|"$home_root/Library/Application Support/Jan-nightly") ;;
    "$home_root/Library/Application Support/jan.ai.app"|"$home_root/Library/Application Support/jan-nightly.ai.app") ;;
    "$home_root/Library/Preferences"/jan.*|"$home_root/Library/Preferences"/jan-nightly.*) ;;
    "$home_root/Library/Caches"/jan.*|"$home_root/Library/Caches"/jan-nightly.*) ;;
    "$home_root/Library/Caches/jan.ai.app"|"$home_root/Library/Caches/jan-nightly.ai.app") ;;
    "$home_root/Library/WebKit/jan.ai.app"|"$home_root/Library/WebKit/jan-nightly.ai.app") ;;
    "$home_root/Library/Saved Application State/jan.ai.app"|"$home_root/Library/Saved Application State/jan-nightly.ai.app") ;;
    /tmp/jan-installer.dmg|/tmp/jan-mount) ;;
    *) echo "Refusing cleanup outside the allowlist: $target" >&2; exit 1 ;;
  esac
}

shopt -s nullglob
targets=(
  "/Applications/Jan.app"
  "/Applications/Jan-nightly.app"
  "$home_root/Applications/Jan.app"
  "$home_root/Applications/Jan-nightly.app"
  "$home_root/Library/Application Support/Jan"
  "$home_root/Library/Application Support/Jan-nightly"
  "$home_root/Library/Application Support/jan.ai.app"
  "$home_root/Library/Application Support/jan-nightly.ai.app"
  "$home_root/Library/Caches/jan.ai.app"
  "$home_root/Library/Caches/jan-nightly.ai.app"
  "$home_root/Library/WebKit/jan.ai.app"
  "$home_root/Library/WebKit/jan-nightly.ai.app"
  "$home_root/Library/Saved Application State/jan.ai.app"
  "$home_root/Library/Saved Application State/jan-nightly.ai.app"
  "/tmp/jan-installer.dmg"
  "/tmp/jan-mount"
)
targets+=("$home_root/Library/Preferences"/jan.*)
targets+=("$home_root/Library/Preferences"/jan-nightly.*)
targets+=("$home_root/Library/Caches"/jan.*)
targets+=("$home_root/Library/Caches"/jan-nightly.*)

for target in "${targets[@]}"; do
  assert_allowed_target "$target"
done

if [[ "$confirmed" != true ]]; then
  echo "[DRY-RUN] Pass --confirm-destruction to execute this cleanup."
  for process_name in Jan jan Jan-nightly jan-nightly; do
    echo "[DRY-RUN] Would stop exact process: $process_name"
  done
  for target in "${targets[@]}"; do
    echo "[DRY-RUN] Would remove: $target"
  done
  exit 0
fi

for process_name in Jan jan Jan-nightly jan-nightly; do
  pkill -x "$process_name" 2>/dev/null || true
done
for target in "${targets[@]}"; do
  rm -rf -- "$target"
done

echo "Atomic Chat post-test cleanup completed"
