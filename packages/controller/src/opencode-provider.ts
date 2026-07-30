import { isBrowserSemanticAction } from "@lhic/schema";
import { redactPII } from "@lhic/trace";

import type {
  SlowPathProvider,
  SlowPathRequest,
  SlowPathResponse,
} from "./slow-path.js";

const defaultEndpoint = "https://opencode.ai/zen/v1/chat/completions";
const defaultTimeoutMs = 45_000;
const RATE_LIMIT_COOLDOWN_MS = 5 * 60 * 60 * 1000; // 5 hours

export const OPENCODE_FREE_MODELS = [
  "deepseek-v4-flash-free",
  "mimo-v2.5-free",
] as const;

export type OpenCodeFreeModel = (typeof OPENCODE_FREE_MODELS)[number];

export interface OpenCodeSlowPathOptions {
  enabled?: boolean;
  apiKey?: string;
  endpoint?: string;
  timeoutMs?: number;
  models?: OpenCodeFreeModel[];
  rateLimitCooldownMs?: number;
  fetchImplementation?: typeof fetch;
}

export interface ModelAvailability {
  model: string;
  available: boolean;
  rateLimitedUntil: number | null;
  lastError: string | null;
  successCount: number;
  failureCount: number;
  rateLimitCount: number;
}

/**
 * OpenCode Zen free-model Slow Path provider with automatic failover.
 * Primary: deepseek-v4-flash-free → fallback: mimo-v2.5-free
 * Rate-limited models cool down for 5 hours before retry.
 */
export class OpenCodeSlowPathProvider implements SlowPathProvider {
  private readonly enabled: boolean;
  private readonly apiKey: string | undefined;
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly models: string[];
  private readonly rateLimitCooldownMs: number;
  private readonly fetchImplementation: typeof fetch;
  private readonly rateLimitedUntil = new Map<string, number>();
  private readonly stats = new Map<
    string,
    { success: number; failure: number; rateLimit: number; lastError: string | null }
  >();

  public constructor(options: OpenCodeSlowPathOptions = {}) {
    this.enabled =
      options.enabled ?? process.env.OPENCODE_SLOW_PATH_ENABLED !== "false";
    this.apiKey =
      options.apiKey ??
      process.env.OPENCODE_API_KEY ??
      process.env.LHIC_OPENCODE_API_KEY;
    this.endpoint = options.endpoint ?? defaultEndpoint;
    this.timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
    this.models = options.models ?? [...OPENCODE_FREE_MODELS];
    this.rateLimitCooldownMs = options.rateLimitCooldownMs ?? RATE_LIMIT_COOLDOWN_MS;
    this.fetchImplementation = options.fetchImplementation ?? fetch;

    for (const model of this.models) {
      this.stats.set(model, { success: 0, failure: 0, rateLimit: 0, lastError: null });
    }
  }

  public getAvailability(): ModelAvailability[] {
    const now = Date.now();
    return this.models.map((model) => {
      const until = this.rateLimitedUntil.get(model) ?? 0;
      const s = this.stats.get(model)!;
      return {
        model,
        available: until <= now,
        rateLimitedUntil: until > now ? until : null,
        lastError: s.lastError,
        successCount: s.success,
        failureCount: s.failure,
        rateLimitCount: s.rateLimit,
      };
    });
  }

  public hasAvailableModel(): boolean {
    const now = Date.now();
    return this.models.some((m) => (this.rateLimitedUntil.get(m) ?? 0) <= now);
  }

  public async reason(request: SlowPathRequest): Promise<SlowPathResponse> {
    if (!this.enabled) {
      return { decision: "blocked", message: "OpenCode Slow Path is disabled." };
    }
    if (!this.apiKey) {
      return {
        decision: "blocked",
        message: "OpenCode Slow Path requires OPENCODE_API_KEY.",
      };
    }

    const now = Date.now();
    const available = this.models.filter((m) => (this.rateLimitedUntil.get(m) ?? 0) <= now);

    if (available.length === 0) {
      const nextRetry = Math.min(
        ...this.models.map((m) => this.rateLimitedUntil.get(m) ?? now)
      );
      const waitMin = Math.ceil((nextRetry - now) / 60_000);
      return {
        decision: "blocked",
        message: `All OpenCode free models rate-limited. Retry in ~${waitMin} min.`,
      };
    }

    const safeRequest = redactPII(request);
    let lastError = "No model available.";

    for (const model of available) {
      const result = await this.callModel(model, safeRequest);
      if (result.ok) {
        this.stats.get(model)!.success += 1;
        this.stats.get(model)!.lastError = null;
        return result.response;
      }

      lastError = result.error;
      this.stats.get(model)!.lastError = result.error;

      if (result.rateLimited) {
        this.rateLimitedUntil.set(model, Date.now() + this.rateLimitCooldownMs);
        this.stats.get(model)!.rateLimit += 1;
      } else {
        this.stats.get(model)!.failure += 1;
      }
    }

    return {
      decision: "blocked",
      message: `OpenCode Slow Path failed on all available models: ${lastError}`,
    };
  }

  private async callModel(
    model: string,
    safeRequest: SlowPathRequest
  ): Promise<
    | { ok: true; response: SlowPathResponse }
    | { ok: false; error: string; rateLimited: boolean }
  > {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImplementation(this.endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
        },
        signal: controller.signal,
        body: JSON.stringify({
          model,
          max_tokens: 1_200,
          temperature: 0.2,
          messages: [
            {
              role: "system",
              content: SYSTEM_PROMPT,
            },
            {
              role: "user",
              content: JSON.stringify({
                task: safeRequest.userIntent,
                reason: safeRequest.reason,
                taskSummary: safeRequest.taskSummary,
                uiState: {
                  url: safeRequest.uiState.url,
                  title: safeRequest.uiState.title,
                  objects: safeRequest.uiState.objects.slice(0, 40).map((o) => ({
                    role: o.role,
                    label: o.label,
                    selector: o.selector,
                  })),
                },
              }),
            },
          ],
        }),
      });

      if (response.status === 429 || response.status === 503) {
        return {
          ok: false,
          error: `HTTP ${response.status} rate limit`,
          rateLimited: true,
        };
      }

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        const rateLimited =
          response.status === 402 ||
          /rate.?limit|quota|too many/i.test(body);
        return {
          ok: false,
          error: `HTTP ${response.status}: ${body.slice(0, 120)}`,
          rateLimited,
        };
      }

      const body = (await response.json()) as ChatCompletionResponse;
      const text = extractContent(body);
      if (!text) {
        return { ok: false, error: "Empty model response", rateLimited: false };
      }

      const parsed = parseSlowPathJson(text);
      if (!parsed) {
        return {
          ok: false,
          error: "Invalid Slow Path JSON from model",
          rateLimited: false,
        };
      }
      return { ok: true, response: parsed };
    } catch (error) {
      const timedOut = controller.signal.aborted;
      return {
        ok: false,
        error: timedOut
          ? `Timeout after ${this.timeoutMs}ms`
          : error instanceof Error
            ? error.message
            : "Unknown error",
        rateLimited: false,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

const SYSTEM_PROMPT = `You are LHIC Slow Path planner. Return ONLY valid JSON matching this schema:
{
  "decision": "ask_user" | "propose_plan" | "retry_with_action" | "blocked",
  "message": string,
  "proposedActions": [
    {
      "scope": "browser",
      "type": "navigate" | "click" | "fill" | "select" | "press" | "wait" | "download" | "custom",
      "intent": string,
      "target": string,
      "value": string | null,
      "methodPreference": ["dom" | "accessibility" | "api" | "keyboard" | "ocr" | "vision" | "mouse"],
      "riskLevel": "low" | "medium" | "high" | "unknown"
    }
  ]
}
Rules:
- Never request/emit credentials, tokens, cookies, passwords, or PII.
- Prefer DOM/accessibility selectors over coordinates.
- Propose minimal safe browser actions only.
- Use blocked or ask_user when unsafe or under-specified.`;

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
      reasoning_content?: string | null;
    };
  }>;
}

function extractContent(body: ChatCompletionResponse): string {
  const msg = body.choices?.[0]?.message;
  const content = msg?.content?.trim() ?? "";
  if (content) return content;
  // Some free models put text only in reasoning; try to recover JSON from it
  const reasoning = msg?.reasoning_content?.trim() ?? "";
  return reasoning;
}

function parseSlowPathJson(text: string): SlowPathResponse | null {
  const candidates = [text];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  const brace = text.match(/\{[\s\S]*\}/);
  if (brace?.[0]) candidates.push(brace[0]);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (isSlowPathResponse(parsed)) return parsed;
    } catch {
      // try next
    }
  }
  return null;
}

function isSlowPathResponse(value: unknown): value is SlowPathResponse {
  if (!value || typeof value !== "object") return false;
  const c = value as Partial<SlowPathResponse>;
  const decisionOk =
    c.decision === "ask_user" ||
    c.decision === "propose_plan" ||
    c.decision === "retry_with_action" ||
    c.decision === "blocked";
  if (!decisionOk || typeof c.message !== "string") return false;
  if (c.proposedActions === undefined) return true;
  return (
    Array.isArray(c.proposedActions) &&
    c.proposedActions.every(isBrowserSemanticAction)
  );
}
