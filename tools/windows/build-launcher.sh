#!/usr/bin/env bash
#
# build-launcher.sh -- build the native bingetovlc Windows protocol handler
# from tools/windows/launcher.c with the pinned Zig toolchain.
#
# No other compiler is needed: zig 0.13.0 is a full C cross-compiler and ships
# its own libc/mingw-w64, so the same source produces
#
#   1. a static x86_64 Windows PE32+ executable (the shipped handler), and
#   2. a native Linux executable, used to assert the decode + M3U path against
#      tests/fixtures/vectors.json (there is no Windows runner here, but the
#      serialiser is pure C behind #ifdef _WIN32-only Win32 code).
#
# Usage
#   tools/windows/build-launcher.sh
#   ZIG=/path/to/zig tools/windows/build-launcher.sh
#   OUT_LINUX=/tmp/my-launcher tools/windows/build-launcher.sh
#
# On success:
#   tools/windows/bingetovlc-handler.exe   PE32+ x86-64, statically linked
#   /tmp/launcher-linux                    native Linux build for --selftest

set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
ZIG=${ZIG:-/tmp/zig/zig}
SRC="$root/tools/windows/launcher.c"
OUT_EXE="$root/tools/windows/bingetovlc-handler.exe"
OUT_LINUX=${OUT_LINUX:-/tmp/launcher-linux}

if [ ! -x "$ZIG" ]; then
    echo "error: zig not found or not executable at '$ZIG' (set ZIG=/path/to/zig)" >&2
    exit 1
fi
if [ ! -f "$SRC" ]; then
    echo "error: source not found: $SRC" >&2
    exit 1
fi

# The version the handler reports, taken from package.json so a bug report cannot
# name a version the project never released.
VERSION=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$root/package.json" | head -1)
VERSION=${VERSION:-0.0.0-dev}

echo "zig : $("$ZIG" version) ($ZIG)"
echo "src : $SRC"
echo "ver : $VERSION"

# 1) Windows PE32+ x86-64. -static so it has no MSVCRT runtime dependency beyond
#    what mingw-w64 bundles, -s to strip symbols. This is the handler that is
#    registered in HKCU\Software\Classes\{vlc,bingetovlc}\shell\open\command.
"$ZIG" cc -target x86_64-windows-gnu -static -Os -s \
    -DHANDLER_VERSION="\"$VERSION\"" \
    -o "$OUT_EXE" "$SRC"

# 2) Native Linux build of the same source, for the byte-exactness selftest.
"$ZIG" cc -DLAUNCHER_PORTABLE_TEST -Os \
    -DHANDLER_VERSION="\"$VERSION\"" \
    -o "$OUT_LINUX" "$SRC"

echo
echo "windows : $OUT_EXE ($(stat -c%s "$OUT_EXE") bytes)"
file "$OUT_EXE" || true
echo "linux   : $OUT_LINUX ($(stat -c%s "$OUT_LINUX") bytes)"
file "$OUT_LINUX" || true
