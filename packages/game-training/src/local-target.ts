import { createReadStream } from "node:fs";
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { basename, extname, join, relative, resolve } from "node:path";

import { gameTrainingPaths } from "./paths.js";
import type { GameTargetProfile } from "./types.js";

export interface RegisteredLocalGameTarget {
  schemaVersion: "local-game-target-v1";
  profileId: string;
  core: "2d" | "3d";
  sourceDirectory: string;
  registeredAt: string;
}

export async function registerLocalGameTarget(
  profile: GameTargetProfile,
  sourceDirectory: string,
  root?: string,
): Promise<RegisteredLocalGameTarget> {
  const resolvedSource = resolve(sourceDirectory);
  const indexFile = join(resolvedSource, "index.html");
  const sourceStats = await stat(resolvedSource).catch(() => undefined);
  if (!sourceStats?.isDirectory()) {
    throw new Error("Game source must be an existing local directory.");
  }
  await access(indexFile).catch(() => {
    throw new Error("Game source directory must contain index.html.");
  });
  const paths = gameTrainingPaths(profile.core, root);
  const target: RegisteredLocalGameTarget = {
    schemaVersion: "local-game-target-v1",
    profileId: profile.id,
    core: profile.core,
    sourceDirectory: resolvedSource,
    registeredAt: new Date().toISOString(),
  };
  await mkdir(paths.targetsRoot, { recursive: true });
  await writeFile(
    join(paths.targetsRoot, `${profile.id}.json`),
    `${JSON.stringify(target, null, 2)}\n`,
    "utf8",
  );
  return target;
}

export async function readRegisteredLocalGameTarget(
  profile: GameTargetProfile,
  root?: string,
): Promise<RegisteredLocalGameTarget> {
  const paths = gameTrainingPaths(profile.core, root);
  const value = JSON.parse(
    await readFile(join(paths.targetsRoot, `${profile.id}.json`), "utf8"),
  ) as Partial<RegisteredLocalGameTarget>;
  if (
    value.schemaVersion !== "local-game-target-v1" ||
    value.profileId !== profile.id ||
    value.core !== profile.core ||
    typeof value.sourceDirectory !== "string"
  ) {
    throw new Error("Registered local game target is invalid.");
  }
  return value as RegisteredLocalGameTarget;
}

export async function startLocalGameTargetServer(
  sourceDirectory: string,
): Promise<{ url: string; close(): Promise<void> }> {
  const root = resolve(sourceDirectory);
  const server = createServer((request, response) => {
    void serveLocalGameFile(root, request.url ?? "/", response);
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolveListen();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("Local game target server did not expose a TCP address.");
  }
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () => closeServer(server),
  };
}

async function serveLocalGameFile(
  root: string,
  requestPath: string,
  response: ServerResponse,
): Promise<void> {
  try {
    const requested = decodeURIComponent(requestPath.split("?", 1)[0] ?? "/");
    const candidate = resolve(
      root,
      requested === "/" ? "index.html" : `.${requested}`,
    );
    if (relative(root, candidate).startsWith("..")) {
      response.writeHead(403).end();
      return;
    }
    const info = await stat(candidate);
    if (!info.isFile()) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      "Content-Type": contentTypeFor(basename(candidate)),
      "Cache-Control": "no-store",
      "Content-Security-Policy":
        "default-src 'self' data: blob:; connect-src 'none';",
    });
    createReadStream(candidate).pipe(response);
  } catch {
    response.writeHead(404).end();
  }
}

function contentTypeFor(fileName: string): string {
  return (
    {
      ".css": "text/css; charset=utf-8",
      ".html": "text/html; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".svg": "image/svg+xml",
      ".wasm": "application/wasm",
    }[extname(fileName).toLowerCase()] ?? "application/octet-stream"
  );
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()));
  });
}
