import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { WorkspaceConflictStore } from "@lhic/ledger";

import { OmpWorkspaceObserver } from "./workspace-observer.js";

describe("OmpWorkspaceObserver", () => {
  let directory: string;
  let store: WorkspaceConflictStore;
  let agentA: OmpWorkspaceObserver;
  let agentB: OmpWorkspaceObserver;
  const conflictsA: string[] = [];
  const conflictsB: string[] = [];

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "lhic-workspace-"));
    await mkdir(join(directory, "src"), { recursive: true });
    await writeFile(join(directory, "src", "a.ts"), "const a = 1;\n");
    conflictsA.length = 0;
    conflictsB.length = 0;
    store = new WorkspaceConflictStore({
      databaseFile: join(directory, "ledger.sqlite"),
    });
    agentA = new OmpWorkspaceObserver({
      store,
      agentId: "agent-a",
      taskId: "task-1",
      workspaceRoot: directory,
      onConflict: (conflict) => conflictsA.push(conflict.path),
    });
    agentB = new OmpWorkspaceObserver({
      store,
      agentId: "agent-b",
      taskId: "task-1",
      workspaceRoot: directory,
      onConflict: (conflict) => conflictsB.push(conflict.path),
    });
  });

  afterEach(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("records reads from observable tool events", async () => {
    await agentB.recordRead("src/a.ts");
    const readSet = store.readSet("agent-b", "task-1", "src/a.ts");
    expect(readSet?.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("notifies a stale sibling when a write lands and gates its write", async () => {
    await agentB.recordRead("src/a.ts");
    await writeFile(join(directory, "src", "a.ts"), "const a = 2;\n");
    await agentA.recordWrite("src/a.ts", true);
    agentB.pollConflicts();
    expect(conflictsB).toEqual(["src/a.ts"]);
    // B's write is gated until re-read.
    const pending = store.pendingConflictForWrite(
      "agent-b",
      "task-1",
      "src/a.ts",
    );
    expect(pending).toBeDefined();
    expect(pending?.newHash).toMatch(/^[a-f0-9]{64}$/);
    // A (the writer) is not conflicted with itself.
    expect(conflictsA).toEqual([]);
    await agentB.recordRead("src/a.ts");
    expect(
      store.pendingConflictForWrite("agent-b", "task-1", "src/a.ts"),
    ).toBeUndefined();
  });

  it("handles the full frame-driven scenario through OMP events", async () => {
    // B reads via a tool event; A edits; B is alerted before its next write.
    agentB.feed({
      type: "tool_execution_start",
      id: "t1",
      toolName: "read",
      args: { filePath: "src/a.ts" },
    });
    await agentB.flush();
    await writeFile(join(directory, "src", "a.ts"), "const a = 3;\n");
    agentA.feed({
      type: "tool_execution_start",
      id: "t2",
      toolName: "edit",
      args: { filePath: "src/a.ts" },
    });
    agentA.feed({
      type: "tool_execution_end",
      id: "t2",
      toolName: "edit",
      success: true,
    });
    await agentA.flush();
    agentB.pollConflicts();
    expect(conflictsB).toEqual(["src/a.ts"]);
    // B's own next write attempt surfaces the conflict before executing.
    const warned: string[] = [];
    const agentBWithWarning = new OmpWorkspaceObserver({
      store,
      agentId: "agent-b",
      taskId: "task-1",
      workspaceRoot: directory,
      onConflict: (conflict) => warned.push(conflict.path),
    });
    agentBWithWarning.feed({
      type: "tool_execution_start",
      id: "t3",
      toolName: "edit",
      args: { filePath: "src/a.ts" },
    });
    expect(warned).toEqual(["src/a.ts"]);
  });

  it("ignores command-string args and out-of-workspace paths", async () => {
    agentB.feed({
      type: "tool_execution_start",
      id: "t1",
      toolName: "bash",
      args: { command: "cat src/a.ts" },
    });
    agentB.feed({
      type: "tool_execution_start",
      id: "t2",
      toolName: "read",
      args: { filePath: "../outside.ts" },
    });
    await agentB.flush();
    expect(store.readSet("agent-b", "task-1", "src/a.ts")).toBeUndefined();
    expect(store.readSet("agent-b", "task-1", "../outside.ts")).toBeUndefined();
  });

  it("survives a store restart with conflicts intact", async () => {
    await agentB.recordRead("src/a.ts");
    await writeFile(join(directory, "src", "a.ts"), "const a = 9;\n");
    await agentA.recordWrite("src/a.ts", true);
    store.close();
    const reopened = new WorkspaceConflictStore({
      databaseFile: join(directory, "ledger.sqlite"),
    });
    expect(
      reopened.pendingConflictForWrite("agent-b", "task-1", "src/a.ts"),
    ).toBeDefined();
    reopened.close();
  });

  it("does not notify when content returns to the read hash", async () => {
    await agentB.recordRead("src/a.ts");
    await writeFile(join(directory, "src", "a.ts"), "const a = 2;\n");
    await agentA.recordWrite("src/a.ts", true);
    agentB.pollConflicts();
    expect(conflictsB).toEqual(["src/a.ts"]);
    await writeFile(join(directory, "src", "a.ts"), "const a = 1;\n");
    await agentA.recordWrite("src/a.ts", true);
    expect(conflictsB).toEqual(["src/a.ts"]);
  });
});
