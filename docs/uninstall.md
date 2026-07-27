# Uninstalling LHIC safely

LHIC separates application removal from data deletion. `lhic uninstall` removes only install artifacts that can be verified as LHIC-managed. It does not delete user data, traces, correction replay markers, credentials, or the shared Playwright Chromium runtime.

## Remove the CLI

```bash
lhic uninstall cli
```

The command:

- obtains the current npm global prefix;
- validates the Unix `~/.local/bin/lhic` symbolic link before npm is changed;
- validates the exact PATH block added by the LHIC installer;
- runs `npm uninstall --global @pinyencheng/lhic`;
- removes only the verified LHIC symlink and exact profile block;
- leaves unrelated files and edited shell configuration untouched.

The command fails before npm uninstall when the managed symlink points somewhere unexpected or when the PATH marker was edited or duplicated. On Windows, npm removes the global package and no Unix profile cleanup is attempted.

The shared Playwright Chromium runtime is preserved because other applications may use it. Remove it only through Playwright's own browser-management procedure after confirming it is not shared.

## Remove the Desktop application

```bash
lhic uninstall desktop
```

Platform behavior:

- **macOS:** removes only `~/Applications/LHIC Control Center.app` after verifying the exact bundle identifier `io.github.chengmatt416.lhic` with the system plist tool.
- **Linux:** removes only the dedicated `~/.local/share/lhic-control-center` directory and matching `.desktop` launcher after validating both as normal, non-symlinked LHIC files.
- **Windows:** executes exactly one normal LHIC NSIS uninstaller from one of the two supported per-user install directories. Ambiguous or non-normal files fail closed. When the expected uninstaller is not found, use Windows **Installed apps** rather than deleting a guessed directory.

Close LHIC before uninstalling it. An operating system may reject removal when files are still in use.

## User data is preserved

Application removal intentionally reports `dataDeleted: false`. Review local data separately:

```bash
lhic data inventory --root .lhic
```

Delete only after reviewing the exact root and confirmation token:

```bash
lhic data erase \
  --root .lhic \
  --confirm ERASE-0123456789ABCDEF \
  --receipt ./lhic-data-erase-receipt.json
```

Also review operating-system keychains, external trace directories, external correction replay directories, backups, cloud-sync copies, and MCP client configuration. Those are outside the selected data root and are never silently removed by uninstall.
