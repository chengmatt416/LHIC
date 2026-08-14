#!/usr/bin/env node
/**
 * Verifies a SHA256SUMS release manifest and its optional detached Ed25519
 * signature. Fails closed: missing signature files, invalid signatures, or
 * missing/mismatched artifacts exit non-zero.
 */
import { createHash, createPublicKey, verify } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

async function sha256File(path) {
  const digest = createHash("sha256");
  await new Promise((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => digest.update(chunk));
    stream.on("end", resolvePromise);
    stream.on("error", reject);
  });
  return digest.digest("hex");
}

async function main() {
  const manifestPath = resolve(process.argv[2] ?? "");
  if (!manifestPath) {
    console.error("usage: node verify-sha256-manifest.mjs <SHA256SUMS-file> [public-key.pem]");
    process.exit(1);
  }
  const errors = [];
  const content = await readFile(manifestPath, "utf8");
  const lines = content.split("\n").filter(Boolean);
  if (lines.length === 0) errors.push("Manifest is empty.");
  const directory = dirname(manifestPath);
  for (const line of lines) {
    const match = /^([a-f0-9]{64})\s+(.+)$/.exec(line);
    if (!match) {
      errors.push(`Malformed manifest line: ${line.slice(0, 80)}`);
      continue;
    }
    const [, expected, name] = match;
    const artifactPath = join(directory, name);
    try {
      const stats = await stat(artifactPath);
      if (!stats.isFile()) {
        errors.push(`Artifact is not a regular file: ${name}`);
        continue;
      }
      const actual = await sha256File(artifactPath);
      if (actual !== expected) errors.push(`SHA-256 mismatch: ${name}`);
    } catch {
      errors.push(`Artifact missing: ${name}`);
    }
  }
  const publicKeyPath = process.argv[3];
  let signatureVerified = false;
  if (publicKeyPath) {
    try {
      const publicKey = createPublicKey(await readFile(publicKeyPath, "utf8"));
      const signature = (await readFile(`${manifestPath}.sig`, "utf8")).trim();
      signatureVerified = verify(
        null,
        await readFile(manifestPath),
        publicKey,
        Buffer.from(signature, "base64"),
      );
      if (!signatureVerified) errors.push("Detached signature is invalid.");
    } catch {
      errors.push("Detached signature missing or unverifiable.");
    }
  }
  if (errors.length > 0) {
    for (const error of errors) console.error(error);
    process.exit(1);
  }
  console.log(
    JSON.stringify(
      {
        passed: true,
        manifest: basename(manifestPath),
        entries: lines.length,
        signatureVerified: publicKeyPath ? signatureVerified : "not-checked",
      },
      null,
      2,
    ),
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
