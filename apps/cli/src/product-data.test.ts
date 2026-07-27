import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  eraseProductData,
  formatProductDataInventory,
  inspectProductData,
  writeProductDataEraseReceipt,
  writeProductDataInventory,
} from "./product-data.js";

const temporaryDirectories: string[] = [];

const fixedTime = new Date("2026-07-27T10:00:00.000Z");

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("product data lifecycle", () => {
  it("builds a deterministic metadata-only inventory", async () => {
    const directory = await temporaryDirectory();
    const root = join(directory, ".lhic");
    await mkdir(join(root, "nested"), { recursive: true });
    await writeFile(join(root, "z.txt"), "secret-z", "utf8");
    await writeFile(join(root, "nested", "a.txt"), "secret-a", "utf8");

    const first = await inspectProductData(root, fixedTime);
    const second = await inspectProductData(root, fixedTime);

    expect(second).toEqual(first);
    expect(first.rootExists).toBe(true);
    expect(first.fileCount).toBe(2);
    expect(first.directoryCount).toBe(1);
    expect(first.totalBytes).toBe(
      Buffer.byteLength("secret-z") + Buffer.byteLength("secret-a"),
    );
    expect(first.entries.map((entry) => entry.relativePath)).toEqual([
      "nested",
      "nested/a.txt",
      "z.txt",
    ]);
    expect(JSON.stringify(first)).not.toContain("secret-a");
    expect(first.eraseConfirmation).toMatch(/^ERASE-[A-F0-9]{16}$/u);
    expect(formatProductDataInventory(first)).toContain(
      first.eraseConfirmation,
    );
  });

  it("requires the exact current confirmation and produces a logical deletion receipt", async () => {
    const directory = await temporaryDirectory();
    const root = join(directory, ".lhic");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "skills.sqlite"), "database", "utf8");
    const inventory = await inspectProductData(root, fixedTime);

    await expect(
      eraseProductData(root, "ERASE-WRONG", fixedTime),
    ).rejects.toThrow("Deletion confirmation does not match");
    await expect(lstat(root)).resolves.toBeDefined();

    const receipt = await eraseProductData(
      root,
      inventory.eraseConfirmation,
      fixedTime,
    );
    await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
    expect(receipt).toEqual(
      expect.objectContaining({
        inventorySha256: inventory.inventorySha256,
        removedFileCount: 1,
        removedBytes: Buffer.byteLength("database"),
        rootAbsentAfterDeletion: true,
        logicalDeletionOnly: true,
      }),
    );
    expect(JSON.stringify(receipt)).not.toContain(root);
  });

  it("refuses dangerous roots before attempting deletion", async () => {
    await expect(
      eraseProductData(process.cwd(), "ERASE-ANYTHING", fixedTime),
    ).rejects.toThrow("Refusing to erase");
  });

  it.runIf(process.platform !== "win32")(
    "rejects symbolic links anywhere inside the selected root",
    async () => {
      const directory = await temporaryDirectory();
      const root = join(directory, ".lhic");
      const outside = join(directory, "outside.txt");
      await mkdir(root, { recursive: true });
      await writeFile(outside, "outside", "utf8");
      await symlink(outside, join(root, "escape"));

      await expect(inspectProductData(root, fixedTime)).rejects.toThrow(
        "contains a symbolic link",
      );
      await expect(readFile(outside, "utf8")).resolves.toBe("outside");
    },
  );

  it("writes private inventory and receipt files without overwriting", async () => {
    const directory = await temporaryDirectory();
    const root = join(directory, ".lhic");
    const outputDirectory = join(directory, "records");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "settings.json"), "{}", "utf8");
    const inventory = await inspectProductData(root, fixedTime);
    const inventoryFile = join(outputDirectory, "inventory.json");

    await writeProductDataInventory(inventoryFile, inventory);
    expect(JSON.parse(await readFile(inventoryFile, "utf8"))).toEqual(
      inventory,
    );
    await expect(
      writeProductDataInventory(inventoryFile, inventory),
    ).rejects.toThrow();

    const receipt = await eraseProductData(
      root,
      inventory.eraseConfirmation,
      fixedTime,
    );
    const receiptFile = join(outputDirectory, "erase-receipt.json");
    await expect(
      writeProductDataEraseReceipt(
        join(root, "erase-receipt.json"),
        receipt,
        root,
      ),
    ).rejects.toThrow("outside the deleted product data root");
    await writeProductDataEraseReceipt(receiptFile, receipt, root);
    expect(JSON.parse(await readFile(receiptFile, "utf8"))).toEqual(receipt);
    await expect(
      writeProductDataEraseReceipt(receiptFile, receipt, root),
    ).rejects.toThrow();
  });

  it("returns a stable empty inventory for an uninitialized root", async () => {
    const directory = await temporaryDirectory();
    const root = join(directory, ".lhic");
    const inventory = await inspectProductData(root, fixedTime);

    expect(inventory).toEqual(
      expect.objectContaining({
        rootExists: false,
        fileCount: 0,
        directoryCount: 0,
        totalBytes: 0,
        entries: [],
      }),
    );
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "lhic-product-data-"));
  temporaryDirectories.push(directory);
  return directory;
}
