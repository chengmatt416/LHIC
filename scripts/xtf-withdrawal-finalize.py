from pathlib import Path
import subprocess


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    if new in text:
        return
    if text.count(old) != 1:
        raise RuntimeError(f"Expected exactly one match in {path}: {old!r}")
    file.write_text(text.replace(old, new, 1))


installer_path = Path("apps/cli/src/installer.ts")
installer = installer_path.read_text()
installer = installer.replace(
    '''const githubReleaseUrl =
  "https://api.github.com/repos/chengmatt416/LHIC/releases/latest";''',
    '''const githubReleasesUrl =
  "https://api.github.com/repos/chengmatt416/LHIC/releases?per_page=100";
const maximumDesktopReleases = 100;
const maximumDesktopAssetsPerRelease = 200;
const maximumChecksumManifestBytes = 256 * 1024;
const maximumDesktopArtifactBytes = 1_500_000_000;''',
    1,
)
installer = installer.replace(
    '''export interface DesktopRelease {
  readonly tag_name: string;
  readonly assets: readonly DesktopReleaseAsset[];
}''',
    '''export interface DesktopRelease {
  readonly tag_name: string;
  readonly draft: boolean;
  readonly prerelease: boolean;
  readonly assets: readonly DesktopReleaseAsset[];
}''',
    1,
)
old_install = '''  const release = await fetchLatestDesktopRelease(fetcher);
  const artifact = selectDesktopReleaseAsset(
    release.assets,
    platform,
    architecture,
  );
  if (basename(artifact.name) !== artifact.name) {
    throw new Error(
      "The desktop release contains an invalid installer filename.",
    );
  }
  const checksumAsset = release.assets.find(
    (candidate) =>
      candidate.name === `SHA256SUMS-${release.tag_name.replace(/^v/, "")}.txt`,
  );
  if (!checksumAsset) {
    throw new Error("The desktop release does not include a SHA-256 manifest.");
  }
  const expectedChecksum = await fetchChecksum(
    fetcher,
    checksumAsset.browser_download_url,
    artifact.name,
  );'''
new_install = '''  const release = await fetchLatestDesktopRelease(fetcher);
  const releaseVersion = parseDesktopReleaseTag(release.tag_name);
  const artifact = selectDesktopReleaseAsset(
    release.assets,
    platform,
    architecture,
    releaseVersion,
  );
  if (basename(artifact.name) !== artifact.name) {
    throw new Error(
      "The desktop release contains an invalid installer filename.",
    );
  }
  const checksumName = `SHA256SUMS-${releaseVersion}.txt`;
  const checksumAssets = release.assets.filter(
    (candidate) => candidate.name === checksumName,
  );
  if (checksumAssets.length !== 1) {
    throw new Error(
      checksumAssets.length === 0
        ? "The desktop release does not include a SHA-256 manifest."
        : "The desktop release contains multiple SHA-256 manifests.",
    );
  }
  const checksumAsset = checksumAssets[0]!;
  const expectedChecksum = await fetchChecksum(
    fetcher,
    checksumAsset.browser_download_url,
    release.tag_name,
    checksumName,
    artifact.name,
  );'''
if old_install not in installer:
    raise RuntimeError("Unable to locate desktop install release selection block.")
installer = installer.replace(old_install, new_install, 1)
old_download_call = '''    await downloadVerifiedArtifact(
      fetcher,
      artifact.browser_download_url,
      downloadedArtifact,
      expectedChecksum,
    );'''
new_download_call = '''    await downloadVerifiedArtifact(
      fetcher,
      artifact.browser_download_url,
      downloadedArtifact,
      expectedChecksum,
      release.tag_name,
      artifact.name,
    );'''
if old_download_call not in installer:
    raise RuntimeError("Unable to locate desktop artifact download call.")
installer = installer.replace(old_download_call, new_download_call, 1)

start = installer.index("export function selectDesktopReleaseAsset(")
end = installer.index("export function profileForShell(")
replacement = '''export function selectDesktopReleaseAsset(
  assets: readonly DesktopReleaseAsset[],
  platform: NodeJS.Platform,
  architecture: string,
  releaseVersion?: string,
): DesktopReleaseAsset {
  const extension = desktopArtifactExtension(platform);
  const prefix = releaseVersion
    ? `lhic-control-center-${releaseVersion}-`
    : "lhic-control-center-";
  const suffix = `-${architecture}${extension}`;
  const matches = assets.filter(
    (candidate) =>
      candidate.name.startsWith(prefix) && candidate.name.endsWith(suffix),
  );
  if (matches.length === 0) {
    throw new Error(
      `No LHIC Control Center installer is published for ${platform}/${architecture}.`,
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `Multiple LHIC Control Center installers are published for ${platform}/${architecture}.`,
    );
  }
  return matches[0]!;
}

export function parseDesktopReleaseTag(tag: string): string {
  const match = tag.match(
    /^desktop-v(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)$/u,
  );
  if (!match) {
    throw new Error("Desktop release tag must be desktop-vX.Y.Z.");
  }
  const parts = match.slice(1).map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part))) {
    throw new Error("Desktop release version is outside the supported range.");
  }
  return parts.join(".");
}

export function selectLatestDesktopRelease(
  releases: readonly DesktopRelease[],
): DesktopRelease {
  const candidates: Array<{
    release: DesktopRelease;
    version: string;
    parts: number[];
  }> = [];
  const seenTags = new Set<string>();
  for (const release of releases) {
    if (release.draft || release.prerelease) continue;
    let version: string;
    try {
      version = parseDesktopReleaseTag(release.tag_name);
    } catch {
      continue;
    }
    if (seenTags.has(release.tag_name)) {
      throw new Error(`Desktop release list contains duplicate tag ${release.tag_name}.`);
    }
    seenTags.add(release.tag_name);
    candidates.push({
      release,
      version,
      parts: version.split(".").map(Number),
    });
  }
  candidates.sort((left, right) => {
    for (let index = 0; index < 3; index += 1) {
      const difference = right.parts[index]! - left.parts[index]!;
      if (difference !== 0) return difference;
    }
    return left.release.tag_name.localeCompare(right.release.tag_name);
  });
  if (!candidates[0]) {
    throw new Error("No stable desktop-vX.Y.Z release is published.");
  }
  return candidates[0].release;
}

export function parseSha256Manifest(
  manifest: string,
  artifactName: string,
): string {
  const escapedName = escapeRegularExpression(artifactName);
  const matches = [
    ...manifest.matchAll(
      new RegExp(`^([a-fA-F0-9]{64})\\\\s+[*]?${escapedName}$`, "gm"),
    ),
  ];
  if (!matches[0]?.[1]) {
    throw new Error(
      `The SHA-256 manifest has no checksum for ${artifactName}.`,
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `The SHA-256 manifest has multiple checksums for ${artifactName}.`,
    );
  }
  return matches[0][1].toLowerCase();
}

'''
installer = installer[:start] + replacement + installer[end:]

start = installer.index("async function fetchLatestDesktopRelease(")
end = installer.index("async function installDesktopArtifact(")
replacement = '''async function fetchLatestDesktopRelease(
  fetcher: typeof fetch,
): Promise<DesktopRelease> {
  const response = await fetcher(githubReleasesUrl, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "lhic-cli-installer",
    },
  });
  if (!response.ok) {
    throw new Error(
      `Unable to retrieve LHIC desktop releases (${response.status}).`,
    );
  }
  const payload: unknown = await response.json();
  if (
    !Array.isArray(payload) ||
    payload.length > maximumDesktopReleases
  ) {
    throw new Error("The LHIC desktop release list is invalid.");
  }
  return selectLatestDesktopRelease(payload.filter(isDesktopRelease));
}

async function fetchChecksum(
  fetcher: typeof fetch,
  url: string,
  releaseTag: string,
  checksumName: string,
  artifactName: string,
): Promise<string> {
  const response = await fetcher(
    verifiedGithubDownloadUrl(url, releaseTag, checksumName),
  );
  if (!response.ok) {
    throw new Error(
      `Unable to download the SHA-256 manifest (${response.status}).`,
    );
  }
  const manifest = await response.text();
  if (Buffer.byteLength(manifest, "utf8") > maximumChecksumManifestBytes) {
    throw new Error("The SHA-256 manifest exceeds the supported size limit.");
  }
  return parseSha256Manifest(manifest, artifactName);
}

async function downloadVerifiedArtifact(
  fetcher: typeof fetch,
  url: string,
  destination: string,
  expectedChecksum: string,
  releaseTag: string,
  artifactName: string,
): Promise<void> {
  const response = await fetcher(
    verifiedGithubDownloadUrl(url, releaseTag, artifactName),
  );
  if (!response.ok || !response.body) {
    throw new Error(
      `Unable to download the desktop installer (${response.status}).`,
    );
  }
  const declaredLength = response.headers.get("content-length");
  if (declaredLength) {
    if (!/^\\d+$/u.test(declaredLength)) {
      throw new Error("The desktop installer has an invalid Content-Length.");
    }
    if (Number(declaredLength) > maximumDesktopArtifactBytes) {
      throw new Error("The desktop installer exceeds the supported size limit.");
    }
  }
  const checksum = createHash("sha256");
  let downloadedBytes = 0;
  const hasher = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      downloadedBytes += chunk.length;
      if (downloadedBytes > maximumDesktopArtifactBytes) {
        callback(
          new Error("The desktop installer exceeds the supported size limit."),
        );
        return;
      }
      checksum.update(chunk);
      callback(null, chunk);
    },
  });
  await pipeline(
    Readable.from(readResponseBody(response.body)),
    hasher,
    createWriteStream(destination, { flags: "wx", mode: 0o600 }),
  );
  const actualChecksum = checksum.digest("hex");
  if (actualChecksum !== expectedChecksum) {
    throw new Error(
      "The desktop installer checksum did not match the release manifest.",
    );
  }
}

'''
installer = installer[:start] + replacement + installer[end:]

start = installer.index("function verifiedGithubDownloadUrl(")
end = installer.index("function pathIncludes(")
replacement = '''function verifiedGithubDownloadUrl(
  url: string,
  releaseTag: string,
  assetName: string,
): string {
  parseDesktopReleaseTag(releaseTag);
  if (
    basename(assetName) !== assetName ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/u.test(assetName)
  ) {
    throw new Error("The desktop release contains an invalid asset name.");
  }
  const parsed = new URL(url);
  const expectedPath = `/chengmatt416/LHIC/releases/download/${releaseTag}/${assetName}`;
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "github.com" ||
    parsed.port !== "" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.pathname !== expectedPath
  ) {
    throw new Error("The desktop release contains an untrusted download URL.");
  }
  return parsed.toString();
}

function isDesktopRelease(value: unknown): value is DesktopRelease {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<DesktopRelease>;
  return (
    typeof candidate.tag_name === "string" &&
    candidate.tag_name.length <= 64 &&
    typeof candidate.draft === "boolean" &&
    typeof candidate.prerelease === "boolean" &&
    Array.isArray(candidate.assets) &&
    candidate.assets.length > 0 &&
    candidate.assets.length <= maximumDesktopAssetsPerRelease &&
    candidate.assets.every(
      (asset) =>
        asset &&
        typeof asset.name === "string" &&
        /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/u.test(asset.name) &&
        typeof asset.browser_download_url === "string" &&
        asset.browser_download_url.length <= 2_048,
    )
  );
}

'''
installer = installer[:start] + replacement + installer[end:]
installer_path.write_text(installer)


test_path = Path("apps/cli/src/installer.test.ts")
test = test_path.read_text()
test = test.replace(
    '''  parseSha256Manifest,
  profileForShell,
  selectDesktopReleaseAsset,''',
    '''  parseDesktopReleaseTag,
  parseSha256Manifest,
  profileForShell,
  selectDesktopReleaseAsset,
  selectLatestDesktopRelease,''',
    1,
)
start = test.index('describe("desktop release selection"')
end = test.index("\nasync function sha256")
new_block = '''describe("desktop release selection", () => {
  const version = "0.1.4";
  const tag = `desktop-v${version}`;
  const releaseUrl =
    `https://github.com/chengmatt416/LHIC/releases/download/${tag}`;
  const assets = [
    {
      name: `lhic-control-center-${version}-arm64.dmg`,
      browser_download_url:
        `${releaseUrl}/lhic-control-center-${version}-arm64.dmg`,
    },
    {
      name: `lhic-control-center-${version}-x64.exe`,
      browser_download_url:
        `${releaseUrl}/lhic-control-center-${version}-x64.exe`,
    },
    {
      name: `lhic-control-center-${version}-arm64.AppImage`,
      browser_download_url:
        `${releaseUrl}/lhic-control-center-${version}-arm64.AppImage`,
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
    expect(() => parseDesktopReleaseTag("v0.1.4")).toThrow(
      "desktop-vX.Y.Z",
    );
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
      parseSha256Manifest(`${checksum}  ${artifactName}\n`, artifactName),
    ).toBe(checksum);
    expect(() =>
      parseSha256Manifest(`${checksum} unrelated.dmg\n`, "app.dmg"),
    ).toThrow("no checksum");
    expect(() =>
      parseSha256Manifest(
        `${checksum}  ${artifactName}\n${checksum}  ${artifactName}\n`,
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
              browser_download_url:
                `${releaseUrl}/SHA256SUMS-${version}.txt`,
            },
          ]),
        ]);
      }
      if (url.endsWith(`SHA256SUMS-${version}.txt`)) {
        return new Response(`${checksum}  ${artifactName}\n`);
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
              browser_download_url:
                `https://github.com/other/project/releases/download/${tag}/${artifactName}`,
            },
            {
              name: `SHA256SUMS-${version}.txt`,
              browser_download_url:
                `${releaseUrl}/SHA256SUMS-${version}.txt`,
            },
          ]),
        ]);
      }
      return new Response(`${checksum}  ${artifactName}\n`);
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
    expect(globalBinDirectory("C:\\npm", "win32")).toBe("C:\\npm");
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
'''
test = test[:start] + new_block + test[end:]
test_path.write_text(test)

workflow = Path(".github/workflows/product-readiness.yml")
workflow_text = workflow.read_text()
workflow_text = workflow_text.replace(
    '''      - "apps/cli/src/product-data*"''',
    '''      - "apps/cli/src/product-data*"
      - "apps/cli/src/installer*"''',
    1,
)
workflow_text = workflow_text.replace(
    '''run: npx vitest run apps/cli/src/product-data.test.ts apps/cli/src/user-experience.test.ts''',
    '''run: >-
          npx vitest run
          apps/cli/src/product-data.test.ts
          apps/cli/src/user-experience.test.ts
          apps/cli/src/installer.test.ts''',
    1,
)
workflow.write_text(workflow_text)

replace_once(
    "README.md",
    '''with a SHA-256-verified GitHub Release asset. macOS installs to''',
    '''with a SHA-256-verified asset from the highest stable `desktop-vX.Y.Z` GitHub Release. CLI-only, draft, and prerelease tags are ignored. macOS installs to''',
)

files = [
    str(installer_path),
    str(test_path),
    str(workflow),
    "README.md",
]
subprocess.run(["npx", "prettier", "--write", *files], check=True)
subprocess.run(
    [
        "npx",
        "vitest",
        "run",
        "apps/cli/src/installer.test.ts",
        "apps/cli/src/product-data.test.ts",
    ],
    check=True,
)
subprocess.run(["npm", "run", "package:smoke"], check=True)
subprocess.run(["git", "add", *files], check=True)
