import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { DurableTaskSummaryStore } from "./task-summary-store.js";

describe("DurableTaskSummaryStore", () => {
  it("persists only redacted compact task summaries", () => {
    const database = new DatabaseSync(":memory:");
    const store = new DurableTaskSummaryStore(database);
    store.save("summary-1", {
      goal: "Find person@example.com invoices",
      currentLocation: "https://example.test/invoices",
      completedSteps: ["observe"],
      verifiedEvidence: ["Found person@example.com"],
      failureReasons: ["selector changed"],
      nextStage: "recover",
    });

    const summary = store.get("summary-1");
    expect(summary).toMatchObject({
      completedSteps: ["observe"],
      nextStage: "recover",
    });
    expect(JSON.stringify(summary)).not.toContain("person@example.com");
  });
});
