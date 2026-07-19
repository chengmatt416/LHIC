import { waitForDownload } from "@lhic/browser";
import type { BrowserSemanticAction } from "@lhic/schema";
import {
  validateActionApproval,
  type ActionApproval,
  type ActionApprovalValidationOptions,
} from "@lhic/security";

import {
  createSkillTrace,
  skillFailure,
  type SkillContext,
  type SkillResult,
} from "./skill-types.js";

export interface DownloadFileInput {
  trigger: string;
  expectedExtension?: string;
  downloadDir?: string;
  approval?: ActionApproval;
  approvalValidation?: ActionApprovalValidationOptions;
}

export function createDownloadAction(trigger: string): BrowserSemanticAction {
  return {
    type: "download",
    intent: "download a requested file",
    target: trigger,
    methodPreference: ["dom", "accessibility"],
    riskLevel: "low",
  };
}

export async function downloadFile(
  context: SkillContext,
  input: DownloadFileInput,
): Promise<SkillResult> {
  const trace = createSkillTrace(context);
  await trace.emit("download_started", {
    expectedExtension: input.expectedExtension,
  });

  try {
    const approval = validateActionApproval(
      createDownloadAction(input.trigger),
      input.approval,
      new Date(),
      {
        ...input.approvalValidation,
        forceConfirmation: true,
        confirmationReason:
          "Downloads write a file to local storage and require human confirmation.",
      },
    );
    if (!approval.allowed) {
      await trace.emit("download_requires_human_approval", {
        reason: approval.reason,
      });
      return skillFailure(trace, approval.reason, true);
    }

    const download = await waitForDownload(context.page, input.trigger, {
      ...(input.downloadDir ? { downloadDir: input.downloadDir } : {}),
    });
    const verification = await context.verifier.verify({
      type: "file",
      description: "Downloaded file exists with expected size and extension.",
      params: {
        filePath: download.filePath,
        ...(input.expectedExtension
          ? { extension: input.expectedExtension }
          : {}),
        minSize: 1,
      },
    });
    if (!verification.success) {
      await trace.emit("download_verification_failed", {
        error: verification.error,
      });
      return skillFailure(
        trace,
        verification.error ?? "Downloaded file could not be verified.",
      );
    }

    await trace.emit("download_verified", {
      size: download.size,
      ...(input.expectedExtension
        ? { extension: input.expectedExtension }
        : {}),
    });
    return {
      success: true,
      evidence: verification.evidence,
      traces: trace.events,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Download failed.";
    await trace.emit("download_failed", { error: message });
    return skillFailure(trace, message);
  }
}
