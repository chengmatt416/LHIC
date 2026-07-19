import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readdir,
  readFile,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";

import type { ActionApproval } from "./action-approval.js";

export interface ApprovalReplayDecision {
  allowed: boolean;
  reason: string;
}

export interface ApprovalReplayStore {
  reserve(approval: ActionApproval): Promise<ApprovalReplayDecision>;
}

export interface FileApprovalReplayStoreOptions {
  now?: () => Date;
}

/**
 * Atomically records a consumed approval before dispatch. Markers contain only
 * a hash of the approval ID and are retained until the approval expires.
 */
export class FileApprovalReplayStore implements ApprovalReplayStore {
  private readonly now: () => Date;

  public constructor(
    private readonly directory: string,
    options: FileApprovalReplayStoreOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  public async reserve(
    approval: ActionApproval,
  ): Promise<ApprovalReplayDecision> {
    const expiresAt = Date.parse(approval.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= this.now().getTime()) {
      return {
        allowed: false,
        reason: "Action approval is expired and cannot be reserved.",
      };
    }
    if (!approval.approvalId.trim()) {
      return {
        allowed: false,
        reason: "Action approval is missing an approval ID.",
      };
    }

    try {
      await this.prepareDirectory();
      await this.pruneExpiredMarkers();
    } catch {
      return {
        allowed: false,
        reason: "Approval replay protection could not prepare its storage.",
      };
    }

    const approvalIdHash = hashApprovalId(approval.approvalId);
    let marker;
    try {
      marker = await open(
        join(this.directory, `${approvalIdHash}.json`),
        "wx",
        0o600,
      );
    } catch (error) {
      if (hasCode(error, "EEXIST")) {
        return {
          allowed: false,
          reason: "Action approval has already been used.",
        };
      }
      return {
        allowed: false,
        reason: "Approval replay protection could not reserve this approval.",
      };
    }

    try {
      if (process.platform !== "win32") {
        await marker.chmod(0o600);
      }
      await marker.writeFile(
        `${JSON.stringify({ approvalIdHash, actionHash: approval.actionHash, expiresAt: approval.expiresAt })}\n`,
        "utf8",
      );
      return {
        allowed: true,
        reason: "Action approval was reserved for one-time use.",
      };
    } catch {
      return {
        allowed: false,
        reason:
          "Approval replay protection could not persist this reservation.",
      };
    } finally {
      await marker.close();
    }
  }

  private async prepareDirectory(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") {
      await chmod(this.directory, 0o700);
    }
  }

  private async pruneExpiredMarkers(): Promise<void> {
    const entries = await readdir(this.directory, { withFileTypes: true });
    const now = this.now().getTime();
    await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map(async (entry) => {
          const filePath = join(this.directory, entry.name);
          try {
            const marker = JSON.parse(await readFile(filePath, "utf8")) as {
              expiresAt?: unknown;
            };
            const expiresAt =
              typeof marker.expiresAt === "string"
                ? Date.parse(marker.expiresAt)
                : Number.NaN;
            if (Number.isFinite(expiresAt) && expiresAt <= now) {
              await unlink(filePath);
            }
          } catch {
            // Preserve malformed markers: deleting them could re-enable a replay.
          }
        }),
    );
  }
}

function hashApprovalId(approvalId: string): string {
  return createHash("sha256").update(approvalId).digest("hex");
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}
