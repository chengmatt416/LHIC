import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import { chromium } from "playwright";

import {
  executeBrowserPlan,
  resolveBrowserPlanVariables,
  type BrowserPlanStepOutcome,
  type BrowserPlanRunResult,
} from "@lhic/controller";
import { createProductionExecutor } from "@lhic/browser";
import {
  isBrowserExecutionPlan,
  type BrowserExecutionPlan,
} from "@lhic/schema";
import {
  createActionApproval,
  parseRuntimeConfig,
  type ActionApproval,
  type EnvironmentSource,
} from "@lhic/security";
import { redactPII } from "@lhic/trace";
import { VerifierEngine } from "@lhic/verifier";

import type { CliPrompter } from "./interactive.js";

export interface BrowserPlanRunArguments {
  approvalFilePath?: string;
  variables?: Readonly<Record<string, string>>;
}

/**
 * Executes a complete, pre-validated browser plan without a model or MCP
 * dependency. Each plan step must produce verifier evidence before execution
 * advances to the next step.
 */
export async function runBrowserPlanFile(
  planFilePath: string,
  options: BrowserPlanRunArguments = {},
  environment: EnvironmentSource = process.env,
): Promise<BrowserPlanRunResult> {
  const plan = resolveBrowserPlanVariables(
    await readBrowserPlanFile(planFilePath),
    options.variables ?? {},
  );
  const approvals = options.approvalFilePath
    ? await readPlanApprovals(options.approvalFilePath, plan)
    : undefined;
  const runtimeConfig = parseRuntimeConfig(environment);
  const taskId = basename(planFilePath).replace(/\.[^.]+$/, "");

  return executeResolvedBrowserPlan(plan, runtimeConfig, taskId, approvals);
}

/**
 * Runs a saved plan through the local terminal flow. In an interactive
 * development or test terminal, undeclared command-line variables are
 * collected locally and every activation is explicitly confirmed before it
 * receives a short-lived approval. Production always requires a supplied,
 * externally signed approval instead.
 */
export async function runBrowserPlanInteractively(
  planFilePath: string,
  prompter: CliPrompter,
  options: BrowserPlanRunArguments = {},
  environment: EnvironmentSource = process.env,
): Promise<BrowserPlanRunResult> {
  const sourcePlan = await readBrowserPlanFile(planFilePath);
  const variables = await collectMissingPlanVariables(
    sourcePlan,
    options.variables ?? {},
    prompter,
  );
  const plan = resolveBrowserPlanVariables(sourcePlan, variables);
  const approvals = options.approvalFilePath
    ? await readPlanApprovals(options.approvalFilePath, plan)
    : undefined;
  const runtimeConfig = parseRuntimeConfig(environment);
  const taskId = basename(planFilePath).replace(/\.[^.]+$/, "");

  return executeResolvedBrowserPlan(plan, runtimeConfig, taskId, approvals, {
    requestApproval: async (step) => {
      if (runtimeConfig.environment === "production" || !prompter.interactive) {
        return undefined;
      }
      const approved = await confirm(
        prompter,
        `Approve ${step.action.type} for ${redactPII(step.action.intent)}? (yes/no)`,
      );
      return approved
        ? createActionApproval(step.action, "local-cli-user")
        : undefined;
    },
  });
}

interface ResolvedBrowserPlanRunOptions {
  requestApproval?(
    step: BrowserExecutionPlan["steps"][number],
  ): Promise<ActionApproval | undefined>;
}

async function executeResolvedBrowserPlan(
  plan: BrowserExecutionPlan,
  runtimeConfig: ReturnType<typeof parseRuntimeConfig>,
  taskId: string,
  suppliedApprovals: Readonly<Record<string, ActionApproval>> | undefined,
  options: ResolvedBrowserPlanRunOptions = {},
): Promise<BrowserPlanRunResult> {
  const browser = await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage();
    const executor = createProductionExecutor(page, runtimeConfig, { taskId });
    const verifier = new VerifierEngine({ page });
    const approvals = { ...suppliedApprovals };
    const completedSteps: BrowserPlanStepOutcome[] = [];
    let startAt = 0;

    while (startAt < plan.steps.length) {
      const result = await executeBrowserPlan(plan, executor, verifier, {
        startAt,
        ...(Object.keys(approvals).length > 0 ? { approvals } : {}),
        requireActivationApproval: true,
      });
      completedSteps.push(...result.completedSteps);
      if (result.status !== "awaiting_approval" || !options.requestApproval) {
        return { ...result, completedSteps };
      }

      const step = plan.steps[result.nextStepIndex]!;
      const approval = await options.requestApproval(step);
      if (!approval) {
        return { ...result, completedSteps };
      }
      approvals[result.stepId] = approval;
      startAt = result.nextStepIndex;
    }

    return {
      status: "completed",
      completedSteps,
      nextStepIndex: plan.steps.length,
    };
  } finally {
    await browser.close();
  }
}

export function parseBrowserPlanRunArguments(
  argumentsList: string[],
): BrowserPlanRunArguments {
  let approvalFilePath: string | undefined;
  let sawVariable = false;
  const variables: Record<string, string> = {};

  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index]!;
    if (argument !== "--var") {
      if (approvalFilePath || sawVariable) {
        throw new Error(
          "Plan execution accepts one optional approval file followed by --var name=value options.",
        );
      }
      approvalFilePath = argument;
      continue;
    }

    const assignment = argumentsList[index + 1];
    if (!assignment) {
      throw new Error("--var requires a name=value assignment.");
    }
    sawVariable = true;
    index += 1;
    const separator = assignment.indexOf("=");
    const name = assignment.slice(0, separator);
    const value = assignment.slice(separator + 1);
    if (
      separator < 1 ||
      !/^[A-Za-z][A-Za-z0-9_-]*$/.test(name) ||
      value.length === 0
    ) {
      throw new Error(
        "Plan variables must use --var name=value with a non-empty, valid name.",
      );
    }
    if (Object.hasOwn(variables, name)) {
      throw new Error(`Plan variable ${name} was supplied more than once.`);
    }
    variables[name] = value;
  }

  return {
    ...(approvalFilePath ? { approvalFilePath } : {}),
    ...(Object.keys(variables).length > 0 ? { variables } : {}),
  };
}

async function readBrowserPlanFile(
  filePath: string,
): Promise<BrowserExecutionPlan> {
  const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
  if (!isBrowserExecutionPlan(parsed)) {
    throw new Error(
      "Plan file does not contain a valid browser-plan-v1 BrowserExecutionPlan.",
    );
  }
  return parsed;
}

async function collectMissingPlanVariables(
  plan: BrowserExecutionPlan,
  suppliedValues: Readonly<Record<string, string>>,
  prompter: CliPrompter,
): Promise<Record<string, string>> {
  const values = { ...suppliedValues };
  if (!prompter.interactive) return values;

  for (const variable of plan.requiredVariables) {
    if (values[variable.name]?.trim()) continue;
    const response = isSensitiveVariable(variable)
      ? await prompter.promptSecret(variable.prompt)
      : await prompter.prompt(variable.prompt);
    if (!response) {
      throw new Error(
        `A value is required for plan variable ${variable.name}.`,
      );
    }
    values[variable.name] = response;
  }
  return values;
}

function isSensitiveVariable(variable: {
  name: string;
  prompt: string;
}): boolean {
  return /password|passcode|secret|token|api[ _-]?key|credential/i.test(
    `${variable.name} ${variable.prompt}`,
  );
}

async function confirm(
  prompter: CliPrompter,
  message: string,
): Promise<boolean> {
  return (await prompter.prompt(message, "no")).toLowerCase() === "yes";
}

async function readPlanApprovals(
  filePath: string,
  plan: BrowserExecutionPlan,
): Promise<Record<string, ActionApproval>> {
  const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      "Plan approval file must be an object keyed by plan step ID.",
    );
  }

  const approvals: Record<string, ActionApproval> = {};
  const planStepIds = new Set(plan.steps.map((step) => step.id));
  for (const [stepId, approval] of Object.entries(parsed)) {
    if (!planStepIds.has(stepId)) {
      throw new Error(`Plan approval references unknown step ${stepId}.`);
    }
    if (!isActionApproval(approval)) {
      throw new Error(`Plan approval for step ${stepId} is invalid.`);
    }
    approvals[stepId] = approval;
  }
  return approvals;
}

function isActionApproval(value: unknown): value is ActionApproval {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<ActionApproval>;
  return (
    typeof candidate.approvalId === "string" &&
    typeof candidate.actionHash === "string" &&
    typeof candidate.approvedBy === "string" &&
    typeof candidate.approvedAt === "string" &&
    typeof candidate.expiresAt === "string" &&
    (candidate.signature === undefined ||
      typeof candidate.signature === "string")
  );
}
