#!/usr/bin/env bash
# Ubuntu post-test cleanup script for Atomic Chat.

set -euo pipefail

is_nightly=false
confirmed=false
for argument in "$@"; do
  case "$argument" in
    true|false) is_nightly="$argument" ;;
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

targets=(
  "$home_root/.config/Jan"
  "$home_root/.config/Jan-nightly"
  "$home_root/.local/share/Jan"
  "$home_root/.local/share/Jan-nightly"
  "$home_root/.cache/jan"
  "$home_root/.cache/jan-nightly"
  "$home_root/.local/share/jan-nightly.ai.app"
  "$home_root/.local/share/jan.ai.app"
  "/tmp/jan-installer.deb"
)

assert_allowed_target() {
  local target="$1"
  case "$target" in
    "$home_root/.config/Jan"|"$home_root/.config/Jan-nightly") ;;
    "$home_root/.local/share/Jan"|"$home_root/.local/share/Jan-nightly") ;;
    "$home_root/.cache/jan"|"$home_root/.cache/jan-nightly") ;;
    "$home_root/.local/share/jan.ai.app"|"$home_root/.local/share/jan-nightly.ai.app") ;;
    /tmp/jan-installer.deb) ;;
    *) echo "Refusing cleanup outside the allowlist: $target" >&2; exit 1 ;;
  esac
}

for target in "${targets[@]}"; do
  assert_allowed_target "$target"
done

if [[ "$is_nightly" == true ]]; then
  package_name="jan-nightly"
else
  package_name="jan"
fi
case "$package_name" in
  jan|jan-nightly) ;;
  *) echo "Refusing cleanup of unexpected package: $package_name" >&2; exit 1 ;;
esac

if [[ "$confirmed" != true ]]; then
  echo "[DRY-RUN] Pass --confirm-destruction to execute this cleanup."
  for process_name in Jan jan Jan-nightly jan-nightly; do
    echo "[DRY-RUN] Would stop exact process: $process_name"
  done
  for target in "${targets[@]}"; do
    echo "[DRY-RUN] Would remove: $target"
  done
  echo "[DRY-RUN] Would uninstall package if present: $package_name"
  exit 0
fi

for process_name in Jan jan Jan-nightly jan-nightly; do
  pkill -x "$process_name" 2>/dev/null || true
done
for target in "${targets[@]}"; do
  rm -rf -- "$target"
done

if dpkg-query -W -f='${Status}' "$package_name" 2>/dev/null | grep -q '^install ok installed$'; then
  sudo dpkg -r "$package_name"
fi

echo "Atomic Chat post-test cleanup completed"
