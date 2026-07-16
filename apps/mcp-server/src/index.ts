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
  createProductionExecutor,
  type PlaywrightDirectExecutor,
} from "@lhic/browser";
import { createMemoryDatabase, SelectorMemory, SkillStore } from "@lhic/memory";
import {
  isSemanticAction,
  type ActionExecutionResult,
  type NormalizedUIState,
  type SemanticAction,
} from "@lhic/schema";
import {
  parseRuntimeConfig,
  type ActionApproval,
  type ProductionRuntimeConfig,
} from "@lhic/security";
import { builtinSkillDefinitions } from "@lhic/skills";
import { redactPII } from "@lhic/trace";

const MCP_SERVER_VERSION = "0.1.0";
const directComputerActionTypes = new Set<SemanticAction["type"]>([
  "navigate",
  "click",
  "fill",
  "select",
  "press",
  "wait",
]);

export interface ComputerUseSnapshot {
  state: NormalizedUIState;
}

export interface ComputerUseStartResult extends ComputerUseSnapshot {
  navigation?: ActionExecutionResult;
}

export interface ComputerUseActionResult extends ComputerUseSnapshot {
  result: ActionExecutionResult;
}

export interface ComputerUseSessionStatus {
  active: boolean;
  taskId?: string;
}

export interface ComputerUseSession {
  start(url?: string): Promise<ComputerUseStartResult>;
  observe(): Promise<ComputerUseSnapshot>;
  act(
    action: SemanticAction,
    approval?: ActionApproval,
  ): Promise<ComputerUseActionResult>;
  close(): Promise<void>;
  getStatus?(): ComputerUseSessionStatus;
}

export interface McpRuntime {
  databaseFile: string;
  skillStore: SkillStore;
  selectorMemory: SelectorMemory;
  close(): void;
}

export async function createMcpRuntime(
  databaseFile = process.env.LHIC_MEMORY_DATABASE ?? ".lhic/skills.sqlite",
): Promise<McpRuntime> {
  const resolvedDatabaseFile = resolve(databaseFile);
  await mkdir(dirname(resolvedDatabaseFile), { recursive: true });
  const database = createMemoryDatabase(resolvedDatabaseFile);
  database.exec("PRAGMA journal_mode = WAL;");
  const skillStore = new SkillStore(database);
  for (const skill of builtinSkillDefinitions) {
    skillStore.preload(skill.name, skill.definition);
  }

  return {
    databaseFile: resolvedDatabaseFile,
    skillStore,
    selectorMemory: new SelectorMemory(database),
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
    action: SemanticAction,
    approval?: ActionApproval,
  ): Promise<ComputerUseActionResult> {
    return this.enqueue(() => this.session.act(action, approval));
  }

  public close(): Promise<void> {
    return this.enqueue(() => this.session.close());
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
  private executor: PlaywrightDirectExecutor | null = null;
  private taskId = this.createTaskId();

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
    action: SemanticAction,
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
  }

  public getStatus(): ComputerUseSessionStatus {
    return {
      active: this.browser !== null && this.page !== null,
      ...(this.browser && this.page ? { taskId: this.taskId } : {}),
    };
  }

  private async ensureSession(): Promise<{
    page: Page;
    observer: BrowserStateObserver;
    executor: PlaywrightDirectExecutor;
  }> {
    if (this.page && this.observer && this.executor) {
      return {
        page: this.page,
        observer: this.observer,
        executor: this.executor,
      };
    }

    const browser = await chromium.launch({
      headless:
        this.options.headless ?? process.env.LHIC_MCP_HEADLESS === "true",
    });

    try {
      const page = await browser.newPage();
      const observer = new BrowserStateObserver(page);
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
      this.executor = executor;

      browser.once("disconnected", () => this.resetSession());
      page.once("close", () => this.resetSession());

      return { page, observer, executor };
    } catch (error) {
      await browser.close().catch(() => undefined);
      throw error;
    }
  }

  private async ensureStartedSession(): Promise<{
    page: Page;
    observer: BrowserStateObserver;
    executor: PlaywrightDirectExecutor;
  }> {
    if (!this.browser || !this.page || !this.observer || !this.executor) {
      throw new Error(
        "No browser session is active. Call lhic_browser_start before observing or acting.",
      );
    }

    return {
      page: this.page,
      observer: this.observer,
      executor: this.executor,
    };
  }

  private resetSession(): void {
    this.observer?.dispose();
    this.browser = null;
    this.page = null;
    this.observer = null;
    this.executor = null;
  }

  private createTaskId(): string {
    return `antigravity-${randomUUID().slice(0, 8)}`;
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
        if (!isSemanticAction(action)) {
          return toolError("action must be a valid SemanticAction.");
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
      case "lhic_browser_close":
        await session.close();
        return toolResult({ closed: true });
      case "lhic_runtime_status":
        return toolResult(runtimeStatus(session, runtime));
      case "lhic_skills_list":
        return toolResult(
          listSkills(runtime, optionalInteger(args?.limit, "limit")),
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
      note: "MCP is an external-agent and debugging boundary; LHIC Fast Path runs locally through Playwright.",
    },
    learning: runtime
      ? {
          enabled: true,
          databaseFile: runtime.databaseFile,
          skillCount: runtime.skillStore.list(1_000).length,
          selectorCandidateCount: runtime.selectorMemory.list(1_000).length,
          selectorMemory:
            "Successful direct DOM actions are retained locally as selector-memory candidates.",
        }
      : {
          enabled: false,
          reason: "No local memory runtime was supplied.",
        },
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
