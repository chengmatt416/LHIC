#!/bin/sh
# Fetches the omp agent engine next to the alpha binaries, with the same
# fail-closed trust verification as CI.
#
# This script delegates to scripts/acquire-omp.sh, which uses the committed
# trust root (.omp-trust/manifest.json) as the single authoritative source:
#   1. resolve expected artifact name + exact SHA-256 from the manifest
#   2. download or reuse a verified cache
#   3. verify SHA-256 BEFORE executing anything
#   4. only then run --version and require exact equality
#
# Usage:
#   sh alpha-dist/fetch-omp.sh <platform-target> [output-dir]
#     platform-target: linux-x64 | linux-arm64 | darwin-x64 | darwin-arm64 |
#                      windows-x64 | linux-musl-x64 | linux-musl-arm64
#     output-dir: default alpha-dist/<platform-target>
#
# Env:
#   OMP_VERSION  pinned engine version (default 17.2.15)
set -eu

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="${1:-linux-arm64}"
OUT_DIR="${2:-$(dirname "$0")/$TARGET}"

mkdir -p "$OUT_DIR"

# Single authoritative acquisition/verification path (same as CI).
"$REPO_ROOT/scripts/acquire-omp.sh" "$TARGET" "$OUT_DIR/omp"

echo "bundled omp (verified) at $OUT_DIR/omp"
