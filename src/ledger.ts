import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { LedgerState, SideEffectLedgerEntry } from "./model.ts";

const allowedTransitions: Record<LedgerState, readonly LedgerState[]> = {
  proposed: ["approved", "possibly_committed", "failed", "needs_resolution"],
  approved: ["possibly_committed", "failed", "needs_resolution"],
  possibly_committed: ["executed", "verified", "needs_resolution", "failed"],
  executed: ["verified", "needs_resolution", "failed"],
  verified: [],
  failed: [],
  needs_resolution: ["executed", "verified", "rolled_back"],
  rolled_back: [],
};

interface LedgerFile {
  schemaVersion: "lhic-core-academic-ledger-v1";
  entries: SideEffectLedgerEntry[];
}

/**
 * Minimal persistent reference ledger.
 *
 * The product implementation uses SQLite. The academic artifact uses an
 * atomically replaced JSON file so the protocol is inspectable and has no
 * external database dependency.
 */
export class FileSideEffectLedger {
  private entries = new Map<string, SideEffectLedgerEntry>();
  private readonly file: string;

  public constructor(file: string) {
    this.file = file;
  }

  public async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8")) as LedgerFile;
      if (parsed.schemaVersion !== "lhic-core-academic-ledger-v1") {
        throw new Error("Unknown ledger schema version.");
      }
      this.entries = new Map(parsed.entries.map((entry) => [entry.actionId, entry]));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;
    }
  }

  public get(actionId: string): SideEffectLedgerEntry | undefined {
    const entry = this.entries.get(actionId);
    return entry ? structuredClone(entry) : undefined;
  }

  public list(): SideEffectLedgerEntry[] {
    return [...this.entries.values()].map((entry) => structuredClone(entry));
  }

  public async put(entry: SideEffectLedgerEntry): Promise<void> {
    if (this.entries.has(entry.actionId)) {
      throw new Error(`Duplicate action identity: ${entry.actionId}`);
    }
    this.entries.set(entry.actionId, structuredClone(entry));
    await this.persist();
  }

  public async transition(
    actionId: string,
    next: LedgerState,
    evidenceId?: string,
  ): Promise<SideEffectLedgerEntry> {
    const current = this.entries.get(actionId);
    if (!current) throw new Error(`Unknown action: ${actionId}`);
    if (!allowedTransitions[current.state].includes(next)) {
      throw new Error(`Invalid transition ${current.state} -> ${next}`);
    }

    const updated: SideEffectLedgerEntry = {
      ...current,
      state: next,
      evidenceIds: evidenceId
        ? [...new Set([...current.evidenceIds, evidenceId])]
        : current.evidenceIds,
      updatedAt: new Date().toISOString(),
    };
    this.entries.set(actionId, updated);
    await this.persist();
    return structuredClone(updated);
  }

  /** Ambiguous outcomes must be re-observed before replay. */
  public ambiguousForRecovery(): SideEffectLedgerEntry[] {
    return this.list().filter((entry) =>
      entry.state === "possibly_committed" || entry.state === "executed",
    );
  }

  public canDispatch(actionId: string): boolean {
    const state = this.entries.get(actionId)?.state;
    return state !== "verified" && state !== "possibly_committed" && state !== "executed";
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    const payload: LedgerFile = {
      schemaVersion: "lhic-core-academic-ledger-v1",
      entries: [...this.entries.values()],
    };
    await writeFile(tmp, JSON.stringify(payload, null, 2), "utf8");
    await rename(tmp, this.file);
  }
}
