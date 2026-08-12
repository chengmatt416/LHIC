import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  globalBinDirectory,
  installDesktopApplication,
  installCliRuntime,
  parseSha256Manifest,
  profileForShell,
  selectDesktopReleaseAsset,
} from "./installer.js";

describe("CLI installer", () => {
  it("installs the CLI and browser runtime without requiring elevated access", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "lhic-cli-install-"));
    const calls: readonly string[][] = [];
    try {
      const result = await installCliRuntime({
        platform: "darwin",
        homeDirectory,
        shell: "/bin/zsh",
        path: "/usr/bin",
        runNpm: async (argumentsList) => {
          (calls as string[][]).push([...argumentsList]);
          if (argumentsList[0] === "prefix") {
            return { stdout: "/opt/lhic", stderr: "" };
          }
          return { stdout: "", stderr: "" };
        },
      });

      expect(calls).toEqual([
        [
          "install",
          "--global",
          "--prefix",
          join(homeDirectory, ".local"),
          "@pinyencheng/lhic@latest",
        ],
        [
          "exec",
          "--yes",
          "--package",
          "@pinyencheng/lhic@latest",
          "--",
          "playwright",
          "install",
          "chromium",
        ],
      ]);
      expect(result).toEqual({
        executable: join(homeDirectory, ".local", "bin", "lhic"),
        pathUpdated: true,
        restartRequired: true,
      });
      await expect(
        readFile(join(homeDirectory, ".zshrc"), "utf8"),
      ).resolves.toBe(
        `# Added by LHIC CLI installer\nexport PATH="${join(homeDirectory, ".local", "bin")}:$PATH"\n`,
      );
    } finally {
      await rm(homeDirectory, { recursive: true, force: true });
    }
  });

  it("uses npm's Windows bin directory without touching a shell profile", async () => {
    const calls: readonly string[][] = [];
    const result = await installCliRuntime({
      platform: "win32",
      path: "C:\\npm;C:\\Windows",
      runNpm: async (argumentsList) => {
        (calls as string[][]).push([...argumentsList]);
        if (argumentsList[0] === "prefix") {
          return { stdout: "C:\\npm\n", stderr: "" };
        }
        return { stdout: "", stderr: "" };
      },
    });

    expect(result).toEqual({
      executable: "C:\\npm/lhic.cmd",
      pathUpdated: true,
      restartRequired: false,
    });
    expect(calls).toHaveLength(3);
  });
});

describe("desktop release selection", () => {
  const assets = [
    {
      name: "lhic-control-center-0.1.2-arm64.dmg",
      browser_download_url:
        "https://github.com/chengmatt416/LHIC/releases/download/v0.1.2/lhic-control-center-0.1.2-arm64.dmg",
    },
    {
      name: "lhic-control-center-0.1.2-x64.exe",
      browser_download_url:
        "https://github.com/chengmatt416/LHIC/releases/download/v0.1.2/lhic-control-center-0.1.2-x64.exe",
    },
    {
      name: "lhic-control-center-0.1.2-arm64.AppImage",
      browser_download_url:
        "https://github.com/chengmatt416/LHIC/releases/download/v0.1.2/lhic-control-center-0.1.2-arm64.AppImage",
    },
  ];

  it("selects only the matching platform and architecture installer", () => {
    expect(selectDesktopReleaseAsset(assets, "darwin", "arm64").name).toBe(
      "lhic-control-center-0.1.2-arm64.dmg",
    );
    expect(selectDesktopReleaseAsset(assets, "win32", "x64").name).toBe(
      "lhic-control-center-0.1.2-x64.exe",
    );
    expect(() => selectDesktopReleaseAsset(assets, "linux", "x64")).toThrow(
      "No LHIC Control Center installer",
    );
  });

  it("requires an exact SHA-256 manifest entry", () => {
    const checksum = "a".repeat(64);
    expect(
      parseSha256Manifest(
        `${checksum}  lhic-control-center-0.1.2-arm64.dmg\n`,
        "lhic-control-center-0.1.2-arm64.dmg",
      ),
    ).toBe(checksum);
    expect(() =>
      parseSha256Manifest(`${checksum} unrelated.dmg\n`, "app.dmg"),
    ).toThrow("no checksum");
  });

  it("downloads a verified Linux AppImage and creates a user launcher", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "lhic-desktop-home-"));
    const temporaryDirectory = await mkdtemp(
      join(tmpdir(), "lhic-desktop-temp-"),
    );
    const artifactName = "lhic-control-center-0.1.2-arm64.AppImage";
    const artifact = new TextEncoder().encode("verified desktop artifact");
    const checksum = await sha256(artifact);
    const releaseUrl =
      "https://github.com/chengmatt416/LHIC/releases/download/v0.1.2";
    const fetcher: typeof fetch = async (input) => {
      const url = input.toString();
      if (url.includes("api.github.com")) {
        return Response.json({
          tag_name: "v0.1.2",
          assets: [
            {
              name: artifactName,
              browser_download_url: `${releaseUrl}/${artifactName}`,
            },
            {
              name: "SHA256SUMS-0.1.2.txt",
              browser_download_url: `${releaseUrl}/SHA256SUMS-0.1.2.txt`,
            },
          ],
        });
      }
      if (url.endsWith("SHA256SUMS-0.1.2.txt")) {
        return new Response(`${checksum}  ${artifactName}\n`);
      }
      return new Response(artifact);
    };
    try {
      const result = await installDesktopApplication({
        platform: "linux",
        architecture: "arm64",
        homeDirectory,
        temporaryDirectory,
        fetcher,
      });

      expect(result).toEqual({
        release: "v0.1.2",
        artifact: artifactName,
        location: join(
          homeDirectory,
          ".local",
          "share",
          "lhic-control-center",
          "lhic-control-center.AppImage",
        ),
      });
      await expect(readFile(result.location, "utf8")).resolves.toBe(
        "verified desktop artifact",
      );
      await expect(
        readFile(
          join(
            homeDirectory,
            ".local",
            "share",
            "applications",
            "lhic-control-center.desktop",
          ),
          "utf8",
        ),
      ).resolves.toContain(`Exec=${result.location}`);
    } finally {
      await Promise.all([
        rm(homeDirectory, { recursive: true, force: true }),
        rm(temporaryDirectory, { recursive: true, force: true }),
      ]);
    }
  });

  it("uses shell-specific configuration files and npm bin conventions", () => {
    expect(profileForShell("/bin/zsh", "/home/person")).toBe(
      "/home/person/.zshrc",
    );
    expect(profileForShell("/bin/bash", "/home/person")).toBe(
      "/home/person/.bashrc",
    );
    expect(globalBinDirectory("C:\\npm", "win32")).toBe("C:\\npm");
    expect(globalBinDirectory("/opt/npm", "linux")).toBe("/opt/npm/bin");
  });
});

async function sha256(value: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", value);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
