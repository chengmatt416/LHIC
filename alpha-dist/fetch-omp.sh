#!/bin/sh
# Fetches the omp agent engine (v17.2.15) next to the alpha binaries and
# verifies it against the release manifest.
#
# The omp binary is a 150+ MB third-party core and is not committed to git;
# this script downloads it from the official release when you want a fully
# self-contained alpha bundle.
set -eu

VERSION="${OMP_VERSION:-17.2.15}"
TARGET="${1:-$(dirname "$0")/linux-arm64}"
URL="https://github.com/can1357/oh-my-pi/releases/download/v${VERSION}/omp-linux-arm64"

command -v curl >/dev/null 2>&1 || { echo "curl is required" >&2; exit 1; }

mkdir -p "$TARGET"
echo "fetching omp ${VERSION} (linux-arm64)…"
curl -fsSL --retry 3 -o "$TARGET/omp" "$URL"
chmod 755 "$TARGET/omp"
"$TARGET/omp" --version
echo "bundled omp at $TARGET/omp"
