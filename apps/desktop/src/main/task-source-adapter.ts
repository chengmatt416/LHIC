import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  isBrowserExecutionPlan,
  isDesktopExecutionPlan,
  type BrowserExecutionPlan,
  type DesktopExecutionPlan,
} from "@lhic/schema";
import { redactPII } from "@lhic/trace";

import type { TaskSourceConfig } from "../shared/contracts.js";
import { spawnProcess, type ProcessResult } from "./process-runner.js";

const providerTimeoutMs = 60_000;

export type TaskExecutionPlan = BrowserExecutionPlan | DesktopExecutionPlan;

export interface TaskSourceAdapterOptions {
  credentialFor(id: string): Promise<string | undefined>;
  fetchImplementation?: typeof fetch;
  runProcess?: (
    executable: string,
    argumentsList: readonly string[],
    options: { cwd: string },
  ) => Promise<ProcessResult>;
}

/**
 * Slow Path sources receive only a task description and return an untrusted
 * browser or desktop proposal. This adapter never owns a browser, MCP client,
 * or execution handle.
 */
export class TaskSourceAdapter {
  private readonly fetchImplementation: typeof fetch;
  private readonly runProcess: NonNullable<
    TaskSourceAdapterOptions["runProcess"]
  >;

  public constructor(private readonly options: TaskSourceAdapterOptions) {
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.runProcess =
      options.runProcess ??
      ((executable, argumentsList, processOptions) =>
        spawnProcess(executable, argumentsList, processOptions).completed);
  }

  public async propose(
    source: TaskSourceConfig,
    goal: string,
    workspaceRoot: string,
  ): Promise<TaskExecutionPlan> {
    const prompt = planningPrompt(goal);
    const raw = await this.request(source, prompt, workspaceRoot);
    return parsePlan(raw);
  }

  /**
   * Uses only each CLI's version command, so ambient authenticated sessions can
   * be used without reading, exporting, or logging their credentials.
   */
  public async discoverCliSources(
    workspaceRoot: string,
  ): Promise<TaskSourceConfig[]> {
    const candidates = [
      { kind: "codex-cli" as const, executable: "codex", label: "Codex CLI" },
      {
        kind: "antigravity-cli" as const,
        executable: "agy",
        label: "Antigravity CLI",
      },
      {
        kind: "claude-code-cli" as const,
        executable: "claude",
        label: "Claude Code CLI",
      },
    ];
    const detected = await Promise.all(
      candidates.map(async (candidate) => {
        try {
          const result = await this.runProcess(
            candidate.executable,
            ["--version"],
            {
              cwd: workspaceRoot,
            },
          );
          return result.exitCode === 0
            ? {
                id: candidate.kind,
                kind: candidate.kind,
                label: candidate.label,
                enabled: true,
              }
            : undefined;
        } catch {
          return undefined;
        }
      }),
    );
    return detected.filter(
      (source): source is Exclude<(typeof detected)[number], undefined> =>
        source !== undefined,
    );
  }

  private async request(
    source: TaskSourceConfig,
    prompt: string,
    workspaceRoot: string,
  ): Promise<unknown> {
    switch (source.kind) {
      case "codex-cli":
        return this.codex(source, prompt, workspaceRoot);
      case "antigravity-cli":
        return this.antigravity(source, prompt, workspaceRoot);
      case "claude-code-cli":
        return this.claudeCode(source, prompt, workspaceRoot);
      case "openai-responses":
      case "openai-compatible":
      case "gemini":
      case "anthropic-messages":
        return this.httpProvider(source, prompt);
    }
  }

  private async codex(
    source: TaskSourceConfig,
    prompt: string,
    workspaceRoot: string,
  ): Promise<unknown> {
    const directory = await mkdtemp(join(tmpdir(), "lhic-codex-plan-"));
    const schemaPath = join(directory, "task-plan.schema.json");
    const outputPath = join(directory, "proposal.json");
    try {
      await writeFile(schemaPath, `${JSON.stringify(taskPlanSchema)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      const result = await this.runProcess(
        "codex",
        [
          "exec",
          "--sandbox",
          "read-only",
          "--skip-git-repo-check",
          "--ephemeral",
          "--output-schema",
          schemaPath,
          "--output-last-message",
          outputPath,
          ...(source.model ? ["--model", source.model] : []),
          prompt,
        ],
        { cwd: workspaceRoot },
      );
      assertSuccessfulCliResult("Codex CLI", result);
      return JSON.parse(await readFile(outputPath, "utf8")) as unknown;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private async antigravity(
    source: TaskSourceConfig,
    prompt: string,
    workspaceRoot: string,
  ): Promise<unknown> {
    const result = await this.runProcess(
      "agy",
      [
        "--print",
        "--mode",
        "plan",
        ...(source.model ? ["--model", source.model] : []),
        prompt,
      ],
      { cwd: workspaceRoot },
    );
    assertSuccessfulCliResult("Antigravity CLI", result);
    return parseJsonText(result.stdout, "Antigravity CLI");
  }

  private async claudeCode(
    source: TaskSourceConfig,
    prompt: string,
    workspaceRoot: string,
  ): Promise<unknown> {
    const result = await this.runProcess(
      "claude",
      [
        "--print",
        "--permission-mode",
        "plan",
        "--no-session-persistence",
        "--output-format",
        "json",
        "--json-schema",
        JSON.stringify(taskPlanSchema),
        ...(source.model ? ["--model", source.model] : []),
        prompt,
      ],
      { cwd: workspaceRoot },
    );
    assertSuccessfulCliResult("Claude Code", result);
    const envelope = parseJsonText(result.stdout, "Claude Code");
    if (!isRecord(envelope) || typeof envelope.result !== "string") {
      throw new Error("Claude Code did not return a structured result.");
    }
    return parseJsonText(envelope.result, "Claude Code result");
  }

  private async httpProvider(
    source: TaskSourceConfig,
    prompt: string,
  ): Promise<unknown> {
    const credentialId = source.credentialId ?? source.id;
    const credential = await this.options.credentialFor(credentialId);
    if (!credential) {
      throw new Error(
        `No Keychain credential is configured for ${source.label}.`,
      );
    }
    const request = providerRequest(source, credential, prompt);
    let response: Response;
    try {
      response = await this.fetchImplementation(request.url, {
        method: "POST",
        headers: request.headers,
        body: JSON.stringify(request.body),
        signal: AbortSignal.timeout(providerTimeoutMs),
      });
    } catch {
      throw new Error(`${source.label} could not be reached.`);
    }
    if (!response.ok) {
      throw new Error(`${source.label} returned HTTP ${response.status}.`);
    }
    let responseBody: unknown;
    try {
      responseBody = await response.json();
    } catch {
      throw new Error(`${source.label} did not return JSON.`);
    }
    const text = extractProviderText(
      source.kind,
      source.protocol,
      responseBody,
    );
    if (!text) {
      throw new Error(`${source.label} returned no structured plan.`);
    }
    return parseJsonText(text, source.label);
  }
}

function providerRequest(
  source: TaskSourceConfig,
  credential: string,
  prompt: string,
): { url: string; headers: Record<string, string>; body: object } {
  const model = source.model?.trim();
  if (!model) throw new Error(`${source.label} requires a model identifier.`);
  const maxOutputTokens = source.maxOutputTokens ?? 2_048;
  if (source.kind === "gemini") {
    return {
      url:
        source.endpoint ??
        "https://generativelanguage.googleapis.com/v1beta/interactions",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": credential,
      },
      body: {
        model,
        input: prompt,
        response_format: {
          type: "text",
          mime_type: "application/json",
          schema: taskPlanSchema,
        },
      },
    };
  }
  if (source.kind === "anthropic-messages") {
    return {
      url: source.endpoint ?? "https://api.anthropic.com/v1/messages",
      headers: {
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-api-key": credential,
      },
      body: {
        model,
        max_tokens: maxOutputTokens,
        system: structuredSystemInstruction,
        messages: [{ role: "user", content: `Task:\n${prompt}` }],
      },
    };
  }
  const useChatCompletions =
    source.kind === "openai-compatible" &&
    source.protocol === "chat-completions";
  if (useChatCompletions) {
    return {
      url: requiredEndpoint(source),
      headers: {
        Authorization: `Bearer ${credential}`,
        "Content-Type": "application/json",
      },
      body: {
        model,
        max_tokens: maxOutputTokens,
        messages: [
          { role: "developer", content: structuredSystemInstruction },
          { role: "user", content: prompt },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "lhic_browser_plan",
            strict: true,
            schema: taskPlanSchema,
          },
        },
      },
    };
  }
  return {
    url: source.endpoint ?? "https://api.openai.com/v1/responses",
    headers: {
      Authorization: `Bearer ${credential}`,
      "Content-Type": "application/json",
    },
    body: {
      model,
      store: false,
      max_output_tokens: maxOutputTokens,
      input: [
        { role: "developer", content: structuredSystemInstruction },
        { role: "user", content: prompt },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "lhic_browser_plan",
          strict: true,
          schema: taskPlanSchema,
        },
      },
    },
  };
}

function requiredEndpoint(source: TaskSourceConfig): string {
  if (!source.endpoint) {
    throw new Error(`${source.label} requires an API endpoint.`);
  }
  return source.endpoint;
}

function extractProviderText(
  kind: TaskSourceConfig["kind"],
  protocol: TaskSourceConfig["protocol"],
  value: unknown,
): string | undefined {
  if (!isRecord(value)) return undefined;
  if (kind === "gemini") {
    return typeof value.output_text === "string"
      ? value.output_text
      : undefined;
  }
  if (kind === "anthropic-messages") {
    const content = Array.isArray(value.content) ? value.content : [];
    const text = content.find(
      (item): item is Record<string, unknown> =>
        isRecord(item) && item.type === "text" && typeof item.text === "string",
    );
    return typeof text?.text === "string" ? text.text : undefined;
  }
  if (kind === "openai-compatible" && protocol === "chat-completions") {
    const choices = Array.isArray(value.choices) ? value.choices : [];
    const first = choices[0];
    if (!isRecord(first) || !isRecord(first.message)) return undefined;
    return typeof first.message.content === "string"
      ? first.message.content
      : undefined;
  }
  const output = Array.isArray(value.output) ? value.output : [];
  for (const item of output) {
    if (!isRecord(item) || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (isRecord(part) && typeof part.text === "string") return part.text;
    }
  }
  return undefined;
}

function planningPrompt(goal: string): string {
  return `${structuredSystemInstruction}\nTask: ${JSON.stringify(redactPII(goal))}`;
}

const structuredSystemInstruction = [
  "Return only one browser-plan-v1 or desktop-plan-v1 JSON object that conforms to the supplied schema.",
  "Create a proposal only; never claim execution, call tools, or request browser control.",
  "Browser steps require a concrete verifier. Desktop steps require a supported OS action and an observable local verifier.",
  "Do not create shell, custom, credential, private-network, or cross-origin actions.",
  "Any desktop action will require an explicit matching human approval immediately before it executes.",
  "Use requiredVariables for information that is not already present in the task.",
].join(" ");

function assertSuccessfulCliResult(label: string, result: ProcessResult): void {
  if (result.exitCode !== 0) {
    throw new Error(`${label} proposal failed: ${safeCliError(result)}`);
  }
}

function safeCliError(result: ProcessResult): string {
  return (result.stderr || result.stdout || "no diagnostic output")
    .replace(
      /\b(?:sk|pk|tok|api)[_-][A-Za-z0-9_-]{12,}\b/gi,
      "[REDACTED_TOKEN]",
    )
    .slice(0, 1_000);
}

function parseJsonText(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`${label} did not return a JSON task plan.`);
  }
}

function parsePlan(value: unknown): TaskExecutionPlan {
  const normalized = normalizePlan(value);
  if (
    !isBrowserExecutionPlan(normalized) &&
    !isDesktopExecutionPlan(normalized)
  ) {
    throw new Error(
      "The Slow Path proposal failed browser-plan-v1 or desktop-plan-v1 validation.",
    );
  }
  return normalized;
}

function normalizePlan(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const plan = { ...value };
  if (plan.skillName === null) delete plan.skillName;
  if (Array.isArray(plan.steps)) {
    plan.steps = plan.steps.map((step) => {
      if (!isRecord(step)) return step;
      const normalized = { ...step };
      if (isRecord(normalized.action)) {
        const action = withoutNulls(normalized.action, [
          "target",
          "value",
          "x",
          "y",
          "text",
          "key",
          "application",
        ]);
        if (isRecord(action.verifier)) {
          normalized.action = {
            ...action,
            verifier: withoutNulls(action.verifier, ["application", "title"]),
          };
        } else {
          normalized.action = action;
        }
      }
      const verification = normalized.verification;
      if (isRecord(verification)) {
        const normalizedVerification = withoutNulls(verification, [
          "timeoutMs",
        ]);
        if (isRecord(normalizedVerification.params)) {
          normalized.verification = {
            ...normalizedVerification,
            params: Object.fromEntries(
              Object.entries(normalizedVerification.params).filter(
                ([, parameter]) => parameter !== null,
              ),
            ),
          };
        } else {
          normalized.verification = normalizedVerification;
        }
      }
      return normalized;
    });
  }
  return plan;
}

function withoutNulls(
  value: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(
      ([key, field]) => !keys.includes(key) || field !== null,
    ),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const browserPlanSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    schemaVersion: { type: "string", const: "browser-plan-v1" },
    goal: { type: "string" },
    skillName: { type: ["string", "null"] },
    requiredVariables: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          prompt: { type: "string" },
        },
        required: ["name", "prompt"],
      },
    },
    steps: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          action: {
            type: "object",
            additionalProperties: false,
            properties: {
              scope: { type: "string", const: "browser" },
              type: {
                type: "string",
                enum: [
                  "navigate",
                  "click",
                  "fill",
                  "select",
                  "press",
                  "wait",
                  "download",
                ],
              },
              intent: { type: "string" },
              target: { type: ["string", "null"] },
              value: { type: ["string", "number", "null"] },
              methodPreference: {
                type: "array",
                items: {
                  type: "string",
                  enum: ["api", "dom", "accessibility", "keyboard"],
                },
              },
              riskLevel: {
                type: "string",
                enum: ["low", "medium", "high", "unknown"],
              },
            },
            required: [
              "scope",
              "type",
              "intent",
              "target",
              "value",
              "methodPreference",
              "riskLevel",
            ],
          },
          verification: {
            type: "object",
            additionalProperties: false,
            properties: {
              type: { type: "string", enum: ["dom", "url", "network", "file"] },
              description: { type: "string" },
              params: {
                type: "object",
                additionalProperties: false,
                properties: {
                  selector: { type: ["string", "null"] },
                  text: { type: ["string", "null"] },
                  state: { type: ["string", "null"] },
                  contains: { type: ["string", "null"] },
                  equals: { type: ["string", "null"] },
                  notContains: { type: ["string", "null"] },
                  requestSucceeded: { type: ["boolean", "null"] },
                  noFailedRequests: { type: ["boolean", "null"] },
                  filePath: { type: ["string", "null"] },
                  extension: { type: ["string", "null"] },
                  minSize: { type: ["number", "null"] },
                },
                required: [
                  "selector",
                  "text",
                  "state",
                  "contains",
                  "equals",
                  "notContains",
                  "requestSucceeded",
                  "noFailedRequests",
                  "filePath",
                  "extension",
                  "minSize",
                ],
              },
              timeoutMs: { type: ["number", "null"] },
            },
            required: ["type", "description", "params", "timeoutMs"],
          },
        },
        required: ["id", "action", "verification"],
      },
    },
  },
  required: [
    "schemaVersion",
    "goal",
    "skillName",
    "requiredVariables",
    "steps",
  ],
} as const;

const desktopPlanSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    schemaVersion: { type: "string", const: "desktop-plan-v1" },
    goal: { type: "string" },
    skillName: { type: ["string", "null"] },
    requiredVariables: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          prompt: { type: "string" },
        },
        required: ["name", "prompt"],
      },
    },
    steps: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          action: {
            type: "object",
            additionalProperties: false,
            properties: {
              scope: { type: "string", const: "os" },
              type: {
                type: "string",
                enum: [
                  "os_click",
                  "os_type",
                  "os_press",
                  "os_launch",
                  "os_focus",
                ],
              },
              intent: { type: "string" },
              target: { type: ["string", "null"] },
              methodPreference: {
                type: "array",
                minItems: 1,
                items: {
                  type: "string",
                  enum: ["accessibility", "keyboard", "mouse"],
                },
              },
              riskLevel: {
                type: "string",
                enum: ["low", "medium", "high", "unknown"],
              },
              x: { type: ["number", "null"] },
              y: { type: ["number", "null"] },
              text: { type: ["string", "null"] },
              key: { type: ["string", "null"] },
              application: { type: ["string", "null"] },
              verifier: {
                type: "object",
                additionalProperties: false,
                properties: {
                  type: {
                    type: "string",
                    enum: ["active_window", "process_running"],
                  },
                  application: { type: ["string", "null"] },
                  title: { type: ["string", "null"] },
                },
                required: ["type", "application", "title"],
              },
            },
            required: [
              "scope",
              "type",
              "intent",
              "target",
              "methodPreference",
              "riskLevel",
              "x",
              "y",
              "text",
              "key",
              "application",
              "verifier",
            ],
          },
        },
        required: ["id", "action"],
      },
    },
  },
  required: [
    "schemaVersion",
    "goal",
    "skillName",
    "requiredVariables",
    "steps",
  ],
} as const;

const taskPlanSchema = {
  oneOf: [browserPlanSchema, desktopPlanSchema],
} as const;
