#!/bin/sh
# One-liner installer for the LHIC desktop app AND the LHIC CLI.
#
#   curl -fsSL https://lhic.techtools.qzz.io/install.sh | sh
#
# Installs both components per-user (no root required):
#   1. Desktop app (LHIC Control Center) — Linux AppImage / macOS app bundle.
#   2. CLI (lhic) — @pinyencheng/lhic via npm (Node.js 24+).
#
# When the desktop app is not supported on this platform/arch (or its install
# fails), a warning is printed and only the CLI is installed. Windows: use
# scripts/install.ps1 instead.
#
# Artifacts are downloaded from the lhic.techtools.qzz.io mirror and fall
# back to the GitHub release when the mirror is unreachable.
#
# Env overrides:
#   LHIC_DESKTOP_VERSION    release version (default 0.2.0)
#   LHIC_DESKTOP_BASE_URL   release download base URL (tests/mirrors)
#   LHIC_DESKTOP_PREFIX     Linux desktop install prefix (default $HOME/.local)
#   LHIC_SKIP_BACKENDS      set 1 to skip execution-layer package provisioning
#   LHIC_SKIP_DESKTOP       set 1 to skip the desktop app and install the CLI only
#   LHIC_SKIP_CLI           set 1 to skip the CLI and install the desktop only
set -eu

VERSION="${LHIC_DESKTOP_VERSION:-0.2.0}"
BASE_URL="${LHIC_DESKTOP_BASE_URL:-https://lhic.techtools.qzz.io/release}"
GITHUB_BASE_URL="https://github.com/chengmatt416/LHIC/releases/download/desktop-v${VERSION}"
CLI_PACKAGE="${LHIC_CLI_PACKAGE:-@pinyencheng/lhic}"
CLI_NODE_MAJOR=24

info() { printf '\033[1;32m[lhic]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[lhic] warning:\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[1;31m[lhic] error:\033[0m %s\n' "$*" >&2; exit 1; }

# Downloads $1 from the mirror $2, falling back to the GitHub release.
fetch() {
  curl -fsSL --retry 3 -o "$1" "$2" \
    || curl -fsSL --retry 3 -o "$1" "${GITHUB_BASE_URL}/${2##*/}" \
    || fail "download failed for ${2##*/} (mirror and GitHub)."
}

command -v curl >/dev/null 2>&1 || fail "curl is required (macOS/Linux ship it by default)."
if command -v sha256sum >/dev/null 2>&1; then
  sha256() { sha256sum "$1" | awk '{print $1}'; }
elif command -v shasum >/dev/null 2>&1; then
  sha256() { shasum -a 256 "$1" | awk '{print $1}'; }
else
  fail "neither sha256sum nor shasum is available."
fi

OS="$(uname -s)"
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64) ARCH="x64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *) ARCH="unsupported" ;;
esac

DESKTOP_OK=1
case "$OS" in
  Linux)
    DESKTOP_ASSET="lhic-control-center-linux-${VERSION}-${ARCH}.AppImage"
    ;;
  Darwin)
    DESKTOP_ASSET="lhic-control-center-mac-${VERSION}-${ARCH}.zip"
    ;;
  *)
    DESKTOP_ASSET=""
    DESKTOP_OK=0
    ;;
esac
if [ "$ARCH" = "unsupported" ]; then
  DESKTOP_ASSET=""
  DESKTOP_OK=0
fi

# ---- 1. Desktop app -------------------------------------------------------
if [ "${LHIC_SKIP_DESKTOP:-0}" = "1" ]; then
  warn "Desktop app skipped (LHIC_SKIP_DESKTOP=1)."
elif [ "$DESKTOP_OK" = "0" ] || [ -z "$DESKTOP_ASSET" ]; then
  warn "The LHIC desktop app is not supported on ${OS}/${ARCH} — installing the CLI only."
  info "Windows users: irm https://lhic.techtools.qzz.io/install.ps1 | iex"
  DESKTOP_OK=0
else
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT

  info "Downloading $DESKTOP_ASSET…"
  fetch "$TMP/$DESKTOP_ASSET" "${BASE_URL}/${DESKTOP_ASSET}"
  fetch "$TMP/SHA256SUMS" "${BASE_URL}/SHA256SUMS-${VERSION}.txt"

  EXPECTED="$(awk -v asset="$DESKTOP_ASSET" '$2 == asset { print $1; exit }' "$TMP/SHA256SUMS")"
  [ -n "${EXPECTED:-}" ] || fail "checksum manifest has no entry for $DESKTOP_ASSET."
  ACTUAL="$(sha256 "$TMP/$DESKTOP_ASSET")"
  if [ "$ACTUAL" != "$EXPECTED" ]; then
    warn "SHA-256 mismatch for $DESKTOP_ASSET (expected $EXPECTED, got $ACTUAL)."
    DESKTOP_OK=0
  elif [ "$OS" = "Darwin" ]; then
    APP_DIR="$HOME/Applications"
    mkdir -p "$APP_DIR"
    info "Extracting LHIC Control Center.app into $APP_DIR…"
    if unzip -o -q "$TMP/$DESKTOP_ASSET" -d "$TMP/extracted" && [ -d "$TMP/extracted/LHIC Control Center.app" ]; then
      rm -rf "$APP_DIR/LHIC Control Center.app"
      cp -R "$TMP/extracted/LHIC Control Center.app" "$APP_DIR/"
      info "Desktop app installed — launch with: open \"$APP_DIR/LHIC Control Center.app\""
    else
      warn "Desktop app extraction failed."
      DESKTOP_OK=0
    fi
  else
    PREFIX="${LHIC_DESKTOP_PREFIX:-$HOME/.local}"
    BIN_DIR="$PREFIX/bin"
    APP_DIR="$PREFIX/lib/lhic-control-center"
    mkdir -p "$BIN_DIR" "$APP_DIR"
    cp "$TMP/$DESKTOP_ASSET" "$APP_DIR/lhic-control-center.AppImage"
    chmod 755 "$APP_DIR/lhic-control-center.AppImage"

    # FUSE-less wrapper: extract-and-run when libfuse is absent (WSL, containers).
    cat > "$BIN_DIR/lhic-control-center" <<EOF
#!/bin/sh
if command -v ldconfig >/dev/null 2>&1 && ldconfig -p 2>/dev/null | grep -q 'libfuse\.so\.2'; then
  exec "$APP_DIR/lhic-control-center.AppImage" "\$@"
fi
exec "$APP_DIR/lhic-control-center.AppImage" --appimage-extract-and-run "\$@"
EOF
    chmod 755 "$BIN_DIR/lhic-control-center"

    mkdir -p "$HOME/.local/share/applications"
    cat > "$HOME/.local/share/applications/lhic-control-center.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=LHIC Control Center
Comment=Local Human Intent Controller — omp agent, browser and desktop control
Exec=$BIN_DIR/lhic-control-center
Icon=lhic-control-center
Terminal=false
Categories=Development;Utility;
StartupWMClass=lhic-control-center
EOF

    info "Desktop app installed to $APP_DIR."
    info "Binary: $BIN_DIR/lhic-control-center"
    if ! printf '%s' "$PATH" | tr ':' '\n' | grep -qx "$BIN_DIR"; then
      info "Add to your PATH: export PATH=\"\$HOME/.local/bin:\$PATH\""
    fi
    info "Launch with: lhic-control-center"

    # Execution-layer package provisioning (best-effort, non-fatal).
    if [ "${LHIC_SKIP_BACKENDS:-0}" = "1" ]; then
      info "Backend provisioning skipped (LHIC_SKIP_BACKENDS=1)."
    else
      if [ "$OS" = "Darwin" ]; then
        MAJOR="$(sw_vers -productVersion 2>/dev/null | cut -d. -f1 || true)"
        if ! command -v peekaboo >/dev/null 2>&1; then
          if [ "${MAJOR:-0}" -ge 15 ] 2>/dev/null; then
            if command -v brew >/dev/null 2>&1; then
              info "Installing Peekaboo (macOS 15+ element layer) via Homebrew…"
              brew install steipete/tap/peekaboo || warn "Peekaboo install failed; the traditional osascript layer is used."
            elif command -v npm >/dev/null 2>&1; then
              info "Installing Peekaboo via npm…"
              npm install --global @steipete/peekaboo || warn "Peekaboo install failed; the traditional osascript layer is used."
            else
              info "Peekaboo needs Homebrew or npm; install it manually (brew install steipete/tap/peekaboo)."
            fi
          else
            info "Peekaboo requires macOS 15+ (this is macOS ${MAJOR:-?}); using the traditional osascript layer."
          fi
        else
          info "Peekaboo already installed."
        fi
      fi
      if command -v python3 >/dev/null 2>&1 && ! python3 -c 'import omni_parser_v2' >/dev/null 2>&1; then
        info "Installing OmniParser V2 (DOM-invisible fallback)…"
        python3 -m pip install --user omni_parser_v2 >/dev/null 2>&1 \
          || python3 -m pip install --user --break-system-packages omni_parser_v2 >/dev/null 2>&1 \
          || warn "OmniParser V2 install failed; LHIC falls back to coordinates for DOM-invisible screens."
      fi
      if command -v npx >/dev/null 2>&1; then
        info "Installing Playwright Chromium (browser layer)…"
        npx --yes playwright install chromium >/dev/null 2>&1 \
          || warn "Chromium install failed; run \`npx playwright install chromium\` later."
      fi
      info "Provisioning done — everything still missing falls back to the traditional layer."
    fi
  fi
  rm -rf "$TMP"
  trap - EXIT
fi

# ---- 2. CLI -----------------------------------------------------------------
CLI_OK=1
if [ "${LHIC_SKIP_CLI:-0}" = "1" ]; then
  warn "CLI skipped (LHIC_SKIP_CLI=1)."
  CLI_OK=0
elif ! command -v node >/dev/null 2>&1; then
  warn "The LHIC CLI needs Node.js ${CLI_NODE_MAJOR}+. Install it, then run: npm install --global ${CLI_PACKAGE}"
  CLI_OK=0
else
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "$NODE_MAJOR" -lt "$CLI_NODE_MAJOR" ] 2>/dev/null; then
    warn "The LHIC CLI needs Node.js ${CLI_NODE_MAJOR}+ (this is Node ${NODE_MAJOR}). Install it, then run: npm install --global ${CLI_PACKAGE}"
    CLI_OK=0
  elif ! command -v npm >/dev/null 2>&1; then
    warn "npm is not available; install the LHIC CLI with: npm install --global ${CLI_PACKAGE}"
    CLI_OK=0
  else
    info "Installing the LHIC CLI (${CLI_PACKAGE})…"
    # --ignore-scripts: the published CLI bundles all of its dependencies, so
    # no lifecycle build is needed — this also avoids optional native rebuilds
    # (e.g. fsevents) on toolchains without a compiler toolchain.
    if npm install --global --ignore-scripts "${CLI_PACKAGE}" >/dev/null 2>&1 && command -v lhic >/dev/null 2>&1; then
      info "CLI installed — run: lhic"
    else
      warn "CLI install failed; install it manually with: npm install --global ${CLI_PACKAGE}"
      CLI_OK=0
    fi
  fi
fi

# ---- Summary ----------------------------------------------------------------
if [ "$DESKTOP_OK" = "0" ] && [ "$CLI_OK" = "0" ]; then
  fail "Neither the desktop app nor the CLI could be installed."
fi
if [ "$DESKTOP_OK" = "0" ]; then
  info "Only the CLI was installed — the desktop app is not supported on ${OS}/${ARCH}."
fi
info "Done. Desktop: lhic-control-center · CLI: lhic"
