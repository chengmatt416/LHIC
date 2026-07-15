import { stat } from "node:fs/promises";
import { extname } from "node:path";

import type { VerificationResult } from "@lhic/schema";

export interface FileVerificationParams {
  filePath?: string;
  extension?: string;
  minSize?: number;
}

export async function verifyFile(
  params: FileVerificationParams,
): Promise<VerificationResult> {
  if (!params.filePath) {
    return {
      success: false,
      evidence: [],
      error: "File verification requires filePath.",
    };
  }
  try {
    const fileStats = await stat(params.filePath);
    const evidence = [
      `File exists: ${params.filePath}`,
      `size=${fileStats.size}`,
    ];
    if (params.extension) {
      const expected = params.extension.startsWith(".")
        ? params.extension
        : `.${params.extension}`;
      if (extname(params.filePath).toLowerCase() !== expected.toLowerCase()) {
        return {
          success: false,
          evidence,
          error: `File extension does not match ${expected}.`,
        };
      }
    }
    if (params.minSize !== undefined && fileStats.size < params.minSize) {
      return {
        success: false,
        evidence,
        error: `File is smaller than ${params.minSize} bytes.`,
      };
    }
    return { success: true, evidence };
  } catch (error) {
    return {
      success: false,
      evidence: [],
      error:
        error instanceof Error ? error.message : "File verification failed.",
    };
  }
}
