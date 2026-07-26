import { cp, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const appDirectory = resolve(scriptDirectory, "..");
const source = resolve(appDirectory, "src/preload/preload.cjs");
const destination = resolve(appDirectory, "dist/main/preload/preload.cjs");
const compiledTypeScript = resolve(
  appDirectory,
  "dist/main/preload/preload.js",
);

const [commonJsSource, typeScriptSource] = await Promise.all([
  readFile(source, "utf8"),
  readFile(compiledTypeScript, "utf8"),
]);
const commonJsChannels = ipcChannels(commonJsSource);
const typeScriptChannels = ipcChannels(typeScriptSource);
const missingChannels = typeScriptChannels.filter(
  (channel) => !commonJsChannels.includes(channel),
);
const unexpectedChannels = commonJsChannels.filter(
  (channel) => !typeScriptChannels.includes(channel),
);
if (missingChannels.length || unexpectedChannels.length) {
  throw new Error(
    `Sandbox preload bridge is out of sync. Missing: ${missingChannels.join(", ") || "none"}. Unexpected: ${unexpectedChannels.join(", ") || "none"}.`,
  );
}

await mkdir(dirname(destination), { recursive: true });
await cp(source, destination);

function ipcChannels(sourceText) {
  return [
    ...sourceText.matchAll(/ipcRenderer\.invoke\(\s*["']([^"']+)["']/g),
  ]
    .map((match) => match[1])
    .filter((channel, index, channels) => channels.indexOf(channel) === index)
    .sort();
}
