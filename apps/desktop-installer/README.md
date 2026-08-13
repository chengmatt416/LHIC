# lhic-desktop

Launch the [LHIC Control Center](https://github.com/chengmatt416/LHIC) desktop app —
the omp agent engine with a full chat/session UI, LHIC browser and desktop
control, and the shared-skill library — from npm or Bun.

## Install

```sh
npm install --global lhic-desktop
# or
bun add --global lhic-desktop
# or run without installing
npx lhic-desktop
```

## Run

```sh
lhic-desktop
```

On first run the launcher downloads the installer for your platform from the
matching GitHub release (`desktop-v<version>`), verifies it against the
release's `SHA256SUMS-<version>.txt` manifest, caches it, and starts the app.
No native dependencies, no root, nothing left in the project tree.

- macOS → `.zip` app bundle copied into `~/Library/Caches/lhic-desktop/<version>`
- Linux → AppImage cached under `~/.cache/lhic-desktop/<version>`
- Windows → NSIS `.exe` under `%LOCALAPPDATA%\lhic-desktop\<version>`

## Environment

| Variable                                                                                 | Default                                                                     | Purpose                                                   |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------- |
| `LHIC_DESKTOP_VERSION`                                                                   | package version                                                             | Release version to install (tag is `desktop-v<version>`). |
| `LHIC_DESKTOP_BASE_URL`                                                                  | `https://github.com/chengmatt416/LHIC/releases/download/desktop-v<version>` | Release download base URL (used by tests and mirrors).    |
| `LHIC_SKIP_BACKENDS`                                                                     | unset                                                                       | Set `1` to skip automatic execution-layer provisioning.   |
| `LHIC_SKIP_PEEKABOO` / `LHIC_SKIP_FLAUI` / `LHIC_SKIP_OMNIPARSER` / `LHIC_SKIP_CHROMIUM` | unset                                                                       | Skip one provisioning step.                               |

## Automatic package provisioning

On first run (and on `lhic-desktop provision`) the launcher installs the
execution-layer packages it needs, best-effort and non-fatal — the executor
falls back to the traditional layer for anything still missing:

- **macOS 15+**: Peekaboo CLI (`brew install steipete/tap/peekaboo`, else
  `npm i -g @steipete/peekaboo`); skipped below macOS 15.
- **Windows 10 1607+**: FlaUI bridge (installs the .NET SDK via winget when
  missing, then `dotnet publish` of the bundled helper); skipped below
  Windows 10 1607.
- **Every OS**: OmniParser V2 (`pip install --user omni_parser_v2`, with a
  `--break-system-packages` retry on PEP 668 distros) and Playwright
  Chromium (`npx playwright install chromium`).

The same provisioning runs inside the desktop app on its first launch
(Homebrew cask / AUR installs) and in `scripts/install.sh` / `install.ps1`
(curl one-liners).

## Installer scripts

Prefer the native one-liners on machines without Node — each installs the
**desktop app and the CLI together**; when the desktop app is not supported
on the platform (e.g. an unsupported architecture), a warning is shown and
only the CLI is installed:

```sh
curl -fsSL https://github.com/chengmatt416/LHIC/releases/latest/download/install.sh | sh
```

```powershell
irm https://github.com/chengmatt416/LHIC/releases/latest/download/install.ps1 | iex
```

### Termux / Android

The Linux desktop bundle and LHIC's native dependencies require glibc; they
cannot execute directly against Android's Bionic libc. Run the normal installer
one-liner in native Termux. It automatically installs `proot-distro`, Debian,
and the Termux:X11 companion package, installs LHIC inside Debian, and creates
native-Termux forwarding launchers. Debian package setup prints concise
progress lines and logs details to `/tmp/lhic-apt.log`.

After installation, open the Termux:X11 Android app, then run:

```sh
termux-x11 :1 &
DISPLAY=:1 lhicd
```

Run the CLI with `lhic`. Both launchers enter Debian with `--shared-tmp`, which
lets the desktop client reach the Termux:X11 socket. Xfce is optional.

On first launch, add a model API key in Agent Studio's **Model management**
panel (or sign in with a provider) to start the agent.

Opt out of either component with `LHIC_SKIP_DESKTOP=1` (CLI only) or
`LHIC_SKIP_CLI=1` (desktop only).

Homebrew and Arch (AUR) packages are maintained in the
`chengmatt416/homebrew-lhic` tap and the `lhic-control-center-bin` AUR package
respectively — see `distribution/` in the repository.

## License

MIT OR Apache-2.0
