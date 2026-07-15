import type { RiskLevel, UserIntent } from "@lhic/schema";

export type IntentOperation =
  "login" | "search" | "download" | "fill_form" | "test_web_flow" | "unknown";

const destructivePattern =
  /\b(delete|remove|destroy|pay|purchase|send(?:\s+external)?\s+email|production\s+write|transfer)\b/i;
const urlPattern = /https?:\/\/[^\s]+/i;

export function parseUserIntent(command: string): UserIntent {
  const operation = inferOperation(command);
  const riskLevel: RiskLevel = destructivePattern.test(command)
    ? "high"
    : "low";
  const url = command.match(urlPattern)?.[0];
  const query = extractQuery(command, operation);
  const constraints: Record<string, unknown> = { operation };
  if (query) {
    constraints.query = query;
  }

  return {
    goal: command.trim(),
    ...(url ? { domain: new URL(url).hostname } : {}),
    constraints,
    riskLevel,
    requiresConfirmation: riskLevel === "high",
    missingInformation: operation === "unknown" ? ["supported_operation"] : [],
  };
}

export function inferOperation(command: string): IntentOperation {
  const normalized = command.toLowerCase();
  if (
    /\b(test|verify|check)\b.*\b(checkout|flow|website|web)\b|\btest\s+(?:the\s+)?checkout\b/i.test(
      normalized,
    )
  ) {
    return "test_web_flow";
  }
  if (/\b(log\s*in|login|sign\s*in|authenticate)\b/i.test(normalized)) {
    return "login";
  }
  if (/\b(download|export|save as)\b/i.test(normalized)) {
    return "download";
  }
  if (
    /\b(fill|complete|populate)\b.*\b(form|fields?|application|profile)\b/i.test(
      normalized,
    )
  ) {
    return "fill_form";
  }
  if (/\b(search|find|look up|lookup)\b/i.test(normalized)) {
    return "search";
  }
  return "unknown";
}

function extractQuery(
  command: string,
  operation: IntentOperation,
): string | undefined {
  if (operation !== "search") {
    return undefined;
  }
  const match = command.match(
    /(?:search|find|look up|lookup)\s+(?:for\s+)?["']?(.+?)["']?(?:\s+on\s+https?:\/\/|$)/i,
  );
  return match?.[1]?.trim() || undefined;
}
