import { isBrowserSemanticAction } from "@lhic/schema";
import { redactPII } from "@lhic/trace";

import type {
  SlowPathProvider,
  SlowPathRequest,
  SlowPathResponse,
} from "./slow-path.js";
import { validateCredentialedModelEndpoint } from "./model-endpoint.js";
import {
  OperationInterruptedError,
  runInterruptible,
} from "./interruptible-operation.js";

const defaultTimeoutMs = 30_000;

export interface ClaudeSlowPathOptions {
  enabled?: boolean;
  apiKey?: string;
  model?: string;
  endpoint?: string;
  timeoutMs?: number;
  fetchImplementation?: typeof fetch;
}

interface ClaudeMessageResponse {
  content?: Array<{ type?: string; text?: string }>;
}

const claudeResponseSchema = {
  type: "object" as const,
  additionalProperties: false,
  properties: {
    decision: {
      type: "string",
      enum: ["ask_user", "propose_plan", "retry_with_action", "blocked"],
    },
    message: { type: "string", minLength: 1 },
    proposedActions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          scope: { type: "string", enum: ["browser"] },
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
              "custom",
            ],
          },
          intent: { type: "string", minLength: 1 },
          target: { type: "string" },
          value: { anyOf: [{ type: "string" }, { type: "null" }] },
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
      },
    },
  },
  required: ["decision", "message", "proposedActions"],
};

const CLAUDE_SYSTEM_PROMPT =
  "You are LHIC's Slow Path planner. Return ONLY a JSON object (no markdown fences, no prose) matching this schema: " +
  JSON.stringify(claudeResponseSchema) +
  " Never request, infer, repeat, or emit credentials, tokens, cookies, API keys, passwords, or personally identifying information. Propose browser semantic actions only. Use ask_user or blocked when information is missing or a safe plan cannot be formed.";

export class ClaudeSlowPathProvider implements SlowPathProvider {
  private readonly enabled: boolean;
  private readonly apiKey: string | undefined;
  private readonly model: string;
  private readonly endpoint: string;
  private readonly fetchImplementation: typeof fetch;
  private readonly timeoutMs: number;

  public constructor(options: ClaudeSlowPathOptions = {}) {
    this.enabled =
      options.enabled ?? process.env.CLAUDE_SLOW_PATH_ENABLED === "true";
    this.apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
    this.model =
      options.model ?? process.env.CLAUDE_MODEL ?? "claude-sonnet-4-5";
    this.endpoint = validateCredentialedModelEndpoint(
      options.endpoint ?? "https://api.anthropic.com/v1/messages",
      "Claude endpoint",
    ).href;
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  }

  public async reason(
    request: SlowPathRequest,
    signal?: AbortSignal,
  ): Promise<SlowPathResponse> {
    if (!this.enabled) {
      return {
        decision: "blocked",
        message: "Claude Slow Path is disabled by default.",
      };
    }
    if (!this.apiKey) {
      return {
        decision: "blocked",
        message:
          "Claude Slow Path is enabled but ANTHROPIC_API_KEY is not configured.",
      };
    }
    const apiKey = this.apiKey;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0) {
      return {
        decision: "blocked",
        message: "Claude Slow Path timeout must be a positive integer.",
      };
    }

    const safeRequest = redactPII(request);
    try {
      return await runInterruptible<SlowPathResponse>(
        "Claude Slow Path",
        this.timeoutMs,
        async (requestSignal) => {
          const response = await this.fetchImplementation(this.endpoint, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-api-key": apiKey,
              "anthropic-version": "2023-06-01",
            },
            signal: requestSignal,
            body: JSON.stringify({
              model: this.model,
              max_tokens: 800,
              system: CLAUDE_SYSTEM_PROMPT,
              messages: [
                { role: "user", content: JSON.stringify(safeRequest) },
              ],
            }),
          });
          if (!response.ok) {
            return {
              decision: "blocked",
              message: `Claude Slow Path request failed with HTTP ${response.status}.`,
            };
          }
          const body = (await response.json()) as ClaudeMessageResponse;
          const text = body.content
            ?.filter((block) => block.type === "text")
            .map((block) => block.text ?? "")
            .join("\n")
            .trim();
          if (!text) {
            return {
              decision: "blocked",
              message: "Claude Slow Path returned no structured output.",
            };
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(text);
          } catch {
            return {
              decision: "blocked",
              message: "Claude Slow Path returned invalid JSON.",
            };
          }
          if (!isClaudeSlowPathResponse(parsed)) {
            return {
              decision: "blocked",
              message:
                "Claude Slow Path returned a plan that failed LHIC semantic-action validation.",
            };
          }
          return parsed;
        },
        signal,
      );
    } catch (error) {
      return {
        decision: "blocked",
        message:
          error instanceof OperationInterruptedError &&
          error.reason === "timeout"
            ? `Claude Slow Path timed out after ${this.timeoutMs} ms.`
            : error instanceof OperationInterruptedError
              ? "Claude Slow Path request was aborted."
              : error instanceof Error
                ? `Claude Slow Path failed: ${error.message}`
                : "Claude Slow Path failed.",
      };
    }
  }
}

function isClaudeSlowPathResponse(value: unknown): value is SlowPathResponse {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<SlowPathResponse>;
  return (
    (candidate.decision === "ask_user" ||
      candidate.decision === "propose_plan" ||
      candidate.decision === "retry_with_action" ||
      candidate.decision === "blocked") &&
    typeof candidate.message === "string" &&
    Array.isArray(candidate.proposedActions) &&
    candidate.proposedActions.every(isBrowserSemanticAction)
  );
}
