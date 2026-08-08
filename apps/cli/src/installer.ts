import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  access,
  appendFile,
  chmod,
  cp,
  mkdir,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const cliPackageName = "@pinyencheng/lhic";
const githubReleaseUrl =
  "https://api.github.com/repos/chengmatt416/LHIC/releases/latest";

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
  const packageSpec = `${cliPackageName}@latest`;

  const userPrefix =
    platform === "win32" ? undefined : join(homeDirectory, ".local");
  await runNpm([
    "install",
    "--global",
    ...(userPrefix ? ["--prefix", userPrefix] : []),
    packageSpec,
  ]);
  await runNpm([
    "exec",
    "--yes",
    "--package",
    packageSpec,
    "--",
    "playwright",
    "install",
    "chromium",
  ]);

  if (platform === "win32") {
    const npmPrefix = (await runNpm(["prefix", "--global"])).stdout.trim();
    if (!npmPrefix) {
      throw new Error("npm did not return its global installation prefix.");
    }
    const executable = join(
      globalBinDirectory(npmPrefix, platform),
      "lhic.cmd",
    );
    const binDirectory = dirname(executable);
    const available = pathIncludes(currentPath, binDirectory, platform);
    return {
      executable,
      pathUpdated: available,
      restartRequired: !available,
    };
  }

  const userBinDirectory = join(userPrefix!, "bin");
  const userExecutable = join(userBinDirectory, "lhic");
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
  );
  const workingDirectory = await createWorkingDirectory(temporaryDirectory);
  const downloadedArtifact = join(workingDirectory, artifact.name);
  try {
    await downloadVerifiedArtifact(
      fetcher,
      artifact.browser_download_url,
      downloadedArtifact,
      expectedChecksum,
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
): DesktopReleaseAsset {
  const extension = desktopArtifactExtension(platform);
  const suffix = `-${architecture}${extension}`;
  const asset = assets.find(
    (candidate) =>
      candidate.name.startsWith("lhic-control-center-") &&
      candidate.name.endsWith(suffix),
  );
  if (!asset) {
    throw new Error(
      `No LHIC Control Center installer is published for ${platform}/${architecture}.`,
    );
  }
  return asset;
}

export function parseSha256Manifest(
  manifest: string,
  artifactName: string,
): string {
  const escapedName = escapeRegularExpression(artifactName);
  const match = manifest.match(
    new RegExp(`^([a-fA-F0-9]{64})\\s+[*]?${escapedName}$`, "m"),
  );
  if (!match?.[1]) {
    throw new Error(
      `The SHA-256 manifest has no checksum for ${artifactName}.`,
    );
  }
  return match[1].toLowerCase();
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
  const response = await fetcher(githubReleaseUrl, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "lhic-cli-installer",
    },
  });
  if (!response.ok) {
    throw new Error(
      `Unable to retrieve the LHIC desktop release (${response.status}).`,
    );
  }
  const payload: unknown = await response.json();
  if (!isDesktopRelease(payload)) {
    throw new Error("The LHIC desktop release response is invalid.");
  }
  return payload;
}

async function fetchChecksum(
  fetcher: typeof fetch,
  url: string,
  artifactName: string,
): Promise<string> {
  const response = await fetcher(verifiedGithubDownloadUrl(url));
  if (!response.ok) {
    throw new Error(
      `Unable to download the SHA-256 manifest (${response.status}).`,
    );
  }
  return parseSha256Manifest(await response.text(), artifactName);
}

async function downloadVerifiedArtifact(
  fetcher: typeof fetch,
  url: string,
  destination: string,
  expectedChecksum: string,
): Promise<void> {
  const response = await fetcher(verifiedGithubDownloadUrl(url));
  if (!response.ok || !response.body) {
    throw new Error(
      `Unable to download the desktop installer (${response.status}).`,
    );
  }
  const checksum = createHash("sha256");
  const hasher = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
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

function verifiedGithubDownloadUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com") {
    throw new Error("The desktop release contains an untrusted download URL.");
  }
  return parsed.toString();
}

function isDesktopRelease(value: unknown): value is DesktopRelease {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<DesktopRelease>;
  return (
    typeof candidate.tag_name === "string" &&
    Array.isArray(candidate.assets) &&
    candidate.assets.every(
      (asset) =>
        asset &&
        typeof asset.name === "string" &&
        typeof asset.browser_download_url === "string",
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
