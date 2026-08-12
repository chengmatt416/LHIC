import { execFile } from "node:child_process";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const markerName = "provisioned.json";

export interface ProvisioningServiceOptions {
  userDataDir: string;
  /** Directory containing execution/flaui and execution/omniparser sources. */
  executionSourceDir?: string;
  execFileImplementation?: typeof execFile;
}

interface StepReport {
  name: string;
  message: string;
}

/**
 * First-run, best-effort provisioning of the execution-layer packages so
 * installs that ship only the app (Homebrew cask, AUR, direct download) also
 * get Peekaboo (macOS), the FlaUI bridge (Windows), OmniParser V2, and
 * Playwright Chromium automatically. Every step is non-fatal: the executor
 * falls back to the traditional layer for anything still missing. Runs once
 * (marker file) unless LHIC_SKIP_BACKENDS=1; re-run by deleting the marker.
 */
export class ProvisioningService {
  private readonly marker: string;
  private readonly executionSourceDir: string | undefined;
  private readonly execFileImplementation: typeof execFile;
  private initialization: Promise<StepReport[]> | undefined;

  public constructor(options: ProvisioningServiceOptions) {
    this.marker = join(options.userDataDir, markerName);
    this.executionSourceDir = options.executionSourceDir;
    this.execFileImplementation = options.execFileImplementation ?? execFile;
  }

  public ensureProvisioned(): Promise<StepReport[]> {
    this.initialization ??= this.runOnce();
    return this.initialization;
  }

  private async runOnce(): Promise<StepReport[]> {
    if (process.env.LHIC_SKIP_BACKENDS === "1") {
      return [{ name: "skip", message: "provisioning skipped (LHIC_SKIP_BACKENDS=1)" }];
    }
    try {
      await stat(this.marker);
      return [{ name: "skip", message: "already provisioned" }];
    } catch {
      // First run — provision.
    }
    const report = await this.runProvisioning();
    try {
      await mkdir(resolve(this.marker, ".."), { recursive: true });
      await writeFile(
        this.marker,
        `${JSON.stringify(
          { provisionedAt: new Date().toISOString(), steps: report },
          null,
          2,
        )}\n`,
        { mode: 0o600 },
      );
    } catch {
      // Marker write failures never break startup.
    }
    return report;
  }

  private async runProvisioning(): Promise<StepReport[]> {
    const report: StepReport[] = [];
    if (process.platform === "darwin") {
      await this.provisionPeekaboo(report);
    } else if (process.platform === "win32") {
      await this.provisionFlaUI(report);
    }
    await this.provisionOmniParser(report);
    await this.provisionChromium(report);
    return report;
  }

  private async provisionPeekaboo(report: StepReport[]): Promise<void> {
    if (await this.commandExists("peekaboo")) {
      report.push({ name: "peekaboo", message: "already installed" });
      return;
    }
    const major = await this.macOsMajor();
    if (major !== undefined && major < 15) {
      report.push({
        name: "peekaboo",
        message: `skipped — requires macOS 15+ (this is macOS ${major}); using the traditional osascript layer`,
      });
      return;
    }
    if (await this.commandExists("brew")) {
      report.push({ name: "peekaboo", message: "installing via Homebrew…" });
      await this.run("brew", ["install", "steipete/tap/peekaboo"], 600_000);
    } else if (await this.commandExists("npm")) {
      report.push({ name: "peekaboo", message: "installing via npm…" });
      await this.run("npm", ["install", "--global", "@steipete/peekaboo"], 600_000);
    } else {
      report.push({
        name: "peekaboo",
        message: "needs Homebrew or npm — install manually (brew install steipete/tap/peekaboo)",
      });
    }
  }

  private async provisionFlaUI(report: StepReport[]): Promise<void> {
    const version = await this.windowsVersion();
    if (version === undefined || version.major < 10 || (version.major === 10 && version.build < 14_393)) {
      report.push({
        name: "flaui",
        message: `skipped — requires Windows 10 1607+ (this is ${version?.major ?? "?"}.${version?.build ?? "?"}); using the traditional PowerShell layer`,
      });
      return;
    }
    if (process.env.LHIC_FLAUI_DLL) {
      try {
        await stat(resolve(process.env.LHIC_FLAUI_DLL));
        report.push({ name: "flaui", message: `bridge present (LHIC_FLAUI_DLL=${process.env.LHIC_FLAUI_DLL})` });
        return;
      } catch {
        report.push({ name: "flaui", message: "LHIC_FLAUI_DLL set but not found — building the bridge" });
      }
    }
    if (!(await this.commandExists("dotnet"))) {
      if (await this.commandExists("winget")) {
        report.push({ name: "flaui", message: "installing the .NET SDK via winget…" });
        await this.run(
          "winget",
          ["install", "--id", "Microsoft.DotNet.SDK.8", "--silent", "--accept-source-agreements", "--accept-package-agreements"],
          600_000,
        );
      } else {
        report.push({
          name: "flaui",
          message: "dotnet missing and winget unavailable — install the .NET SDK, then run scripts/build-flaui-helper.ps1",
        });
        return;
      }
    }
    const project = this.executionSourceDir
      ? resolve(this.executionSourceDir, "flaui", "lhic-flaui.csproj")
      : undefined;
    if (!project) {
      report.push({
        name: "flaui",
        message: "bridge sources not bundled — set LHIC_FLAUI_DLL after building scripts/build-flaui-helper.ps1",
      });
      return;
    }
    report.push({ name: "flaui", message: "building the FlaUI bridge…" });
    const result = await this.run(
      "dotnet",
      ["publish", project, "-c", "Release", "-r", "win-x64", "--self-contained", "false", "-o", resolve(this.executionSourceDir!, "flaui", "bin", "win-x64")],
      600_000,
    );
    report.push(
      result.code === 0
        ? { name: "flaui", message: "bridge built — set LHIC_FLAUI_DLL to execution/flaui/bin/win-x64/lhic-flaui.dll" }
        : { name: "flaui", message: `bridge build failed: ${result.stderr.trim().slice(0, 200)}` },
    );
  }

  private async provisionOmniParser(report: StepReport[]): Promise<void> {
    if (!(await this.commandExists("python3"))) {
      report.push({ name: "omniparser", message: "skipped — python3 is not available" });
      return;
    }
    const check = await this.run("python3", ["-c", "import omni_parser_v2; print('ok')"], 15_000);
    if (check.code === 0) {
      report.push({ name: "omniparser", message: "omni_parser_v2 already installed" });
      return;
    }
    report.push({ name: "omniparser", message: "installing omni_parser_v2 (pip --user)…" });
    let result = await this.run("python3", ["-m", "pip", "install", "--user", "omni_parser_v2"], 900_000);
    if (result.code !== 0 && result.stderr.includes("externally-managed-environment")) {
      report.push({ name: "omniparser", message: "retrying with --break-system-packages (PEP 668)…" });
      result = await this.run(
        "python3",
        ["-m", "pip", "install", "--user", "--break-system-packages", "omni_parser_v2"],
        900_000,
      );
    }
    report.push(
      result.code === 0
        ? { name: "omniparser", message: "installed (weights download on first use)" }
        : { name: "omniparser", message: `install failed: ${result.stderr.trim().slice(0, 200)}` },
    );
  }

  private async provisionChromium(report: StepReport[]): Promise<void> {
    if (!(await this.commandExists("npx"))) {
      report.push({ name: "chromium", message: "skipped — npx is not available" });
      return;
    }
    report.push({ name: "chromium", message: "installing Playwright Chromium…" });
    const result = await this.run("npx", ["--yes", "playwright", "install", "chromium"], 900_000);
    report.push(
      result.code === 0
        ? { name: "chromium", message: "installed" }
        : { name: "chromium", message: `install failed: ${result.stderr.trim().slice(0, 200)}` },
    );
  }

  private async commandExists(file: string): Promise<boolean> {
    return (await this.run(file, ["--version"], 10_000)).code === 0;
  }

  private async macOsMajor(): Promise<number | undefined> {
    const result = await this.run("sw_vers", ["-productVersion"], 5_000);
    if (result.code !== 0) return undefined;
    const major = Number(result.stdout.trim().split(".")[0]);
    return Number.isFinite(major) ? major : undefined;
  }

  private async windowsVersion(): Promise<{ major: number; build: number } | undefined> {
    const result = await this.run(
      "powershell",
      ["-NoProfile", "-Command", "Write-Output ([System.Environment]::OSVersion.Version.ToString())"],
      5_000,
    );
    if (result.code !== 0) return undefined;
    const parts = result.stdout.trim().split(".").map(Number);
    if (parts.length < 2 || !parts.slice(0, 2).every(Number.isFinite)) {
      return undefined;
    }
    return { major: parts[0]!, build: Number.isFinite(parts[2]) ? parts[2]! : 0 };
  }

  private run(
    file: string,
    args: string[],
    timeoutMs: number,
  ): Promise<{ stdout: string; stderr: string; code: number }> {
    return new Promise((resolvePromise) => {
      this.execFileImplementation(
        file,
        args,
        { timeout: timeoutMs, windowsHide: true },
        (error, stdout, stderr) => {
          resolvePromise({
            stdout: String(stdout),
            stderr: String(stderr),
            code:
              error && typeof error === "object" && "code" in error
                ? Number((error as { code?: unknown }).code) || 1
                : 0,
          });
        },
      );
    });
  }
}
