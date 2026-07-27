from pathlib import Path
import subprocess


def replace_once(path: Path, old: str, new: str) -> None:
    text = path.read_text()
    if new in text:
        return
    if text.count(old) != 1:
        raise RuntimeError(f"Expected exactly one match in {path}: {old!r}")
    path.write_text(text.replace(old, new, 1))


installer = Path("apps/cli/src/installer.ts")
replace_once(
    installer,
    'import { createWriteStream } from "node:fs";',
    'import { createWriteStream, readFileSync } from "node:fs";',
)
replace_once(
    installer,
    'import { promisify } from "node:util";',
    'import { fileURLToPath } from "node:url";\nimport { promisify } from "node:util";',
)
replace_once(
    installer,
    '''const execFileAsync = promisify(execFile);
const cliPackageName = "@pinyencheng/lhic";''',
    '''const execFileAsync = promisify(execFile);
const cliPackageName = "@pinyencheng/lhic";
const cliPackageVersion = readCliPackageVersion();''',
)
replace_once(
    installer,
    '''  readonly path?: string | undefined;
  readonly runNpm?: (''',
    '''  readonly path?: string | undefined;
  readonly version?: string;
  readonly runNpm?: (''',
)
replace_once(
    installer,
    '''  const runNpm = options.runNpm ?? runNpmCommand;
  const currentPath = options.path ?? process.env.PATH ?? process.env.Path;

  await runNpm(["install", "--global", `${cliPackageName}@latest`]);''',
    '''  const runNpm = options.runNpm ?? runNpmCommand;
  const currentPath = options.path ?? process.env.PATH ?? process.env.Path;
  const version = parseCliPackageVersion(
    options.version ?? cliPackageVersion,
  );
  const packageSpecifier = `${cliPackageName}@${version}`;

  await runNpm(["install", "--global", packageSpecifier]);''',
)
replace_once(
    installer,
    '''    `${cliPackageName}@latest`,
    "--",''',
    '''    packageSpecifier,
    "--",''',
)
replace_once(
    installer,
    '''async function runNpmCommand(
  argumentsList: readonly string[],''',
    '''export function parseCliPackageVersion(value: string): string {
  const match = value.match(
    /^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)$/u,
  );
  if (!match) {
    throw new Error("CLI package version must be an exact X.Y.Z version.");
  }
  const parts = match.slice(1).map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part))) {
    throw new Error("CLI package version is outside the supported range.");
  }
  return parts.join(".");
}

function readCliPackageVersion(): string {
  const packageFile = fileURLToPath(
    new URL("../package.json", import.meta.url),
  );
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(packageFile, "utf8")) as unknown;
  } catch {
    throw new Error("Unable to read the installed LHIC package metadata.");
  }
  if (
    !value ||
    typeof value !== "object" ||
    (value as { name?: unknown }).name !== cliPackageName ||
    typeof (value as { version?: unknown }).version !== "string"
  ) {
    throw new Error("Installed LHIC package metadata is invalid.");
  }
  return parseCliPackageVersion(
    (value as { version: string }).version,
  );
}

async function runNpmCommand(
  argumentsList: readonly string[],''',
)

test = Path("apps/cli/src/installer.test.ts")
replace_once(
    test,
    '''  parseDesktopReleaseTag,
  parseSha256Manifest,''',
    '''  parseCliPackageVersion,
  parseDesktopReleaseTag,
  parseSha256Manifest,''',
)
replace_once(
    test,
    '''        path: "/usr/bin",
        runNpm:''',
    '''        path: "/usr/bin",
        version: "1.2.3",
        runNpm:''',
)
replace_once(
    test,
    '''        ["install", "--global", "@pinyencheng/lhic@latest"],''',
    '''        ["install", "--global", "@pinyencheng/lhic@1.2.3"],''',
)
replace_once(
    test,
    '''          "@pinyencheng/lhic@latest",''',
    '''          "@pinyencheng/lhic@1.2.3",''',
)
replace_once(
    test,
    '''      path: "C:\\npm;C:\\Windows",
      runNpm:''',
    '''      path: "C:\\npm;C:\\Windows",
      version: "1.2.3",
      runNpm:''',
)
replace_once(
    test,
    '''    expect(calls).toHaveLength(3);
  });
});''',
    '''    expect(calls).toHaveLength(3);
    expect(calls[0]).toEqual([
      "install",
      "--global",
      "@pinyencheng/lhic@1.2.3",
    ]);
  });

  it("rejects moving tags and malformed versions before invoking npm", async () => {
    expect(parseCliPackageVersion("0.1.2")).toBe("0.1.2");
    for (const invalid of [
      "latest",
      "1.2",
      "01.2.3",
      "1.2.3-beta.1",
      "1.2.3 || malicious",
    ]) {
      expect(() => parseCliPackageVersion(invalid)).toThrow(
        "exact X.Y.Z version",
      );
    }
    let invoked = false;
    await expect(
      installCliRuntime({
        version: "latest",
        runNpm: async () => {
          invoked = true;
          return { stdout: "", stderr: "" };
        },
      }),
    ).rejects.toThrow("exact X.Y.Z version");
    expect(invoked).toBe(false);
  });
});''',
)

readme = Path("README.md")
replace_once(
    readme,
    '''On macOS and Linux this creates `~/.local/bin/lhic` and adds that directory to''',
    '''The self-installer pins the exact version of the package currently running; it does not resolve a moving `latest` tag, so the CLI binary and Playwright Chromium runtime stay reproducible.

On macOS and Linux this creates `~/.local/bin/lhic` and adds that directory to''',
)

files = [str(installer), str(test), str(readme)]
subprocess.run(["npx", "prettier", "--write", *files], check=True)
subprocess.run(
    ["npx", "vitest", "run", "apps/cli/src/installer.test.ts"],
    check=True,
)
subprocess.run(["npm", "run", "package:smoke"], check=True)
subprocess.run(["git", "add", *files], check=True)
