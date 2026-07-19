import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { DurableWorkflowStore } from "./workflow-state.js";

describe("DurableWorkflowStore", () => {
  it("saves, gets, and deletes active workflow states in SQLite database", () => {
    const db = new DatabaseSync(":memory:");
    const store = new DurableWorkflowStore(db, {
      encryptionSecret: "test-workflow-encryption-secret",
    });

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

    const storedRow = db
      .prepare(
        "SELECT url, cookies_json FROM workflow_states WHERE task_id = ?",
      )
      .get("task-123") as { url: string; cookies_json: string };
    expect(storedRow.url).not.toContain(testState.url);
    expect(storedRow.cookies_json).not.toContain("xyz");

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

  it("fails closed when the encryption secret is missing or incorrect", () => {
    const db = new DatabaseSync(":memory:");
    expect(
      () => new DurableWorkflowStore(db, { encryptionSecret: "" }),
    ).toThrow("encryption secret");

    const store = new DurableWorkflowStore(db, {
      encryptionSecret: "correct-secret",
    });
    store.save({
      taskId: "task-incorrect-secret",
      workflowName: "test-flow",
      lastCompletedStep: 1,
      url: "https://example.com",
      cookiesJson: "[]",
      localStorageJson: "{}",
      sessionStorageJson: "{}",
    });
    expect(() =>
      new DurableWorkflowStore(db, {
        encryptionSecret: "wrong-secret",
      }).get("task-incorrect-secret"),
    ).toThrow("could not be decrypted");
  });
});
