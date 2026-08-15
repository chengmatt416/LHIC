import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

import type { WorkspaceConflict, WorkspaceConflictStore } from "@lhic/ledger";

export interface OmpWorkspaceObserverOptions {
  store: WorkspaceConflictStore;
  agentId: string;
  taskId: string;
  workspaceRoot: string;
  onConflict?: (conflict: WorkspaceConflict) => void;
}

const readTools = new Set(["read", "grep", "glob"]);
const writeTools = new Set(["edit", "write", "apply_patch", "patch"]);

/**
 * Same-repository stale-read awareness for OMP agents. Reads and writes are
 * recorded only from observable tool events with explicit path fields —
 * never invented. When a write lands, every agent that read the old hash is
 * notified with a versioned conflict before its next write can proceed.
 * State persists in the durable ledger database, so known conflicts survive
 * OMP restarts.
 */
export class OmpWorkspaceObserver {
  private readonly store: WorkspaceConflictStore;
  private readonly agentId: string;
  private readonly taskId: string;
  private readonly workspaceRoot: string;
  private readonly onConflict:
    ((conflict: WorkspaceConflict) => void) | undefined;
  private writes = Promise.resolve();
  private readonly notified = new Set<string>();
  private readonly pendingPaths = new Map<string, string[]>();

  public constructor(options: OmpWorkspaceObserverOptions) {
    this.store = options.store;
    this.agentId = options.agentId;
    this.taskId = options.taskId;
    this.workspaceRoot = resolve(options.workspaceRoot);
    this.onConflict = options.onConflict;
  }

  /** Resolves when all read/write recording started so far has completed. */
  public flush(): Promise<void> {
    return this.writes;
  }

  public feed(frame: Record<string, unknown>): void {
    if (
      frame.type === "tool_execution_start" ||
      frame.type === "tool_execution_end"
    ) {
      this.handleToolFrame(frame);
    }
    this.pollConflicts();
  }

  /**
   * Emits this agent's unacknowledged conflicts once each. Called on every
   * feed; conflicts created by sibling writers are delivered here, so the
   * stale agent is alerted before its next write.
   */
  public pollConflicts(): void {
    for (const conflict of this.store.conflictsForAgent(
      this.agentId,
      this.taskId,
    )) {
      if (this.notified.has(conflict.conflictId)) continue;
      this.notified.add(conflict.conflictId);
      this.onConflict?.(conflict);
    }
  }

  private handleToolFrame(frame: Record<string, unknown>): void {
    const tool = firstString(frame.toolName, frame.name, frame.tool);
    const id = firstString(frame.id, frame.toolId, frame.callId);
    if (!tool) return;
    if (frame.type === "tool_execution_start") {
      const paths = pathsFromArgs(frame.args, this.workspaceRoot);
      if (id && writeTools.has(tool)) this.pendingPaths.set(id, paths);
      if (paths.length === 0) return;
      if (readTools.has(tool)) {
        for (const path of paths) {
          this.enqueue(this.recordRead(path));
        }
      } else if (writeTools.has(tool)) {
        // The write is about to happen; surface any blocking conflict first.
        for (const path of paths) {
          const conflict = this.store.pendingConflictForWrite(
            this.agentId,
            this.taskId,
            path,
          );
          if (conflict && !this.notified.has(conflict.conflictId)) {
            this.notified.add(conflict.conflictId);
            this.onConflict?.(conflict);
          }
        }
      }
      return;
    }
    if (writeTools.has(tool)) {
      // The end frame may omit args; use the paths captured at start.
      const paths =
        (id && this.pendingPaths.get(id)) ??
        pathsFromArgs(frame.args, this.workspaceRoot);
      if (id) this.pendingPaths.delete(id);
      const success = frame.success === true || frame.status === "success";
      for (const path of paths) {
        this.enqueue(this.recordWrite(path, success));
      }
    }
  }

  private enqueue(operation: Promise<void>): void {
    this.writes = this.writes.catch(() => undefined).then(() => operation);
  }

  /** Re-read: the agent has observed the current content of `path`. */
  public async recordRead(path: string): Promise<void> {
    const normalized = this.normalizePath(path);
    if (!normalized) return;
    const hash = await contentHash(
      resolve(this.workspaceRoot, normalized),
    ).catch(() => undefined);
    if (!hash) return;
    this.store.recordRead(this.agentId, this.taskId, normalized, hash);
  }

  /** A write landed: notify every other agent that read the old hash. */
  public async recordWrite(path: string, success: boolean): Promise<void> {
    if (!success) return;
    const normalized = this.normalizePath(path);
    if (!normalized) return;
    const hash = await contentHash(
      resolve(this.workspaceRoot, normalized),
    ).catch(() => undefined);
    if (!hash) return;
    const conflicts = this.store.onFileChanged(this.taskId, normalized, hash, {
      writerAgentId: this.agentId,
    });
    for (const conflict of conflicts) {
      // Conflicts are delivered to the affected (stale) agent, not the
      // writer; the affected agent's observer polls them on its next feed.
      if (conflict.affectedAgentId === this.agentId)
        this.onConflict?.(conflict);
    }
  }

  private normalizePath(path: string): string | undefined {
    const resolved = resolve(this.workspaceRoot, path);
    if (
      resolved !== this.workspaceRoot &&
      !resolved.startsWith(`${this.workspaceRoot}${sep}`)
    ) {
      return undefined; // Outside the workspace: not observable, not recorded.
    }
    const relativePath = relative(this.workspaceRoot, resolved);
    return relativePath.length > 0 ? relativePath : undefined;
  }
}

function pathsFromArgs(args: unknown, workspaceRoot: string): string[] {
  if (typeof args === "string") {
    // Command strings are not reliable path sources; do not invent reads.
    return [];
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) return [];
  const record = args as Record<string, unknown>;
  const candidates = [
    record.filePath,
    record.path,
    record.file,
    ...(Array.isArray(record.paths) ? (record.paths as unknown[]) : []),
  ];
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || candidate.length === 0) continue;
    const normalized = resolve(workspaceRoot, candidate);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    paths.push(candidate);
  }
  return paths;
}

async function contentHash(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

function firstString(...values: unknown[]): string | undefined {
  return values.find(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
}
