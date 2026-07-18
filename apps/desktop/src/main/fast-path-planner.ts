import type { BrowserExecutionPlan } from "@lhic/schema";

export interface FastPathTaskInput {
  goal: string;
  startUrl?: string;
}

/**
 * Compiles the deliberately small, deterministic desktop Fast Path. It never
 * reads a model, an MCP server, or remote shared-Skill state.
 */
export function compileLocalFastPath(
  input: FastPathTaskInput,
): BrowserExecutionPlan | undefined {
  const url = requiredHttpUrl(input.startUrl);
  const query = searchQuery(input.goal);
  if (!url || !query) return undefined;
  return {
    schemaVersion: "browser-plan-v1",
    goal: input.goal,
    skillName: "search",
    requiredVariables: [],
    steps: [
      {
        id: "open-target",
        action: {
          scope: "browser",
          type: "navigate",
          intent: "Open the requested search page",
          target: url.toString(),
          methodPreference: ["api", "dom"],
          riskLevel: "low",
        },
        verification: {
          type: "url",
          description: "The requested search page is open",
          params: { equals: url.toString() },
        },
      },
      {
        id: "fill-query",
        action: {
          scope: "browser",
          type: "fill",
          intent: "Fill the search query",
          target: "Search",
          value: query,
          methodPreference: ["accessibility", "dom", "keyboard"],
          riskLevel: "low",
        },
        verification: {
          type: "dom",
          description: "A search input remains available after filling",
          params: {
            selector:
              "input[type=search], input[role=searchbox], [role=searchbox]",
            state: "exists",
          },
        },
      },
      {
        id: "submit-query",
        action: {
          scope: "browser",
          type: "press",
          intent: "Submit the search query",
          target: "Search",
          value: "Enter",
          methodPreference: ["keyboard", "accessibility"],
          riskLevel: "low",
        },
        verification: {
          type: "url",
          description: "Search submission changes the page URL",
          params: { notEquals: url.toString() },
        },
      },
    ],
  };
}

function requiredHttpUrl(value: string | undefined): URL | undefined {
  if (!value?.trim()) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password
  ) {
    return undefined;
  }
  return url;
}

function searchQuery(goal: string): string | undefined {
  const match = goal.match(
    /(?:search|find|look up|lookup)\s+(?:for\s+)?["']?(.+?)["']?$/i,
  );
  const value = match?.[1]?.trim();
  return value && value.length <= 512 ? value : undefined;
}
