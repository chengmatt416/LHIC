import { cp, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const appDirectory = resolve(scriptDirectory, "..");
const source = resolve(appDirectory, "src/preload/preload.cjs");
const destination = resolve(appDirectory, "dist/main/preload/preload.cjs");

await mkdir(dirname(destination), { recursive: true });
await cp(source, destination);
