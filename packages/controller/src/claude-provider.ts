import type {
  SlowPathProvider,
  SlowPathRequest,
  SlowPathResponse,
} from "./slow-path.js";
import { redactPII } from "@lhic/trace";

export interface ClaudeSlowPathOptions {
  enabled?: boolean;
  apiKey?: string;
  model?: string;
  endpoint?: string;
  fetchImplementation?: typeof fetch;
}

interface ClaudeMessageResponse {
  content?: Array<{ type?: string; text?: string }>;
}

export class ClaudeSlowPathProvider implements SlowPathProvider {
  private readonly enabled: boolean;
  private readonly apiKey: string | undefined;
  private readonly model: string;
  private readonly endpoint: string;
  private readonly fetchImplementation: typeof fetch;

  public constructor(options: ClaudeSlowPathOptions = {}) {
    this.enabled =
      options.enabled ?? process.env.CLAUDE_SLOW_PATH_ENABLED === "true";
    this.apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
    this.model =
      options.model ?? process.env.CLAUDE_MODEL ?? "claude-sonnet-4-5";
    this.endpoint = options.endpoint ?? "https://api.anthropic.com/v1/messages";
    this.fetchImplementation = options.fetchImplementation ?? fetch;
  }

  public async reason(request: SlowPathRequest): Promise<SlowPathResponse> {
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

    const safeRequest = redactPII(request);
    try {
      const response = await this.fetchImplementation(this.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 800,
          system:
            "You are a Slow Path reasoning provider. Never return credentials. Propose safe semantic actions only.",
          messages: [{ role: "user", content: JSON.stringify(safeRequest) }],
        }),
      });
      if (!response.ok) {
        return {
          decision: "blocked",
          message: `Claude Slow Path request failed with HTTP ${response.status}.`,
        };
      }
      const body = (await response.json()) as ClaudeMessageResponse;
      const message = body.content
        ?.filter((block) => block.type === "text")
        .map((block) => block.text ?? "")
        .join("\n")
        .trim();
      return {
        decision: "propose_plan",
        message: message || "Claude Slow Path returned no textual plan.",
      };
    } catch (error) {
      return {
        decision: "blocked",
        message:
          error instanceof Error
            ? `Claude Slow Path failed: ${error.message}`
            : "Claude Slow Path failed.",
      };
    }
  }
}
