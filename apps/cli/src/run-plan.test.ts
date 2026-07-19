import { generateKeyPairSync } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import type { BrowserExecutionPlan } from "@lhic/schema";
import { createActionApproval } from "@lhic/security";
import type { CliPrompter } from "./interactive.js";

import {
  parseBrowserPlanRunArguments,
  runBrowserPlanInteractively,
  runBrowserPlanFile,
} from "./run-plan.js";

const servers: Server[] = [];

describe("runBrowserPlanFile", () => {
  afterEach(async () => {
    await Promise.all(servers.splice(0).map(closeServer));
  });

  it("runs a normal multi-step browser task locally with approvals, evidence, and redacted traces", async () => {
    const server = await startDailyWorkflowFixture();
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const directory = await mkdtemp(join(tmpdir(), "lhic-run-plan-"));
    const planPath = join(directory, "daily-workflow.json");
    const approvalPath = join(directory, "daily-workflow-approvals.json");
    const plan: BrowserExecutionPlan = {
      schemaVersion: "browser-plan-v1",
      goal: "Find a project and save its daily update",
      requiredVariables: [
        { name: "query", prompt: "Project to find" },
        { name: "update", prompt: "Daily update" },
      ],
      steps: [
        {
          id: "open-workspace",
          action: {
            type: "navigate",
            intent: "open the local daily workspace",
            target: `${origin}/`,
            methodPreference: ["api"],
            riskLevel: "low",
          },
          verification: {
            type: "dom",
            description: "workspace search is ready",
            params: { selector: "#search" },
          },
        },
        {
          id: "fill-search",
          action: {
            type: "fill",
            intent: "enter the project search",
            target: "#search",
            value: "{{variables.query}}",
            methodPreference: ["dom"],
            riskLevel: "low",
          },
          verification: {
            type: "dom",
            description: "search field remains available",
            params: { selector: "#search" },
          },
        },
        {
          id: "show-project",
          action: {
            type: "click",
            intent: "show matching project",
            target: "#find-project",
            methodPreference: ["dom"],
            riskLevel: "low",
          },
          verification: {
            type: "dom",
            description: "project result is visible",
            params: { text: "Project result ready" },
          },
        },
        {
          id: "fill-update",
          action: {
            type: "fill",
            intent: "enter the daily update",
            target: "#daily-update",
            value: "{{variables.update}}",
            methodPreference: ["dom"],
            riskLevel: "low",
          },
          verification: {
            type: "dom",
            description: "daily update field remains available",
            params: { selector: "#daily-update" },
          },
        },
        {
          id: "save-draft",
          action: {
            type: "click",
            intent: "save the daily update draft",
            target: "#save-draft",
            methodPreference: ["dom"],
            riskLevel: "low",
          },
          verification: {
            type: "dom",
            description: "draft save confirmation is visible",
            params: { text: "Draft saved" },
          },
        },
      ],
    };
    const approvals = Object.fromEntries(
      ["show-project", "save-draft"].map((stepId) => {
        const step = plan.steps.find((candidate) => candidate.id === stepId);
        if (!step) throw new Error(`Fixture step ${stepId} is missing.`);
        return [
          stepId,
          createActionApproval(step.action, "daily-workflow-reviewer"),
        ];
      }),
    );

    try {
      await writeFile(planPath, JSON.stringify(plan));
      await writeFile(approvalPath, JSON.stringify(approvals));

      const result = await runBrowserPlanFile(
        planPath,
        {
          approvalFilePath: approvalPath,
          variables: {
            query: "release planning",
            update: "blue-orchid-launch-status",
          },
        },
        {
          LHIC_ENV: "test",
          LHIC_TRACE_DIRECTORY: directory,
          LHIC_ALLOW_PRIVATE_NETWORK: "true",
        },
      );

      expect(result).toMatchObject({
        status: "completed",
        nextStepIndex: plan.steps.length,
      });
      expect(result.completedSteps).toHaveLength(plan.steps.length);
      expect(
        result.completedSteps.every(
          (step) =>
            step.execution.success &&
            step.verification.success &&
            step.verification.evidence.length > 0,
        ),
      ).toBe(true);
      const trace = await readFile(
        join(directory, "daily-workflow.jsonl"),
        "utf8",
      );
      expect(trace).not.toContain("release planning");
      expect(trace).not.toContain("blue-orchid-launch-status");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("stops at an activation without an approval instead of running the rest of the plan", async () => {
    const server = await startDailyWorkflowFixture();
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const directory = await mkdtemp(join(tmpdir(), "lhic-run-plan-"));
    const planPath = join(directory, "approval-boundary.json");
    const plan: BrowserExecutionPlan = {
      schemaVersion: "browser-plan-v1",
      goal: "Show the approval boundary",
      requiredVariables: [],
      steps: [
        {
          id: "open-workspace",
          action: {
            type: "navigate",
            intent: "open the local workspace",
            target: `${origin}/`,
            methodPreference: ["api"],
            riskLevel: "low",
          },
          verification: {
            type: "dom",
            description: "workspace is ready",
            params: { selector: "#search" },
          },
        },
        {
          id: "show-project",
          action: {
            type: "click",
            intent: "show the project",
            target: "#find-project",
            methodPreference: ["dom"],
            riskLevel: "low",
          },
          verification: {
            type: "dom",
            description: "project result is visible",
            params: { text: "Project result ready" },
          },
        },
      ],
    };

    try {
      await writeFile(planPath, JSON.stringify(plan));
      const result = await runBrowserPlanFile(
        planPath,
        {},
        {
          LHIC_ENV: "test",
          LHIC_TRACE_DIRECTORY: directory,
          LHIC_ALLOW_PRIVATE_NETWORK: "true",
        },
      );

      expect(result).toMatchObject({
        status: "awaiting_approval",
        nextStepIndex: 1,
        stepId: "show-project",
        completedSteps: [{ stepId: "open-workspace" }],
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("collects normal-user variables and confirmations locally for a complete daily workflow", async () => {
    const server = await startDailyWorkflowFixture();
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const directory = await mkdtemp(join(tmpdir(), "lhic-run-plan-"));
    const planPath = join(directory, "guided-daily-workflow.json");
    const plan: BrowserExecutionPlan = {
      schemaVersion: "browser-plan-v1",
      goal: "Find a project and save a daily update",
      requiredVariables: [
        { name: "query", prompt: "Project to find" },
        { name: "update", prompt: "Daily update" },
      ],
      steps: [
        {
          id: "open-workspace",
          action: {
            type: "navigate",
            intent: "open the local daily workspace",
            target: `${origin}/`,
            methodPreference: ["api"],
            riskLevel: "low",
          },
          verification: {
            type: "dom",
            description: "workspace search is ready",
            params: { selector: "#search" },
          },
        },
        {
          id: "fill-search",
          action: {
            type: "fill",
            intent: "enter the project search",
            target: "#search",
            value: "{{variables.query}}",
            methodPreference: ["dom"],
            riskLevel: "low",
          },
          verification: {
            type: "dom",
            description: "search field remains available",
            params: { selector: "#search" },
          },
        },
        {
          id: "show-project",
          action: {
            type: "click",
            intent: "show matching project",
            target: "#find-project",
            methodPreference: ["dom"],
            riskLevel: "low",
          },
          verification: {
            type: "dom",
            description: "project result is visible",
            params: { text: "Project result ready" },
          },
        },
        {
          id: "fill-update",
          action: {
            type: "fill",
            intent: "enter the daily update",
            target: "#daily-update",
            value: "{{variables.update}}",
            methodPreference: ["dom"],
            riskLevel: "low",
          },
          verification: {
            type: "dom",
            description: "daily update field remains available",
            params: { selector: "#daily-update" },
          },
        },
        {
          id: "save-draft",
          action: {
            type: "click",
            intent: "save the daily update draft",
            target: "#save-draft",
            methodPreference: ["dom"],
            riskLevel: "low",
          },
          verification: {
            type: "dom",
            description: "draft save confirmation is visible",
            params: { text: "Draft saved" },
          },
        },
      ],
    };

    try {
      await writeFile(planPath, JSON.stringify(plan));
      const result = await runBrowserPlanInteractively(
        planPath,
        createPrompter([
          "release planning",
          "blue-orchid-launch-status",
          "yes",
          "yes",
        ]),
        {},
        {
          LHIC_ENV: "test",
          LHIC_TRACE_DIRECTORY: directory,
          LHIC_ALLOW_PRIVATE_NETWORK: "true",
        },
      );

      expect(result).toMatchObject({
        status: "completed",
        nextStepIndex: plan.steps.length,
      });
      expect(result.completedSteps).toHaveLength(plan.steps.length);
      const trace = await readFile(
        join(directory, "guided-daily-workflow.jsonl"),
        "utf8",
      );
      expect(trace).not.toContain("release planning");
      expect(trace).not.toContain("blue-orchid-launch-status");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not create local approvals in production", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lhic-run-plan-"));
    const planPath = join(directory, "production-approval.json");
    const { publicKey } = generateKeyPairSync("ed25519");
    const plan: BrowserExecutionPlan = {
      schemaVersion: "browser-plan-v1",
      goal: "Confirm production approval behavior",
      requiredVariables: [],
      steps: [
        {
          id: "approved-action",
          action: {
            type: "click",
            intent: "confirm a production action",
            target: "#confirm",
            methodPreference: ["dom"],
            riskLevel: "low",
          },
          verification: {
            type: "dom",
            description: "confirmation is visible",
            params: { text: "Confirmed" },
          },
        },
      ],
    };

    try {
      await writeFile(planPath, JSON.stringify(plan));
      const prompter = createPrompter(["yes"]);
      const result = await runBrowserPlanInteractively(
        planPath,
        prompter,
        {},
        {
          LHIC_ENV: "production",
          LHIC_TRACE_DIRECTORY: directory,
          LHIC_ALLOWED_ORIGINS: "https://example.test",
          LHIC_APPROVAL_PUBLIC_KEY: publicKey
            .export({ type: "spki", format: "pem" })
            .toString(),
        },
      );

      expect(result).toMatchObject({
        status: "awaiting_approval",
        stepId: "approved-action",
      });
      expect(prompter.responses).toEqual(["yes"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("parseBrowserPlanRunArguments", () => {
  it("accepts one approval file and declared variable assignments", () => {
    expect(
      parseBrowserPlanRunArguments([
        "approvals.json",
        "--var",
        "query=weekly plan",
        "--var",
        "title=Planning = review",
      ]),
    ).toEqual({
      approvalFilePath: "approvals.json",
      variables: { query: "weekly plan", title: "Planning = review" },
    });
  });

  it("rejects malformed and repeated variable assignments", () => {
    expect(() => parseBrowserPlanRunArguments(["--var", "query="])).toThrow(
      "name=value",
    );
    expect(() =>
      parseBrowserPlanRunArguments([
        "--var",
        "query=first",
        "--var",
        "query=second",
      ]),
    ).toThrow("more than once");
    expect(() =>
      parseBrowserPlanRunArguments(["--var", "query=first", "approvals.json"]),
    ).toThrow("approval file followed by --var");
  });
});

async function startDailyWorkflowFixture(): Promise<Server> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`
      <main>
        <label>Search <input id="search" type="search"></label>
        <button id="find-project" type="button">Find project</button>
        <p id="project-result"></p>
        <label>Daily update <textarea id="daily-update"></textarea></label>
        <button id="save-draft" type="button">Save draft</button>
        <p id="save-result"></p>
      </main>
      <script>
        document.querySelector('#find-project').addEventListener('click', () => {
          document.querySelector('#project-result').textContent = 'Project result ready';
        });
        document.querySelector('#save-draft').addEventListener('click', () => {
          document.querySelector('#save-result').textContent = 'Draft saved';
        });
      </script>
    `);
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function createPrompter(
  responses: string[],
): CliPrompter & { responses: string[] } {
  return {
    interactive: true,
    responses,
    prompt: async () => responses.shift() ?? "",
    promptSecret: async () => responses.shift() ?? "",
    close: () => undefined,
  };
}
