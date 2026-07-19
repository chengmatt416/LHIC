import { realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, sep } from "node:path";

import type { VerificationResult } from "@lhic/schema";

export interface FileVerificationParams {
  filePath?: string;
  allowedRoot?: string;
  extension?: string;
  minSize?: number;
}

export async function verifyFile(
  params: FileVerificationParams,
): Promise<VerificationResult> {
  if (!params.filePath || !params.allowedRoot) {
    return {
      success: false,
      evidence: [],
      error: "File verification requires filePath and allowedRoot.",
    };
  }
  try {
    const [resolvedFilePath, resolvedRoot] = await Promise.all([
      resolveRealPath(params.filePath),
      resolveRealPath(params.allowedRoot),
    ]);
    const relativePath = relative(resolvedRoot, resolvedFilePath);
    if (
      !relativePath ||
      relativePath === ".." ||
      relativePath.startsWith(`..${sep}`) ||
      isAbsolute(relativePath)
    ) {
      return {
        success: false,
        evidence: [],
        error: "File verification target is outside the allowed root.",
      };
    }

    const fileStats = await stat(resolvedFilePath);
    if (!fileStats.isFile()) {
      return {
        success: false,
        evidence: [],
        error: "File verification target is not a regular file.",
      };
    }
    const evidence = [
      `File exists within allowed root: ${relativePath}`,
      `size=${fileStats.size}`,
    ];
    if (params.extension) {
      const expected = params.extension.startsWith(".")
        ? params.extension
        : `.${params.extension}`;
      if (extname(resolvedFilePath).toLowerCase() !== expected.toLowerCase()) {
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

async function resolveRealPath(path: string): Promise<string> {
  return realpath(path);
}
