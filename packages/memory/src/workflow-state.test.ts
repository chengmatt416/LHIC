import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { DurableWorkflowStore } from "./workflow-state.js";

describe("DurableWorkflowStore", () => {
  it("saves, gets, and deletes active workflow states in SQLite database", () => {
    const db = new DatabaseSync(":memory:");
    const store = new DurableWorkflowStore(db);

    const testState = {
      taskId: "task-123",
      workflowName: "test-flow",
      lastCompletedStep: 3,
      url: "https://example.com/form",
      cookiesJson: JSON.stringify([{ name: "session", value: "xyz" }]),
      localStorageJson: JSON.stringify({ theme: "dark" }),
      sessionStorageJson: JSON.stringify({ sidebar: "open" }),
    };

    // Retrieve non-existent state
    expect(store.get("task-123")).toBeUndefined();

    // Save state
    store.save(testState);

    // Retrieve state
    const retrieved = store.get("task-123");
    expect(retrieved).toBeDefined();
    expect(retrieved?.taskId).toBe("task-123");
    expect(retrieved?.lastCompletedStep).toBe(3);
    expect(retrieved?.url).toBe("https://example.com/form");
    expect(JSON.parse(retrieved!.cookiesJson)).toHaveLength(1);

    // Update state
    store.save({
      ...testState,
      lastCompletedStep: 4,
    });
    expect(store.get("task-123")?.lastCompletedStep).toBe(4);

    // Delete state
    store.delete("task-123");
    expect(store.get("task-123")).toBeUndefined();
  });
});
