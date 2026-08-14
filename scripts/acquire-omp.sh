#!/bin/sh
# Acquire and verify the pinned omp engine for CI (fail-closed).
#
# Trust chain:
#   committed manifest (.omp-trust/manifest.json, official v17.2.15 SHA-256)
#   -> select platform/arch artifact
#   -> download from the official upstream release
#   -> verify SHA-256 against the manifest (independent of the binary)
#   -> verify exact engine version string
#   -> only then write the verified binary to the output path
#
# Never self-attest: the expected digest comes from the committed manifest,
# never from the downloaded file.
#
# Usage:
#   scripts/acquire-omp.sh <platform-target> <output-path>
#     platform-target: linux-x64 | linux-arm64 | linux-musl-x64 |
#                      linux-musl-arm64 | darwin-x64 | darwin-arm64 |
#                      windows-x64
#
# Env:
#   OMP_VERSION      pinned engine version (default 17.2.15)
#   OMP_MANIFEST     path to the trust manifest (default .omp-trust/manifest.json)
#   OMP_DOWNLOAD_URL base URL for artifacts (default official GitHub release)
#   OMP_CACHE_DIR    optional verified cache directory (re-verified before use)
set -eu

TARGET="${1:?platform-target required (e.g. linux-x64)}"
OUT="${2:?output path required}"
OMP_VERSION="${OMP_VERSION:-17.2.15}"
MANIFEST="${OMP_MANIFEST:-.omp-trust/manifest.json}"
RELEASE_BASE="${OMP_DOWNLOAD_URL:-https://github.com/can1357/oh-my-pi/releases/download/v${OMP_VERSION}}"

[ -f "$MANIFEST" ] || {
  echo "error: trust manifest missing: $MANIFEST" >&2
  exit 1
}

# Parse the manifest without jq: extract asset name + sha256 for the target.
ASSET="$(python3 -c "
import json, sys
m = json.load(open('$MANIFEST'))
a = m.get('artifacts', {}).get('$TARGET')
if not a:
    sys.stderr.write('error: unsupported platform/arch target: $TARGET\n')
    sys.exit(2)
if m.get('version') != '$OMP_VERSION':
    sys.stderr.write('error: manifest version mismatch: %s != %s\n' % (m.get('version'), '$OMP_VERSION'))
    sys.exit(2)
print(a['assetName'])
")" || exit $?
EXPECTED_SHA="$(python3 -c "
import json, sys
m = json.load(open('$MANIFEST'))
print(m['artifacts']['$TARGET']['assetSha256'])
")"

echo "[omp] acquiring $TARGET (asset: $ASSET, version $OMP_VERSION)"

if command -v curl >/dev/null 2>&1; then
  FETCH="curl -fsSL"
else
  echo "error: curl is required" >&2
  exit 1
fi

# Optional verified cache: reuse only after re-verifying the digest.
if [ -n "${OMP_CACHE_DIR:-}" ] && [ -f "$OMP_CACHE_DIR/$ASSET" ]; then
  ACTUAL_SHA="$(sha256sum "$OMP_CACHE_DIR/$ASSET" | cut -d' ' -f1)"
  if [ "$ACTUAL_SHA" = "$EXPECTED_SHA" ]; then
    echo "[omp] verified cache hit: $ASSET"
    cp "$OMP_CACHE_DIR/$ASSET" "$OUT"
  else
    echo "error: cached $ASSET failed verification (cache is not trusted)" >&2
    exit 1
  fi
else
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  echo "[omp] downloading $RELEASE_BASE/$ASSET"
  $FETCH "$RELEASE_BASE/$ASSET" -o "$TMP/$ASSET"
  ACTUAL_SHA="$(sha256sum "$TMP/$ASSET" | cut -d' ' -f1)"
  if [ "$ACTUAL_SHA" != "$EXPECTED_SHA" ]; then
    echo "error: SHA-256 mismatch for $ASSET" >&2
    echo "  expected: $EXPECTED_SHA" >&2
    echo "  actual:   $ACTUAL_SHA" >&2
    exit 1
  fi
  echo "[omp] SHA-256 verified: $ACTUAL_SHA"
  cp "$TMP/$ASSET" "$OUT"
fi

chmod +x "$OUT" 2>/dev/null || true

# Exact version verification: the binary must print exactly omp/<version>
# (after trimming whitespace). Loose substring matching is rejected so that
# "omp/17.2.15-evil" or "omp/17.2.150" never pass.
VERSION_OUT="$("$OUT" --version 2>&1 | tr -d '\r\n' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
if [ "$VERSION_OUT" != "omp/${OMP_VERSION}" ]; then
  echo "error: engine version mismatch: expected exactly 'omp/$OMP_VERSION', got: '$VERSION_OUT'" >&2
  exit 1
fi
echo "[omp] verified engine: $VERSION_OUT"
echo "[omp] verified binary ready at: $OUT"
