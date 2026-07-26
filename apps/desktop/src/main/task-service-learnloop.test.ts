import { describe, expect, it } from "vitest";

import type { BrowserExecutionPlan, NormalizedUIState } from "@lhic/schema";

import {
  summarizePlan,
  type BrowserIntentAdmission,
  type BrowserRunResult,
} from "./desktop-browser-runner.js";
import { compileLocalFastPath } from "./fast-path-planner.js";
import { TaskService } from "./task-service.js";

const startUrl = "https://docs.example.test/search";
const searchState: NormalizedUIState = {
  surface: "browser",
  url: startUrl,
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
    const service = createService({
      uiState: searchState,
      onAdmission: () => {
        admissionObserved = true;
      },
    });
    const proposed = await service.start({
      goal: "Search for release notes",
      startUrl,
    });

    const completed = await service.execute(proposed.commandId);

    expect(admissionObserved).toBe(true);
    expect(completed.status).toBe("completed");
    expect(completed.evidence).toContain(
      "Human Intent prediction ran against live normalized UI before task actions.",
    );
  });

  it("propagates a fail-closed Human Intent decision and clears the pending plan", async () => {
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
    const service = createService({ uiState: ambiguousState });
    const proposed = await service.start({
      goal: "Search for release notes",
      startUrl,
    });

    const blocked = await service.execute(proposed.commandId);

    expect(blocked.status).toBe("blocked");
    expect(blocked.message).toContain("Human-intent admission blocked");
    await expect(service.execute(proposed.commandId)).rejects.toThrow(
      "validated browser-plan-v1",
    );
  });

  it("does not apply LearnLoop admission to a Slow Path browser plan", async () => {
    let admissionObserved = false;
    const service = createService({
      uiState: searchState,
      enableSlowPath: true,
      onAdmission: () => {
        admissionObserved = true;
      },
    });
    const awaitingProviderApproval = await service.start({
      goal: "Perform an unsupported custom browser workflow",
      sourceId: "codex-cli",
    });
    expect(awaitingProviderApproval.status).toBe("awaiting_approval");

    const proposed = await service.approve(awaitingProviderApproval.commandId);
    expect(proposed.status).toBe("proposed");

    const completed = await service.execute(proposed.commandId);

    expect(completed.status).toBe("completed");
    expect(admissionObserved).toBe(false);
    expect(completed.evidence).toContain(
      "Slow Path plan did not receive LearnLoop admission.",
    );
  });
});

function createService(options: {
  uiState: NormalizedUIState;
  onAdmission?: () => void;
  enableSlowPath?: boolean;
}): TaskService {
  const browserRunner = {
    readiness: async () => ({
      ready: true,
      executablePath: "/test/chromium",
      message: "ready",
    }),
    execute: async (
      _commandId: string,
      plan: BrowserExecutionPlan,
      admission?: BrowserIntentAdmission,
    ): Promise<BrowserRunResult> => {
      if (!admission) {
        return {
          status: "completed",
          message:
            "Slow Path plan completed under its existing approval gates.",
          evidence: ["Slow Path plan did not receive LearnLoop admission."],
          proposal: summarizePlan(plan),
        };
      }
      options.onAdmission?.();
      const decision = await admission(options.uiState);
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
  const slowPathPlan = compileLocalFastPath({
    goal: "Search for release notes",
    startUrl,
  });
  if (!slowPathPlan) throw new Error("Expected local search fixture plan.");
  return new TaskService(
    process.cwd(),
    { get: async () => undefined } as never,
    {
      propose: async () => slowPathPlan,
      discoverCliSources: async () => [],
    } as never,
    {
      browserRunner,
      sourceStore: {
        load: async () =>
          options.enableSlowPath
            ? [
                {
                  id: "codex-cli",
                  kind: "codex-cli" as const,
                  label: "Codex CLI",
                  enabled: true,
                },
              ]
            : [],
        save: async () => undefined,
      },
      journalStore: {
        load: async () => ({ events: [], pending: [] }),
        save: async () => undefined,
      },
    },
  );
}
