import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, readdir, rename, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const installerExtensions = new Set([
  ".appimage",
  ".deb",
  ".dmg",
  ".exe",
  ".rpm",
  ".zip",
]);

export async function createSha256Manifest(
  directory,
  version,
  outputPath = join(directory, `SHA256SUMS-${version}.txt`),
) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error("Release checksum manifests require a semantic version.");
  }
  const artifacts = await findInstallerArtifacts(resolve(directory));
  if (artifacts.length === 0) {
    throw new Error(`No desktop installer artifacts found in ${directory}.`);
  }
  const names = new Set();
  const entries = [];
  for (const artifact of artifacts) {
    const name = basename(artifact);
    if (names.has(name)) {
      throw new Error(`Duplicate release artifact filename: ${name}.`);
    }
    names.add(name);
    entries.push({
      name,
      line: `${await sha256File(artifact)}  ${name}`,
    });
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  const temporaryPath = `${outputPath}.tmp-${process.pid}`;
  await writeFile(
    temporaryPath,
    `${entries.map((entry) => entry.line).join("\n")}\n`,
    {
      encoding: "utf8",
      mode: 0o600,
    },
  );
  await rename(temporaryPath, outputPath);
  return { outputPath, artifacts: entries.length };
}

async function findInstallerArtifacts(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await findInstallerArtifacts(path)));
      continue;
    }
    if (
      entry.isFile() &&
      entry.name.startsWith("lhic-control-center-") &&
      installerExtensions.has(extname(entry.name).toLowerCase())
    ) {
      found.push(path);
    }
  }
  return found.sort();
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

async function main() {
  const directory = resolve(process.argv[2] ?? "apps/desktop/release");
  const packagePath = join(process.cwd(), "package.json");
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  const version = process.argv[3] ?? packageJson.version;
  const outputPath =
    process.argv[4] ?? join(directory, `SHA256SUMS-${version}.txt`);
  const result = await createSha256Manifest(directory, version, outputPath);
  console.log(
    `Generated ${result.outputPath} for ${result.artifacts} desktop artifact${result.artifacts === 1 ? "" : "s"}.`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
