import { createHash, randomUUID } from "node:crypto";
import { access, copyFile, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";

import type {
  McpClientAdapter,
  McpClientKind,
  McpConfigPreview,
  McpProbeResult,
  McpServerDefinition,
} from "../shared/contracts.js";
import { spawnProcess } from "./process-runner.js";

const configurationFileName = "apps/mcp-server/dist/index.js";
const confirmationTtlMs = 2 * 60_000;

interface PendingMcpConfirmation {
  client: McpClientKind;
  workspaceRoot: string;
  beforeDigest: string;
  afterDigest: string;
  expiresAt: number;
}

export interface McpServiceOptions {
  runProcess?: (
    executable: string,
    argumentsList: readonly string[],
    options: { cwd: string },
  ) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

export class McpService {
  private readonly confirmations = new Map<string, PendingMcpConfirmation>();
  private readonly runProcess: NonNullable<McpServiceOptions["runProcess"]>;

  public constructor(
    private readonly workspaceRoot: string,
    private readonly home = homedir(),
    options: McpServiceOptions = {},
  ) {
    this.runProcess =
      options.runProcess ??
      ((executable, argumentsList, processOptions) =>
        spawnProcess(executable, argumentsList, processOptions).completed);
  }

  public async list(): Promise<McpClientAdapter[]> {
    return Promise.all(
      (
        [
          "codex",
          "antigravity",
          "claude-code",
          "openclaw",
          "hermes",
          "custom",
        ] as const
      ).map((client) => this.adapter(client)),
    );
  }

  public async preview(
    client: McpClientKind,
    workspaceRoot: string,
  ): Promise<McpConfigPreview> {
    const preview = await this.createPreview(client, workspaceRoot);
    const confirmationToken = randomUUID();
    const confirmationExpiresAt = new Date(
      Date.now() + confirmationTtlMs,
    ).toISOString();
    this.confirmations.set(confirmationToken, {
      client,
      workspaceRoot: resolve(workspaceRoot),
      beforeDigest: digest(preview.before),
      afterDigest: digest(preview.after),
      expiresAt: Date.parse(confirmationExpiresAt),
    });
    return { ...preview, confirmationToken, confirmationExpiresAt };
  }

  public async apply(
    client: McpClientKind,
    workspaceRoot: string,
    confirmationToken: string,
  ): Promise<McpConfigPreview> {
    const confirmation = this.confirmations.get(confirmationToken);
    if (!confirmation || confirmation.expiresAt <= Date.now()) {
      this.confirmations.delete(confirmationToken);
      throw new Error(
        "The MCP preview confirmation has expired. Generate a new preview before applying changes.",
      );
    }
    if (
      confirmation.client !== client ||
      confirmation.workspaceRoot !== resolve(workspaceRoot)
    ) {
      throw new Error(
        "The MCP confirmation does not match this client or workspace.",
      );
    }
    const current = await this.createPreview(client, workspaceRoot);
    if (
      confirmation.beforeDigest !== digest(current.before) ||
      confirmation.afterDigest !== digest(current.after)
    ) {
      throw new Error(
        "The MCP configuration changed after review. Generate a new preview before applying changes.",
      );
    }
    this.confirmations.delete(confirmationToken);
    const preview: McpConfigPreview = {
      ...current,
      confirmationToken,
      confirmationExpiresAt: new Date(confirmation.expiresAt).toISOString(),
    };
    if (!preview.changed) return preview;
    if (preview.adapter.format === "command") {
      const [executable, ...argumentsList] = preview.after.split("\u0000");
      if (!executable) throw new Error("MCP command preview is invalid.");
      const result = await spawnProcess(executable, argumentsList, {
        cwd: this.workspaceRoot,
      }).completed;
      if (result.exitCode !== 0) {
        throw new Error(
          `MCP install command failed: ${result.stderr || result.stdout}`,
        );
      }
      return preview;
    }
    const configPath = preview.adapter.configPath;
    if (!configPath) throw new Error("MCP configuration was not detected.");
    const backupPath = `${configPath}.lhic-backup`;
    await copyFile(configPath, backupPath, 0);
    await writeFile(configPath, preview.after, {
      encoding: "utf8",
      mode: 0o600,
    });
    return { ...preview, backupPath };
  }

  public async probe(
    client: McpClientKind,
    workspaceRoot: string,
  ): Promise<McpProbeResult> {
    const adapter = await this.adapter(client);
    if (adapter.configurationError) throw new Error(adapter.configurationError);
    const command = healthCommandFor(adapter);
    if (!command) {
      return {
        status: "manual",
        message:
          "Restart the detected client, then confirm lhic-computer-use in its MCP status view.",
      };
    }
    const [executable, ...argumentsList] = command;
    const result = await this.runProcess(executable!, argumentsList, {
      cwd: resolve(workspaceRoot),
    });
    const commandText = command.join(" ");
    if (result.exitCode !== 0) {
      return {
        status: "failed",
        command: commandText,
        message: redactDiagnostic(
          result.stderr || result.stdout || "The MCP health command failed.",
        ),
      };
    }
    return {
      status: "passed",
      command: commandText,
      message: "The MCP health command completed successfully.",
    };
  }

  private async createPreview(
    client: McpClientKind,
    workspaceRoot: string,
  ): Promise<
    Omit<McpConfigPreview, "confirmationToken" | "confirmationExpiresAt">
  > {
    const adapter = await this.adapter(client);
    const definition = serverDefinition(workspaceRoot);
    if (adapter.format === "command") {
      return {
        adapter,
        before: "",
        after: commandFor(client, definition),
        changed: true,
        healthCheck: healthCheckFor(adapter),
      };
    }
    if (adapter.configurationError) {
      throw new Error(adapter.configurationError);
    }
    if (!adapter.configPath) {
      throw new Error(
        "A custom MCP adapter must provide a detected configuration file.",
      );
    }
    const before = await readDetectedConfig(adapter.configPath);
    const after = renderConfig(client, before, definition, adapter);
    return {
      adapter,
      before,
      after,
      changed: before !== after,
      healthCheck: healthCheckFor(adapter),
    };
  }

  private async adapter(client: McpClientKind): Promise<McpClientAdapter> {
    const descriptor = await adapterDescriptor(
      client,
      this.workspaceRoot,
      this.home,
    );
    const detected = descriptor.configPath
      ? await exists(descriptor.configPath)
      : descriptor.executable
        ? await executableExists(descriptor.executable)
        : false;
    return { ...descriptor, detected };
  }
}

async function adapterDescriptor(
  client: McpClientKind,
  workspaceRoot: string,
  home: string,
): Promise<Omit<McpClientAdapter, "detected">> {
  switch (client) {
    case "codex":
      return {
        id: client,
        label: "Codex",
        executable: "codex",
        configPath: resolve(home, ".codex/config.toml"),
        format: "toml",
      };
    case "antigravity":
      return {
        id: client,
        label: "Antigravity",
        executable: "agy",
        configPath: resolve(workspaceRoot, ".agents/mcp.json"),
        format: "json",
      };
    case "claude-code":
      return {
        id: client,
        label: "Claude Code",
        executable: "claude",
        configPath: resolve(workspaceRoot, ".mcp.json"),
        format: "json",
      };
    case "openclaw":
      return {
        id: client,
        label: "OpenClaw",
        executable: "openclaw",
        format: "command",
      };
    case "hermes":
      return {
        id: client,
        label: "Nous Hermes",
        executable: "hermes",
        format: "command",
      };
    case "custom":
      return customAdapterDescriptor(workspaceRoot);
  }
}

async function customAdapterDescriptor(
  workspaceRoot: string,
): Promise<Omit<McpClientAdapter, "detected">> {
  const manifestPath = resolve(workspaceRoot, ".lhic/custom-mcp-adapter.json");
  if (!(await exists(manifestPath))) {
    return {
      id: "custom",
      label: "Custom MCP client",
      format: "custom",
    };
  }
  try {
    const descriptor = parseCustomAdapter(
      JSON.parse(await readFile(manifestPath, "utf8")) as unknown,
      workspaceRoot,
    );
    return {
      id: "custom",
      label: descriptor.label,
      executable: descriptor.executable,
      configPath: descriptor.configPath,
      format: "custom",
      configFormat: descriptor.configFormat,
      serverCollectionKey: descriptor.serverCollectionKey,
      healthCommand: descriptor.healthCommand,
    };
  } catch (error) {
    return {
      id: "custom",
      label: "Custom MCP client",
      format: "custom",
      configurationError:
        error instanceof Error
          ? `Custom MCP adapter is invalid: ${error.message}`
          : "Custom MCP adapter is invalid.",
    };
  }
}

interface CustomAdapterConfig {
  label: string;
  executable: string;
  configPath: string;
  configFormat: "toml" | "json";
  serverCollectionKey: string;
  healthCommand: string[];
}

function parseCustomAdapter(
  value: unknown,
  workspaceRoot: string,
): CustomAdapterConfig {
  if (!isRecord(value)) {
    throw new Error("the adapter manifest must be a JSON object");
  }
  const label = requiredAdapterString(value.label, "label", 96);
  const executable = requiredAdapterString(value.executable, "executable", 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(executable)) {
    throw new Error("executable must be a command name, not a path or script");
  }
  const configPathInput = requiredAdapterString(
    value.configPath,
    "configPath",
    512,
  );
  if (isAbsolute(configPathInput)) {
    throw new Error("configPath must be relative to the selected workspace");
  }
  const root = resolve(workspaceRoot);
  const configPath = resolve(root, configPathInput);
  const pathFromRoot = relative(root, configPath);
  if (
    pathFromRoot === "" ||
    pathFromRoot === ".." ||
    pathFromRoot.startsWith("../") ||
    isAbsolute(pathFromRoot)
  ) {
    throw new Error("configPath must remain inside the selected workspace");
  }
  const configFormat = value.configFormat;
  if (configFormat !== "json" && configFormat !== "toml") {
    throw new Error("configFormat must be json or toml");
  }
  const serverCollectionKey = requiredAdapterString(
    value.serverCollectionKey,
    "serverCollectionKey",
    64,
  );
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(serverCollectionKey)) {
    throw new Error("serverCollectionKey is invalid");
  }
  const healthCommand = parseHealthCommand(value.healthCommand, executable);
  return {
    label,
    executable,
    configPath,
    configFormat,
    serverCollectionKey,
    healthCommand,
  };
}

function requiredAdapterString(
  value: unknown,
  name: string,
  maximum: number,
): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw new Error(`${name} is invalid`);
  }
  return value.trim();
}

function parseHealthCommand(value: unknown, executable: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(
      "healthCommand must be a fixed '<client> mcp list|status|show|get|test [lhic-computer-use]' command",
    );
  }
  const command = value;
  if (
    command.length < 3 ||
    command.length > 4 ||
    !command.every(
      (argument) =>
        typeof argument === "string" &&
        /^[A-Za-z0-9._-]{1,128}$/.test(argument),
    ) ||
    command[0] !== executable ||
    command[1] !== "mcp" ||
    !["list", "status", "show", "get", "test"].includes(command[2]) ||
    (command.length === 4 && command[3] !== "lhic-computer-use")
  ) {
    throw new Error(
      "healthCommand must be a fixed '<client> mcp list|status|show|get|test [lhic-computer-use]' command",
    );
  }
  return [...command];
}

function serverDefinition(workspaceRoot: string): McpServerDefinition {
  const root = resolve(workspaceRoot);
  return {
    command: "node",
    args: [resolve(root, configurationFileName)],
    cwd: root,
    name: "lhic-computer-use",
  };
}

function renderConfig(
  client: McpClientKind,
  before: string,
  server: McpServerDefinition,
  adapter: McpClientAdapter,
): string {
  const configFormat = adapter.configFormat ?? adapter.format;
  const serverCollectionKey =
    adapter.serverCollectionKey ??
    (client === "codex" ? "mcp_servers" : "mcpServers");
  if (configFormat === "toml") {
    const section = `[${serverCollectionKey}.${server.name}]\ncommand = "node"\nargs = [${server.args.map((argument) => JSON.stringify(argument)).join(", ")}]\ncwd = ${JSON.stringify(server.cwd)}\nstartup_timeout_sec = 20\ntool_timeout_sec = 45\ndefault_tools_approval_mode = "prompt"\n`;
    if (before.includes(`[${serverCollectionKey}.${server.name}]`))
      return before;
    return `${before.trimEnd()}\n\n${section}`;
  }
  if (configFormat === "json") {
    const parsed = JSON.parse(before) as Record<string, unknown>;
    const servers = isRecord(parsed[serverCollectionKey])
      ? parsed[serverCollectionKey]
      : {};
    return `${JSON.stringify({ ...parsed, [serverCollectionKey]: { ...servers, [server.name!]: { command: server.command, args: server.args, cwd: server.cwd } } }, null, 2)}\n`;
  }
  throw new Error(
    "This client must be configured through its own CLI command.",
  );
}

function commandFor(
  client: McpClientKind,
  server: McpServerDefinition,
): string {
  if (client === "openclaw") {
    return [
      "openclaw",
      "mcp",
      "set",
      server.name!,
      JSON.stringify({ command: server.command, args: server.args }),
    ].join("\u0000");
  }
  if (client === "hermes") {
    return [
      "hermes",
      "mcp",
      "add",
      server.name!,
      "--command",
      server.command,
      "--args",
      ...server.args,
    ].join("\u0000");
  }
  throw new Error("No command installation exists for this MCP client.");
}

function healthCheckFor(adapter: McpClientAdapter): string {
  const command = healthCommandFor(adapter);
  if (command) return command.join(" ");
  return "Restart the detected client, then verify lhic-computer-use in its MCP status view.";
}

function healthCommandFor(adapter: McpClientAdapter): string[] | undefined {
  if (adapter.healthCommand) return [...adapter.healthCommand];
  if (adapter.id === "codex")
    return ["codex", "mcp", "get", "lhic-computer-use", "--json"];
  if (adapter.id === "openclaw") return ["openclaw", "mcp", "list"];
  if (adapter.id === "hermes")
    return ["hermes", "mcp", "test", "lhic-computer-use"];
  return undefined;
}

async function readDetectedConfig(path: string): Promise<string> {
  if (!(await exists(path))) {
    throw new Error(
      `Refusing to create an undetected MCP configuration: ${path}`,
    );
  }
  return readFile(path, "utf8");
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function executableExists(executable: string): Promise<boolean> {
  try {
    const result = await spawnProcess(executable, ["--version"], {
      cwd: process.cwd(),
    }).completed;
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function redactDiagnostic(value: string): string {
  return value
    .replace(
      /\b(?:sk|pk|tok|api)[_-][A-Za-z0-9_-]{12,}\b/gi,
      "[REDACTED_TOKEN]",
    )
    .slice(0, 1_000);
}
