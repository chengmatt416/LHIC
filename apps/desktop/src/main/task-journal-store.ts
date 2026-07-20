import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { CommandEvent, TaskSourceConfig } from "../shared/contracts.js";
import type { TaskExecutionPlan } from "./task-source-adapter.js";
import { ensurePrivateDirectory } from "./private-directory.js";

export interface PersistedPendingTask {
  commandId: string;
  goal: string;
  startUrl?: string;
  source?: TaskSourceConfig;
  phase: "source" | "execution";
  plan?: TaskExecutionPlan;
}

export interface TaskJournalSnapshot {
  events: CommandEvent[];
  pending: PersistedPendingTask[];
}

const journalName = ".lhic/task-journal.json";

/** Stores resumable proposals and redacted task events, never credentials. */
export class TaskJournalStore {
  private readonly path: string;

  public constructor(workspaceRoot: string) {
    this.path = resolve(workspaceRoot, journalName);
  }

  public async load(): Promise<TaskJournalSnapshot> {
    try {
      const value = JSON.parse(await readFile(this.path, "utf8")) as unknown;
      if (!isRecord(value)) return emptySnapshot();
      return {
        events: Array.isArray(value.events)
          ? value.events.filter(isCommandEvent)
          : [],
        pending: Array.isArray(value.pending)
          ? value.pending.filter(isPersistedPendingTask)
          : [],
      };
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code === "ENOENT" ||
        error instanceof SyntaxError
      ) {
        return emptySnapshot();
      }
      throw error;
    }
  }

  public async save(snapshot: TaskJournalSnapshot): Promise<void> {
    const content = `${JSON.stringify(snapshot, null, 2)}\n`;
    await ensurePrivateDirectory(dirname(this.path));
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.path);
  }
}

function emptySnapshot(): TaskJournalSnapshot {
  return { events: [], pending: [] };
}

function isPersistedPendingTask(value: unknown): value is PersistedPendingTask {
  if (!isRecord(value)) return false;
  return (
    typeof value.commandId === "string" &&
    typeof value.goal === "string" &&
    (value.phase === "source" || value.phase === "execution") &&
    (value.startUrl === undefined || typeof value.startUrl === "string") &&
    (value.source === undefined || isRecord(value.source)) &&
    (value.plan === undefined || isRecord(value.plan))
  );
}

function isCommandEvent(value: unknown): value is CommandEvent {
  if (!isRecord(value)) return false;
  return (
    typeof value.commandId === "string" &&
    isCommandStatus(value.status) &&
    typeof value.message === "string" &&
    typeof value.createdAt === "string"
  );
}

function isCommandStatus(value: unknown): value is CommandEvent["status"] {
  return (
    value === "queued" ||
    value === "running" ||
    value === "awaiting_approval" ||
    value === "proposed" ||
    value === "blocked" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
