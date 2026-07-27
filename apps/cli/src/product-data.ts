import { homedir } from "node:os";
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";

import { hashState } from "@lhic/trace";

const maximumEntries = 20_000;
const maximumDepth = 32;

export interface ProductDataEntry {
  relativePath: string;
  kind: "file" | "directory";
  sizeBytes: number;
  modifiedAt: string;
}

export interface ProductDataInventory {
  schemaVersion: "lhic-product-data-inventory-v1";
  root: string;
  rootExists: boolean;
  generatedAt: string;
  fileCount: number;
  directoryCount: number;
  totalBytes: number;
  inventorySha256: string;
  eraseConfirmation: string;
  entries: ProductDataEntry[];
  limitations: string[];
}

export interface ProductDataEraseReceipt {
  schemaVersion: "lhic-product-data-erase-receipt-v1";
  rootCommitment: string;
  inventorySha256: string;
  erasedAt: string;
  removedFileCount: number;
  removedDirectoryCount: number;
  removedBytes: number;
  rootAbsentAfterDeletion: true;
  logicalDeletionOnly: true;
  limitations: string[];
}

export async function inspectProductData(
  rootInput = ".lhic",
  now = new Date(),
): Promise<ProductDataInventory> {
  const root = resolveSafeRoot(rootInput);
  const generatedAt = canonicalTimestamp(now, "inventory time");
  let rootStat;
  try {
    rootStat = await lstat(root);
  } catch (error) {
    if (isMissing(error)) {
      return createInventory(root, false, generatedAt, []);
    }
    throw error;
  }
  if (rootStat.isSymbolicLink()) {
    throw new Error("Product data root must not be a symbolic link.");
  }
  if (!rootStat.isDirectory()) {
    throw new Error("Product data root must be a directory.");
  }

  const entries: ProductDataEntry[] = [];
  await walkProductData(root, root, 0, entries);
  entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return createInventory(root, true, generatedAt, entries);
}

export async function writeProductDataInventory(
  outputFile: string,
  inventory: ProductDataInventory,
): Promise<void> {
  await writePrivateJsonExclusive(outputFile, inventory);
}

export async function eraseProductData(
  rootInput: string,
  confirmation: string,
  now = new Date(),
): Promise<ProductDataEraseReceipt> {
  const root = resolveSafeRoot(rootInput);
  assertErasableRoot(root);
  const inventory = await inspectProductData(root, now);
  if (confirmation !== inventory.eraseConfirmation) {
    throw new Error(
      `Deletion confirmation does not match. Re-run \`lhic data inventory --root ${JSON.stringify(rootInput)}\` and provide the exact current eraseConfirmation.`,
    );
  }
  if (inventory.rootExists) {
    await rm(root, {
      recursive: true,
      force: false,
      maxRetries: 3,
      retryDelay: 50,
    });
  }
  try {
    await lstat(root);
    throw new Error("Product data root still exists after deletion.");
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  return {
    schemaVersion: "lhic-product-data-erase-receipt-v1",
    rootCommitment: hashState({ root }),
    inventorySha256: inventory.inventorySha256,
    erasedAt: canonicalTimestamp(now, "erase time"),
    removedFileCount: inventory.fileCount,
    removedDirectoryCount: inventory.directoryCount,
    removedBytes: inventory.totalBytes,
    rootAbsentAfterDeletion: true,
    logicalDeletionOnly: true,
    limitations: [
      "This receipt proves only that the selected filesystem path was absent after the command completed.",
      "Logical deletion does not guarantee physical erasure from SSD wear leveling, filesystem snapshots, cloud sync, backups, crash dumps, or copies outside the selected root.",
      "Operating-system keychain entries, externally configured trace directories, and remote services require their own deletion procedures.",
    ],
  };
}

export async function writeProductDataEraseReceipt(
  outputFile: string,
  receipt: ProductDataEraseReceipt,
): Promise<void> {
  await writePrivateJsonExclusive(outputFile, receipt);
}

export function formatProductDataInventory(
  inventory: ProductDataInventory,
): string {
  return `${[
    `LHIC local data: ${inventory.rootExists ? "found" : "not initialized"}`,
    `Root: ${inventory.root}`,
    `Files: ${inventory.fileCount}`,
    `Directories: ${inventory.directoryCount}`,
    `Bytes: ${inventory.totalBytes}`,
    `Inventory SHA-256: ${inventory.inventorySha256}`,
    `Erase confirmation: ${inventory.eraseConfirmation}`,
    "",
    "The confirmation changes whenever the inventory changes. Review the root and inventory before using `lhic data erase`.",
    "This inventory does not inspect operating-system keychains, external backups, or remote services.",
    "",
  ].join("\n")}`;
}

function createInventory(
  root: string,
  rootExists: boolean,
  generatedAt: string,
  entries: ProductDataEntry[],
): ProductDataInventory {
  const fileCount = entries.filter((entry) => entry.kind === "file").length;
  const directoryCount = entries.filter(
    (entry) => entry.kind === "directory",
  ).length;
  const totalBytes = entries.reduce(
    (total, entry) => total + (entry.kind === "file" ? entry.sizeBytes : 0),
    0,
  );
  if (!Number.isSafeInteger(totalBytes)) {
    throw new Error("Product data size exceeds the supported safe integer range.");
  }
  const inventorySha256 = hashState({ root, rootExists, entries });
  return {
    schemaVersion: "lhic-product-data-inventory-v1",
    root,
    rootExists,
    generatedAt,
    fileCount,
    directoryCount,
    totalBytes,
    inventorySha256,
    eraseConfirmation: `ERASE-${hashState({ root, inventorySha256 }).slice(0, 16).toUpperCase()}`,
    entries,
    limitations: [
      "The inventory lists metadata only and never includes file contents.",
      "Symbolic links are rejected so the command cannot traverse into an unrelated location.",
      "Operating-system keychains, external trace directories, backups, cloud sync, and remote services are outside this root inventory.",
    ],
  };
}

async function walkProductData(
  root: string,
  directory: string,
  depth: number,
  entries: ProductDataEntry[],
): Promise<void> {
  if (depth > maximumDepth) {
    throw new Error(`Product data exceeds maximum depth ${maximumDepth}.`);
  }
  const names = (await readdir(directory)).sort();
  for (const name of names) {
    const absolutePath = resolve(directory, name);
    if (!isInsideRoot(root, absolutePath)) {
      throw new Error("Product data path escaped the selected root.");
    }
    const stat = await lstat(absolutePath);
    if (stat.isSymbolicLink()) {
      throw new Error(
        `Product data contains a symbolic link and cannot be inventoried safely: ${toRelativePath(root, absolutePath)}`,
      );
    }
    if (!stat.isDirectory() && !stat.isFile()) {
      throw new Error(
        `Product data contains an unsupported filesystem object: ${toRelativePath(root, absolutePath)}`,
      );
    }
    entries.push({
      relativePath: toRelativePath(root, absolutePath),
      kind: stat.isDirectory() ? "directory" : "file",
      sizeBytes: stat.isFile() ? stat.size : 0,
      modifiedAt: stat.mtime.toISOString(),
    });
    if (entries.length > maximumEntries) {
      throw new Error(`Product data exceeds ${maximumEntries} entries.`);
    }
    if (stat.isDirectory()) {
      await walkProductData(root, absolutePath, depth + 1, entries);
    }
  }
}

function resolveSafeRoot(rootInput: string): string {
  if (!rootInput.trim() || rootInput.includes("\0")) {
    throw new Error("Product data root must be a non-empty filesystem path.");
  }
  const root = resolve(rootInput);
  if (!isAbsolute(root)) {
    throw new Error("Product data root could not be resolved to an absolute path.");
  }
  return root;
}

function assertErasableRoot(root: string): void {
  const filesystemRoot = parse(root).root;
  const dangerousRoots = new Set([
    filesystemRoot,
    resolve(homedir()),
    resolve(process.cwd()),
  ]);
  if (dangerousRoots.has(root)) {
    throw new Error(
      "Refusing to erase a filesystem root, the current user's home directory, or the current working directory.",
    );
  }
  const relativeToFilesystemRoot = relative(filesystemRoot, root)
    .split(sep)
    .filter(Boolean);
  if (relativeToFilesystemRoot.length < 2 || basename(root) === "..") {
    throw new Error("Product data root is too broad to erase safely.");
  }
}

function isInsideRoot(root: string, candidate: string): boolean {
  const candidateRelative = relative(root, candidate);
  return (
    candidateRelative.length > 0 &&
    candidateRelative !== ".." &&
    !candidateRelative.startsWith(`..${sep}`) &&
    !isAbsolute(candidateRelative)
  );
}

function toRelativePath(root: string, absolutePath: string): string {
  return relative(root, absolutePath).split(sep).join("/");
}

async function writePrivateJsonExclusive(
  outputFile: string,
  value: unknown,
): Promise<void> {
  const resolvedOutputFile = resolve(outputFile);
  await mkdir(dirname(resolvedOutputFile), { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    await chmod(dirname(resolvedOutputFile), 0o700);
  }
  await writeFile(
    resolvedOutputFile,
    `${JSON.stringify(value, null, 2)}\n`,
    {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    },
  );
}

function canonicalTimestamp(value: Date, name: string): string {
  if (!Number.isFinite(value.getTime())) {
    throw new Error(`${name} is invalid.`);
  }
  return value.toISOString();
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
