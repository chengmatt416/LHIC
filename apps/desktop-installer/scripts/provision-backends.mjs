#!/usr/bin/env node
/**
 * Best-effort provisioning of the LHIC desktop execution-layer packages.
 *
 *   node provision-backends.mjs [--check]
 *
 * Provisions, per platform and OS version:
 *   - macOS 15+: Peekaboo CLI (brew steipete/tap/peekaboo, else npm
 *     @steipete/peekaboo) — the element-grounded execution layer.
 *   - Windows 10 1607+: FlaUI bridge (dotnet publish of the bundled helper;
 *     installs the .NET SDK via winget when missing).
 *   - Any: OmniParser V2 fallback (pip install omni_parser_v2) and Playwright
 *     Chromium for the browser runner (npx playwright install chromium).
 *
 * Nothing here is fatal: every step is best-effort and the executor falls
 * back to the traditional layer when a backend stays unavailable. Opt out
 * with LHIC_SKIP_BACKENDS=1 (or per-backend LHIC_SKIP_PEEKABOO /
 * LHIC_SKIP_FLAUI / LHIC_SKIP_OMNIPARSER / LHIC_SKIP_CHROMIUM).
 *
 * --check only reports what is installed and what would be installed.
 */
import { execFile } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const checkOnly = process.argv.includes("--check");
const skipAll = process.env.LHIC_SKIP_BACKENDS === "1";
const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const skip = {
  peekaboo: skipAll || process.env.LHIC_SKIP_PEEKABOO === "1",
  flaui: skipAll || process.env.LHIC_SKIP_FLAUI === "1",
  omniparser: skipAll || process.env.LHIC_SKIP_OMNIPARSER === "1",
  chromium: skipAll || process.env.LHIC_SKIP_CHROMIUM === "1",
};

function run(
  file,
  args,
  timeoutMs = 120_000,
) {
  return new Promise((resolvePromise) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, windowsHide: true },
      (error, stdout, stderr) => {
        resolvePromise({
          stdout: String(stdout),
          stderr: String(stderr),
          code: error && typeof error === "object" && "code" in error
            ? Number(error.code) || 1
            : 0,
        });
      },
    );
  });
}

async function commandExists(file) {
  const result = await run(file, ["--version"], 10_000);
  return result.code === 0;
}

async function macOsMajor() {
  const result = await run("sw_vers", ["-productVersion"], 5_000);
  if (result.code !== 0) return undefined;
  return Number(result.stdout.trim().split(".")[0]);
}

async function windowsVersion() {
  const result = await run(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      "Write-Output ([System.Environment]::OSVersion.Version.ToString())",
    ],
    5_000,
  );
  if (result.code !== 0) return undefined;
  const parts = result.stdout.trim().split(".").map(Number);
  if (parts.length < 2 || !parts.slice(0, 2).every(Number.isFinite)) {
    return undefined;
  }
  return { major: parts[0], build: parts[2] ?? 0 };
}

async function provisionPeekaboo(report) {
  if (process.platform !== "darwin") {
    report.push("peekaboo: skipped — macOS-only execution layer");
    return;
  }
  if (await commandExists("peekaboo")) {
    report.push("peekaboo: already installed");
    return;
  }
  const major = await macOsMajor();
  if (major !== undefined && major < 15) {
    report.push(
      `peekaboo: skipped — requires macOS 15 or later (this system is macOS ${major}); the traditional osascript layer is used`,
    );
    return;
  }
  if (checkOnly) {
    report.push("peekaboo: would install (brew steipete/tap/peekaboo or npm @steipete/peekaboo)");
    return;
  }
  if (await commandExists("brew")) {
    report.push("peekaboo: installing via Homebrew (steipete/tap/peekaboo)…");
    await run("brew", ["install", "steipete/tap/peekaboo"], 600_000);
  } else if (await commandExists("npm")) {
    report.push("peekaboo: installing via npm (@steipete/peekaboo)…");
    await run("npm", ["install", "--global", "@steipete/peekaboo"], 600_000);
  } else {
    report.push(
      "peekaboo: neither brew nor npm is available — install it manually (brew install steipete/tap/peekaboo)",
    );
  }
}

async function provisionFlaUI(report) {
  const version = await windowsVersion();
  if (version === undefined) {
    report.push("flaui: skipped — Windows-only execution layer");
    return;
  }
  if (version.major < 10 || (version.major === 10 && version.build < 14_393)) {
    report.push(
      `flaui: skipped — requires Windows 10 1607 or later (this system is ${version.major}.${version.build}); the traditional PowerShell layer is used`,
    );
    return;
  }
  if (process.env.LHIC_FLAUI_DLL) {
    try {
      await stat(resolve(process.env.LHIC_FLAUI_DLL));
      report.push(`flaui: bridge present at LHIC_FLAUI_DLL (${process.env.LHIC_FLAUI_DLL})`);
      return;
    } catch {
      report.push(`flaui: LHIC_FLAUI_DLL set but not found (${process.env.LHIC_FLAUI_DLL}) — will build the bridge`);
    }
  }
  if (!(await commandExists("dotnet"))) {
    if (checkOnly) {
      report.push("flaui: would install the .NET SDK (winget) and build the bridge");
      return;
    }
    if (await commandExists("winget")) {
      report.push("flaui: installing the .NET SDK via winget…");
      await run("winget", ["install", "--id", "Microsoft.DotNet.SDK.8", "--silent", "--accept-source-agreements", "--accept-package-agreements"], 600_000);
    } else {
      report.push(
        "flaui: dotnet is missing and winget is unavailable — install the .NET SDK, then run `lhic-desktop provision`",
      );
      return;
    }
  }
  if (checkOnly) {
    report.push("flaui: would build the bridge (dotnet publish)");
    return;
  }
  const project = join(packageDirectory, "execution", "flaui", "lhic-flaui.csproj");
  const output = join(packageDirectory, "execution", "flaui", "bin", "win-x64");
  await mkdir(dirname(project), { recursive: true });
  report.push("flaui: building the FlaUI bridge…");
  const result = await run(
    "dotnet",
    ["publish", project, "-c", "Release", "-r", "win-x64", "--self-contained", "false", "-o", output],
    600_000,
  );
  if (result.code === 0) {
    report.push(
      `flaui: bridge built at ${join(output, "lhic-flaui.dll")} — set LHIC_FLAUI_DLL to it (or copy it beside the app)`,
    );
  } else {
    report.push(`flaui: bridge build failed: ${result.stderr.trim().slice(0, 300)}`);
  }
}

async function provisionOmniParser(report) {
  if (!(await commandExists("python3"))) {
    report.push("omniparser: skipped — python3 is not available");
    return;
  }
  const check = await run("python3", ["-c", "import omni_parser_v2; print('ok')"], 15_000);
  if (check.code === 0) {
    report.push("omniparser: omni_parser_v2 already installed");
    return;
  }
  if (checkOnly) {
    report.push("omniparser: would install (pip ladder + import verification)");
    return;
  }
  report.push("omniparser: installing omni_parser_v2 (pip ladder)…");
  const attempts = [
    ["python3", ["-m", "pip", "install", "--user", "omni_parser_v2"]],
    ["python3", ["-m", "pip", "install", "--user", "--break-system-packages", "omni_parser_v2"]],
    ["python3", ["-m", "pip", "install", "--break-system-packages", "omni_parser_v2"]],
  ];
  let lastError = "";
  for (const [file, args] of attempts) {
    const result = await run(file, args, 900_000);
    if (result.code === 0) {
      lastError = "";
      break;
    }
    lastError = result.stderr.trim().slice(0, 300);
  }
  const verified = await run("python3", ["-c", "import omni_parser_v2; print('ok')"], 15_000);
  if (verified.code === 0) {
    report.push("omniparser: installed (model weights download on first use)");
  } else {
    report.push(
      `omniparser: install failed — ${lastError || "the import check still fails"} (check PyPI access / Python version)`,
    );
  }
}

async function provisionChromium(report) {
  if (!(await commandExists("npx"))) {
    report.push("chromium: skipped — npx is not available");
    return;
  }
  if (checkOnly) {
    report.push("chromium: would install (npx playwright install chromium)");
    return;
  }
  report.push("chromium: installing Playwright Chromium…");
  const result = await run("npx", ["--yes", "playwright", "install", "chromium"], 900_000);
  if (result.code === 0) {
    report.push("chromium: installed");
  } else {
    report.push(`chromium: install failed: ${result.stderr.trim().slice(0, 300)}`);
  }
}

async function main() {
  const report = [];
  if (skipAll) {
    report.push("provisioning skipped (LHIC_SKIP_BACKENDS=1)");
  } else {
    if (!skip.peekaboo) await provisionPeekaboo(report);
    if (!skip.flaui) await provisionFlaUI(report);
    if (!skip.omniparser) await provisionOmniParser(report);
    if (!skip.chromium) await provisionChromium(report);
  }
  for (const line of report) {
    console.log(`[provision] ${line}`);
  }
  console.log(
    checkOnly
      ? "[provision] check complete — run without --check to install missing packages."
      : "[provision] done — the executor falls back to the traditional layer for anything still missing.",
  );
}

await main();
