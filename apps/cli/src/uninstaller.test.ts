import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  uninstallCliRuntime,
  uninstallDesktopApplication,
} from "./uninstaller.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("CLI uninstall lifecycle", () => {
  it.runIf(process.platform !== "win32")(
    "removes only the managed symlink and exact PATH block",
    async () => {
      const home = await temporaryDirectory();
      const prefix = join(home, "npm-prefix");
      const globalExecutable = join(prefix, "bin", "lhic");
      const userBin = join(home, ".local", "bin");
      const userExecutable = join(userBin, "lhic");
      const profile = join(home, ".zshrc");
      await mkdir(join(prefix, "bin"), { recursive: true });
      await mkdir(userBin, { recursive: true });
      await writeFile(globalExecutable, "#!/bin/sh\n", "utf8");
      await symlink(globalExecutable, userExecutable);
      await writeFile(
        profile,
        [
          "export EXISTING=value",
          "# Added by LHIC CLI installer",
          `export PATH="${userBin}:$PATH"`,
          "export AFTER=value",
          "",
        ].join("\n"),
        "utf8",
      );
      const calls: readonly string[][] = [];
      const result = await uninstallCliRuntime({
        platform: "linux",
        homeDirectory: home,
        shell: "/bin/zsh",
        runNpm: async (argumentsList) => {
          (calls as string[][]).push([...argumentsList]);
          return {
            stdout: argumentsList[0] === "prefix" ? `${prefix}\n` : "removed\n",
            stderr: "",
          };
        },
      });

      expect(calls).toEqual([
        ["prefix", "--global"],
        ["uninstall", "--global", "@pinyencheng/lhic"],
      ]);
      await expect(lstat(userExecutable)).rejects.toMatchObject({
        code: "ENOENT",
      });
      const profileContent = await readFile(profile, "utf8");
      expect(profileContent).toContain("export EXISTING=value");
      expect(profileContent).toContain("export AFTER=value");
      expect(profileContent).not.toContain("Added by LHIC");
      expect(result).toEqual(
        expect.objectContaining({
          packageRemoved: true,
          managedLinkRemoved: true,
          profileUpdated: true,
          dataDeleted: false,
          browserRuntimeDeleted: false,
        }),
      );
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects an unrelated link before invoking npm",
    async () => {
      const home = await temporaryDirectory();
      const prefix = join(home, "npm-prefix");
      const userBin = join(home, ".local", "bin");
      const userExecutable = join(userBin, "lhic");
      const unrelated = join(home, "unrelated");
      await mkdir(userBin, { recursive: true });
      await writeFile(unrelated, "unrelated", "utf8");
      await symlink(unrelated, userExecutable);
      const calls: string[][] = [];

      await expect(
        uninstallCliRuntime({
          platform: "linux",
          homeDirectory: home,
          shell: "/bin/zsh",
          runNpm: async (argumentsList) => {
            calls.push([...argumentsList]);
            return { stdout: `${prefix}\n`, stderr: "" };
          },
        }),
      ).rejects.toThrow("target is not the LHIC global executable");
      expect(calls).toEqual([["prefix", "--global"]]);
      await expect(readFile(unrelated, "utf8")).resolves.toBe("unrelated");
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects a modified installer marker before invoking npm uninstall",
    async () => {
      const home = await temporaryDirectory();
      const prefix = join(home, "npm-prefix");
      await writeFile(
        join(home, ".profile"),
        "# Added by LHIC CLI installer\nexport PATH=modified\n",
        "utf8",
      );
      const calls: string[][] = [];
      await expect(
        uninstallCliRuntime({
          platform: "linux",
          homeDirectory: home,
          shell: "/bin/fish",
          runNpm: async (argumentsList) => {
            calls.push([...argumentsList]);
            return { stdout: `${prefix}\n`, stderr: "" };
          },
        }),
      ).rejects.toThrow("PATH marker was edited or duplicated");
      expect(calls).toEqual([["prefix", "--global"]]);
    },
  );

  it("uses npm-only cleanup on Windows and preserves user data", async () => {
    const calls: string[][] = [];
    const result = await uninstallCliRuntime({
      platform: "win32",
      homeDirectory: "C:\\Users\\Person",
      runNpm: async (argumentsList) => {
        calls.push([...argumentsList]);
        return {
          stdout: argumentsList[0] === "prefix" ? "C:\\npm\n" : "removed\n",
          stderr: "",
        };
      },
    });
    expect(calls).toEqual([
      ["prefix", "--global"],
      ["uninstall", "--global", "@pinyencheng/lhic"],
    ]);
    expect(result.dataDeleted).toBe(false);
  });
});

describe("Desktop uninstall lifecycle", () => {
  it("removes the exact Linux application and launcher", async () => {
    const home = await temporaryDirectory();
    const application = join(
      home,
      ".local",
      "share",
      "lhic-control-center",
      "lhic-control-center.AppImage",
    );
    const launcher = join(
      home,
      ".local",
      "share",
      "applications",
      "lhic-control-center.desktop",
    );
    await mkdir(join(application, ".."), { recursive: true });
    await mkdir(join(launcher, ".."), { recursive: true });
    await writeFile(application, "appimage", "utf8");
    await writeFile(
      launcher,
      [
        "[Desktop Entry]",
        "Name=LHIC Control Center",
        `Exec=${application.replace(/([\\\s"'`$])/gu, "\\$1")}`,
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await uninstallDesktopApplication({
      platform: "linux",
      homeDirectory: home,
    });
    expect(result).toEqual(
      expect.objectContaining({
        platform: "linux",
        applicationRemoved: true,
        launcherRemoved: true,
        dataDeleted: false,
      }),
    );
    await expect(lstat(application)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(launcher)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses to remove a modified Linux launcher", async () => {
    const home = await temporaryDirectory();
    const application = join(
      home,
      ".local",
      "share",
      "lhic-control-center",
      "lhic-control-center.AppImage",
    );
    const launcher = join(
      home,
      ".local",
      "share",
      "applications",
      "lhic-control-center.desktop",
    );
    await mkdir(join(application, ".."), { recursive: true });
    await mkdir(join(launcher, ".."), { recursive: true });
    await writeFile(application, "appimage", "utf8");
    await writeFile(launcher, "Name=Different Application\n", "utf8");

    await expect(
      uninstallDesktopApplication({
        platform: "linux",
        homeDirectory: home,
      }),
    ).rejects.toThrow("launcher because it no longer matches");
  });

  it("checks the macOS bundle identifier before removal", async () => {
    const home = await temporaryDirectory();
    const application = join(home, "Applications", "LHIC Control Center.app");
    await mkdir(join(application, "Contents"), { recursive: true });
    await writeFile(
      join(application, "Contents", "Info.plist"),
      "fixture",
      "utf8",
    );
    const calls: Array<{ file: string; argumentsList: readonly string[] }> = [];
    const result = await uninstallDesktopApplication({
      platform: "darwin",
      homeDirectory: home,
      runCommand: async (file, argumentsList) => {
        calls.push({ file, argumentsList });
        return { stdout: "io.github.chengmatt416.lhic\n", stderr: "" };
      },
    });
    expect(calls[0]?.file).toBe("/usr/libexec/PlistBuddy");
    expect(result.applicationRemoved).toBe(true);
    await expect(lstat(application)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("executes only one exact normal Windows uninstaller", async () => {
    const directory = await temporaryDirectory();
    const uninstaller = join(
      directory,
      "Programs",
      "LHIC Control Center",
      "Uninstall LHIC Control Center.exe",
    );
    await mkdir(join(uninstaller, ".."), { recursive: true });
    await writeFile(uninstaller, "fixture", "utf8");
    const calls: Array<{ file: string; argumentsList: readonly string[] }> = [];
    const result = await uninstallDesktopApplication({
      platform: "win32",
      localAppData: directory,
      runCommand: async (file, argumentsList) => {
        calls.push({ file, argumentsList });
        return { stdout: "", stderr: "" };
      },
    });
    expect(calls).toEqual([{ file: uninstaller, argumentsList: ["/S"] }]);
    expect(result.applicationRemoved).toBe(true);
    expect(result.dataDeleted).toBe(false);
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "lhic-uninstaller-"));
  temporaryDirectories.push(directory);
  return directory;
}
