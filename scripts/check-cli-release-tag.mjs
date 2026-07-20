import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const cliArtifacts = ["@pinyencheng/lhic", "lhic"];

export function parseCliReleaseTag(tag) {
  const match = /^cli-v(\d+\.\d+\.\d+)$/.exec(tag);
  if (!match?.[1]) {
    throw new Error(
      `CLI release tags must use cli-vX.Y.Z; received ${tag || "an empty tag"}.`,
    );
  }
  return match[1];
}

export async function checkCliReleaseTag(tag, rootDirectory = process.cwd()) {
  const version = parseCliReleaseTag(tag);
  const manifest = JSON.parse(
    await readFile(resolve(rootDirectory, "release-manifest.json"), "utf8"),
  );
  if (manifest.schemaVersion !== "lhic-release-manifest-v1") {
    throw new Error("Release manifest schema is invalid.");
  }

  const artifacts = new Map(
    manifest.artifacts.map((artifact) => [artifact.name, artifact]),
  );
  for (const name of cliArtifacts) {
    const artifact = artifacts.get(name);
    if (!artifact || artifact.version !== version) {
      throw new Error(`Release manifest does not declare ${name}@${version}.`);
    }
    if (!["release-candidate", "published"].includes(artifact.status)) {
      throw new Error(
        `Release manifest marks ${name}@${version} as ${artifact.status}, not releasable.`,
      );
    }
    const packageJson = JSON.parse(
      await readFile(resolve(rootDirectory, artifact.packagePath), "utf8"),
    );
    if (packageJson.name !== name || packageJson.version !== version) {
      throw new Error(`Package declaration does not match ${name}@${version}.`);
    }
  }

  return { tag, version, artifacts: cliArtifacts };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const result = await checkCliReleaseTag(process.env.RELEASE_TAG ?? "");
  console.log(
    `Verified ${result.tag} for ${result.artifacts.join(" and ")}@${result.version}.`,
  );
}
