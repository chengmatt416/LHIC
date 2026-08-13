#!/bin/sh
# One-liner installer for the LHIC desktop app AND the LHIC CLI.
#
#   curl -fsSL https://github.com/chengmatt416/LHIC/releases/latest/download/install.sh | sh
#
# Installs both components per-user (no root required):
#   1. Desktop app (LHIC Control Center) — Linux AppImage / macOS app bundle.
#   2. CLI (lhic) — @pinyencheng/lhic via npm (Node.js 24+).
#
# Also:
#   - Auto-installs/upgrades Node.js 24+ when missing or too old.
#   - Installs `lhicd` (X11 launcher for Termux PRoot / WSL / remote X).
#   - Auto-chmods everything it creates and verifies executability.
#   - Provisions execution-layer packages (Peekaboo / OmniParser V2 /
#     Chromium) best-effort.
#
# When the desktop app is not supported on this platform/arch (or its install
# fails), a warning is printed and only the CLI is installed. Windows: use
# scripts/install.ps1 instead.
#
# Env overrides:
#   LHIC_DESKTOP_VERSION    release version (default 0.2.2)
#   LHIC_DESKTOP_BASE_URL   release download base URL (default the mirror)
#   LHIC_DESKTOP_PREFIX     install prefix (default $HOME/.local)
#   LHIC_SKIP_BACKENDS      set 1 to skip execution-layer package provisioning
#   LHIC_SKIP_NODE          set 1 to skip the automatic Node.js install
#   NODE_DIST_BASE_URL      Node.js tarball base URL (tests/mirrors)
#   LHIC_SKIP_DESKTOP       set 1 to install the CLI only
#   LHIC_SKIP_CLI           set 1 to install the desktop only
set -eu

VERSION="${LHIC_DESKTOP_VERSION:-0.2.2}"
BASE_URL="${LHIC_DESKTOP_BASE_URL:-https://lhic.techtools.qzz.io/release}"
GITHUB_BASE_URL="https://github.com/chengmatt416/LHIC/releases/download/desktop-v${VERSION}"
CLI_PACKAGE="${LHIC_CLI_PACKAGE:-@pinyencheng/lhic}"
CLI_PACKAGE_NAME="${LHIC_CLI_PACKAGE_NAME:-@pinyencheng/lhic}"
CLI_NODE_MAJOR=24
PLAYWRIGHT_VERSION=1.61.1
NODE_DIST_BASE_URL="${NODE_DIST_BASE_URL:-https://nodejs.org/dist}"
INSTALL_URL="${LHIC_INSTALL_URL:-https://github.com/chengmatt416/LHIC/releases/latest/download/install.sh}"
TERMUX_PROOT_PREFIX="${LHIC_TERMUX_PROOT_PREFIX:-/root/.local}"

info() { printf '\033[1;32m[lhic]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[lhic] warning:\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[1;31m[lhic] error:\033[0m %s\n' "$*" >&2; exit 1; }

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
PREFIX="${LHIC_DESKTOP_PREFIX:-$HOME/.local}"
BIN_DIR="$PREFIX/bin"
export PATH="$BIN_DIR:$PATH"
export NPM_CONFIG_PREFIX="${NPM_CONFIG_PREFIX:-$PREFIX}"
TERMUX_NATIVE=0
if [ "${LHIC_TERMUX_PROOT_BOOTSTRAP:-0}" != "1" ]; then
  if [ "${LHIC_TERMUX_NATIVE:-0}" = "1" ]; then
    TERMUX_NATIVE=1
  elif { [ -n "${TERMUX_VERSION:-}" ] \
         || uname -o 2>/dev/null | grep -qi android \
         || uname -r 2>/dev/null | grep -qiE 'android|termux'; } \
       && [ ! -x /lib/ld-linux-aarch64.so.1 ] \
       && [ ! -x /lib64/ld-linux-x86-64.so.2 ]; then
    TERMUX_NATIVE=1
  fi
fi

# Downloads $1 from the mirror $2, falling back to the GitHub release.
fetch() {
  curl -fsSL --retry 3 -o "$1" "$2" \
    || curl -fsSL --retry 3 -o "$1" "${GITHUB_BASE_URL}/${2##*/}" \
    || fail "download failed for ${2##*/} (mirror and GitHub)."
}

# Native Termux uses Android/Bionic. LHIC's Electron, Playwright, keyring, and
# ONNX runtimes are glibc builds, so install the complete product in Debian
# PRoot and expose native-Termux forwarding launchers.
install_termux_proot() {
  command -v pkg >/dev/null 2>&1 \
    || fail "native Termux requires the pkg command to install proot-distro."

  if ! command -v proot-distro >/dev/null 2>&1; then
    info "Installing proot-distro for the glibc runtime…"
    pkg install -y proot-distro \
      || fail "could not install proot-distro from the Termux repository."
  fi

  if [ "${LHIC_SKIP_DESKTOP:-0}" != "1" ]; then
    info "Installing the Termux:X11 companion packages…"
    pkg install -y x11-repo >/dev/null 2>&1 \
      && pkg install -y termux-x11-nightly >/dev/null 2>&1 \
      || warn "Termux:X11 package setup failed; the CLI will still work, but desktop launch needs Termux:X11."
  fi

  if ! proot-distro login debian --shared-tmp -- true >/dev/null 2>&1; then
    info "Installing the Debian PRoot distribution…"
    proot-distro install debian \
      || fail "could not install the Debian PRoot distribution."
  fi

  info "Installing LHIC inside Debian PRoot…"
  if ! proot-distro login debian --shared-tmp -- /usr/bin/env \
    "LHIC_TERMUX_PROOT_BOOTSTRAP=1" \
    "LHIC_DESKTOP_VERSION=$VERSION" \
    "LHIC_DESKTOP_BASE_URL=$BASE_URL" \
    "LHIC_DESKTOP_PREFIX=$TERMUX_PROOT_PREFIX" \
    "LHIC_SKIP_BACKENDS=${LHIC_SKIP_BACKENDS:-0}" \
    "LHIC_SKIP_NODE=${LHIC_SKIP_NODE:-0}" \
    "LHIC_SKIP_DESKTOP=${LHIC_SKIP_DESKTOP:-0}" \
    "LHIC_SKIP_CLI=${LHIC_SKIP_CLI:-0}" \
    "LHIC_CLI_PACKAGE=$CLI_PACKAGE" \
    "LHIC_CLI_PACKAGE_NAME=$CLI_PACKAGE_NAME" \
    "NODE_DIST_BASE_URL=$NODE_DIST_BASE_URL" \
    "LHIC_INSTALL_URL=$INSTALL_URL" \
    /bin/sh -c '
      set -eu
      if [ "${LHIC_SKIP_DESKTOP:-0}" != "1" ] \
         || ! command -v curl >/dev/null 2>&1 \
         || ! command -v xz >/dev/null 2>&1; then
        export DEBIAN_FRONTEND=noninteractive
        apt-get update
      fi
      if ! command -v curl >/dev/null 2>&1 || ! command -v xz >/dev/null 2>&1; then
        apt-get install -y curl ca-certificates xz-utils
      fi
      if [ "${LHIC_SKIP_DESKTOP:-0}" != "1" ]; then
        first_package() {
          for candidate in "$@"; do
            if apt-cache show "$candidate" 2>/dev/null | grep -q "^Package:"; then
              printf "%s\n" "$candidate"
              return 0
            fi
          done
          return 1
        }
        gtk_package="$(first_package libgtk-3-0 libgtk-3-0t64)" \
          || { echo "[lhic] no compatible GTK 3 runtime package was found." >&2; exit 1; }
        atspi_package="$(first_package libatspi2.0-0 libatspi2.0-0t64)" \
          || { echo "[lhic] no compatible AT-SPI runtime package was found." >&2; exit 1; }
        alsa_package="$(first_package libasound2 libasound2t64)" \
          || { echo "[lhic] no compatible ALSA runtime package was found." >&2; exit 1; }
        cups_package="$(first_package libcups2 libcups2t64)" \
          || { echo "[lhic] no compatible CUPS runtime package was found." >&2; exit 1; }
        apt-get install -y \
          "$gtk_package" "$atspi_package" "$alsa_package" "$cups_package" \
          libnotify4 libnss3 libxss1 libxtst6 libgbm1 libdrm2 \
          libxkbcommon0 libuuid1 libsecret-1-0 xdg-utils
      fi
      curl -fsSL --retry 3 "$LHIC_INSTALL_URL" | /bin/sh
    '; then
    fail "LHIC installation inside Debian PRoot failed."
  fi

  mkdir -p "$BIN_DIR"
  if proot-distro login debian --shared-tmp -- test -x "$TERMUX_PROOT_PREFIX/bin/lhic" >/dev/null 2>&1; then
    cat > "$BIN_DIR/lhic" <<EOF
#!/bin/sh
exec proot-distro login debian --shared-tmp -- /usr/bin/env DISPLAY="\${DISPLAY:-:1}" GDK_BACKEND="\${GDK_BACKEND:-x11}" "$TERMUX_PROOT_PREFIX/bin/lhic" "\$@"
EOF
    chmod 755 "$BIN_DIR/lhic"
  elif [ "${LHIC_SKIP_CLI:-0}" != "1" ]; then
    fail "the Debian PRoot install did not create $TERMUX_PROOT_PREFIX/bin/lhic."
  fi

  if proot-distro login debian --shared-tmp -- test -x "$TERMUX_PROOT_PREFIX/bin/lhicd" >/dev/null 2>&1; then
    for launcher in lhicd lhic-control-center; do
      cat > "$BIN_DIR/$launcher" <<EOF
#!/bin/sh
exec proot-distro login debian --shared-tmp -- /usr/bin/env DISPLAY="\${DISPLAY:-:1}" GDK_BACKEND="\${GDK_BACKEND:-x11}" "$TERMUX_PROOT_PREFIX/bin/lhicd" "\$@"
EOF
      chmod 755 "$BIN_DIR/$launcher"
    done
  elif [ "${LHIC_SKIP_DESKTOP:-0}" != "1" ]; then
    fail "the Debian PRoot install did not create $TERMUX_PROOT_PREFIX/bin/lhicd."
  fi

  info "Termux installation complete."
  if [ "${LHIC_SKIP_CLI:-0}" != "1" ]; then
    info "CLI: lhic"
  fi
  if [ "${LHIC_SKIP_DESKTOP:-0}" != "1" ]; then
    info "Desktop: open the Termux:X11 Android app, then run: termux-x11 :1 &"
    info "Launch LHIC with: DISPLAY=:1 lhicd"
  fi
}

if [ "$TERMUX_NATIVE" = "1" ]; then
  install_termux_proot
  exit 0
fi

# ---- Node.js 24+ (auto-install when missing or too old) --------------------
NODE_OK=0
if [ "${LHIC_SKIP_NODE:-0}" = "1" ]; then
  warn "Node.js install skipped (LHIC_SKIP_NODE=1); the CLI needs Node ${CLI_NODE_MAJOR}+."
elif command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "$NODE_MAJOR" -ge "$CLI_NODE_MAJOR" ] 2>/dev/null; then
    NODE_OK=1
    info "Node.js ${NODE_MAJOR} found."
  else
    info "Node.js ${NODE_MAJOR} is too old (need ${CLI_NODE_MAJOR}+) — installing Node.js 24…"
  fi
else
  info "Node.js not found — installing Node.js 24…"
fi

if [ "$NODE_OK" = "0" ] && [ "${LHIC_SKIP_NODE:-0}" != "1" ]; then
  case "$OS" in
    Linux|Darwin) : ;;
    *) warn "Node.js auto-install is not supported on $OS; install Node ${CLI_NODE_MAJOR}+ manually." ;;
  esac
  if [ "$NODE_OK" = "0" ] && [ "$OS" = "Linux" ] || [ "$OS" = "Darwin" ]; then
    TMP_NODE="$(mktemp -d)"
    trap 'rm -rf "$TMP_NODE"' EXIT
    NODE_OS="$( [ "$OS" = "Darwin" ] && echo darwin || echo linux )"
    NODE_ARCH="$ARCH"
    if [ "$NODE_ARCH" = "unsupported" ]; then
      warn "Node.js auto-install is not supported on ${ARCH}; install Node ${CLI_NODE_MAJOR}+ manually."
    else
      info "Downloading Node.js 24 for ${NODE_OS}/${NODE_ARCH}…"
      curl -fsSL --retry 3 -o "$TMP_NODE/SHASUMS256.txt" \
        "${NODE_DIST_BASE_URL}/latest-v24.x/SHASUMS256.txt"
      NODE_TARBALL="$(awk -v pat="node-v[0-9.]+-${NODE_OS}-${NODE_ARCH}\\.tar\\.xz\$" '$2 ~ pat { last = $2 } END { print last }' "$TMP_NODE/SHASUMS256.txt")"
      [ -n "${NODE_TARBALL:-}" ] || fail "could not resolve the Node.js 24 tarball for ${NODE_OS}/${NODE_ARCH}."
      NODE_SHA="$(awk -v name="$NODE_TARBALL" '$2 == name { print $1; exit }' "$TMP_NODE/SHASUMS256.txt")"
      [ -n "${NODE_SHA:-}" ] || fail "checksum manifest has no entry for $NODE_TARBALL."
      curl -fsSL --retry 3 -o "$TMP_NODE/$NODE_TARBALL" \
        "${NODE_DIST_BASE_URL}/latest-v24.x/${NODE_TARBALL}"
      ACTUAL="$(sha256 "$TMP_NODE/$NODE_TARBALL")"
      [ "$ACTUAL" = "$NODE_SHA" ] || fail "Node.js SHA-256 mismatch (expected $NODE_SHA, got $ACTUAL)."
      tar -xJf "$TMP_NODE/$NODE_TARBALL" -C "$TMP_NODE"
      mkdir -p "$BIN_DIR" "$PREFIX/lib"
      rm -rf "$PREFIX/lib/nodejs"
      mv "$TMP_NODE/node-v"*/ "$PREFIX/lib/nodejs"
      for tool in node npm npx corepack; do
        ln -sf "$PREFIX/lib/nodejs/bin/$tool" "$BIN_DIR/$tool"
        chmod 755 "$PREFIX/lib/nodejs/bin/$tool" 2>/dev/null || true
      done
      export PATH="$BIN_DIR:$PATH"
      if "$BIN_DIR/node" -v >/dev/null 2>&1 && [ "$("$BIN_DIR/node" -p 'process.versions.node.split(".")[0]')" -ge "$CLI_NODE_MAJOR" ]; then
        NODE_OK=1
        info "Node.js installed: $("$BIN_DIR/node" -v) ($BIN_DIR/node)."
      else
        warn "Node.js install did not produce a working binary; the CLI install may fail."
      fi
    fi
    rm -rf "$TMP_NODE"
    trap - EXIT
  fi
fi

# ---- 1. Desktop app --------------------------------------------------------
DESKTOP_OK=1
case "$OS" in
  Linux)
    case "$ARCH" in
      x64) DESKTOP_ASSET="lhic-control-center-linux-${VERSION}-x86_64.AppImage" ;;
      *) DESKTOP_ASSET="lhic-control-center-linux-${VERSION}-${ARCH}.AppImage" ;;
    esac
    ;;
  Darwin) DESKTOP_ASSET="lhic-control-center-mac-${VERSION}-${ARCH}.zip" ;;
  *) DESKTOP_ASSET="" ; DESKTOP_OK=0 ;;
esac
[ "$ARCH" = "unsupported" ] && { DESKTOP_ASSET=""; DESKTOP_OK=0; }

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
    APP_DIR="$PREFIX/lib/lhic-control-center"
    mkdir -p "$BIN_DIR" "$APP_DIR"
    cp "$TMP/$DESKTOP_ASSET" "$APP_DIR/lhic-control-center.AppImage"
    chmod 755 "$APP_DIR/lhic-control-center.AppImage"
    [ -x "$APP_DIR/lhic-control-center.AppImage" ] \
      || fail "the AppImage is not executable after install (chmod failed on $APP_DIR)."

    # FUSE-less wrapper: extract-and-run when libfuse is absent (WSL, proot,
    # containers).
    cat > "$BIN_DIR/lhic-control-center" <<EOF
#!/bin/sh
if command -v ldconfig >/dev/null 2>&1 && ldconfig -p 2>/dev/null | grep -q 'libfuse\.so\.2'; then
  exec "$APP_DIR/lhic-control-center.AppImage" "\$@"
fi
exec "$APP_DIR/lhic-control-center.AppImage" --appimage-extract-and-run "\$@"
EOF
    chmod 755 "$BIN_DIR/lhic-control-center"
    [ -x "$BIN_DIR/lhic-control-center" ] \
      || fail "the lhic-control-center wrapper is not executable after install."
    # lhicd: X11 launcher for glibc Linux and PRoot distributions. AppImage
    # extraction does not require X11, but it does require a glibc loader; a
    # native Termux shell uses Android's Bionic libc and must enter PRoot first.
    cat > "$BIN_DIR/lhicd" <<EOF
#!/bin/sh
# LHIC Control Center launcher for X11-forwarded glibc environments.
if [ ! -x /lib/ld-linux-aarch64.so.1 ] && [ ! -x /lib64/ld-linux-x86-64.so.2 ]; then
  cat >&2 <<'MESSAGE'
[lhicd] error: the Linux desktop bundle requires a glibc PRoot distribution.
[lhicd] This shell is native Termux (Android/Bionic), so the AppImage cannot run here.
[lhicd] Install and enter a distribution from native Termux:
[lhicd]   pkg install proot-distro x11-repo termux-x11-nightly
[lhicd]   proot-distro install debian
[lhicd]   termux-x11 :1 &
[lhicd]   proot-distro login debian --shared-tmp
[lhicd] Then run the installer and lhicd inside Debian with DISPLAY=:1.
MESSAGE
  exit 1
fi
DISPLAY="\${DISPLAY:-:1}"
export DISPLAY
export GDK_BACKEND="\${GDK_BACKEND:-x11}"
EXTRACTED="$APP_DIR/extracted"
INNER="\$EXTRACTED/squashfs-root/lhic-control-center"
if [ ! -x "\$INNER" ]; then
  rm -rf "\$EXTRACTED"
  mkdir -p "\$EXTRACTED"
  if ! (cd "\$EXTRACTED" && "$APP_DIR/lhic-control-center.AppImage" --appimage-extract >/dev/null); then
    echo "[lhicd] error: AppImage extraction failed; verify that this PRoot uses glibc and reinstall LHIC." >&2
    exit 1
  fi
fi
if [ ! -x "\$INNER" ]; then
  echo "[lhicd] error: the extracted desktop executable is missing: \$INNER" >&2
  exit 1
fi
exec "\$INNER" --no-sandbox "\$@"
EOF
    chmod 755 "$BIN_DIR/lhicd"
    [ -x "$BIN_DIR/lhicd" ] || warn "the lhicd launcher is not executable after install."

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

    # Android kernels appear both in native Termux and inside PRoot. The
    # desktop binary is glibc-only, so identify whether the current shell has
    # the loader before giving launch instructions.
    if uname -r 2>/dev/null | grep -qiE 'android|termux' \
       || uname -o 2>/dev/null | grep -qi android; then
      if [ -x /lib/ld-linux-aarch64.so.1 ] || [ -x /lib64/ld-linux-x86-64.so.2 ]; then
        info "Termux PRoot detected — in native Termux run: termux-x11 :1 &"
        info "This PRoot must have been entered with --shared-tmp; then run: DISPLAY=:1 lhicd"
      else
        warn "Native Termux uses Android/Bionic and cannot execute the glibc desktop AppImage directly."
        info "Install the bridge in native Termux: pkg install proot-distro x11-repo termux-x11-nightly"
        info "Then: proot-distro install debian; termux-x11 :1 &; proot-distro login debian --shared-tmp"
        info "Inside Debian rerun this installer, then launch with: DISPLAY=:1 lhicd"
      fi
    fi

    # Execution-layer provisioning (best-effort, non-fatal).
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
      if command -v python3 >/dev/null 2>&1; then
        if python3 -c 'import omni_parser_v2' >/dev/null 2>&1; then
          info "OmniParser V2 already installed."
        else
          info "Installing OmniParser V2 (DOM-invisible fallback)…"
          # Ladder: plain --user, then PEP 668 consent, then system-wide.
          python3 -m pip install --user omni_parser_v2 >/dev/null 2>&1 \
            || python3 -m pip install --user --break-system-packages omni_parser_v2 >/dev/null 2>&1 \
            || python3 -m pip install --break-system-packages omni_parser_v2 >/dev/null 2>&1 \
            || warn "OmniParser V2 pip install failed (check PyPI access / Python version)."
          if python3 -c 'import omni_parser_v2' >/dev/null 2>&1; then
            info "OmniParser V2 installed (model weights download on first use)."
          else
            warn "OmniParser V2 is not importable yet; LHIC falls back to coordinates for DOM-invisible screens."
          fi
        fi
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
elif [ "$NODE_OK" = "0" ]; then
  warn "The LHIC CLI needs Node.js ${CLI_NODE_MAJOR}+; install it, then run: npm install --global ${CLI_PACKAGE}"
  CLI_OK=0
elif ! command -v npm >/dev/null 2>&1; then
  warn "npm is not available; install the LHIC CLI with: npm install --global ${CLI_PACKAGE}"
  CLI_OK=0
else
  info "Installing the LHIC CLI (${CLI_PACKAGE})…"
  # The CLI tarball contains LHIC workspace packages. npm currently creates
  # empty directories for their external dependencies, so install Playwright
  # into the CLI package root to materialize Playwright, keyring, Transformers,
  # and their complete transitive trees before declaring the CLI usable.
  if npm install --global --ignore-scripts "${CLI_PACKAGE}" >/dev/null 2>&1 && command -v lhic >/dev/null 2>&1; then
    NPM_ROOT="$(npm root --global 2>/dev/null || true)"
    CLI_ROOT="${NPM_ROOT}/${CLI_PACKAGE_NAME}"
    if [ -d "$CLI_ROOT" ] \
       && npm install --prefix "$CLI_ROOT" --ignore-scripts --no-save "playwright@${PLAYWRIGHT_VERSION}" >/dev/null 2>&1 \
       && [ -f "$CLI_ROOT/node_modules/playwright/index.js" ] \
       && lhic --help >/dev/null 2>&1; then
      info "CLI installed — run: lhic"
    else
      warn "CLI dependencies are incomplete; reinstall with: npm install --global ${CLI_PACKAGE} && npm install --prefix \"\$(npm root --global)/${CLI_PACKAGE_NAME}\" --ignore-scripts --no-save playwright@${PLAYWRIGHT_VERSION}"
      CLI_OK=0
    fi
  else
    warn "CLI install failed; install it manually with: npm install --global ${CLI_PACKAGE}"
    CLI_OK=0
  fi
fi

# ---- Summary ----------------------------------------------------------------
if [ "$DESKTOP_OK" = "0" ] && [ "$CLI_OK" = "0" ]; then
  fail "Neither the desktop app nor the CLI could be installed."
fi
if [ "$DESKTOP_OK" = "0" ]; then
  info "Only the CLI was installed — the desktop app is not supported on ${OS}/${ARCH}."
fi
info "Done. Desktop: lhic-control-center (X11/Termux: lhicd) · CLI: lhic"
