#!/bin/sh
set -eu

# keep the sandbox runtime and dependency graph reproducible without changing global installations
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"
VERSION=1.4.4
case "$(uname -s):$(uname -m)" in
  Linux:x86_64) TARGET=bun-linux-x64 ;;
  Linux:aarch64|Linux:arm64) TARGET=bun-linux-aarch64 ;;
  *) printf '%s\n' 'Setup supports Linux x86_64 and aarch64 only' >&2; exit 1 ;;
esac
BUN="$ROOT/.tools/$TARGET/bun"
if [ ! -x "$BUN" ] || [ "$("$BUN" --version)" != "$VERSION" ]; then
  command -v curl >/dev/null 2>&1 || { echo 'curl is required for Bun installation' >&2; exit 1; }
  command -v unzip >/dev/null 2>&1 || { echo 'unzip is required for Bun installation' >&2; exit 1; }
  mkdir -p "$ROOT/.tools"
  TEMP=$(mktemp -d "$ROOT/.tools/bun-install.XXXXXX")
  trap 'rm -rf "$TEMP"' EXIT HUP INT TERM
  curl --fail --location --silent --show-error \
    "https://github.com/oven-sh/bun/releases/download/bun-v$VERSION/$TARGET.zip" \
    --output "$TEMP/bun.zip"
  unzip -q "$TEMP/bun.zip" -d "$TEMP"
  test "$("$TEMP/$TARGET/bun" --version)" = "$VERSION"
  mkdir -p "$ROOT/.tools/$TARGET"
  cp "$TEMP/$TARGET/bun" "$BUN"
  chmod +x "$BUN"
fi
export PATH="$(dirname "$BUN"):$PATH"
"$BUN" install --frozen-lockfile
printf 'Bun %s ready; add %s to PATH for subsequent commands\n' "$VERSION" "$(dirname "$BUN")"
