import type { BrowserExecutionPlan, VerificationCondition } from "@lhic/schema";

export const publicWebTrainingScenarioIds = [
  "wikipedia-search",
  "mdn-search",
  "github-issue-filter",
  "openstreetmap-place-search",
] as const;

export type PublicWebTrainingScenarioId =
  (typeof publicWebTrainingScenarioIds)[number];

export interface PublicWebTrainingScenario {
  id: PublicWebTrainingScenarioId;
  title: string;
  description: string;
  entryUrl: string;
  allowedOrigin: string;
  entryVerification: VerificationCondition;
  goal: string;
  buildPlan(query: string): BrowserExecutionPlan;
}

const wikipediaSearch: PublicWebTrainingScenario = {
  id: "wikipedia-search",
  title: "Wikipedia public search",
  description:
    "Search public encyclopaedia content without logging in or changing remote data.",
  entryUrl: "https://en.wikipedia.org/wiki/Special:Search",
  allowedOrigin: "https://en.wikipedia.org",
  entryVerification: {
    type: "url",
    description: "Wikipedia search page is open.",
    params: { contains: "/wiki/Special:Search" },
  },
  goal: "Search public Wikipedia content",
  buildPlan(query) {
    return {
      schemaVersion: "browser-plan-v1",
      goal: this.goal,
      skillName: this.id,
      requiredVariables: [],
      steps: [
        {
          id: "fill-query",
          action: {
            type: "fill",
            intent: "fill the public Wikipedia search query",
            target: 'form#search input[name="search"]',
            value: query,
            methodPreference: ["dom", "accessibility"],
            riskLevel: "low",
          },
          verification: {
            type: "dom",
            description: "The public search field remains available.",
            params: {
              selector: 'form#search input[name="search"]',
              state: "visible",
            },
          },
        },
        {
          id: "submit-query",
          action: {
            type: "click",
            intent: "submit the public Wikipedia search query",
            target: "form#search button",
            methodPreference: ["dom", "accessibility"],
            riskLevel: "low",
          },
          verification: {
            type: "url",
            description: "Wikipedia returned a search-result URL.",
            params: { hasQueryParam: "search" },
          },
        },
      ],
    };
  },
};

const mdnSearch: PublicWebTrainingScenario = {
  id: "mdn-search",
  title: "MDN documentation search",
  description:
    "Open MDN's public search panel and navigate to a documentation result without logging in or changing remote data.",
  entryUrl: "https://developer.mozilla.org/en-US/",
  allowedOrigin: "https://developer.mozilla.org",
  entryVerification: {
    type: "dom",
    description: "MDN developer resources are visible.",
    params: { text: "Resources for Developers" },
  },
  goal: "Search public MDN documentation",
  buildPlan(query) {
    return {
      schemaVersion: "browser-plan-v1",
      goal: this.goal,
      skillName: this.id,
      requiredVariables: [],
      steps: [
        {
          id: "open-search",
          action: {
            type: "click",
            intent: "open the MDN documentation search panel",
            target: "Search",
            methodPreference: ["accessibility", "dom"],
            riskLevel: "low",
          },
          verification: {
            type: "dom",
            description: "The MDN search panel is visible.",
            params: { role: "searchbox", name: "Search", state: "visible" },
          },
        },
        {
          id: "fill-query",
          action: {
            type: "fill",
            intent: "fill the public MDN documentation search query",
            target: "Search",
            value: query,
            methodPreference: ["accessibility", "dom"],
            riskLevel: "low",
          },
          verification: {
            type: "dom",
            description: "The MDN search panel remains available.",
            params: { role: "searchbox", name: "Search", state: "visible" },
          },
        },
        {
          id: "submit-query",
          action: {
            type: "press",
            intent: "submit the public MDN documentation search query",
            target: "Search",
            value: "Enter",
            methodPreference: ["keyboard", "accessibility"],
            riskLevel: "low",
          },
          verification: {
            type: "url",
            description: "MDN navigated away from its home page.",
            params: { notEquals: "https://developer.mozilla.org/en-US/" },
          },
        },
      ],
    };
  },
};

const githubIssueFilter: PublicWebTrainingScenario = {
  id: "github-issue-filter",
  title: "GitHub public issue filtering",
  description:
    "Filter a public repository's issues without signing in or changing remote data.",
  entryUrl: "https://github.com/microsoft/vscode/issues",
  allowedOrigin: "https://github.com",
  entryVerification: {
    type: "dom",
    description: "GitHub's public issue filter is available.",
    params: { role: "combobox", name: "Search Issues", state: "visible" },
  },
  goal: "Filter public GitHub issues",
  buildPlan(query) {
    return {
      schemaVersion: "browser-plan-v1",
      goal: this.goal,
      skillName: this.id,
      requiredVariables: [],
      steps: [
        {
          id: "fill-filter",
          action: {
            type: "fill",
            intent: "fill the public GitHub issue filter",
            target: 'input[placeholder="Search Issues"]',
            value: query,
            methodPreference: ["accessibility", "dom"],
            riskLevel: "low",
          },
          verification: {
            type: "dom",
            description: "The GitHub issue filter remains available.",
            params: {
              role: "combobox",
              name: "Search Issues",
              state: "visible",
            },
          },
        },
        {
          id: "submit-filter",
          action: {
            type: "press",
            intent: "apply the public GitHub issue filter",
            target: 'input[placeholder="Search Issues"]',
            value: "Enter",
            methodPreference: ["keyboard", "accessibility"],
            riskLevel: "low",
          },
          verification: {
            type: "url",
            description: "GitHub returned a filtered issue-list URL.",
            params: { hasQueryParam: "q" },
          },
        },
      ],
    };
  },
};

const openStreetMapPlaceSearch: PublicWebTrainingScenario = {
  id: "openstreetmap-place-search",
  title: "OpenStreetMap public place search",
  description:
    "Find a public place on OpenStreetMap without signing in, using location search only.",
  entryUrl: "https://www.openstreetmap.org/",
  allowedOrigin: "https://www.openstreetmap.org",
  entryVerification: {
    type: "dom",
    description: "The OpenStreetMap place-search field is available.",
    params: { selector: "input#query:visible", state: "visible" },
  },
  goal: "Find a public place on OpenStreetMap",
  buildPlan(query) {
    return {
      schemaVersion: "browser-plan-v1",
      goal: this.goal,
      skillName: this.id,
      requiredVariables: [],
      steps: [
        {
          id: "fill-place-query",
          action: {
            type: "fill",
            intent: "fill the public OpenStreetMap place search query",
            target: "input#query:visible",
            value: query,
            methodPreference: ["dom", "accessibility"],
            riskLevel: "low",
          },
          verification: {
            type: "dom",
            description:
              "The OpenStreetMap place-search field remains available.",
            params: { selector: "input#query:visible", state: "visible" },
          },
        },
        {
          id: "submit-place-query",
          action: {
            type: "click",
            intent: "run the public OpenStreetMap place search",
            target: "form:visible button.btn-primary",
            methodPreference: ["dom", "accessibility"],
            riskLevel: "low",
          },
          verification: {
            type: "url",
            description: "OpenStreetMap returned a location-search URL.",
            params: { hasQueryParam: "query" },
          },
        },
      ],
    };
  },
};

const scenarios: Record<
  PublicWebTrainingScenarioId,
  PublicWebTrainingScenario
> = {
  "wikipedia-search": wikipediaSearch,
  "mdn-search": mdnSearch,
  "github-issue-filter": githubIssueFilter,
  "openstreetmap-place-search": openStreetMapPlaceSearch,
};

export function getPublicWebTrainingScenario(
  id: string,
): PublicWebTrainingScenario {
  const scenario = scenarios[id as PublicWebTrainingScenarioId];
  if (!scenario) {
    throw new Error(
      `Unknown public-web training scenario ${JSON.stringify(id)}. Choose one of: ${publicWebTrainingScenarioIds.join(", ")}.`,
    );
  }
  return scenario;
}

export function buildPublicWebTrainingPlan(
  scenarioId: string,
  query: string,
): BrowserExecutionPlan {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) {
    throw new Error("Public-web training requires a non-empty query.");
  }
  if (normalizedQuery.length > 256) {
    throw new Error(
      "Public-web training queries must be 256 characters or fewer.",
    );
  }
  return getPublicWebTrainingScenario(scenarioId).buildPlan(normalizedQuery);
}
