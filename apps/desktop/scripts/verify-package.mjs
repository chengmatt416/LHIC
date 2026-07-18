import { access, readdir } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { listPackage } from "@electron/asar";

const applicationDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);
const releaseDirectory = join(applicationDirectory, "release");
const allArchives = await findAsarArchives(releaseDirectory);
const archives =
  process.env.LHIC_VERIFY_ALL_PACKAGES === "true"
    ? allArchives
    : allArchives.filter(isCurrentPlatformArchive);

if (archives.length === 0) {
  throw new Error("Desktop package verification could not locate app.asar.");
}

for (const archive of archives) {
  const entries = new Set(await listPackage(archive));
  for (const required of [
    "/dist/main/main/main.js",
    "/dist/main/preload/preload.cjs",
    "/dist/renderer/index.html",
    "/dist/main/main/game-service.js",
    "/dist/main/main/game-cli-worker.js",
    "/dist/main/main/public-web-training-service.js",
    "/node_modules/@lhic/game-training/dist/desktop-recording.js",
    "/node_modules/@pinyencheng/lhic/dist/game-training.js",
  ]) {
    if (!entries.has(required)) {
      throw new Error(
        `${archive} is missing required runtime entry ${required}.`,
      );
    }
  }
  const unpacked = `${archive}.unpacked`;
  await Promise.all([
    access(join(unpacked, "node_modules/@lhic/game-training/python/worker.py")),
    access(join(unpacked, "node_modules/@lhic/game-training/requirements.txt")),
  ]);
}

console.log(
  `Desktop package verification passed for ${archives.length} app archive${archives.length === 1 ? "" : "s"}.`,
);

async function findAsarArchives(directory) {
  const found = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await findAsarArchives(path)));
    } else if (entry.isFile() && entry.name === "app.asar") {
      found.push(path);
    }
  }
  return found;
}

function isCurrentPlatformArchive(archive) {
  const marker =
    process.platform === "darwin"
      ? `${sep}mac-`
      : process.platform === "win32"
        ? `${sep}win-`
        : `${sep}linux-`;
  return archive.includes(marker);
}
