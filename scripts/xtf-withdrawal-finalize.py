from pathlib import Path
import subprocess


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    if new in text:
        return
    if text.count(old) != 1:
        raise RuntimeError(f"Expected exactly one match in {path}: {old!r}")
    file.write_text(text.replace(old, new, 1))


product_data = "apps/cli/src/product-data.ts"
replace_once(
    product_data,
    '''export async function writeProductDataEraseReceipt(
  outputFile: string,
  receipt: ProductDataEraseReceipt,
): Promise<void> {
  await writePrivateJsonExclusive(outputFile, receipt);
}''',
    '''export async function writeProductDataEraseReceipt(
  outputFile: string,
  receipt: ProductDataEraseReceipt,
  erasedRoot?: string,
): Promise<void> {
  if (erasedRoot) {
    const root = resolveSafeRoot(erasedRoot);
    const resolvedOutputFile = resolve(outputFile);
    if (
      resolvedOutputFile === root ||
      isInsideRoot(root, resolvedOutputFile)
    ) {
      throw new Error(
        "Erase receipt must be written outside the deleted product data root.",
      );
    }
  }
  await writePrivateJsonExclusive(outputFile, receipt);
}''',
)

product_test = "apps/cli/src/product-data.test.ts"
replace_once(
    product_test,
    '''    const receiptFile = join(outputDirectory, "erase-receipt.json");
    await writeProductDataEraseReceipt(receiptFile, receipt);
    expect(JSON.parse(await readFile(receiptFile, "utf8"))).toEqual(receipt);''',
    '''    const receiptFile = join(outputDirectory, "erase-receipt.json");
    await expect(
      writeProductDataEraseReceipt(
        join(root, "erase-receipt.json"),
        receipt,
        root,
      ),
    ).rejects.toThrow("outside the deleted product data root");
    await writeProductDataEraseReceipt(receiptFile, receipt, root);
    expect(JSON.parse(await readFile(receiptFile, "utf8"))).toEqual(receipt);''',
)
replace_once(
    product_test,
    '''      writeProductDataEraseReceipt(receiptFile, receipt),''',
    '''      writeProductDataEraseReceipt(receiptFile, receipt, root),''',
)

entry = "apps/cli/src/entry.ts"
replace_once(
    entry,
    '''import { parseMcpHarness } from "./mcp-harness-config.js";''',
    '''import { parseMcpHarness } from "./mcp-harness-config.js";
import {
  eraseProductData,
  formatProductDataInventory,
  inspectProductData,
  writeProductDataEraseReceipt,
  writeProductDataInventory,
} from "./product-data.js";''',
)
replace_once(
    entry,
    '''XTF research commands:\n  lhic bench learnloop''',
    '''Product data commands:\n  lhic data inventory [--root <directory>] [--output <inventory.json>]\n  lhic data erase --root <directory> --confirm <token> --receipt <receipt.json>\n\nXTF research commands:\n  lhic bench learnloop''',
)
replace_once(
    entry,
    '''    if (command === "bench" && firstArgument === "learnloop") {''',
    '''    if (command === "data") {
      if (firstArgument === "inventory") {
        const options = parseProductDataInventoryOptions(argumentsList.slice(2));
        const inventory = await inspectProductData(options.root);
        if (options.outputFile) {
          await writeProductDataInventory(options.outputFile, inventory);
        }
        console.log(formatProductDataInventory(inventory));
        return;
      }
      if (firstArgument === "erase") {
        const options = parseProductDataEraseOptions(argumentsList.slice(2));
        const receipt = await eraseProductData(
          options.root,
          options.confirmation,
        );
        await writeProductDataEraseReceipt(
          options.receiptFile,
          receipt,
          options.root,
        );
        console.log(JSON.stringify(receipt, null, 2));
        return;
      }
      throw new Error(
        "Data action must be inventory or erase. Run `lhic help` for usage.",
      );
    }

    if (command === "bench" && firstArgument === "learnloop") {''',
)
replace_once(
    entry,
    '''function parseResearchOutput(argumentsList: string[]): string | undefined {''',
    '''function parseProductDataInventoryOptions(argumentsList: string[]): {
  root: string;
  outputFile?: string;
} {
  if (argumentsList.length % 2 !== 0 || argumentsList.length > 4) {
    throw new Error(
      "Data inventory accepts only [--root <directory>] [--output <inventory.json>].",
    );
  }
  let root = ".lhic";
  let outputFile: string | undefined;
  const seen = new Set<string>();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const flag = argumentsList[index];
    const value = argumentsList[index + 1];
    if (
      !flag ||
      !value ||
      seen.has(flag) ||
      (flag !== "--root" && flag !== "--output")
    ) {
      throw new Error(
        "Data inventory contains an unknown, duplicate, or empty flag.",
      );
    }
    seen.add(flag);
    if (flag === "--root") root = value;
    else outputFile = value;
  }
  return { root, ...(outputFile ? { outputFile } : {}) };
}

function parseProductDataEraseOptions(argumentsList: string[]): {
  root: string;
  confirmation: string;
  receiptFile: string;
} {
  if (argumentsList.length !== 6) {
    throw new Error(
      "Data erase requires exactly --root <directory> --confirm <token> --receipt <receipt.json>.",
    );
  }
  const allowed = new Set(["--root", "--confirm", "--receipt"]);
  const options: Record<string, string> = {};
  for (let index = 0; index < argumentsList.length; index += 2) {
    const flag = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!flag || !value || !allowed.has(flag) || options[flag]) {
      throw new Error(
        "Data erase contains an unknown, duplicate, or empty flag.",
      );
    }
    options[flag] = value;
  }
  if (Object.keys(options).length !== allowed.size) {
    throw new Error("Data erase is missing a required flag.");
  }
  return {
    root: options["--root"]!,
    confirmation: options["--confirm"]!,
    receiptFile: options["--receipt"]!,
  };
}

function parseResearchOutput(argumentsList: string[]): string | undefined {''',
)

readme = "README.md"
replace_once(
    readme,
    '''### Published CLI commands''',
    '''### Local data inventory and deletion

Review all metadata under the selected local product-data root:

```bash
npx @pinyencheng/lhic data inventory --root .lhic
```

The output includes an inventory digest and a confirmation value derived from the current root contents. To perform logical deletion, stop LHIC, review the inventory, and pass that exact value while writing the receipt outside the selected root:

```bash
npx @pinyencheng/lhic data erase \\
  --root .lhic \\
  --confirm ERASE-0123456789ABCDEF \\
  --receipt ./lhic-data-erase-receipt.json
```

The command rejects symbolic links, filesystem roots, the user's home directory, the current working directory, stale confirmation values, and receipt paths inside the deleted root. It does not claim physical SSD erasure and does not automatically remove operating-system Keychain entries, external trace/replay directories, backups, or remote-service data. See the [product-data lifecycle guide](docs/product-data-lifecycle.md).

### Published CLI commands''',
)

files = [
    product_data,
    product_test,
    entry,
    readme,
    "docs/product-data-lifecycle.md",
    ".github/workflows/product-readiness.yml",
]
subprocess.run(["npx", "prettier", "--write", *files], check=True)
subprocess.run(
    [
        "npx",
        "vitest",
        "run",
        "apps/cli/src/product-data.test.ts",
        "apps/cli/src/user-experience.test.ts",
    ],
    check=True,
)
help_output = subprocess.run(
    ["npx", "tsx", "apps/cli/src/entry.ts", "help"],
    check=True,
    capture_output=True,
    text=True,
).stdout
for required in ["data inventory", "data erase"]:
    if required not in help_output:
        raise RuntimeError(f"Public CLI help is missing {required!r}.")
subprocess.run(["npm", "run", "package:smoke"], check=True)
subprocess.run(["git", "add", *files], check=True)
