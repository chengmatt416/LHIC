#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { chromium, type Browser, type Page } from "playwright";

import {
  BrowserStateObserver,
  ConsoleNetworkObserver,
  createProductionExecutor,
  type PlaywrightDirectExecutor,
} from "@lhic/browser";
import {
  executeBrowserPlan,
  learnDemoSkill,
  type BrowserPlanRunResult,
  type BrowserPlanStepOutcome,
  type LocalEmbeddingEngine,
  TransformersEmbeddingEngine,
} from "@lhic/controller";
import { createMemoryDatabase, SelectorMemory, SkillStore } from "@lhic/memory";
import {
  createConfiguredSharedSkillsRuntime,
  type ConfiguredSharedSkillsRuntime,
} from "@lhic/shared-skills";
import {
  isBrowserSemanticAction,
  isBrowserExecutionPlan,
  type ActionExecutionResult,
  type BrowserSemanticAction,
  type BrowserExecutionPlan,
  type NormalizedUIState,
} from "@lhic/schema";
import {
  parseRuntimeConfig,
  type ActionApproval,
  type ProductionRuntimeConfig,
} from "@lhic/security";
import { builtinSkillDefinitions } from "@lhic/skills";
import { redactPII } from "@lhic/trace";
import { VerifierEngine } from "@lhic/verifier";

const MCP_SERVER_VERSION = "0.1.0";
const directComputerActionTypes = new Set<BrowserSemanticAction["type"]>([
  "navigate",
  "click",
  "fill",
  "select",
  "press",
  "wait",
]);

interface PendingMcpPlanTraining {
  plan: BrowserExecutionPlan;
  initialState: NormalizedUIState;
  taskId: string;
}

const pendingMcpPlanTraining = new WeakMap<
  ComputerUseSession,
  PendingMcpPlanTraining
>();

export interface ComputerUseSnapshot {
  state: NormalizedUIState;
}

export interface ComputerUseStartResult extends ComputerUseSnapshot {
  navigation?: ActionExecutionResult;
}

export interface ComputerUseActionResult extends ComputerUseSnapshot {
  result: ActionExecutionResult;
}

export interface ComputerUsePlanResult extends ComputerUseSnapshot {
  result: BrowserPlanRunResult;
  learning?: McpPlanLearningResult;
}

export type McpPlanLearningResult =
  | {
      status: "recorded";
      candidateName: string;
      verifiedRunCount: number;
      promotion: "requires_three_independent_runs_and_holdout";
    }
  | { status: "skipped"; reason: string };

export interface ComputerUseSessionStatus {
  active: boolean;
  taskId?: string;
}

export interface ComputerUseSession {
  start(url?: string): Promise<ComputerUseStartResult>;
  observe(): Promise<ComputerUseSnapshot>;
  act(
    action: BrowserSemanticAction,
    approval?: ActionApproval,
  ): Promise<ComputerUseActionResult>;
  close(): Promise<void>;
  executePlan?(plan: BrowserExecutionPlan): Promise<ComputerUsePlanResult>;
  resumePlan?(approval: ActionApproval): Promise<ComputerUsePlanResult>;
  getStatus?(): ComputerUseSessionStatus;
}

export interface McpRuntime {
  databaseFile: string;
  skillStore: SkillStore;
  selectorMemory: SelectorMemory;
  embeddingEngine: LocalEmbeddingEngine;
  sharedSkills?: ConfiguredSharedSkillsRuntime;
  close(): void;
}

export interface McpRuntimeOptions {
  embeddingEngine?: LocalEmbeddingEngine;
}

export async function createMcpRuntime(
  databaseFile = process.env.LHIC_MEMORY_DATABASE ?? ".lhic/skills.sqlite",
  options: McpRuntimeOptions = {},
): Promise<McpRuntime> {
  const resolvedDatabaseFile = resolve(databaseFile);
  await mkdir(dirname(resolvedDatabaseFile), { recursive: true });
  const database = createMemoryDatabase(resolvedDatabaseFile);
  database.exec("PRAGMA journal_mode = WAL;");
  const skillStore = new SkillStore(database);
  for (const skill of builtinSkillDefinitions) {
    skillStore.preload(skill.name, skill.definition);
  }
  const sharedSkills = await createConfiguredSharedSkillsRuntime(
    database,
    resolvedDatabaseFile,
  );

  return {
    databaseFile: resolvedDatabaseFile,
    skillStore,
    selectorMemory: new SelectorMemory(database),
    embeddingEngine:
      options.embeddingEngine ?? new TransformersEmbeddingEngine(),
    ...(sharedSkills ? { sharedSkills } : {}),
    close: () => database.close(),
  };
}

/**
 * MCP clients may issue tool calls concurrently. A browser page has one shared
 * state, so serialize all session operations in request order.
 */
export class SerializedComputerUseSession implements ComputerUseSession {
  private operationTail: Promise<void> = Promise.resolve();

  public constructor(private readonly session: ComputerUseSession) {}

  public start(url?: string): Promise<ComputerUseStartResult> {
    return this.enqueue(() => this.session.start(url));
  }

  public observe(): Promise<ComputerUseSnapshot> {
    return this.enqueue(() => this.session.observe());
  }

  public act(
    action: BrowserSemanticAction,
    approval?: ActionApproval,
  ): Promise<ComputerUseActionResult> {
    return this.enqueue(() => this.session.act(action, approval));
  }

  public close(): Promise<void> {
    return this.enqueue(() => this.session.close());
  }

  public executePlan(
    plan: BrowserExecutionPlan,
  ): Promise<ComputerUsePlanResult> {
    if (!this.session.executePlan) {
      return Promise.reject(
        new Error("This browser session does not support batch plans."),
      );
    }
    return this.enqueue(() => this.session.executePlan!(plan));
  }

  public resumePlan(approval: ActionApproval): Promise<ComputerUsePlanResult> {
    if (!this.session.resumePlan) {
      return Promise.reject(
        new Error("This browser session does not support batch-plan resume."),
      );
    }
    return this.enqueue(() => this.session.resumePlan!(approval));
  }

  public getStatus(): ComputerUseSessionStatus {
    return this.session.getStatus?.() ?? { active: false };
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.operationTail.then(operation, operation);
    this.operationTail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

export interface PlaywrightComputerUseSessionOptions {
  headless?: boolean;
  runtimeConfig?: ProductionRuntimeConfig;
  selectorMemory?: SelectorMemory;
}

/**
 * A single browser session owned by one MCP server process. The MCP boundary
 * only exposes semantic actions; Playwright remains the local executor.
 */
export class PlaywrightComputerUseSession implements ComputerUseSession {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private observer: BrowserStateObserver | null = null;
  private networkObserver: ConsoleNetworkObserver | null = null;
  private executor: PlaywrightDirectExecutor | null = null;
  private verifier: VerifierEngine | null = null;
  private pendingPlan:
    | {
        plan: BrowserExecutionPlan;
        nextStepIndex: number;
        completedSteps: BrowserPlanStepOutcome[];
      }
    | undefined;
  private taskId = this.createTaskId();
  private planTaskId: string | undefined;

  public constructor(
    private readonly options: PlaywrightComputerUseSessionOptions = {},
  ) {}

  public async start(url?: string): Promise<ComputerUseStartResult> {
    const { executor } = await this.ensureSession();
    let navigation: ActionExecutionResult | undefined;

    if (url !== undefined) {
      navigation = await executor.execute({
        type: "navigate",
        intent: `Open ${url}`,
        target: url,
        methodPreference: ["api"],
        riskLevel: "low",
      });
    }

    const { state } = await this.observe();
    return navigation ? { state, navigation } : { state };
  }

  public async observe(): Promise<ComputerUseSnapshot> {
    const { observer } = await this.ensureStartedSession();
    return { state: await observer.observe() };
  }

  public async act(
    action: BrowserSemanticAction,
    approval?: ActionApproval,
  ): Promise<ComputerUseActionResult> {
    const { executor } = await this.ensureStartedSession();
    const result = await executor.execute(action, approval);
    const { state } = await this.observe();
    return { result, state };
  }

  public async close(): Promise<void> {
    const browser = this.browser;
    this.resetSession();
    if (browser) {
      await browser.close().catch(() => undefined);
    }
    this.taskId = this.createTaskId();
    this.planTaskId = undefined;
  }

  public async executePlan(
    plan: BrowserExecutionPlan,
  ): Promise<ComputerUsePlanResult> {
    if (this.pendingPlan) {
      throw new Error(
        "A browser plan is waiting for approval. Call lhic_browser_resume_plan.",
      );
    }
    if (!isBrowserExecutionPlan(plan)) {
      throw new Error(
        "plan must be a valid browser-plan-v1 BrowserExecutionPlan.",
      );
    }
    this.planTaskId = this.createTaskId();
    const { executor, verifier } = await this.ensureStartedSession();
    const result = await executeBrowserPlan(plan, executor, verifier, {
      requireActivationApproval: true,
    });
    return this.completePlanResult(plan, result);
  }

  public async resumePlan(
    approval: ActionApproval,
  ): Promise<ComputerUsePlanResult> {
    if (!this.pendingPlan) {
      throw new Error("No browser plan is waiting for approval.");
    }
    const { plan, nextStepIndex, completedSteps } = this.pendingPlan;
    const step = plan.steps[nextStepIndex];
    if (!step) {
      throw new Error("The pending browser plan has no next step.");
    }
    const { executor, verifier } = await this.ensureStartedSession();
    const result = await executeBrowserPlan(plan, executor, verifier, {
      startAt: nextStepIndex,
      approvals: { [step.id]: approval },
      requireActivationApproval: true,
    });
    return this.completePlanResult(plan, result, completedSteps);
  }

  public getStatus(): ComputerUseSessionStatus {
    return {
      active: this.browser !== null && this.page !== null,
      ...(this.browser && this.page
        ? { taskId: this.planTaskId ?? this.taskId }
        : {}),
    };
  }

  private async ensureSession(): Promise<{
    page: Page;
    observer: BrowserStateObserver;
    executor: PlaywrightDirectExecutor;
    verifier: VerifierEngine;
  }> {
    if (this.page && this.observer && this.executor && this.verifier) {
      return {
        page: this.page,
        observer: this.observer,
        executor: this.executor,
        verifier: this.verifier,
      };
    }

    const browser = await chromium.launch({
      headless:
        this.options.headless ?? process.env.LHIC_MCP_HEADLESS === "true",
    });

    try {
      const page = await browser.newPage();
      const networkObserver = new ConsoleNetworkObserver(page);
      const observer = new BrowserStateObserver(page, networkObserver);
      const executor = createProductionExecutor(
        page,
        this.options.runtimeConfig ?? parseRuntimeConfig(process.env),
        {
          taskId: this.taskId,
          ...(this.options.selectorMemory
            ? { selectorMemory: this.options.selectorMemory }
            : {}),
        },
      );

      this.browser = browser;
      this.page = page;
      this.observer = observer;
      this.networkObserver = networkObserver;
      this.executor = executor;
      this.verifier = new VerifierEngine({ page, networkObserver });

      browser.once("disconnected", () => this.resetSession());
      page.once("close", () => this.resetSession());

      return { page, observer, executor, verifier: this.verifier };
    } catch (error) {
      await browser.close().catch(() => undefined);
      throw error;
    }
  }

  private async ensureStartedSession(): Promise<{
    page: Page;
    observer: BrowserStateObserver;
    executor: PlaywrightDirectExecutor;
    verifier: VerifierEngine;
  }> {
    if (
      !this.browser ||
      !this.page ||
      !this.observer ||
      !this.executor ||
      !this.verifier
    ) {
      throw new Error(
        "No browser session is active. Call lhic_browser_start before observing or acting.",
      );
    }

    return {
      page: this.page,
      observer: this.observer,
      executor: this.executor,
      verifier: this.verifier,
    };
  }

  private resetSession(): void {
    this.observer?.dispose();
    this.browser = null;
    this.page = null;
    this.observer = null;
    this.networkObserver = null;
    this.executor = null;
    this.verifier = null;
    this.pendingPlan = undefined;
    this.planTaskId = undefined;
  }

  private createTaskId(): string {
    return `antigravity-${randomUUID().slice(0, 8)}`;
  }

  private async completePlanResult(
    plan: BrowserExecutionPlan,
    result: BrowserPlanRunResult,
    previousCompletedSteps: readonly BrowserPlanStepOutcome[] = [],
  ): Promise<ComputerUsePlanResult> {
    const completedSteps = [
      ...previousCompletedSteps,
      ...result.completedSteps,
    ];
    const combined: BrowserPlanRunResult = { ...result, completedSteps };
    this.pendingPlan =
      combined.status === "awaiting_approval"
        ? {
            plan,
            nextStepIndex: combined.nextStepIndex,
            completedSteps,
          }
        : undefined;
    const { state } = await this.observe();
    return { state, result: combined };
  }
}

export const COMPUTER_USE_TOOLS = [
  {
    name: "lhic_browser_start",
    description:
      "Start a visible local browser session owned by LHIC. Optionally navigate to one URL, then inspect the returned structured state before acting.",
    annotations: {
      title: "Start LHIC browser",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    outputSchema: {
      type: "object",
      additionalProperties: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "Optional absolute http(s) URL to open.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "lhic_browser_observe",
    description:
      "Read LHIC's normalized DOM/accessibility browser state. Call before every action and after every result; input values are intentionally omitted.",
    annotations: {
      title: "Observe LHIC browser",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    outputSchema: {
      type: "object",
      additionalProperties: true,
    },
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "lhic_browser_act",
    description:
      "Execute one validated SemanticAction through LHIC's local Playwright executor. High- or unknown-risk actions need a matching human ActionApproval. Do not use raw coordinates, screenshots, page-evaluate JavaScript, or browser-native tool fallbacks.",
    annotations: {
      title: "Act in LHIC browser",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    outputSchema: {
      type: "object",
      additionalProperties: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "object",
          description:
            "A SemanticAction: type, intent, target/value when needed, methodPreference, and riskLevel.",
          properties: {
            type: {
              type: "string",
              enum: ["navigate", "click", "fill", "select", "press", "wait"],
            },
            intent: { type: "string", minLength: 1 },
            target: { type: "string" },
            value: {},
            methodPreference: {
              type: "array",
              minItems: 1,
              items: {
                type: "string",
                enum: [
                  "api",
                  "dom",
                  "accessibility",
                  "keyboard",
                  "ocr",
                  "vision",
                  "mouse",
                ],
              },
            },
            riskLevel: {
              type: "string",
              enum: ["low", "medium", "high", "unknown"],
            },
          },
          required: ["type", "intent", "methodPreference", "riskLevel"],
          additionalProperties: false,
        },
        approval: {
          type: "object",
          description:
            "A human-created ActionApproval bound to the exact high- or unknown-risk action. Never fabricate one.",
          properties: {
            approvalId: { type: "string" },
            actionHash: { type: "string" },
            approvedBy: { type: "string" },
            approvedAt: { type: "string" },
            expiresAt: { type: "string" },
            signature: { type: "string" },
          },
          required: [
            "approvalId",
            "actionHash",
            "approvedBy",
            "approvedAt",
            "expiresAt",
          ],
          additionalProperties: false,
        },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
  {
    name: "lhic_browser_execute_plan",
    description:
      "Fast Path execution boundary. Execute one complete parameterized browser-plan-v1 prepared before this call by a local Skill or an external planner. LHIC never calls a model while running the plan; it pauses only for human approval or verifier failure. A fully verified plan is recorded as a local candidate Skill after execution.",
    annotations: {
      title: "Execute LHIC browser plan",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    outputSchema: { type: "object", additionalProperties: true },
    inputSchema: {
      type: "object",
      properties: {
        plan: {
          type: "object",
          description:
            "BrowserExecutionPlan: schemaVersion browser-plan-v1, goal, requiredVariables, and unique steps with action plus verification.",
          additionalProperties: true,
        },
      },
      required: ["plan"],
      additionalProperties: false,
    },
  },
  {
    name: "lhic_browser_resume_plan",
    description:
      "Resume the pending Fast Path browser plan with a human ActionApproval bound to the exact displayed step. No model call is made.",
    annotations: {
      title: "Resume LHIC browser plan",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    outputSchema: { type: "object", additionalProperties: true },
    inputSchema: {
      type: "object",
      properties: {
        approval: {
          type: "object",
          description:
            "A user-created ActionApproval for the pending plan step.",
          additionalProperties: true,
        },
      },
      required: ["approval"],
      additionalProperties: false,
    },
  },
  {
    name: "lhic_browser_close",
    description: "Close the local browser session owned by LHIC.",
    annotations: {
      title: "Close LHIC browser",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    outputSchema: {
      type: "object",
      additionalProperties: true,
    },
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "lhic_runtime_status",
    description:
      "Read LHIC runtime readiness, the active browser-session state, and local-learning storage metadata. This does not inspect page content or credentials.",
    annotations: {
      title: "Inspect LHIC runtime",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    outputSchema: {
      type: "object",
      additionalProperties: true,
    },
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "lhic_skills_list",
    description:
      "List the local verified-skill catalogue and its promotion state. Returned records contain only redacted metadata, never action input values or credentials.",
    annotations: {
      title: "List learned LHIC skills",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    outputSchema: {
      type: "object",
      additionalProperties: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 1000,
          description:
            "Maximum number of skill summaries to return (default: 100).",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "lhic_shared_skills_list",
    description:
      "List approved shared skills cached locally. Returned records contain redacted metadata only and never action input values or credentials.",
    annotations: {
      title: "List cached LHIC shared skills",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    outputSchema: {
      type: "object",
      additionalProperties: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 1000,
          description:
            "Maximum number of cached shared skill summaries to return (default: 100).",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "lhic_selector_memory_list",
    description:
      "List redacted metadata for locally verified selector-memory candidates. This exposes usage counters but never the saved selector or action input values.",
    annotations: {
      title: "List LHIC selector memory",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    outputSchema: {
      type: "object",
      additionalProperties: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 1000,
          description:
            "Maximum number of selector-memory summaries to return (default: 100).",
        },
      },
      additionalProperties: false,
    },
  },
] as const;

export function createComputerUseServer(
  session: ComputerUseSession = new PlaywrightComputerUseSession(),
  runtime?: McpRuntime,
): Server {
  const serializedSession = new SerializedComputerUseSession(session);
  const server = new Server(
    { name: "lhic-computer-use", version: MCP_SERVER_VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        "Use LHIC for browser computer use. Observe before and after each action. All browser actions must be SemanticActions executed with lhic_browser_act; high- and unknown-risk actions require a human approval.",
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: COMPUTER_USE_TOOLS,
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    callComputerUseTool(
      serializedSession,
      request.params.name,
      request.params.arguments,
      runtime,
    ),
  );

  return server;
}

export async function callComputerUseTool(
  session: ComputerUseSession,
  name: string,
  args: Record<string, unknown> | undefined,
  runtime?: McpRuntime,
): Promise<CallToolResult> {
  try {
    switch (name) {
      case "lhic_browser_start": {
        const url = optionalString(args?.url, "url");
        const result = await session.start(url);
        return toolResult(
          result,
          result.navigation !== undefined && !result.navigation.success,
        );
      }
      case "lhic_browser_observe":
        return toolResult(await session.observe());
      case "lhic_browser_act": {
        const action = args?.action;
        if (!isBrowserSemanticAction(action)) {
          return toolError("action must be a valid browser SemanticAction.");
        }
        if (!directComputerActionTypes.has(action.type)) {
          return toolError(
            "action.type must be navigate, click, fill, select, press, or wait.",
          );
        }
        const approval = args?.approval;
        if (approval !== undefined && !isActionApproval(approval)) {
          return toolError("approval must be a valid ActionApproval.");
        }
        const result = await session.act(action, approval);
        return toolResult(result, !result.result.success);
      }
      case "lhic_browser_execute_plan": {
        const plan = args?.plan;
        if (!isBrowserExecutionPlan(plan)) {
          return toolError(
            "plan must be a valid browser-plan-v1 BrowserExecutionPlan.",
          );
        }
        if (!session.executePlan) {
          return toolError(
            "This browser session does not support batch plans.",
          );
        }
        const initialState = runtime
          ? (await session.observe()).state
          : undefined;
        const result = await session.executePlan(plan);
        const learning = await captureMcpPlanLearning(
          session,
          runtime,
          result,
          initialState,
          plan,
        );
        return toolResult(
          learning ? { ...result, learning } : result,
          result.result.status === "failed",
        );
      }
      case "lhic_browser_resume_plan": {
        const approval = args?.approval;
        if (!isActionApproval(approval)) {
          return toolError("approval must be a valid ActionApproval.");
        }
        if (!session.resumePlan) {
          return toolError(
            "This browser session does not support batch-plan resume.",
          );
        }
        const result = await session.resumePlan(approval);
        const learning = await captureMcpPlanLearning(session, runtime, result);
        return toolResult(
          learning ? { ...result, learning } : result,
          result.result.status === "failed",
        );
      }
      case "lhic_browser_close":
        pendingMcpPlanTraining.delete(session);
        await session.close();
        return toolResult({ closed: true });
      case "lhic_runtime_status":
        return toolResult(runtimeStatus(session, runtime));
      case "lhic_skills_list":
        return toolResult(
          listSkills(runtime, optionalInteger(args?.limit, "limit")),
        );
      case "lhic_shared_skills_list":
        return toolResult(
          listSharedSkills(runtime, optionalInteger(args?.limit, "limit")),
        );
      case "lhic_selector_memory_list":
        return toolResult(
          listSelectorMemory(runtime, optionalInteger(args?.limit, "limit")),
        );
      default:
        return toolError(`Unknown LHIC computer-use tool: ${name}.`);
    }
  } catch (error) {
    return toolError(error instanceof Error ? error.message : String(error));
  }
}

async function captureMcpPlanLearning(
  session: ComputerUseSession,
  runtime: McpRuntime | undefined,
  result: ComputerUsePlanResult,
  initialState?: NormalizedUIState,
  plan?: BrowserExecutionPlan,
): Promise<McpPlanLearningResult | undefined> {
  if (!runtime) return undefined;

  const taskId = session.getStatus?.().taskId;
  if (plan && initialState && taskId) {
    if (result.result.status === "awaiting_approval") {
      pendingMcpPlanTraining.set(session, { plan, initialState, taskId });
      return {
        status: "skipped",
        reason: "Training waits until every plan step has verifier evidence.",
      };
    }
    if (result.result.status !== "completed") {
      return {
        status: "skipped",
        reason: "Training requires a completed plan with verifier evidence.",
      };
    }
    return recordMcpPlanCandidate(runtime, taskId, initialState, plan, result);
  }

  const pending = pendingMcpPlanTraining.get(session);
  if (!pending) return undefined;
  if (result.result.status === "awaiting_approval") {
    return {
      status: "skipped",
      reason: "Training waits until every plan step has verifier evidence.",
    };
  }
  pendingMcpPlanTraining.delete(session);
  if (result.result.status !== "completed") {
    return {
      status: "skipped",
      reason: "Training requires a completed plan with verifier evidence.",
    };
  }
  return recordMcpPlanCandidate(
    runtime,
    pending.taskId,
    pending.initialState,
    pending.plan,
    result,
  );
}

async function recordMcpPlanCandidate(
  runtime: McpRuntime,
  taskId: string,
  initialState: NormalizedUIState,
  plan: BrowserExecutionPlan,
  result: ComputerUsePlanResult,
): Promise<McpPlanLearningResult> {
  try {
    const candidate = await learnDemoSkill(
      runtime.skillStore,
      runtime.embeddingEngine,
      taskId,
      plan.goal,
      initialState,
      plan,
      result.result.completedSteps,
    );
    return {
      status: "recorded",
      candidateName: candidate.name,
      verifiedRunCount: candidate.verifiedRunCount,
      promotion: "requires_three_independent_runs_and_holdout",
    };
  } catch {
    return {
      status: "skipped",
      reason: "Local candidate training was not completed.",
    };
  }
}

function runtimeStatus(
  session: ComputerUseSession,
  runtime: McpRuntime | undefined,
): Record<string, unknown> {
  const browserSession = session.getStatus?.() ?? { active: false };
  return {
    serverVersion: MCP_SERVER_VERSION,
    browserSession,
    fastPath: {
      usesLLM: false,
      usesMcp: false,
      note: "A harness may make one planning-model call before lhic_browser_execute_plan. LHIC then runs the verified batch locally through Playwright without LLM or MCP calls.",
    },
    learning: runtime
      ? {
          enabled: true,
          databaseFile: runtime.databaseFile,
          skillCount: runtime.skillStore.list(1_000).length,
          selectorCandidateCount: runtime.selectorMemory.list(1_000).length,
          selectorMemory:
            "Successful direct DOM actions are retained locally as selector-memory candidates.",
          planTraining:
            "Only fully completed MCP browser plans with verifier evidence become local parameterized candidate Skills. Training is local and never calls an LLM or MCP server.",
          sharedSkills: runtime.sharedSkills
            ? runtime.sharedSkills.service.status()
            : { enabled: false },
        }
      : {
          enabled: false,
          reason: "No local memory runtime was supplied.",
        },
  };
}

function listSharedSkills(
  runtime: McpRuntime | undefined,
  limit: number | undefined,
): Record<string, unknown> {
  if (!runtime?.sharedSkills) {
    throw new Error("Shared skills are not enabled in this MCP runtime.");
  }
  const skills = runtime.sharedSkills.store.listApproved(
    runtime.sharedSkills.config.registryId,
    limit,
  );
  return {
    returned: skills.length,
    skills: skills.map((skill) => ({
      skillId: skill.skillId,
      name: skill.name,
      version: skill.version,
      operationKey: skill.operationKey,
      fastPathEligible: skill.fastPathEligible,
      updatedAt: skill.updatedAt,
    })),
  };
}

function listSelectorMemory(
  runtime: McpRuntime | undefined,
  limit: number | undefined,
): Record<string, unknown> {
  if (!runtime) {
    throw new Error(
      "Local selector memory is unavailable in this MCP runtime.",
    );
  }
  const entries = runtime.selectorMemory.list(limit);
  return {
    databaseFile: runtime.databaseFile,
    returned: entries.length,
    selectors: entries.map((entry) => ({
      skillName: entry.skillName,
      target: entry.target,
      successCount: entry.successCount,
      failureCount: entry.failureCount,
      ...(entry.lastSuccessAt ? { lastSuccessAt: entry.lastSuccessAt } : {}),
    })),
  };
}

function listSkills(
  runtime: McpRuntime | undefined,
  limit: number | undefined,
): Record<string, unknown> {
  if (!runtime) {
    throw new Error("Local skill memory is unavailable in this MCP runtime.");
  }
  const skills = runtime.skillStore.list(limit);
  return {
    databaseFile: runtime.databaseFile,
    returned: skills.length,
    skills: skills.map((skill) => ({
      name: skill.name,
      lifecycle: skill.lifecycle,
      successCount: skill.successCount,
      failureCount: skill.failureCount,
      ...(skill.lastSuccessAt ? { lastSuccessAt: skill.lastSuccessAt } : {}),
    })),
  };
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${name} must be a string when provided.`);
  }
  return value;
}

function optionalInteger(value: unknown, name: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > 1_000
  ) {
    throw new Error(
      `${name} must be an integer between 1 and 1000 when provided.`,
    );
  }
  return value;
}

function isActionApproval(value: unknown): value is ActionApproval {
  if (!value || typeof value !== "object") {
    return false;
  }
  const approval = value as Partial<ActionApproval>;
  return (
    typeof approval.approvalId === "string" &&
    typeof approval.actionHash === "string" &&
    typeof approval.approvedBy === "string" &&
    typeof approval.approvedAt === "string" &&
    typeof approval.expiresAt === "string" &&
    (approval.signature === undefined || typeof approval.signature === "string")
  );
}

function toolResult(value: unknown, isError = false): CallToolResult {
  const safeValue = redactPII(stripInputValues(value));
  const structuredContent = isRecord(safeValue)
    ? safeValue
    : { value: safeValue };
  return {
    content: [{ type: "text", text: JSON.stringify(safeValue, null, 2) }],
    structuredContent,
    ...(isError ? { isError: true } : {}),
  };
}

function toolError(message: string): CallToolResult {
  const safeMessage = redactPII(message);
  return {
    content: [{ type: "text", text: safeMessage }],
    structuredContent: { error: safeMessage },
    isError: true,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stripInputValues(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }

  const snapshot = value as Partial<ComputerUseSnapshot>;
  if (!snapshot.state || !Array.isArray(snapshot.state.objects)) {
    return value;
  }

  return {
    ...snapshot,
    state: {
      ...snapshot.state,
      objects: snapshot.state.objects.map((object) => {
        const safeObject = { ...object };
        delete safeObject.value;
        return safeObject;
      }),
    },
  };
}

async function runStdioServer(): Promise<void> {
  const runtime = await createMcpRuntime();
  const session = new PlaywrightComputerUseSession({
    selectorMemory: runtime.selectorMemory,
  });
  const server = createComputerUseServer(session, runtime);
  const shutdown = async (): Promise<void> => {
    await session.close();
    await server.close();
    runtime.close();
  };

  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());

  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await runStdioServer();
}
