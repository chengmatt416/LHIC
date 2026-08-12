#!/usr/bin/env node
/**
 * Syncs the canonical execution-layer sources (packages/skills/src/execution)
 * into this package so the published npm artifact can build the FlaUI bridge
 * and run the OmniParser helper without a network fetch. Keeps exactly one
 * source of truth in the repository.
 */
import { cp, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(packageDirectory, "..", "..", "packages", "skills", "src", "execution");
const destination = resolve(packageDirectory, "execution");

await rm(destination, { recursive: true, force: true });
await cp(source, destination, { recursive: true });
await rm(resolve(destination, "flaui", "bin"), { recursive: true, force: true }).catch(() => undefined);
console.log("[sync-execution] Synced execution-layer sources into the launcher package.");
