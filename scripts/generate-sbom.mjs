#!/usr/bin/env node
/**
 * Generates a minimal SPDX 2.3 SBOM (JSON) from the production dependency
 * tree (`npm ls --json --omit=dev`) plus repository metadata. Fail-closed:
 * exits non-zero when npm ls reports problems. The SBOM is evidence, not a
 * substitute for a vulnerability scan.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function npmTree() {
  const output = execFileSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["ls", "--json", "--omit=dev", "--all"],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  return JSON.parse(output);
}

function collectPackages(node, packages) {
  if (!node || typeof node !== "object") return;
  const record = node;
  if (typeof record.name === "string" && typeof record.version === "string") {
    packages.push({ name: record.name, version: record.version });
  }
  const dependencies = record.dependencies;
  if (dependencies && typeof dependencies === "object") {
    for (const [name, child] of Object.entries(dependencies)) {
      collectPackages({ name, ...child }, packages);
    }
  }
}

const tree = npmTree();
if (tree.problems && tree.problems.length > 0) {
  console.error("npm ls reported dependency problems:");
  for (const problem of tree.problems) console.error(`  ${String(problem)}`);
  process.exit(1);
}

const packages = [];
collectPackages(tree, packages);
const unique = new Map();
for (const pkg of packages) {
  unique.set(`${pkg.name}@${pkg.version}`, pkg);
}

const documentNamespace = `https://lhic.dev/sbom/${new Date().toISOString().replace(/[:.]/g, "-")}`;
const sbom = {
  spdxVersion: "SPDX-2.3",
  dataLicense: "CC0-1.0",
  SPDXID: "SPDXRef-DOCUMENT",
  name: "LHIC TypeScript production dependencies",
  documentNamespace,
  creationInfo: {
    created: new Date().toISOString(),
    creators: ["Tool: lhic-generate-sbom"],
  },
  packages: [...unique.values()].map((pkg, index) => ({
    name: pkg.name,
    versionInfo: pkg.version,
    SPDXID: `SPDXRef-Package-${index}`,
    downloadLocation: "NOASSERTION",
    filesAnalyzed: false,
    licenseConcluded: "NOASSERTION",
    copyrightText: "NOASSERTION",
  })),
  relationships: [
    {
      spdxElementId: "SPDXRef-DOCUMENT",
      relationshipType: "DESCRIBES",
      relatedSpdxElement: "SPDXRef-Package-0",
    },
  ],
};

const outputPath = resolve(process.argv[2] ?? "sbom.spdx.json");
const serialized = `${JSON.stringify(sbom, null, 2)}\n`;
await writeFile(outputPath, serialized, { encoding: "utf8", mode: 0o600 });
const digest = createHash("sha256").update(serialized).digest("hex");
console.log(
  JSON.stringify(
    {
      sbomPath: outputPath,
      packageCount: unique.size,
      sha256: digest,
    },
    null,
    2,
  ),
);
