import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { McpService } from "./mcp-service.js";

describe("McpService", () => {
  it("previews, backs up, and applies a detected Codex configuration", async () => {
    const root = await mkdtemp(join(tmpdir(), "lhic-desktop-mcp-"));
    const home = join(root, "home");
    await mkdir(join(home, ".codex"), { recursive: true });
    const config = join(home, ".codex/config.toml");
    await writeFile(config, 'model = "gpt"\n', "utf8");
    const service = new McpService(root, home);

    const preview = await service.preview("codex", root);
    expect(preview.changed).toBe(true);
    expect(preview.after).toContain("[mcp_servers.lhic-computer-use]");

    await expect(service.apply("codex", root, "missing-token")).rejects.toThrow(
      "confirmation",
    );

    const applied = await service.apply(
      "codex",
      root,
      preview.confirmationToken,
    );
    expect(applied.backupPath).toBe(`${config}.lhic-backup`);
    await expect(readFile(config, "utf8")).resolves.toContain(
      'default_tools_approval_mode = "prompt"',
    );
    await expect(readFile(applied.backupPath!, "utf8")).resolves.toBe(
      'model = "gpt"\n',
    );
  });

  it("refuses an apply when the reviewed MCP configuration changed", async () => {
    const root = await mkdtemp(join(tmpdir(), "lhic-desktop-mcp-"));
    const home = join(root, "home");
    await mkdir(join(home, ".codex"), { recursive: true });
    const config = join(home, ".codex/config.toml");
    await writeFile(config, 'model = "gpt"\n', "utf8");
    const service = new McpService(root, home);
    const preview = await service.preview("codex", root);
    await writeFile(config, 'model = "changed-after-preview"\n', "utf8");

    await expect(
      service.apply("codex", root, preview.confirmationToken),
    ).rejects.toThrow("changed after review");
  });

  it("uses the installed OpenClaw command contract in its immutable preview", async () => {
    const root = await mkdtemp(join(tmpdir(), "lhic-desktop-mcp-"));
    const service = new McpService(root, join(root, "home"));
    const preview = await service.preview("openclaw", root);

    expect(preview.after.split("\u0000").slice(0, 4)).toEqual([
      "openclaw",
      "mcp",
      "set",
      "lhic-computer-use",
    ]);
    expect(preview.healthCheck).toBe("openclaw mcp list");
  });

  it("runs only an allowlisted MCP health command and redacts diagnostics", async () => {
    const root = await mkdtemp(join(tmpdir(), "lhic-desktop-mcp-"));
    const invocations: string[][] = [];
    const service = new McpService(root, join(root, "home"), {
      runProcess: async (executable, argumentsList) => {
        invocations.push([executable, ...argumentsList]);
        return {
          exitCode: 1,
          stdout: "",
          stderr: "api_test_token_123456789012",
        };
      },
    });

    await expect(service.probe("openclaw", root)).resolves.toEqual({
      status: "failed",
      command: "openclaw mcp list",
      message: "[REDACTED_TOKEN]",
    });
    expect(invocations).toEqual([["openclaw", "mcp", "list"]]);
  });

  it("accepts only declarative, workspace-contained custom MCP adapters", async () => {
    const root = await mkdtemp(join(tmpdir(), "lhic-desktop-mcp-"));
    await mkdir(join(root, ".lhic"), { recursive: true });
    await mkdir(join(root, ".agent"), { recursive: true });
    await writeFile(join(root, ".agent/mcp.json"), "{}\n", "utf8");
    await writeFile(
      join(root, ".lhic/custom-mcp-adapter.json"),
      JSON.stringify({
        label: "Acme Agent",
        executable: "acme-agent",
        configPath: ".agent/mcp.json",
        configFormat: "json",
        serverCollectionKey: "mcpServers",
        healthCommand: ["acme-agent", "mcp", "list"],
      }),
      "utf8",
    );
    const service = new McpService(root, join(root, "home"));
    const preview = await service.preview("custom", root);

    expect(preview.adapter).toMatchObject({
      detected: true,
      configPath: join(root, ".agent/mcp.json"),
      configFormat: "json",
    });
    expect(preview.after).toContain('"lhic-computer-use"');
    expect(preview.healthCheck).toBe("acme-agent mcp list");
  });

  it("rejects custom adapter paths that escape the workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "lhic-desktop-mcp-"));
    await mkdir(join(root, ".lhic"), { recursive: true });
    await writeFile(
      join(root, ".lhic/custom-mcp-adapter.json"),
      JSON.stringify({
        label: "Unsafe Agent",
        executable: "unsafe-agent",
        configPath: "../outside.json",
        configFormat: "json",
        serverCollectionKey: "mcpServers",
        healthCommand: ["unsafe-agent", "mcp", "list"],
      }),
      "utf8",
    );
    const service = new McpService(root, join(root, "home"));

    await expect(service.preview("custom", root)).rejects.toThrow(
      "must remain inside",
    );
  });
});
