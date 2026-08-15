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

const defaultEndpoint = "https://api.openai.com/v1/responses";
const defaultModel = "gpt-5.6";
const defaultTimeoutMs = 30_000;

const slowPathResponseSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    decision: {
      type: "string",
      enum: ["ask_user", "propose_plan", "retry_with_action", "blocked"],
    },
    message: { type: "string" },
    proposedActions: {
      type: "array",
      items: {
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
              "custom",
            ],
          },
          intent: { type: "string", minLength: 1 },
          target: { type: "string", minLength: 1 },
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
    },
  },
  required: ["decision", "message", "proposedActions"],
} as const;

export interface OpenAISlowPathOptions {
  enabled?: boolean;
  apiKey?: string;
  model?: string;
  endpoint?: string;
  timeoutMs?: number;
  fetchImplementation?: typeof fetch;
}

interface OpenAIResponsesResponse {
  output?: Array<{
    type?: string;
    content?: Array<{
      type?: string;
      text?: string;
      refusal?: string;
    }>;
  }>;
}

/**
 * Optional GPT-5.6 Slow Path adapter. It uses a strict response schema and
 * validates every returned browser action before it reaches LHIC's executor.
 * Fast Path routing never instantiates or calls this provider.
 */
export class OpenAISlowPathProvider implements SlowPathProvider {
  private readonly enabled: boolean;
  private readonly apiKey: string | undefined;
  private readonly model: string;
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly fetchImplementation: typeof fetch;

  public constructor(options: OpenAISlowPathOptions = {}) {
    this.enabled =
      options.enabled ?? process.env.OPENAI_SLOW_PATH_ENABLED === "true";
    this.apiKey =
      options.apiKey ??
      process.env.LHIC_OPENAI_API_KEY ??
      process.env.OPENAI_API_KEY;
    this.model = options.model ?? process.env.LHIC_OPENAI_MODEL ?? defaultModel;
    this.endpoint = validateCredentialedModelEndpoint(
      options.endpoint ?? defaultEndpoint,
      "OpenAI endpoint",
    ).href;
    this.timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
    this.fetchImplementation = options.fetchImplementation ?? fetch;
  }

  public async reason(
    request: SlowPathRequest,
    signal?: AbortSignal,
  ): Promise<SlowPathResponse> {
    if (!this.enabled) {
      return {
        decision: "blocked",
        message: "OpenAI Slow Path is disabled by default.",
      };
    }
    if (!this.apiKey) {
      return {
        decision: "blocked",
        message:
          "OpenAI Slow Path is enabled but OPENAI_API_KEY is not configured.",
      };
    }
    const apiKey = this.apiKey;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0) {
      return {
        decision: "blocked",
        message: "OpenAI Slow Path timeout must be a positive integer.",
      };
    }

    const safeRequest = redactPII(request);
    try {
      return await runInterruptible<SlowPathResponse>(
        "OpenAI Slow Path",
        this.timeoutMs,
        async (requestSignal) => {
          const response = await this.fetchImplementation(this.endpoint, {
            method: "POST",
            headers: {
              authorization: `Bearer ${apiKey}`,
              "content-type": "application/json",
            },
            signal: requestSignal,
            body: JSON.stringify({
              model: this.model,
              store: false,
              max_output_tokens: 1_200,
              instructions:
                "You are LHIC's Slow Path planner. Return only the required JSON schema. Never request, infer, repeat, or emit credentials, tokens, cookies, API keys, passwords, or personally identifying information. Propose browser semantic actions only. Use ask_user or blocked when information is missing or a safe plan cannot be formed.",
              input: JSON.stringify(safeRequest),
              text: {
                format: {
                  type: "json_schema",
                  name: "lhic_slow_path_plan",
                  strict: true,
                  schema: slowPathResponseSchema,
                },
              },
            }),
          });
          if (!response.ok) {
            return {
              decision: "blocked",
              message: `OpenAI Slow Path request failed with HTTP ${response.status}.`,
            };
          }

          const body = (await response.json()) as OpenAIResponsesResponse;
          const refusal = findRefusal(body);
          if (refusal) {
            return {
              decision: "blocked",
              message: `OpenAI Slow Path refused the request: ${refusal}`,
            };
          }
          const text = findOutputText(body);
          if (!text) {
            return {
              decision: "blocked",
              message: "OpenAI Slow Path returned no structured output.",
            };
          }

          let parsed: unknown;
          try {
            parsed = JSON.parse(text);
          } catch {
            return {
              decision: "blocked",
              message: "OpenAI Slow Path returned invalid JSON.",
            };
          }
          if (!isSlowPathResponse(parsed)) {
            return {
              decision: "blocked",
              message:
                "OpenAI Slow Path returned a plan that failed LHIC semantic-action validation.",
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
            ? `OpenAI Slow Path timed out after ${this.timeoutMs} ms.`
            : error instanceof OperationInterruptedError
              ? "OpenAI Slow Path request was aborted."
              : error instanceof Error
                ? `OpenAI Slow Path failed: ${error.message}`
                : "OpenAI Slow Path failed.",
      };
    }
  }
}

function findRefusal(body: OpenAIResponsesResponse): string | undefined {
  for (const output of body.output ?? []) {
    for (const content of output.content ?? []) {
      if (content.type === "refusal" && content.refusal?.trim()) {
        return content.refusal.trim();
      }
    }
  }
  return undefined;
}

function findOutputText(body: OpenAIResponsesResponse): string | undefined {
  return body.output
    ?.flatMap((output) => output.content ?? [])
    .filter((content) => content.type === "output_text")
    .map((content) => content.text ?? "")
    .join("\n")
    .trim();
}

function isSlowPathResponse(value: unknown): value is SlowPathResponse {
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
