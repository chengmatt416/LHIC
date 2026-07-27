import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  globalBinDirectory,
  installDesktopApplication,
  installCliRuntime,
  parseDesktopReleaseTag,
  parseSha256Manifest,
  profileForShell,
  selectDesktopReleaseAsset,
  selectLatestDesktopRelease,
} from "./installer.js";

describe("CLI installer", () => {
  it("installs the global CLI, browser runtime, and stable user command", async () => {
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
        ["install", "--global", "@pinyencheng/lhic@latest"],
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
        ["prefix", "--global"],
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
  const version = "0.1.4";
  const tag = `desktop-v${version}`;
  const releaseUrl = `https://github.com/chengmatt416/LHIC/releases/download/${tag}`;
  const assets = [
    {
      name: `lhic-control-center-${version}-arm64.dmg`,
      browser_download_url: `${releaseUrl}/lhic-control-center-${version}-arm64.dmg`,
    },
    {
      name: `lhic-control-center-${version}-x64.exe`,
      browser_download_url: `${releaseUrl}/lhic-control-center-${version}-x64.exe`,
    },
    {
      name: `lhic-control-center-${version}-arm64.AppImage`,
      browser_download_url: `${releaseUrl}/lhic-control-center-${version}-arm64.AppImage`,
    },
  ];

  it("selects only the matching version, platform, and architecture installer", () => {
    expect(
      selectDesktopReleaseAsset(assets, "darwin", "arm64", version).name,
    ).toBe(`lhic-control-center-${version}-arm64.dmg`);
    expect(
      selectDesktopReleaseAsset(assets, "win32", "x64", version).name,
    ).toBe(`lhic-control-center-${version}-x64.exe`);
    expect(() =>
      selectDesktopReleaseAsset(assets, "linux", "x64", version),
    ).toThrow("No LHIC Control Center installer");
    expect(() =>
      selectDesktopReleaseAsset(
        [assets[0]!, { ...assets[0] }],
        "darwin",
        "arm64",
        version,
      ),
    ).toThrow("Multiple LHIC Control Center installers");
    expect(() =>
      selectDesktopReleaseAsset(assets, "darwin", "arm64", "0.1.5"),
    ).toThrow("No LHIC Control Center installer");
  });

  it("selects the highest stable desktop tag and ignores unrelated releases", () => {
    expect(parseDesktopReleaseTag("desktop-v0.1.4")).toBe("0.1.4");
    expect(() => parseDesktopReleaseTag("v0.1.4")).toThrow("desktop-vX.Y.Z");
    const selected = selectLatestDesktopRelease([
      release("cli-v9.0.0", false, false),
      release("desktop-v0.1.6", true, false),
      release("desktop-v0.1.5", false, true),
      release("desktop-v0.1.3", false, false),
      release("desktop-v0.1.4", false, false),
    ]);
    expect(selected.tag_name).toBe("desktop-v0.1.4");
    expect(() =>
      selectLatestDesktopRelease([
        release("cli-v9.0.0", false, false),
        release("desktop-v0.1.5", false, true),
      ]),
    ).toThrow("No stable desktop-vX.Y.Z release");
  });

  it("requires one exact SHA-256 manifest entry", () => {
    const checksum = "a".repeat(64);
    const artifactName = `lhic-control-center-${version}-arm64.dmg`;
    expect(
      parseSha256Manifest(
        `${checksum}  ${artifactName}
`,
        artifactName,
      ),
    ).toBe(checksum);
    expect(() =>
      parseSha256Manifest(
        `${checksum} unrelated.dmg
`,
        "app.dmg",
      ),
    ).toThrow("no checksum");
    expect(() =>
      parseSha256Manifest(
        `${checksum}  ${artifactName}
${checksum}  ${artifactName}
`,
        artifactName,
      ),
    ).toThrow("multiple checksums");
  });

  it("ignores a newer CLI release and installs the stable desktop release", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "lhic-desktop-home-"));
    const temporaryDirectory = await mkdtemp(
      join(tmpdir(), "lhic-desktop-temp-"),
    );
    const artifactName = `lhic-control-center-${version}-arm64.AppImage`;
    const artifact = new TextEncoder().encode("verified desktop artifact");
    const checksum = await sha256(artifact);
    const fetcher: typeof fetch = async (input) => {
      const url = input.toString();
      if (url.includes("api.github.com")) {
        return Response.json([
          release("cli-v9.0.0", false, false),
          release(tag, false, false, [
            {
              name: artifactName,
              browser_download_url: `${releaseUrl}/${artifactName}`,
            },
            {
              name: `SHA256SUMS-${version}.txt`,
              browser_download_url: `${releaseUrl}/SHA256SUMS-${version}.txt`,
            },
          ]),
        ]);
      }
      if (url.endsWith(`SHA256SUMS-${version}.txt`)) {
        return new Response(`${checksum}  ${artifactName}
`);
      }
      return new Response(artifact, {
        headers: { "content-length": String(artifact.byteLength) },
      });
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
        release: tag,
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

  it("rejects a same-name artifact hosted under another release path", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "lhic-desktop-home-"));
    const temporaryDirectory = await mkdtemp(
      join(tmpdir(), "lhic-desktop-temp-"),
    );
    const artifactName = `lhic-control-center-${version}-arm64.AppImage`;
    const checksum = "a".repeat(64);
    const fetcher: typeof fetch = async (input) => {
      const url = input.toString();
      if (url.includes("api.github.com")) {
        return Response.json([
          release(tag, false, false, [
            {
              name: artifactName,
              browser_download_url: `https://github.com/other/project/releases/download/${tag}/${artifactName}`,
            },
            {
              name: `SHA256SUMS-${version}.txt`,
              browser_download_url: `${releaseUrl}/SHA256SUMS-${version}.txt`,
            },
          ]),
        ]);
      }
      return new Response(`${checksum}  ${artifactName}
`);
    };
    try {
      await expect(
        installDesktopApplication({
          platform: "linux",
          architecture: "arm64",
          homeDirectory,
          temporaryDirectory,
          fetcher,
        }),
      ).rejects.toThrow("untrusted download URL");
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
    expect(globalBinDirectory("C:\npm", "win32")).toBe("C:\npm");
    expect(globalBinDirectory("/opt/npm", "linux")).toBe("/opt/npm/bin");
  });
});

function release(
  tag_name: string,
  draft: boolean,
  prerelease: boolean,
  assets: Array<{ name: string; browser_download_url: string }> = [
    {
      name: "placeholder.txt",
      browser_download_url:
        "https://github.com/chengmatt416/LHIC/releases/download/desktop-v0.0.1/placeholder.txt",
    },
  ],
) {
  return { tag_name, draft, prerelease, assets };
}

async function sha256(value: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", value);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
