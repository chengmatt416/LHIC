import {
  createSkillTrace,
  skillFailure,
  type SkillContext,
  type SkillResult,
} from "./skill-types.js";
import { waitForDownload } from "@lhic/browser";

export interface DownloadFileInput {
  trigger: string;
  expectedExtension?: string;
  downloadDir?: string;
}

export async function downloadFile(
  context: SkillContext,
  input: DownloadFileInput,
): Promise<SkillResult> {
  const trace = createSkillTrace(context);
  await trace.emit("download_started", {
    trigger: input.trigger,
    expectedExtension: input.expectedExtension,
  });

  try {
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
        filePath: download.filePath,
        error: verification.error,
      });
      return skillFailure(
        trace,
        verification.error ?? "Downloaded file could not be verified.",
      );
    }

    await trace.emit("download_verified", {
      filePath: download.filePath,
      size: download.size,
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
