import { execFile } from "node:child_process";
import {
  lstat,
  readFile,
  readlink,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import {
  globalBinDirectory,
  profileForShell,
  type CommandResult,
} from "./installer.js";

const execFileAsync = promisify(execFile);
const cliPackageName = "@pinyencheng/lhic";
const profileMarker = "# Added by LHIC CLI installer";
const macBundleIdentifier = "io.github.chengmatt416.lhic";

export interface CliUninstallerOptions {
  readonly platform?: NodeJS.Platform;
  readonly homeDirectory?: string;
  readonly shell?: string | undefined;
  readonly runNpm?: (
    argumentsList: readonly string[],
  ) => Promise<CommandResult>;
}

export interface DesktopUninstallerOptions {
  readonly platform?: NodeJS.Platform;
  readonly homeDirectory?: string;
  readonly localAppData?: string;
  readonly runCommand?: (
    file: string,
    argumentsList: readonly string[],
  ) => Promise<CommandResult>;
}

export interface CliUninstallResult {
  readonly packageRemoved: true;
  readonly managedLinkRemoved: boolean;
  readonly profileUpdated: boolean;
  readonly dataDeleted: false;
  readonly browserRuntimeDeleted: false;
  readonly nextStep: string;
}

export interface DesktopUninstallResult {
  readonly platform: NodeJS.Platform;
  readonly applicationRemoved: boolean;
  readonly launcherRemoved: boolean;
  readonly location: string | null;
  readonly dataDeleted: false;
  readonly nextStep: string;
}

export async function uninstallCliRuntime(
  options: CliUninstallerOptions = {},
): Promise<CliUninstallResult> {
  const platform = options.platform ?? process.platform;
  const homeDirectory = options.homeDirectory ?? homedir();
  const runNpm = options.runNpm ?? runNpmCommand;
  const npmPrefix = (await runNpm(["prefix", "--global"])).stdout.trim();
  if (!npmPrefix) {
    throw new Error("npm did not return its global installation prefix.");
  }
  const globalExecutable = join(
    globalBinDirectory(npmPrefix, platform),
    platform === "win32" ? "lhic.cmd" : "lhic",
  );
  let managedLink: string | undefined;
  let profilePlan: ProfileCleanupPlan | undefined;
  if (platform !== "win32") {
    const userBinDirectory = join(homeDirectory, ".local", "bin");
    managedLink = join(userBinDirectory, "lhic");
    profilePlan = await planProfileCleanup(
      profileForShell(options.shell ?? process.env.SHELL, homeDirectory),
      userBinDirectory,
    );
    await assertManagedLinkSafe(managedLink, globalExecutable);
  }

  await runNpm(["uninstall", "--global", cliPackageName]);

  const managedLinkRemoved = managedLink
    ? await removeManagedLink(managedLink, globalExecutable)
    : false;
  const profileUpdated = profilePlan
    ? await applyProfileCleanup(profilePlan)
    : false;
  return {
    packageRemoved: true,
    managedLinkRemoved,
    profileUpdated,
    dataDeleted: false,
    browserRuntimeDeleted: false,
    nextStep:
      "LHIC user data and the shared Playwright Chromium runtime were preserved. Run `lhic data inventory` before any separate data deletion.",
  };
}

export async function uninstallDesktopApplication(
  options: DesktopUninstallerOptions = {},
): Promise<DesktopUninstallResult> {
  const platform = options.platform ?? process.platform;
  const homeDirectory = options.homeDirectory ?? homedir();
  const runCommand = options.runCommand ?? runSystemCommand;
  switch (platform) {
    case "darwin":
      return uninstallMacApplication(homeDirectory, runCommand);
    case "linux":
      return uninstallLinuxApplication(homeDirectory);
    case "win32":
      return uninstallWindowsApplication(
        options.localAppData ??
          process.env.LOCALAPPDATA ??
          join(homeDirectory, "AppData", "Local"),
        runCommand,
      );
    default:
      throw new Error(`Desktop uninstallation is unsupported on ${platform}.`);
  }
}

interface ProfileCleanupPlan {
  readonly path: string;
  readonly original: string;
  readonly updated: string;
}

async function planProfileCleanup(
  profile: string,
  userBinDirectory: string,
): Promise<ProfileCleanupPlan | undefined> {
  const original = await readOptionalText(profile);
  if (!original.includes(profileMarker)) return undefined;
  const exactBlock = `${profileMarker}\nexport PATH="${userBinDirectory}:$PATH"\n`;
  if (countOccurrences(original, profileMarker) !== 1 || !original.includes(exactBlock)) {
    throw new Error(
      `Refusing to modify ${profile}: the LHIC PATH marker was edited or duplicated.`,
    );
  }
  const updated = original.replace(exactBlock, "").replace(/^\n/u, "");
  return { path: profile, original, updated };
}

async function applyProfileCleanup(
  plan: ProfileCleanupPlan,
): Promise<boolean> {
  const current = await readOptionalText(plan.path);
  if (current !== plan.original) {
    throw new Error(
      `Refusing to modify ${plan.path}: it changed after uninstall validation.`,
    );
  }
  const temporary = `${plan.path}.lhic-uninstall-${process.pid}`;
  await writeFile(temporary, plan.updated, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  try {
    await rename(temporary, plan.path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return true;
}

async function assertManagedLinkSafe(
  linkPath: string,
  expectedTarget: string,
): Promise<void> {
  const stat = await optionalLstat(linkPath);
  if (!stat) return;
  if (!stat.isSymbolicLink()) {
    throw new Error(
      `Refusing to remove ${linkPath}: it is not an LHIC-managed symbolic link.`,
    );
  }
  const target = await readlink(linkPath);
  if (resolve(dirname(linkPath), target) !== resolve(expectedTarget)) {
    throw new Error(
      `Refusing to remove ${linkPath}: its target is not the LHIC global executable.`,
    );
  }
}

async function removeManagedLink(
  linkPath: string,
  expectedTarget: string,
): Promise<boolean> {
  const stat = await optionalLstat(linkPath);
  if (!stat) return false;
  await assertManagedLinkSafe(linkPath, expectedTarget);
  await rm(linkPath);
  return true;
}

async function uninstallMacApplication(
  homeDirectory: string,
  runCommand: (
    file: string,
    argumentsList: readonly string[],
  ) => Promise<CommandResult>,
): Promise<DesktopUninstallResult> {
  const application = join(
    homeDirectory,
    "Applications",
    "LHIC Control Center.app",
  );
  const stat = await optionalLstat(application);
  if (!stat) return desktopResult("darwin", false, false, null);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(
      "Refusing to remove the macOS application because it is not a normal application directory.",
    );
  }
  const infoPlist = join(application, "Contents", "Info.plist");
  const bundleIdentifier = (
    await runCommand("/usr/libexec/PlistBuddy", [
      "-c",
      "Print :CFBundleIdentifier",
      infoPlist,
    ])
  ).stdout.trim();
  if (bundleIdentifier !== macBundleIdentifier) {
    throw new Error(
      "Refusing to remove the macOS application because its bundle identifier is not LHIC.",
    );
  }
  await rm(application, { recursive: true, force: false });
  return desktopResult("darwin", true, false, application);
}

async function uninstallLinuxApplication(
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
  let applicationRemoved = false;
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
    await rm(applicationDirectory, { recursive: true, force: false });
    applicationRemoved = true;
  }

  let launcherRemoved = false;
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
    await rm(launcher);
    launcherRemoved = true;
  }
  return desktopResult(
    "linux",
    applicationRemoved,
    launcherRemoved,
    applicationRemoved ? application : null,
  );
}

async function uninstallWindowsApplication(
  localAppData: string,
  runCommand: (
    file: string,
    argumentsList: readonly string[],
  ) => Promise<CommandResult>,
): Promise<DesktopUninstallResult> {
  const candidates = [
    join(
      localAppData,
      "Programs",
      "LHIC Control Center",
      "Uninstall LHIC Control Center.exe",
    ),
    join(
      localAppData,
      "Programs",
      "lhic-control-center",
      "Uninstall LHIC Control Center.exe",
    ),
  ];
  const present = [];
  for (const candidate of candidates) {
    const stat = await optionalLstat(candidate);
    if (!stat) continue;
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(
        "Refusing to execute the Windows uninstaller because it is not a normal file.",
      );
    }
    present.push(candidate);
  }
  if (present.length === 0) return desktopResult("win32", false, false, null);
  if (present.length !== 1) {
    throw new Error(
      "Multiple LHIC Windows uninstallers were found; remove the ambiguity through Windows Apps settings.",
    );
  }
  await runCommand(present[0]!, ["/S"]);
  return desktopResult("win32", true, false, present[0]!);
}

function desktopResult(
  platform: NodeJS.Platform,
  applicationRemoved: boolean,
  launcherRemoved: boolean,
  location: string | null,
): DesktopUninstallResult {
  return {
    platform,
    applicationRemoved,
    launcherRemoved,
    location,
    dataDeleted: false,
    nextStep:
      "LHIC user data was preserved. Run `lhic data inventory` and use the separate confirmation-gated erase command only when deletion is intended.",
  };
}

async function readOptionalText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return "";
    throw error;
  }
}

async function optionalLstat(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

function countOccurrences(value: string, token: string): number {
  return value.split(token).length - 1;
}

function escapeDesktopEntryValue(value: string): string {
  return value.replace(/([\\\s"'`$])/gu, "\\$1");
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

async function runNpmCommand(
  argumentsList: readonly string[],
): Promise<CommandResult> {
  return execFileAsync("npm", [...argumentsList], {
    encoding: "utf8",
    windowsHide: true,
  });
}

async function runSystemCommand(
  file: string,
  argumentsList: readonly string[],
): Promise<CommandResult> {
  return execFileAsync(file, [...argumentsList], {
    encoding: "utf8",
    windowsHide: true,
  });
}
