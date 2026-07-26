import { describe, expect, it } from "vitest";

import type { NormalizedUIState } from "@lhic/schema";

import {
  summarizePlan,
  type BrowserIntentAdmission,
  type BrowserRunResult,
} from "./desktop-browser-runner.js";
import { TaskService } from "./task-service.js";

const searchState: NormalizedUIState = {
  surface: "browser",
  url: "https://docs.example.test/search",
  title: "Documentation search",
  objects: [
    {
      id: "query",
      role: "searchbox",
      label: "Search",
      enabled: true,
      source: "dom",
      selector: "input[type=search]",
    },
  ],
  signals: {},
  capturedAt: "2026-07-27T00:00:00.000Z",
};

describe("TaskService prediction-first browser wiring", () => {
  it("evaluates live UI before completing a local Fast Path", async () => {
    let admissionObserved = false;
    const service = createService(searchState, () => {
      admissionObserved = true;
    });
    const proposed = await service.start({
      goal: "Search for release notes",
      startUrl: "https://docs.example.test/search",
    });

    const completed = await service.execute(proposed.commandId);

    expect(admissionObserved).toBe(true);
    expect(completed.status).toBe("completed");
    expect(completed.evidence).toContain(
      "Human Intent prediction ran against live normalized UI before task actions.",
    );
  });

  it("propagates a fail-closed Human Intent decision as blocked", async () => {
    const ambiguousState: NormalizedUIState = {
      ...searchState,
      objects: [
        ...searchState.objects,
        {
          id: "email",
          role: "textbox",
          label: "Email",
          enabled: true,
          source: "dom",
          selector: "#email",
        },
        {
          id: "password",
          role: "textbox",
          label: "Password",
          enabled: true,
          source: "dom",
          selector: "#password",
        },
      ],
    };
    const service = createService(ambiguousState);
    const proposed = await service.start({
      goal: "Search for release notes",
      startUrl: "https://docs.example.test/search",
    });

    const blocked = await service.execute(proposed.commandId);

    expect(blocked.status).toBe("blocked");
    expect(blocked.message).toContain("Human-intent admission blocked");
  });
});

function createService(
  uiState: NormalizedUIState,
  onAdmission?: () => void,
): TaskService {
  const browserRunner = {
    readiness: async () => ({
      ready: true,
      executablePath: "/test/chromium",
      message: "ready",
    }),
    execute: async (
      _commandId: string,
      plan: Parameters<BrowserIntentAdmission>[2],
      admission?: BrowserIntentAdmission,
    ): Promise<BrowserRunResult> => {
      expect(admission).toBeDefined();
      onAdmission?.();
      const decision = await admission!(uiState);
      return {
        status: decision.allowed ? "completed" : "blocked",
        message: decision.message,
        evidence: decision.evidence,
        proposal: summarizePlan(plan),
      };
    },
    approve: async () => {
      throw new Error("not used");
    },
    cancel: async () => undefined,
    close: async () => undefined,
  };
  return new TaskService(
    process.cwd(),
    { get: async () => undefined } as never,
    { propose: async () => neverPlan() } as never,
    {
      browserRunner,
      sourceStore: { load: async () => [], save: async () => undefined },
      journalStore: {
        load: async () => ({ events: [], pending: [] }),
        save: async () => undefined,
      },
    },
  );
}

function neverPlan(): never {
  throw new Error("Slow Path must not be invoked by this test.");
}
