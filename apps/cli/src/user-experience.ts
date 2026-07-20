import { access } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  createMemoryDatabase,
  SkillStore,
  type SkillLifecycle,
} from "@lhic/memory";
import { inspectGlobalControlCapability } from "@lhic/skills";

import {
  renderMcpHarnessConfig,
  type McpHarness,
} from "./mcp-harness-config.js";
import { runPreflight, type PreflightCheck } from "./preflight.js";
import { startLocalRuntime } from "./start.js";

const defaultMemoryDatabasePath = ".lhic/skills.sqlite";

export type DoctorStatus = "pass" | "warn" | "fail";

export interface DoctorItem {
  name: string;
  status: DoctorStatus;
  detail: string;
  fix?: string;
}

export interface UserDoctorReport {
  ready: boolean;
  browserReady: boolean;
  desktopReady: boolean;
  databaseFile: string;
  skillCount: number;
  items: DoctorItem[];
}

export interface UserSetupOptions {
  harness: McpHarness;
  workspaceRoot?: string;
  databaseFile?: string;
}

export interface UserSetupReport {
  ready: boolean;
  databaseFile: string;
  preloadedSkills: string[];
  mcpHarness: McpHarness;
  mcpReady: boolean;
  mcpConfig?: string;
  doctor: UserDoctorReport;
  nextSteps: string[];
}

export interface SkillProgressItem {
  name: string;
  kind: "skill" | "candidate";
  stage: SkillLifecycle | "candidate";
  successes: number;
  failures: number;
  progress: string;
  nextStep: string;
}

export async function runUserDoctor(
  databaseFile = defaultMemoryDatabasePath,
): Promise<UserDoctorReport> {
  const resolvedDatabaseFile = resolve(databaseFile);
  const preflight = await runPreflight();
  const items = preflight.checks.map(doctorItemForPreflightCheck);
  const criticalNames = new Set([
    "node-version",
    "non-root-execution",
    "runtime-configuration",
    "trace-storage",
    "chromium",
  ]);
  const browserReady = preflight.checks
    .filter((check) => criticalNames.has(check.name))
    .every((check) => check.passed);

  let desktopReady = false;
  try {
    const desktop = await inspectGlobalControlCapability();
    desktopReady = desktop.supported;
    items.push({
      name: "desktop-control",
      status: desktop.supported ? "pass" : "warn",
      detail: desktop.detail,
      ...(desktop.supported
        ? {}
        : {
            fix: "Browser automation remains available. Run `lhic global doctor` after granting the required OS permission or installing the platform dependency.",
          }),
    });
  } catch (error) {
    items.push({
      name: "desktop-control",
      status: "warn",
      detail:
        error instanceof Error
          ? error.message
          : "Desktop control could not be inspected.",
      fix: "Browser automation remains available; desktop control is optional.",
    });
  }

  let skillCount = 0;
  try {
    await access(resolvedDatabaseFile);
    const database = createMemoryDatabase(resolvedDatabaseFile);
    try {
      skillCount = new SkillStore(database).list(1_000).length;
    } finally {
      database.close();
    }
    items.push({
      name: "skill-memory",
      status: "pass",
      detail: `${skillCount} local Skills are available in ${resolvedDatabaseFile}.`,
    });
  } catch {
    items.push({
      name: "skill-memory",
      status: "warn",
      detail: `Local Skill memory has not been initialized at ${resolvedDatabaseFile}.`,
      fix: `Run \`lhic start ${databaseFile}\` or use \`lhic setup\`.`,
    });
  }

  return {
    ready: browserReady,
    browserReady,
    desktopReady,
    databaseFile: resolvedDatabaseFile,
    skillCount,
    items,
  };
}

export async function runUserSetup(
  options: UserSetupOptions,
): Promise<UserSetupReport> {
  const databaseFile = options.databaseFile ?? defaultMemoryDatabasePath;
  const runtime = await startLocalRuntime(databaseFile);
  const doctor = await runUserDoctor(runtime.databaseFile);
  const workspaceRoot = resolve(options.workspaceRoot ?? process.cwd());
  const mcpEntrypoint = join(
    workspaceRoot,
    "apps",
    "mcp-server",
    "dist",
    "index.js",
  );
  let mcpReady = true;
  try {
    await access(mcpEntrypoint);
  } catch {
    mcpReady = false;
  }

  const nextSteps = !doctor.browserReady
    ? [
        "Apply the fixes listed by `lhic doctor`.",
        "Run `lhic setup` again after the failed checks are resolved.",
      ]
    : !mcpReady
      ? [
          `Build the MCP server first: run \`npm run build\` in ${workspaceRoot}.`,
          "Re-run `lhic setup` after apps/mcp-server/dist/index.js exists.",
          "You can still use `lhic demo`, `lhic gui`, and local plans without MCP.",
        ]
      : [
          "Review and add the generated MCP configuration to your client.",
          "Restart the MCP client and verify that `lhic_runtime_status` is available.",
          "Run `lhic skills` at any time to inspect local learning progress.",
        ];

  return {
    ready: doctor.browserReady && mcpReady,
    databaseFile: runtime.databaseFile,
    preloadedSkills: runtime.preloadedSkills,
    mcpHarness: options.harness,
    mcpReady,
    ...(mcpReady
      ? { mcpConfig: renderMcpHarnessConfig(options.harness, workspaceRoot) }
      : {}),
    doctor,
    nextSteps,
  };
}

export async function listSkillProgress(
  databaseFile = defaultMemoryDatabasePath,
): Promise<SkillProgressItem[]> {
  const resolvedDatabaseFile = resolve(databaseFile);
  try {
    await access(resolvedDatabaseFile);
  } catch {
    throw new Error(
      `Skill memory does not exist at ${resolvedDatabaseFile}. Run \`lhic start\` or \`lhic setup\` first.`,
    );
  }

  const database = createMemoryDatabase(resolvedDatabaseFile);
  try {
    const skills = new SkillStore(database).list(1_000).map((skill) => ({
      name: skill.name,
      kind: "skill" as const,
      stage: skill.lifecycle,
      successes: skill.successCount,
      failures: skill.failureCount,
      ...lifecycleProgress(skill.lifecycle, skill.successCount),
    }));
    const candidates = database
      .prepare(
        `
          SELECT name, verified_run_count, holdout_passed
          FROM candidate_skills
          WHERE promoted_at IS NULL
          ORDER BY name ASC
        `,
      )
      .all() as unknown as Array<{
      name: string;
      verified_run_count: number;
      holdout_passed: number;
    }>;

    return [
      ...skills,
      ...candidates.map((candidate) => ({
        name: candidate.name,
        kind: "candidate" as const,
        stage: "candidate" as const,
        successes: candidate.verified_run_count,
        failures: 0,
        progress: `${Math.min(candidate.verified_run_count, 3)}/3 verified runs; holdout ${candidate.holdout_passed === 1 ? "passed" : "pending"}`,
        nextStep:
          candidate.verified_run_count < 3
            ? `${3 - candidate.verified_run_count} more independent verified run(s) required.`
            : candidate.holdout_passed === 1
              ? "Ready for promotion review."
              : "Run the separate offline holdout evaluation.",
      })),
    ].sort((left, right) => left.name.localeCompare(right.name));
  } finally {
    database.close();
  }
}

export function formatDoctorReport(report: UserDoctorReport): string {
  const lines = [
    `LHIC doctor: ${report.browserReady ? "browser runtime ready" : "action required"}`,
    `Skill memory: ${report.databaseFile}`,
    "",
  ];
  for (const item of report.items) {
    lines.push(`[${item.status.toUpperCase()}] ${item.name}: ${item.detail}`);
    if (item.fix) lines.push(`  Fix: ${item.fix}`);
  }
  lines.push(
    "",
    report.desktopReady
      ? "Browser and global desktop control are available."
      : "Browser automation status is shown above; global desktop control is optional.",
  );
  return `${lines.join("\n")}\n`;
}

export function formatSetupReport(report: UserSetupReport): string {
  return [
    `LHIC setup: ${report.ready ? "ready" : "action required"}`,
    `Skill memory: ${report.databaseFile}`,
    `Preloaded Skills: ${report.preloadedSkills.join(", ")}`,
    `MCP client: ${report.mcpHarness}`,
    "",
    report.mcpConfig
      ? "MCP configuration (review before applying):"
      : "MCP configuration is not available because the compiled server was not found.",
    ...(report.mcpConfig ? [report.mcpConfig.trimEnd(), ""] : [""]),
    "Next steps:",
    ...report.nextSteps.map((step, index) => `${index + 1}. ${step}`),
    "",
  ].join("\n");
}

export function formatSkillProgress(items: SkillProgressItem[]): string {
  if (items.length === 0) {
    return "No local Skills have been initialized. Run `lhic start` first.\n";
  }
  return `${[
    "LHIC Skill progress",
    "",
    ...items.flatMap((item) => [
      `${item.name} [${item.stage}] — ${item.progress}`,
      `  Next: ${item.nextStep}`,
    ]),
  ].join("\n")}\n`;
}

function doctorItemForPreflightCheck(check: PreflightCheck): DoctorItem {
  const warningOnly = check.name === "dns-integrity";
  const fix = check.passed ? undefined : fixForPreflightCheck(check.name);
  return {
    name: check.name,
    status: check.passed ? "pass" : warningOnly ? "warn" : "fail",
    detail: check.detail,
    ...(fix ? { fix } : {}),
  };
}

function fixForPreflightCheck(name: string): string | undefined {
  switch (name) {
    case "node-version":
      return "Install Node.js 24, open a new terminal, and run `lhic doctor` again.";
    case "non-root-execution":
      return "Run LHIC as your normal user instead of root or Administrator.";
    case "dns-integrity":
      return "Check the network, VPN, proxy, and DNS configuration. Local Fast Path execution can still work after installation.";
    case "runtime-configuration":
      return "Review LHIC_ENV, LHIC_ALLOWED_ORIGINS, approval-key, and trace-directory environment variables.";
    case "trace-storage":
      return "Set LHIC_TRACE_DIRECTORY to a private writable directory owned by the current user.";
    case "chromium":
      return "Run `npx playwright install chromium`, or reinstall the LHIC CLI with `npx @pinyencheng/lhic install cli`.";
    default:
      return undefined;
  }
}

function lifecycleProgress(
  lifecycle: SkillLifecycle,
  successes: number,
): Pick<SkillProgressItem, "progress" | "nextStep"> {
  switch (lifecycle) {
    case "draft":
      return {
        progress: `${successes} verified success(es)`,
        nextStep: "Complete one verifier-backed run to become verified.",
      };
    case "verified":
      return {
        progress: `${Math.min(successes, 3)}/3 verified successes`,
        nextStep: `${Math.max(0, 3 - successes)} more verified success(es) to become a habit.`,
      };
    case "habit":
      return {
        progress: `${Math.min(successes, 10)}/10 verified successes`,
        nextStep: `${Math.max(0, 10 - successes)} more verified success(es) to become trusted.`,
      };
    case "trusted":
      return {
        progress: `${successes} verified successes`,
        nextStep:
          "Trusted Fast Path Skill; continue monitoring verifier failures.",
      };
  }
}
