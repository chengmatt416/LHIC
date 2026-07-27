from pathlib import Path
import subprocess


def replace_once(path: Path, old: str, new: str) -> None:
    text = path.read_text()
    if new in text:
        return
    if text.count(old) != 1:
        raise RuntimeError(f"Expected exactly one match in {path}: {old!r}")
    path.write_text(text.replace(old, new, 1))


uninstaller = Path("apps/cli/src/uninstaller.ts")
text = uninstaller.read_text()
start = text.index("async function uninstallLinuxApplication(")
end = text.index("\nasync function uninstallWindowsApplication(")
replacement = '''async function uninstallLinuxApplication(
  homeDirectory: string,
): Promise<DesktopUninstallResult> {
  const applicationDirectory = join(
    homeDirectory,
    ".local",
    "share",
    "lhic-control-center",
  );
  const application = join(
    applicationDirectory,
    "lhic-control-center.AppImage",
  );
  const launcher = join(
    homeDirectory,
    ".local",
    "share",
    "applications",
    "lhic-control-center.desktop",
  );
  const directoryStat = await optionalLstat(applicationDirectory);
  if (directoryStat) {
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
      throw new Error(
        "Refusing to remove the Linux application because its managed directory is not a normal directory.",
      );
    }
    const applicationStat = await optionalLstat(application);
    if (
      !applicationStat ||
      applicationStat.isSymbolicLink() ||
      !applicationStat.isFile()
    ) {
      throw new Error(
        "Refusing to remove the Linux application because the managed AppImage is missing or unsafe.",
      );
    }
  }

  const launcherStat = await optionalLstat(launcher);
  if (launcherStat) {
    if (launcherStat.isSymbolicLink() || !launcherStat.isFile()) {
      throw new Error(
        "Refusing to remove the Linux launcher because it is not a normal file.",
      );
    }
    const launcherContent = await readFile(launcher, "utf8");
    const expectedExec = `Exec=${escapeDesktopEntryValue(application)}`;
    if (
      !launcherContent.includes("Name=LHIC Control Center") ||
      !launcherContent.includes(expectedExec)
    ) {
      throw new Error(
        "Refusing to remove the Linux launcher because it no longer matches the LHIC-managed application.",
      );
    }
  }

  if (directoryStat) {
    await rm(applicationDirectory, { recursive: true, force: false });
  }
  if (launcherStat) {
    await rm(launcher);
  }
  return desktopResult(
    "linux",
    Boolean(directoryStat),
    Boolean(launcherStat),
    directoryStat ? application : null,
  );
}
'''
uninstaller.write_text(text[:start] + replacement + text[end:])

main = Path("apps/cli/src/main.ts")
replace_once(
    main,
    'import { installCliRuntime, installDesktopApplication } from "./installer.js";',
    '''import { installCliRuntime, installDesktopApplication } from "./installer.js";
import {
  uninstallCliRuntime,
  uninstallDesktopApplication,
} from "./uninstaller.js";''',
)
replace_once(
    main,
    '''  if (command === "install" && subcommand === "desktop") {
    const result = await installDesktopApplication();
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "demo") {''',
    '''  if (command === "install" && subcommand === "desktop") {
    const result = await installDesktopApplication();
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "uninstall" && subcommand === "cli") {
    const result = await uninstallCliRuntime();
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "uninstall" && subcommand === "desktop") {
    const result = await uninstallDesktopApplication();
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "demo") {''',
)

interactive = Path("apps/cli/src/interactive.ts")
replace_once(
    interactive,
    '"Usage: lhic [install <cli|desktop> | start',
    '"Usage: lhic [install <cli|desktop> | uninstall <cli|desktop> | start',
)
replace_once(
    interactive,
    '''    case "install":
      return guideInstallCommand(guided, prompter);
    case "shared":''',
    '''    case "install":
      return guideInstallCommand(guided, prompter);
    case "uninstall":
      return guideUninstallCommand(guided, prompter);
    case "shared":''',
)
replace_once(
    interactive,
    '''    "start",
    "install",
    "demo",''',
    '''    "start",
    "install",
    "uninstall",
    "demo",''',
)
replace_once(
    interactive,
    '''async function guideTrainingCommand(''',
    '''async function guideUninstallCommand(
  argumentsList: string[],
  prompter: CliPrompter,
): Promise<string[]> {
  const guided = [...argumentsList];
  guided[1] ??= await askChoice(prompter, "Uninstall LHIC", [
    "cli",
    "desktop",
  ]);
  return guided;
}

async function guideTrainingCommand(''',
)

readme = Path("README.md")
replace_once(
    readme,
    '''### Local data inventory and deletion''',
    '''### Safe uninstall

Remove application binaries without silently deleting user data:

```bash
npx @pinyencheng/lhic uninstall cli
npx @pinyencheng/lhic uninstall desktop
```

The CLI uninstaller validates its managed symlink and exact shell-profile marker before invoking npm. The Desktop uninstaller verifies the macOS bundle identifier, the Linux AppImage and launcher, or one exact Windows NSIS uninstaller. Modified, ambiguous, symlinked, or unrelated targets fail closed. User data and the shared Playwright Chromium runtime are preserved. See the [safe uninstall guide](docs/uninstall.md), then use the separate confirmation-gated data command only when deletion is intended.

### Local data inventory and deletion''',
)

files = [
    str(uninstaller),
    "apps/cli/src/uninstaller.test.ts",
    str(main),
    str(interactive),
    str(readme),
    "docs/uninstall.md",
]
subprocess.run(["npx", "prettier", "--write", *files], check=True)
subprocess.run(["npm", "run", "typecheck"], check=True)
subprocess.run(
    [
        "npx",
        "vitest",
        "run",
        "apps/cli/src/uninstaller.test.ts",
        "apps/cli/src/installer.test.ts",
        "apps/cli/src/product-data.test.ts",
    ],
    check=True,
)
help_output = subprocess.run(
    ["npx", "tsx", "apps/cli/src/entry.ts", "help"],
    check=True,
    capture_output=True,
    text=True,
).stdout
for required in ["uninstall <cli|desktop>", "data erase"]:
    if required not in help_output:
        raise RuntimeError(f"Public CLI help is missing {required!r}.")
subprocess.run(["npm", "run", "package:smoke"], check=True)
subprocess.run(["npm", "run", "lint"], check=True)
subprocess.run(["git", "add", *files], check=True)
