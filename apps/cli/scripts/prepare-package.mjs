import { chmod, cp, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceDirectory = resolve(packageDirectory, "..", "..");
for (const filename of ["LICENSE-MIT", "LICENSE-APACHE"]) {
  await cp(
    join(workspaceDirectory, filename),
    join(packageDirectory, filename),
  );
}
const bundledPackages = [
  "browser",
  "controller",
  "game-training",
  "game-training-2d",
  "game-training-3d",
  "memory",
  "schema",
  "security",
  "shared-skills",
  "skills",
  "trace",
  "verifier",
];
const bundleDirectory = join(packageDirectory, "node_modules", "@lhic");

await rm(bundleDirectory, {
  recursive: true,
  force: true,
  maxRetries: 5,
  retryDelay: 100,
});
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
  if (packageName === "game-training") {
    await cp(
      join(sourceDirectory, "python"),
      join(destinationDirectory, "python"),
      { recursive: true },
    );
    await cp(
      join(sourceDirectory, "requirements.txt"),
      join(destinationDirectory, "requirements.txt"),
    );
  }
}

await removeTestArtifacts(join(packageDirectory, "dist"));
await removeTestArtifacts(bundleDirectory);
await Promise.all([
  chmod(join(packageDirectory, "dist", "main.js"), 0o755),
  chmod(join(packageDirectory, "dist", "entry.js"), 0o755),
]);

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
