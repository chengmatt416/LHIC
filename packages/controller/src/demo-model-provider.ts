import {
  isBrowserExecutionPlan,
  isPlannedBrowserStep,
  type BrowserExecutionPlan,
  type NormalizedUIState,
  type PlannedBrowserStep,
} from "@lhic/schema";
import { redactPII } from "@lhic/trace";

import { validateCredentialedModelEndpoint } from "./model-endpoint.js";
import { toSlowPathSafeUiState } from "./slow-path.js";

export type DemoModelProviderKind = "openai" | "gemini" | "claude";

export interface DemoModelProviderOptions {
  provider: DemoModelProviderKind;
  apiKey: string;
  model: string;
  endpoint?: string;
  timeoutMs?: number;
  fetchImplementation?: typeof fetch;
}

export interface DemoModelRequest {
  task: string;
  uiState: NormalizedUIState;
  recentOutcome?: string;
  learnedSkill?: Record<string, unknown>;
  providedVariables?: Record<string, string>;
}

export interface DemoSlowPathModelResponse {
  status: "next_action" | "complete" | "needs_input" | "blocked";
  message: string;
  step?: PlannedBrowserStep;
  requiredVariables: Array<{ name: string; prompt: string }>;
}

export interface DemoFastPathModelResponse {
  status: "plan" | "needs_input" | "blocked";
  message: string;
  plan?: BrowserExecutionPlan;
  requiredVariables: Array<{ name: string; prompt: string }>;
}

export interface DemoModelProvider {
  nextStep(request: DemoModelRequest): Promise<DemoSlowPathModelResponse>;
  plan(request: DemoModelRequest): Promise<DemoFastPathModelResponse>;
}

const timeoutDefaultMs = 30_000;
const slowPathMaxOutputTokens = 1_200;
const fastPathMaxOutputTokens = 4_096;
const maxModelObjects = 160;
const maxModelFieldChars = 512;

interface ModelPrompt {
  system: string;
  user: string;
}

const variableSchema = {
  type: "object",
  additionalProperties: false,
  properties: { name: { type: "string" }, prompt: { type: "string" } },
  required: ["name", "prompt"],
} as const;

const actionSchema = {
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
        "upload",
      ],
    },
    intent: { type: "string" },
    target: { anyOf: [{ type: "string" }, { type: "null" }] },
    value: {
      anyOf: [{ type: "string" }, { type: "number" }, { type: "null" }],
    },
    filePath: { anyOf: [{ type: "string" }, { type: "null" }] },
    methodPreference: {
      type: "array",
      items: {
        type: "string",
        enum: ["api", "dom", "accessibility", "keyboard"],
      },
    },
    riskLevel: { type: "string", enum: ["low", "medium", "high", "unknown"] },
  },
  required: [
    "scope",
    "type",
    "intent",
    "target",
    "value",
    "filePath",
    "methodPreference",
    "riskLevel",
  ],
} as const;

const verificationSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    type: { type: "string", enum: ["dom", "url", "network", "file"] },
    description: { type: "string" },
    params: {
      type: "object",
      additionalProperties: false,
      properties: {
        selector: { anyOf: [{ type: "string" }, { type: "null" }] },
        text: { anyOf: [{ type: "string" }, { type: "null" }] },
        state: { anyOf: [{ type: "string" }, { type: "null" }] },
        contains: { anyOf: [{ type: "string" }, { type: "null" }] },
        equals: { anyOf: [{ type: "string" }, { type: "null" }] },
        notContains: { anyOf: [{ type: "string" }, { type: "null" }] },
        requestSucceeded: { anyOf: [{ type: "boolean" }, { type: "null" }] },
        noFailedRequests: { anyOf: [{ type: "boolean" }, { type: "null" }] },
        filePath: { anyOf: [{ type: "string" }, { type: "null" }] },
        extension: { anyOf: [{ type: "string" }, { type: "null" }] },
        minSize: { anyOf: [{ type: "number" }, { type: "null" }] },
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
    timeoutMs: { anyOf: [{ type: "number" }, { type: "null" }] },
  },
  required: ["type", "description", "params", "timeoutMs"],
} as const;

const stepSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string" },
    action: actionSchema,
    verification: verificationSchema,
  },
  required: ["id", "action", "verification"],
} as const;

const slowResponseSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: {
      type: "string",
      enum: ["next_action", "complete", "needs_input", "blocked"],
    },
    message: { type: "string" },
    step: { anyOf: [stepSchema, { type: "null" }] },
    requiredVariables: { type: "array", items: variableSchema },
  },
  required: ["status", "message", "step", "requiredVariables"],
} as const;

const planSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    schemaVersion: { type: "string", const: "browser-plan-v1" },
    goal: { type: "string" },
    skillName: { anyOf: [{ type: "string" }, { type: "null" }] },
    requiredVariables: { type: "array", items: variableSchema },
    steps: { type: "array", minItems: 1, items: stepSchema },
  },
  required: [
    "schemaVersion",
    "goal",
    "skillName",
    "requiredVariables",
    "steps",
  ],
} as const;

const fastResponseSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: { type: "string", enum: ["plan", "needs_input", "blocked"] },
    message: { type: "string" },
    plan: { anyOf: [planSchema, { type: "null" }] },
    requiredVariables: { type: "array", items: variableSchema },
  },
  required: ["status", "message", "plan", "requiredVariables"],
} as const;

export function createDemoModelProvider(
  options: DemoModelProviderOptions,
): DemoModelProvider {
  return new StructuredDemoModelProvider(options);
}

class StructuredDemoModelProvider implements DemoModelProvider {
  private readonly fetchImplementation: typeof fetch;
  private readonly timeoutMs: number;

  public constructor(private readonly options: DemoModelProviderOptions) {
    if (!options.apiKey.trim()) {
      throw new Error("A demo model API key is required.");
    }
    if (!options.model.trim()) {
      throw new Error("A demo model identifier is required.");
    }
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.timeoutMs = options.timeoutMs ?? timeoutDefaultMs;
  }

  public async nextStep(
    request: DemoModelRequest,
  ): Promise<DemoSlowPathModelResponse> {
    const parsed = await this.requestJson(
      "lhic_slow_path_step",
      slowResponseSchema,
      slowPrompt(request),
      slowPathMaxOutputTokens,
    );
    return parseSlowResponse(parsed);
  }

  public async plan(
    request: DemoModelRequest,
  ): Promise<DemoFastPathModelResponse> {
    const parsed = await this.requestJson(
      "lhic_fast_path_plan",
      fastResponseSchema,
      fastPrompt(request),
      fastPathMaxOutputTokens,
    );
    return parseFastResponse(parsed);
  }

  private async requestJson(
    schemaName: string,
    schema: Record<string, unknown>,
    prompt: ModelPrompt,
    maxOutputTokens: number,
  ): Promise<unknown> {
    const request = providerRequest(
      this.options,
      schemaName,
      schema,
      prompt,
      maxOutputTokens,
    );
    const endpoint = validateCredentialedModelEndpoint(
      request.url,
      `${this.options.provider} model endpoint`,
    );
    const timeout = AbortSignal.timeout(this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImplementation(endpoint, {
        method: "POST",
        headers: request.headers,
        body: JSON.stringify(request.body),
        signal: timeout,
      });
    } catch {
      throw new Error("The selected model provider could not be reached.");
    }
    if (!response.ok) {
      throw new Error(
        `The selected model provider returned HTTP ${response.status}.`,
      );
    }
    let responseBody: unknown;
    try {
      responseBody = await response.json();
    } catch {
      throw new Error("The selected model provider did not return JSON.");
    }
    const text = extractProviderText(this.options.provider, responseBody);
    if (!text) {
      throw new Error(
        `The selected ${this.options.provider} model returned no structured text${providerStatusSuffix(responseBody)}${providerShapeSuffix(responseBody)}.`,
      );
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error(
        "The selected model provider returned invalid structured JSON.",
      );
    }
  }
}

function providerRequest(
  options: DemoModelProviderOptions,
  schemaName: string,
  schema: Record<string, unknown>,
  prompt: ModelPrompt,
  maxOutputTokens: number,
): {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
} {
  switch (options.provider) {
    case "openai":
      return {
        url: options.endpoint ?? "https://api.openai.com/v1/responses",
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          "Content-Type": "application/json",
        },
        body: {
          model: options.model,
          store: false,
          max_output_tokens: maxOutputTokens,
          instructions: prompt.system,
          input: [{ role: "user", content: prompt.user }],
          text: {
            format: {
              type: "json_schema",
              name: schemaName,
              strict: true,
              schema,
            },
          },
        },
      };
    case "gemini":
      return {
        url:
          options.endpoint ??
          "https://generativelanguage.googleapis.com/v1beta/interactions",
        headers: {
          "x-goog-api-key": options.apiKey,
          "Content-Type": "application/json",
        },
        body: {
          model: options.model,
          store: false,
          input: `${prompt.system}\n${prompt.user}`,
          response_format: {
            type: "text",
            mime_type: "application/json",
            schema,
          },
        },
      };
    case "claude":
      return {
        url: options.endpoint ?? "https://api.anthropic.com/v1/messages",
        headers: {
          "x-api-key": options.apiKey,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        body: {
          model: options.model,
          max_tokens: maxOutputTokens,
          system: prompt.system,
          messages: [{ role: "user", content: prompt.user }],
          output_config: { format: { type: "json_schema", schema } },
        },
      };
  }
}

function extractProviderText(
  provider: DemoModelProviderKind,
  body: unknown,
): string | undefined {
  if (!body || typeof body !== "object") {
    return undefined;
  }
  const record = body as Record<string, unknown>;
  if (provider === "gemini") {
    if (typeof record.output_text === "string") return record.output_text;
    const nestedInteraction = isRecord(record.interaction)
      ? record.interaction
      : undefined;
    const fromSteps =
      extractGeminiStepText(record.steps) ??
      extractGeminiStepText(nestedInteraction?.steps) ??
      extractGeminiContentText(record.outputs);
    if (fromSteps) return fromSteps;
    return extractGeminiCandidateText(record.candidates);
  }
  if (provider === "claude") {
    return extractGeminiContentText(record.content);
  }
  const output = Array.isArray(record.output) ? record.output : [];
  return extractGeminiContentText(
    output.flatMap((item) =>
      isRecord(item) && Array.isArray(item.content) ? item.content : [],
    ),
  );
}

function providerStatusSuffix(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const status = (body as Record<string, unknown>).status;
  return typeof status === "string" ? ` (status: ${status})` : "";
}

function providerShapeSuffix(body: unknown): string {
  if (!isRecord(body)) return "";
  const keys = Object.keys(body).sort().slice(0, 12).join(", ");
  const steps = Array.isArray(body.steps) ? body.steps : [];
  const stepTypes = steps
    .flatMap((step) =>
      isRecord(step) && typeof step.type === "string" ? [step.type] : [],
    )
    .slice(0, 8)
    .join(", ");
  return ` (response keys: ${keys || "none"}${stepTypes ? `; step types: ${stepTypes}` : ""})`;
}

function extractGeminiStepText(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  for (const step of [...value].reverse()) {
    if (!isRecord(step)) continue;
    const text = extractGeminiContentText(step.content);
    if (text) return text;
  }
  return undefined;
}

function extractGeminiContentText(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const text = value
    .flatMap((part) =>
      isRecord(part) && typeof part.text === "string" ? [part.text] : [],
    )
    .join("");
  return text || undefined;
}

function extractGeminiCandidateText(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  for (const candidate of value) {
    if (!isRecord(candidate) || !isRecord(candidate.content)) continue;
    const text = extractGeminiContentText(candidate.content.parts);
    if (text) return text;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function slowPrompt(request: DemoModelRequest): ModelPrompt {
  return {
    system: [
      "You are LHIC Slow Path. Return JSON only.",
      "Choose exactly one safe browser action with one concrete verifier, or complete/ask for input/block.",
      "Never emit custom, OS, raw-coordinate, script, credential, cross-origin, or private-network actions.",
      "For uploads, use only a caller-provided filePath variable; never infer or invent a local path.",
    ].join(" "),
    user: [
      `Task: ${JSON.stringify(compactText(redactPII(request.task) as string, 4_096))}`,
      `UI: ${JSON.stringify(compactUiState(request.uiState))}`,
      request.recentOutcome
        ? `Previous outcome: ${JSON.stringify(compactText(redactPII(request.recentOutcome) as string, 2_048))}`
        : "",
      request.providedVariables
        ? `Provided variables: ${boundedJson(redactPII(request.providedVariables), 4_096)}`
        : "",
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

function fastPrompt(request: DemoModelRequest): ModelPrompt {
  return {
    system: [
      "You are LHIC Fast Path planner. Return one complete browser-plan-v1 JSON plan only.",
      "Use the learned skill only as constrained evidence. Every step needs a concrete verifier.",
      "The plan will execute without further model calls; use requiredVariables for values not present in the task.",
      "Never emit custom, OS, raw-coordinate, script, credential, cross-origin, or private-network actions.",
      "For uploads, use only an exact {{variables.name}} filePath backed by provided or required variables; never infer or invent a local path.",
    ].join(" "),
    user: [
      `Task: ${JSON.stringify(compactText(redactPII(request.task) as string, 4_096))}`,
      `UI: ${JSON.stringify(compactUiState(request.uiState))}`,
      `Learned skill: ${boundedJson(redactPII(request.learnedSkill ?? {}), 6_144)}`,
      request.providedVariables
        ? `Provided variables: ${boundedJson(redactPII(request.providedVariables), 4_096)}`
        : "",
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

const interactiveRoles: Record<string, true> = {
  button: true,
  checkbox: true,
  combobox: true,
  link: true,
  menuitem: true,
  option: true,
  radio: true,
  searchbox: true,
  tab: true,
  textbox: true,
};

function compactUiState(state: NormalizedUIState): NormalizedUIState {
  const safeState = toSlowPathSafeUiState(state);
  const objects = safeState.objects
    .map((object, index) => ({
      object: {
        ...object,
        id: compactText(object.id, maxModelFieldChars),
        ...(object.role
          ? { role: compactText(object.role, maxModelFieldChars) }
          : {}),
        ...(object.label
          ? { label: compactText(object.label, maxModelFieldChars) }
          : {}),
        ...(object.selector
          ? { selector: compactText(object.selector, maxModelFieldChars) }
          : {}),
        ...(object.ref
          ? { ref: compactText(object.ref, maxModelFieldChars) }
          : {}),
      },
      index,
      priority:
        (object.focused ? 4 : 0) +
        (object.role && interactiveRoles[object.role.toLowerCase()] ? 2 : 0) +
        (object.enabled === true ? 1 : 0),
    }))
    .sort(
      (left, right) =>
        right.priority - left.priority || left.index - right.index,
    )
    .slice(0, maxModelObjects)
    .map(({ object }) => object);
  const compacted = { ...safeState, objects };
  while (objects.length > 1 && JSON.stringify(compacted).length > 12_000) {
    objects.pop();
  }
  return compacted;
}

function boundedJson(value: unknown, maxChars: number): string {
  const serialized = JSON.stringify(value) ?? "null";
  if (serialized.length <= maxChars) return serialized;
  const excerptChars = Math.max(1, Math.floor((maxChars - 64) / 2));
  return JSON.stringify({
    truncated: true,
    excerpt: compactText(serialized, excerptChars),
  });
}

function compactText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars - 1)}…`;
}

function parseSlowResponse(value: unknown): DemoSlowPathModelResponse {
  if (!value || typeof value !== "object")
    throw new Error("Slow Path response must be an object.");
  const candidate = value as Record<string, unknown>;
  const status = candidate.status;
  const message = candidate.message;
  const requiredVariables = parseVariables(candidate.requiredVariables);
  if (
    (status !== "next_action" &&
      status !== "complete" &&
      status !== "needs_input" &&
      status !== "blocked") ||
    typeof message !== "string"
  )
    throw new Error("Slow Path response has an invalid status or message.");
  if (status === "next_action") {
    const step = normalizePlannedStep(candidate.step);
    if (!isPlannedBrowserStep(step)) {
      throw new Error(
        "Slow Path response must include one valid planned step.",
      );
    }
    return { status, message, step, requiredVariables };
  }
  return { status, message, requiredVariables };
}

function parseFastResponse(value: unknown): DemoFastPathModelResponse {
  if (!value || typeof value !== "object")
    throw new Error("Fast Path response must be an object.");
  const candidate = value as Record<string, unknown>;
  const status = candidate.status;
  const message = candidate.message;
  const requiredVariables = parseVariables(candidate.requiredVariables);
  if (
    (status !== "plan" && status !== "needs_input" && status !== "blocked") ||
    typeof message !== "string"
  ) {
    throw new Error("Fast Path response has an invalid status or message.");
  }
  if (status === "plan") {
    const plan = normalizeBrowserPlan(candidate.plan);
    if (!isBrowserExecutionPlan(plan)) {
      throw new Error("Fast Path response must include a valid browser plan.");
    }
    return { status, message, plan, requiredVariables };
  }
  return { status, message, requiredVariables };
}

function normalizeBrowserPlan(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const plan = { ...(value as Record<string, unknown>) };
  if (plan.skillName === null) delete plan.skillName;
  if (Array.isArray(plan.steps)) {
    plan.steps = plan.steps.map(normalizePlannedStep);
  }
  return plan;
}

function normalizePlannedStep(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const step = { ...(value as Record<string, unknown>) };
  if (step.action && typeof step.action === "object") {
    const action = { ...(step.action as Record<string, unknown>) };
    if (action.target === null) delete action.target;
    if (action.value === null) delete action.value;
    if (action.filePath === null) delete action.filePath;
    step.action = action;
  }
  if (step.verification && typeof step.verification === "object") {
    const verification = { ...(step.verification as Record<string, unknown>) };
    if (verification.timeoutMs === null) delete verification.timeoutMs;
    if (verification.params && typeof verification.params === "object") {
      verification.params = Object.fromEntries(
        Object.entries(verification.params as Record<string, unknown>).filter(
          ([, parameter]) => parameter !== null,
        ),
      );
    }
    step.verification = verification;
  }
  return step;
}

function parseVariables(
  value: unknown,
): Array<{ name: string; prompt: string }> {
  if (
    !Array.isArray(value) ||
    !value.every(
      (item) =>
        item &&
        typeof item === "object" &&
        typeof (item as Record<string, unknown>).name === "string" &&
        typeof (item as Record<string, unknown>).prompt === "string",
    )
  ) {
    throw new Error(
      "Model response requiredVariables must be an array of prompts.",
    );
  }
  return value.map((item) => ({
    name: (item as Record<string, unknown>).name as string,
    prompt: (item as Record<string, unknown>).prompt as string,
  }));
}
