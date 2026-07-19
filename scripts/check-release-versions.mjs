import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const manifest = JSON.parse(
  await readFile(resolve(root, "release-manifest.json"), "utf8"),
);

if (
  manifest.schemaVersion !== "lhic-release-manifest-v1" ||
  !Array.isArray(manifest.artifacts) ||
  manifest.artifacts.length === 0
) {
  throw new Error("Release manifest is invalid.");
}

const names = new Set();
for (const artifact of manifest.artifacts) {
  if (
    !artifact ||
    typeof artifact.name !== "string" ||
    typeof artifact.packagePath !== "string" ||
    !/^\d+\.\d+\.\d+$/.test(artifact.version ?? "") ||
    !["release-candidate", "development-build", "published"].includes(
      artifact.status,
    ) ||
    names.has(artifact.name)
  ) {
    throw new Error("Release manifest contains an invalid artifact.");
  }
  names.add(artifact.name);
  const packageJson = JSON.parse(
    await readFile(resolve(root, artifact.packagePath), "utf8"),
  );
  if (
    packageJson.name !== artifact.name ||
    packageJson.version !== artifact.version
  ) {
    throw new Error(
      `Release manifest does not match ${artifact.packagePath}: expected ${artifact.name}@${artifact.version}.`,
    );
  }
}

console.log(
  `Verified ${manifest.artifacts.length} release artifact version declaration${manifest.artifacts.length === 1 ? "" : "s"}.`,
);
