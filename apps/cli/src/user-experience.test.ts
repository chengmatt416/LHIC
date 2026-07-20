import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createMemoryDatabase, SkillStore } from "@lhic/memory";
import { afterEach, describe, expect, it } from "vitest";

import {
  formatDoctorReport,
  formatSetupReport,
  formatSkillProgress,
  listSkillProgress,
  type UserDoctorReport,
  type UserSetupReport,
} from "./user-experience.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("user-friendly CLI reports", () => {
  it("renders actionable doctor fixes without hiding optional desktop status", () => {
    const report: UserDoctorReport = {
      ready: false,
      browserReady: false,
      desktopReady: false,
      databaseFile: "/tmp/skills.sqlite",
      skillCount: 0,
      items: [
        {
          name: "chromium",
          status: "fail",
          detail: "Chromium is missing.",
          fix: "Install Chromium.",
        },
        {
          name: "desktop-control",
          status: "warn",
          detail: "Wayland is unsupported.",
        },
      ],
    };

    const output = formatDoctorReport(report);
    expect(output).toContain("LHIC doctor: action required");
    expect(output).toContain("[FAIL] chromium: Chromium is missing.");
    expect(output).toContain("Fix: Install Chromium.");
    expect(output).toContain("global desktop control is optional");
  });

  it("renders setup configuration and concrete next steps", () => {
    const doctor: UserDoctorReport = {
      ready: true,
      browserReady: true,
      desktopReady: true,
      databaseFile: "/tmp/skills.sqlite",
      skillCount: 6,
      items: [],
    };
    const report: UserSetupReport = {
      ready: true,
      databaseFile: doctor.databaseFile,
      preloadedSkills: ["search", "login"],
      mcpHarness: "codex",
      mcpReady: true,
      mcpConfig: '[mcp_servers.lhic_computer_use]\ncommand = "node"\n',
      doctor,
      nextSteps: ["Restart Codex."],
    };

    const output = formatSetupReport(report);
    expect(output).toContain("LHIC setup: ready");
    expect(output).toContain("Preloaded Skills: search, login");
    expect(output).toContain("[mcp_servers.lhic_computer_use]");
    expect(output).toContain("1. Restart Codex.");
  });

  it("does not print a misleading MCP configuration before the server is built", () => {
    const doctor: UserDoctorReport = {
      ready: true,
      browserReady: true,
      desktopReady: false,
      databaseFile: "/tmp/skills.sqlite",
      skillCount: 6,
      items: [],
    };
    const report: UserSetupReport = {
      ready: false,
      databaseFile: doctor.databaseFile,
      preloadedSkills: ["search"],
      mcpHarness: "vscode",
      mcpReady: false,
      doctor,
      nextSteps: ["Run npm run build."],
    };

    const output = formatSetupReport(report);
    expect(output).toContain("compiled server was not found");
    expect(output).not.toContain("lhicComputerUse");
  });
});

describe("Skill progress", () => {
  it("explains the next lifecycle milestone from local memory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lhic-skill-progress-"));
    temporaryDirectories.push(directory);
    const databaseFile = join(directory, "skills.sqlite");
    const database = createMemoryDatabase(databaseFile);
    try {
      const store = new SkillStore(database);
      store.preload("search", { source: "test" });
      store.recordVerifiedSuccess(
        "search",
        { source: "test" },
        { success: true, evidence: ["verified"] },
      );
    } finally {
      database.close();
    }

    const progress = await listSkillProgress(databaseFile);
    expect(progress).toEqual([
      expect.objectContaining({
        name: "search",
        kind: "skill",
        stage: "verified",
        successes: 1,
        nextStep: "2 more verified success(es) to become a habit.",
      }),
    ]);
    expect(formatSkillProgress(progress)).toContain("search [verified]");
  });

  it("gives a direct initialization command when memory is missing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lhic-missing-memory-"));
    temporaryDirectories.push(directory);

    await expect(
      listSkillProgress(join(directory, "missing.sqlite")),
    ).rejects.toThrow("Run `lhic start` or `lhic setup` first");
  });
});
