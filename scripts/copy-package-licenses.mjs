import { cp } from "node:fs/promises";
import { resolve } from "node:path";

const packageDirectory = process.cwd();
const workspaceDirectory = resolve(packageDirectory, "..", "..");

for (const filename of ["LICENSE-MIT", "LICENSE-APACHE"]) {
  await cp(
    resolve(workspaceDirectory, filename),
    resolve(packageDirectory, filename),
  );
}
