import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { TaskBudgetTracker } from "@lhic/controller";

import { TaskService } from "./task-service.js";
import { TaskJournalStore } from "./task-journal-store.js";

describe("TaskService", () => {
  it("keeps a Fast Path admission model-free", async () => {
    let proposalCalls = 0;
    const service = createService(async () => {
      proposalCalls += 1;
      return validPlan;
    });
    const event = await service.start({ goal: "open the known search skill" });
    expect(event.status).toBe("blocked");
    expect(event.evidence).toContain(
      "No LLM or MCP call was made on the Fast Path.",
    );
    expect(proposalCalls).toBe(0);
  });

  it("compiles a deterministic Fast Path when a supported local Skill and start URL are supplied", async () => {
    let proposalCalls = 0;
    const service = createService(async () => {
      proposalCalls += 1;
      return validPlan;
    });

    const event = await service.start({
      goal: "Search for release notes",
      startUrl: "https://docs.example.test/search",
    });

    expect(event.status).toBe("proposed");
    expect(event.proposal?.steps).toHaveLength(3);
    expect(event.evidence).toContain(
      "Fast Path compiled locally with zero LLM calls and zero MCP calls.",
    );
    expect(proposalCalls).toBe(0);
  });

  it("requires provider approval and validates a Slow Path plan before execution", async () => {
    const service = createService(async () => validPlan);
    const updates: string[] = [];
    service.subscribe((event) => updates.push(event.status));
    await service.configure({
      id: "openai",
      kind: "openai-responses",
      label: "OpenAI",
      model: "test-model",
      enabled: true,
    });
    const pending = await service.start({
      goal: "plan a difficult browser task",
      sourceId: "openai",
    });
    expect(pending.status).toBe("awaiting_approval");
    const proposal = await service.approve(pending.commandId);
    expect(proposal.status).toBe("proposed");
    expect(proposal.evidence).toContain(
      "Schema validation accepted 1 browser steps with verifier conditions.",
    );
    expect(updates).toEqual(["awaiting_approval", "running", "proposed"]);
  });

  it("automatically selects an enabled Slow Path source after no local Skill matches", async () => {
    const service = createService(async () => validPlan);
    await service.configure({
      id: "openai",
      kind: "openai-responses",
      label: "OpenAI",
      model: "test-model",
      enabled: true,
    });

    const pending = await service.start({ goal: "plan a desktop task" });

    expect(pending.status).toBe("awaiting_approval");
    expect(pending.message).toContain("OpenAI may receive");
  });

  it("never creates a provider request for explicit Fast Path admission", async () => {
    let proposalCalls = 0;
    const service = createService(async () => {
      proposalCalls += 1;
      return validPlan;
    });
    await service.configure({
      id: "openai",
      kind: "openai-responses",
      label: "OpenAI",
      model: "test-model",
      enabled: true,
    });

    const result = await service.start({
      goal: "Run an unavailable learned workflow",
      startUrl: "https://vendor.techtools.qzz.io/",
      fastOnly: true,
    });

    expect(result.status).toBe("blocked");
    expect(result.message).toContain("Slow Path fallback is disabled");
    expect(result.evidence).toContain(
      "No provider approval request was created.",
    );
    expect(proposalCalls).toBe(0);
  });

  it("blocks a Slow Path provider before sending a request when its budget is exhausted", async () => {
    let proposalCalls = 0;
    const service = new TaskService(
      process.cwd(),
      { get: async () => undefined } as never,
      {
        propose: async () => {
          proposalCalls += 1;
          return validPlan;
        },
      } as never,
      {
        sourceStore: { load: async () => [], save: async () => undefined },
        journalStore: emptyJournalStore(),
        sourceBudget: () =>
          new TaskBudgetTracker("balanced", {
            budget: { maxSlowPathCalls: 0 },
          }),
      },
    );
    await service.configure({
      id: "openai",
      kind: "openai-responses",
      label: "OpenAI",
      model: "test-model",
      enabled: true,
    });
    const pending = await service.start({
      goal: "plan a difficult browser task",
      sourceId: "openai",
    });

    const result = await service.approve(pending.commandId);
    expect(result.status).toBe("blocked");
    expect(result.evidence).toContain("No provider request was sent.");
    expect(proposalCalls).toBe(0);
  });

  it("enforces the configured Fast-Path-only safety profile before calling a provider", async () => {
    let proposalCalls = 0;
    const service = createService(async () => {
      proposalCalls += 1;
      return validPlan;
    });
    service.setSlowPathProfile("fast_only");
    await service.configure({
      id: "openai",
      kind: "openai-responses",
      label: "OpenAI",
      model: "test-model",
      enabled: true,
    });
    const pending = await service.start({
      goal: "plan a difficult browser task",
      sourceId: "openai",
    });
    const result = await service.approve(pending.commandId);

    expect(result.status).toBe("blocked");
    expect(result.message).toContain("Slow Path call budget");
    expect(proposalCalls).toBe(0);
  });

  it("persists a pending provider proposal so it can be resumed after restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lhic-task-journal-test-"));
    const journal = new TaskJournalStore(directory);
    try {
      const service = new TaskService(
        directory,
        { get: async () => undefined } as never,
        { propose: async () => validPlan } as never,
        {
          sourceStore: { load: async () => [], save: async () => undefined },
          journalStore: journal,
        },
      );
      await service.configure({
        id: "openai",
        kind: "openai-responses",
        label: "OpenAI",
        model: "test-model",
        enabled: true,
      });
      const pending = await service.start({
        goal: "plan a difficult browser task",
        sourceId: "openai",
      });
      await service.close();

      const restored = new TaskService(
        directory,
        { get: async () => undefined } as never,
        { propose: async () => validPlan } as never,
        {
          sourceStore: { load: async () => [], save: async () => undefined },
          journalStore: journal,
        },
      );
      await restored.initialize();
      expect(restored.recentEvents()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            commandId: pending.commandId,
            status: "awaiting_approval",
          }),
        ]),
      );
      await expect(restored.approve(pending.commandId)).resolves.toMatchObject({
        status: "proposed",
      });
      await restored.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("passes the user's start URL into Slow Path planning", async () => {
    let receivedStartUrl: string | undefined;
    const service = new TaskService(
      process.cwd(),
      { get: async () => undefined } as never,
      {
        propose: async (_source, _goal, _workspaceRoot, options) => {
          receivedStartUrl = options?.startUrl;
          return validPlan;
        },
      } as never,
      {
        sourceStore: { load: async () => [], save: async () => undefined },
        journalStore: emptyJournalStore(),
      },
    );
    await service.configure({
      id: "openai",
      kind: "openai-responses",
      label: "OpenAI",
      model: "test-model",
      enabled: true,
    });
    const pending = await service.start({
      goal: "plan a difficult browser task",
      sourceId: "openai",
      startUrl: "https://docs.example.test/start",
    });
    await service.approve(pending.commandId);
    expect(receivedStartUrl).toBe("https://docs.example.test/start");
  });

  it("keeps a cancelled provider task cancelled after the provider returns", async () => {
    let resolveProposal: ((value: typeof validPlan) => void) | undefined;
    const service = new TaskService(
      process.cwd(),
      { get: async () => undefined } as never,
      {
        propose: async () =>
          new Promise<typeof validPlan>((resolve) => {
            resolveProposal = resolve;
          }),
      } as never,
      {
        sourceStore: { load: async () => [], save: async () => undefined },
        journalStore: emptyJournalStore(),
      },
    );
    await service.configure({
      id: "openai",
      kind: "openai-responses",
      label: "OpenAI",
      model: "test-model",
      enabled: true,
    });
    const pending = await service.start({
      goal: "plan a difficult browser task",
      sourceId: "openai",
    });
    const approval = service.approve(pending.commandId);
    await new Promise((resolve) => setImmediate(resolve));
    await service.cancel(pending.commandId);
    resolveProposal?.(validPlan);
    await expect(approval).resolves.toMatchObject({ status: "cancelled" });
  });
});

function createService(propose: () => Promise<typeof validPlan>): TaskService {
  return new TaskService(
    process.cwd(),
    { get: async () => undefined } as never,
    { propose } as never,
    {
      sourceStore: { load: async () => [], save: async () => undefined },
      journalStore: emptyJournalStore(),
    },
  );
}

function emptyJournalStore() {
  return {
    load: async () => ({ events: [], pending: [] }),
    save: async () => undefined,
  };
}

const validPlan = {
  schemaVersion: "browser-plan-v1" as const,
  goal: "Open a public page",
  requiredVariables: [],
  steps: [
    {
      id: "open",
      action: {
        scope: "browser" as const,
        type: "navigate" as const,
        intent: "Open the public page",
        target: "https://example.test/",
        methodPreference: ["api" as const],
        riskLevel: "low" as const,
      },
      verification: {
        type: "url" as const,
        description: "The public page is open",
        params: { equals: "https://example.test/" },
      },
    },
  ],
};
