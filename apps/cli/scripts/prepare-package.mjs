import { cp, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceDirectory = resolve(packageDirectory, "..", "..");
const bundledPackages = [
  "browser",
  "memory",
  "schema",
  "security",
  "skills",
  "trace",
  "verifier",
];
const bundleDirectory = join(packageDirectory, "node_modules", "@lhic");

await mkdir(bundleDirectory, { recursive: true });
for (const packageName of bundledPackages) {
  await cp(
    join(workspaceDirectory, "packages", packageName),
    join(bundleDirectory, packageName),
    { recursive: true },
  );
}
