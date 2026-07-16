import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceDirectory = resolve(packageDirectory, "..", "..");
const bundledPackages = [
  "browser",
  "controller",
  "memory",
  "schema",
  "security",
  "shared-skills",
  "skills",
  "trace",
  "verifier",
];
const bundleDirectory = join(packageDirectory, "node_modules", "@lhic");

await rm(bundleDirectory, { recursive: true, force: true });
await mkdir(bundleDirectory, { recursive: true });
for (const packageName of bundledPackages) {
  const sourceDirectory = join(workspaceDirectory, "packages", packageName);
  const destinationDirectory = join(bundleDirectory, packageName);
  await mkdir(destinationDirectory, { recursive: true });
  await cp(
    join(sourceDirectory, "package.json"),
    join(destinationDirectory, "package.json"),
  );
  await cp(join(sourceDirectory, "dist"), join(destinationDirectory, "dist"), {
    recursive: true,
  });
}

await removeTestArtifacts(join(packageDirectory, "dist"));
await removeTestArtifacts(bundleDirectory);

async function removeTestArtifacts(directory) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    (error) => {
      if (isMissingDirectoryError(error)) {
        return [];
      }
      throw error;
    },
  );
  for (const entry of entries) {
    const filePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      await removeTestArtifacts(filePath);
    } else if (entry.name.includes(".test.")) {
      await rm(filePath);
    }
  }
}

function isMissingDirectoryError(error) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
