import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, readFileSync } from "node:fs";
import {
  access,
  appendFile,
  chmod,
  cp,
  lstat,
  mkdir,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const cliPackageName = "@pinyencheng/lhic";
const cliPackageVersion = readCliPackageVersion();
const githubReleasesUrl =
  "https://api.github.com/repos/chengmatt416/LHIC/releases?per_page=100";
const maximumDesktopReleases = 100;
const maximumDesktopAssetsPerRelease = 200;
const maximumChecksumManifestBytes = 256 * 1024;
const maximumDesktopArtifactBytes = 1_500_000_000;

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

export interface CliInstallResult {
  readonly executable: string;
  readonly pathUpdated: boolean;
  readonly restartRequired: boolean;
}

export interface DesktopReleaseAsset {
  readonly name: string;
  readonly browser_download_url: string;
}

export interface DesktopRelease {
  readonly tag_name: string;
  readonly draft: boolean;
  readonly prerelease: boolean;
  readonly assets: readonly DesktopReleaseAsset[];
}

export interface DesktopInstallResult {
  readonly release: string;
  readonly artifact: string;
  readonly location: string;
}

export interface CliInstallerOptions {
  readonly platform?: NodeJS.Platform;
  readonly homeDirectory?: string;
  readonly shell?: string | undefined;
  readonly path?: string | undefined;
  readonly version?: string;
  readonly runNpm?: (
    argumentsList: readonly string[],
  ) => Promise<CommandResult>;
}

export interface DesktopInstallerOptions {
  readonly platform?: NodeJS.Platform;
  readonly architecture?: string;
  readonly homeDirectory?: string;
  readonly temporaryDirectory?: string;
  readonly fetcher?: typeof fetch;
  readonly runCommand?: (
    file: string,
    argumentsList: readonly string[],
  ) => Promise<CommandResult>;
}

export async function installCliRuntime(
  options: CliInstallerOptions = {},
): Promise<CliInstallResult> {
  const platform = options.platform ?? process.platform;
  const homeDirectory = options.homeDirectory ?? homedir();
  const runNpm = options.runNpm ?? runNpmCommand;
  const currentPath = options.path ?? process.env.PATH ?? process.env.Path;
  const version = parseCliPackageVersion(options.version ?? cliPackageVersion);
  const packageSpecifier = `${cliPackageName}@${version}`;

  await runNpm(["install", "--global", packageSpecifier]);
  await runNpm([
    "exec",
    "--yes",
    "--package",
    packageSpecifier,
    "--",
    "playwright",
    "install",
    "chromium",
  ]);
  const npmPrefix = (await runNpm(["prefix", "--global"])).stdout.trim();
  if (!npmPrefix) {
    throw new Error("npm did not return its global installation prefix.");
  }

  const globalExecutable = join(
    globalBinDirectory(npmPrefix, platform),
    platform === "win32" ? "lhic.cmd" : "lhic",
  );
  if (platform === "win32") {
    return {
      executable: globalExecutable,
      pathUpdated: pathIncludes(
        currentPath,
        dirname(globalExecutable),
        platform,
      ),
      restartRequired: !pathIncludes(
        currentPath,
        dirname(globalExecutable),
        platform,
      ),
    };
  }

  const userBinDirectory = join(homeDirectory, ".local", "bin");
  await mkdir(userBinDirectory, { recursive: true, mode: 0o755 });
  const userExecutable = join(userBinDirectory, "lhic");
  await replaceSymlink(userExecutable, globalExecutable);
  const profile = profileForShell(
    options.shell ?? process.env.SHELL,
    homeDirectory,
  );
  const pathUpdated = await appendPathExport(profile, userBinDirectory);
  return {
    executable: userExecutable,
    pathUpdated,
    restartRequired: !pathIncludes(currentPath, userBinDirectory, platform),
  };
}

export async function installDesktopApplication(
  options: DesktopInstallerOptions = {},
): Promise<DesktopInstallResult> {
  const platform = options.platform ?? process.platform;
  const architecture = options.architecture ?? process.arch;
  const homeDirectory = options.homeDirectory ?? homedir();
  const temporaryDirectory = options.temporaryDirectory ?? tmpdir();
  const fetcher = options.fetcher ?? fetch;
  const runCommand = options.runCommand ?? runSystemCommand;
  const release = await fetchLatestDesktopRelease(fetcher);
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
  );
  const workingDirectory = await createWorkingDirectory(temporaryDirectory);
  const downloadedArtifact = join(workingDirectory, artifact.name);
  try {
    await downloadVerifiedArtifact(
      fetcher,
      artifact.browser_download_url,
      downloadedArtifact,
      expectedChecksum,
      release.tag_name,
      artifact.name,
    );
    const location = await installDesktopArtifact({
      platform,
      homeDirectory,
      downloadedArtifact,
      runCommand,
    });
    return { release: release.tag_name, artifact: artifact.name, location };
  } finally {
    await rm(workingDirectory, { recursive: true, force: true });
  }
}

export function selectDesktopReleaseAsset(
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
    /^desktop-v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u,
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
      throw new Error(
        `Desktop release list contains duplicate tag ${release.tag_name}.`,
      );
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
      new RegExp(`^([a-fA-F0-9]{64})\\s+[*]?${escapedName}$`, "gm"),
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

export function profileForShell(
  shell: string | undefined,
  homeDirectory: string,
): string {
  if (shell?.endsWith("/zsh")) return join(homeDirectory, ".zshrc");
  if (shell?.endsWith("/bash")) return join(homeDirectory, ".bashrc");
  return join(homeDirectory, ".profile");
}

export function globalBinDirectory(
  npmPrefix: string,
  platform: NodeJS.Platform,
): string {
  return platform === "win32" ? npmPrefix : join(npmPrefix, "bin");
}

async function fetchLatestDesktopRelease(
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
  if (!Array.isArray(payload) || payload.length > maximumDesktopReleases) {
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
    if (!/^\d+$/u.test(declaredLength)) {
      throw new Error("The desktop installer has an invalid Content-Length.");
    }
    if (Number(declaredLength) > maximumDesktopArtifactBytes) {
      throw new Error(
        "The desktop installer exceeds the supported size limit.",
      );
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

async function installDesktopArtifact(options: {
  readonly platform: NodeJS.Platform;
  readonly homeDirectory: string;
  readonly downloadedArtifact: string;
  readonly runCommand: (
    file: string,
    argumentsList: readonly string[],
  ) => Promise<CommandResult>;
}): Promise<string> {
  switch (options.platform) {
    case "darwin":
      return installMacApplication(options);
    case "win32":
      await options.runCommand(options.downloadedArtifact, ["/S"]);
      return "Windows Apps (installed by the release NSIS installer)";
    case "linux":
      return installLinuxApplication(options);
    default:
      throw new Error(
        `Desktop installation is unsupported on ${options.platform}.`,
      );
  }
}

async function installMacApplication(options: {
  readonly homeDirectory: string;
  readonly downloadedArtifact: string;
  readonly runCommand: (
    file: string,
    argumentsList: readonly string[],
  ) => Promise<CommandResult>;
}): Promise<string> {
  const workingDirectory = dirname(options.downloadedArtifact);
  const mountDirectory = join(workingDirectory, "mounted");
  await mkdir(mountDirectory, { recursive: true, mode: 0o700 });
  await options.runCommand("hdiutil", [
    "attach",
    options.downloadedArtifact,
    "-nobrowse",
    "-readonly",
    "-mountpoint",
    mountDirectory,
  ]);
  try {
    const appBundle = await findMacApplicationBundle(mountDirectory);
    const destinationDirectory = join(options.homeDirectory, "Applications");
    const destination = join(destinationDirectory, basename(appBundle));
    await mkdir(destinationDirectory, { recursive: true, mode: 0o755 });
    await replaceApplicationBundle(appBundle, destination);
    await options.runCommand("open", [destination]);
    return destination;
  } finally {
    await options
      .runCommand("hdiutil", ["detach", mountDirectory])
      .catch(() => undefined);
  }
}

async function installLinuxApplication(options: {
  readonly homeDirectory: string;
  readonly downloadedArtifact: string;
}): Promise<string> {
  const applicationDirectory = join(
    options.homeDirectory,
    ".local",
    "share",
    "lhic-control-center",
  );
  const destination = join(
    applicationDirectory,
    "lhic-control-center.AppImage",
  );
  await mkdir(applicationDirectory, { recursive: true, mode: 0o755 });
  await cp(options.downloadedArtifact, destination, { force: true });
  await chmod(destination, 0o755);
  const launcherDirectory = join(
    options.homeDirectory,
    ".local",
    "share",
    "applications",
  );
  await mkdir(launcherDirectory, { recursive: true, mode: 0o755 });
  await writeFile(
    join(launcherDirectory, "lhic-control-center.desktop"),
    [
      "[Desktop Entry]",
      "Type=Application",
      "Name=LHIC Control Center",
      "Comment=Local Human Intent Controller",
      `Exec=${escapeDesktopEntryValue(destination)}`,
      "Terminal=false",
      "Categories=Utility;",
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o644 },
  );
  return destination;
}

async function findMacApplicationBundle(
  mountDirectory: string,
): Promise<string> {
  const entries = await readdir(mountDirectory, { withFileTypes: true });
  const app = entries.find(
    (entry) => entry.isDirectory() && entry.name.endsWith(".app"),
  );
  if (!app) {
    throw new Error(
      "The downloaded DMG does not contain an application bundle.",
    );
  }
  return join(mountDirectory, app.name);
}

async function replaceApplicationBundle(
  source: string,
  destination: string,
): Promise<void> {
  const staging = `${destination}.lhic-staging`;
  const backup = `${destination}.lhic-backup`;
  await rm(staging, { recursive: true, force: true });
  await rm(backup, { recursive: true, force: true });
  await cp(source, staging, { recursive: true, force: true });
  try {
    if (await exists(destination)) await rename(destination, backup);
    await rename(staging, destination);
    await rm(backup, { recursive: true, force: true });
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    if ((await exists(backup)) && !(await exists(destination))) {
      await rename(backup, destination);
    }
    throw error;
  }
}

async function replaceSymlink(
  targetPath: string,
  sourcePath: string,
): Promise<void> {
  if (await exists(targetPath)) {
    const existing = await lstat(targetPath);
    if (!existing.isSymbolicLink()) {
      throw new Error(
        `${targetPath} already exists and is not an LHIC-managed symbolic link.`,
      );
    }
    await rm(targetPath);
  }
  await symlink(sourcePath, targetPath);
}

async function appendPathExport(
  profile: string,
  userBinDirectory: string,
): Promise<boolean> {
  const marker = "# Added by LHIC CLI installer";
  const pathExport = `${marker}\nexport PATH="${userBinDirectory}:$PATH"\n`;
  const content = await readOptionalText(profile);
  if (content.includes(marker)) return false;
  await mkdir(dirname(profile), { recursive: true, mode: 0o700 });
  await appendFile(
    profile,
    `${content && !content.endsWith("\n") ? "\n" : ""}${pathExport}`,
    {
      encoding: "utf8",
      mode: 0o600,
    },
  );
  return true;
}

async function readOptionalText(path: string): Promise<string> {
  try {
    const { readFile } = await import("node:fs/promises");
    return await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) return "";
    throw error;
  }
}

async function createWorkingDirectory(parent: string): Promise<string> {
  const { mkdtemp } = await import("node:fs/promises");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  return mkdtemp(join(parent, "lhic-desktop-"));
}

function desktopArtifactExtension(platform: NodeJS.Platform): string {
  switch (platform) {
    case "darwin":
      return ".dmg";
    case "win32":
      return ".exe";
    case "linux":
      return ".AppImage";
    default:
      throw new Error(`Desktop installation is unsupported on ${platform}.`);
  }
}

function verifiedGithubDownloadUrl(
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

function pathIncludes(
  pathValue: string | undefined,
  directory: string,
  platform: NodeJS.Platform,
): boolean {
  return Boolean(
    pathValue?.split(platform === "win32" ? ";" : ":").includes(directory),
  );
}

async function* readResponseBody(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) return;
      yield next.value;
    }
  } finally {
    reader.releaseLock();
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (isMissingFileError(error)) return false;
    throw error;
  }
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeDesktopEntryValue(value: string): string {
  return value.replace(/([\\\s"'`$])/g, "\\$1");
}

export function parseCliPackageVersion(value: string): string {
  const match = value.match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u);
  if (!match) {
    throw new Error("CLI package version must be an exact X.Y.Z version.");
  }
  const parts = match.slice(1).map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part))) {
    throw new Error("CLI package version is outside the supported range.");
  }
  return parts.join(".");
}

function readCliPackageVersion(): string {
  const packageFile = fileURLToPath(
    new URL("../package.json", import.meta.url),
  );
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(packageFile, "utf8")) as unknown;
  } catch {
    throw new Error("Unable to read the installed LHIC package metadata.");
  }
  if (
    !value ||
    typeof value !== "object" ||
    (value as { name?: unknown }).name !== cliPackageName ||
    typeof (value as { version?: unknown }).version !== "string"
  ) {
    throw new Error("Installed LHIC package metadata is invalid.");
  }
  return parseCliPackageVersion((value as { version: string }).version);
}

async function runNpmCommand(
  argumentsList: readonly string[],
): Promise<CommandResult> {
  return runSystemCommand(
    process.platform === "win32" ? "npm.cmd" : "npm",
    argumentsList,
  );
}

async function runSystemCommand(
  file: string,
  argumentsList: readonly string[],
): Promise<CommandResult> {
  return execFileAsync(file, [...argumentsList], {
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: false,
  });
}
