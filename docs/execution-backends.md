# Element-grounded desktop execution layers

LHIC's desktop (OS-level) executor dispatches through an element-grounded
layer first, then falls back to the traditional platform layer. Every path
keeps the same guarantees: schema validation, per-action human approval, and
post-action verification live in `GlobalComputerExecutor`, which only swaps
how input is dispatched.

## Layer order

1. **Platform element backend** — observe the desktop (accessibility/DOM
   equivalent), resolve the action target to an element, act on the element:
   - macOS 15+: **Peekaboo** (`peekaboo click "Address and search bar" --app Safari`)
   - Windows 10 1607+: **FlaUI** (UIA3 bridge, element-targeted)
2. **OmniParser V2 fallback** — when the accessibility tree cannot see the
   interface (canvas, games, remote/virtualized screens), parse a screenshot
   into structured elements and dispatch to the located coordinates through
   the traditional layer.
3. **Traditional layer** — the original per-platform commands
   (osascript on macOS, PowerShell on Windows, xdotool on Linux).

## OS version support

Backends are gated on OS version at probe time; when the OS (or the tool)
does not support the layer, LHIC **automatically uses the traditional layer**:

| OS      | Element layer | Requirement                                                                 | Fallback when unsupported        |
| ------- | ------------- | --------------------------------------------------------------------------- | -------------------------------- |
| macOS   | Peekaboo      | macOS 15+, `peekaboo` CLI (brew install steipete/tap/peekaboo)              | osascript System Events          |
| Windows | FlaUI         | Windows 10 1607+, built bridge DLL                                          | PowerShell UIA/native input      |
| Any     | OmniParser V2 | Python + weights (see `packages/skills/src/execution/omniparser/README.md`) | coordinates via the native layer |

## Configuration

| Env                      | Default                        | Meaning                                                         |
| ------------------------ | ------------------------------ | --------------------------------------------------------------- |
| `LHIC_EXECUTION_BACKEND` | `auto`                         | `auto` \| `peekaboo` \| `flaui` \| `omniparser` \| `native`     |
| `LHIC_PEEKABOO_BIN`      | `peekaboo`                     | Peekaboo CLI binary                                             |
| `LHIC_FLAUI_DLL`         | `lhic-flaui/lhic-flaui.dll`    | Compiled FlaUI bridge (build: `scripts/build-flaui-helper.ps1`) |
| `LHIC_OMNIPARSER_PYTHON` | `python3`                      | Python interpreter for the OmniParser helper                    |
| `LHIC_OMNIPARSER_DIR`    | bundled `execution/omniparser` | OmniParser repo checkout (repo mode)                            |
| `LHIC_SKIP_BACKENDS`     | unset                          | Set `1` to skip automatic provisioning                          |

## Automatic provisioning

All install paths provision the required packages automatically (best-effort,
non-fatal; per-backend `LHIC_SKIP_PEEKABOO` / `LHIC_SKIP_FLAUI` /
`LHIC_SKIP_OMNIPARSER` / `LHIC_SKIP_CHROMIUM` opt-outs):

- `lhic-desktop` (npm/Bun): first run + `lhic-desktop provision`.
- `scripts/install.sh` / `scripts/install.ps1` (curl one-liners).
- The desktop app itself on first launch (`ProvisioningService`; covers
  Homebrew cask and AUR installs) — the packaged app bundles the FlaUI and
  OmniParser sources under `resources/execution`.

OS-version gates apply during provisioning too: Peekaboo is only installed on
macOS 15+, the FlaUI bridge only on Windows 10 1607+; older systems keep the
traditional layer untouched.

The active layer is visible in the executor's evidence:
`Dispatched os_click through the peekaboo element backend.` /
`OmniParser V2 located "Submit" at (120, 60).` / the native API line.

## Code map

- `packages/skills/src/execution-backend.ts` — backend interface, Peekaboo /
  FlaUI / OmniParser adapters, chain resolver, environment mapping.
- `packages/skills/src/os-bridge.ts` — `GlobalComputerExecutor.dispatcher`
  hook; approval, verification, and tracing stay here.
- `packages/skills/src/execution/flaui/` — FlaUI C# bridge source.
- `packages/skills/src/execution/omniparser/` — OmniParser V2 Python helper.
- `apps/desktop/src/main/desktop-global-runner.ts` — desktop-plan execution
  wired to the resolved chain.
