import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";

export interface DesktopScreenshotVerificationParams {
  /** Path to the screenshot file to verify. */
  filePath: string;
  /** Minimum file size in bytes (default: 1024). */
  minSize?: number;
  /** Maximum age in milliseconds (default: 30000 = 30s). */
  maxAgeMs?: number;
  /** Expected image dimensions (optional). */
  expectedWidth?: number;
  expectedHeight?: number;
}

export interface DesktopScreenshotVerificationResult {
  success: boolean;
  evidence: string[];
  error?: string;
  metadata?: {
    size: number;
    ageMs: number;
    format: string;
  };
}

/**
 * Verifies a desktop screenshot file exists, is recent, and meets size/format requirements.
 * This is the desktop equivalent of browser DOM verification — it proves what was on screen.
 */
export async function verifyDesktopScreenshot(
  params: DesktopScreenshotVerificationParams,
): Promise<DesktopScreenshotVerificationResult> {
  const evidence: string[] = [];

  try {
    const fileStat = await stat(params.filePath);

    // Check it's a file, not a directory
    if (!fileStat.isFile()) {
      return {
        success: false,
        evidence,
        error: "Screenshot path is not a file.",
      };
    }

    // Check minimum size
    const minSize = params.minSize ?? 1024;
    if (fileStat.size < minSize) {
      return {
        success: false,
        evidence: [`size=${fileStat.size}`],
        error: `Screenshot file is too small (${fileStat.size} bytes, minimum ${minSize}).`,
      };
    }
    evidence.push(`size=${fileStat.size}`);

    // Check age
    const ageMs = Date.now() - fileStat.mtimeMs;
    const maxAgeMs = params.maxAgeMs ?? 30_000;
    if (ageMs > maxAgeMs) {
      return {
        success: false,
        evidence: [...evidence, `age_ms=${Math.round(ageMs)}`],
        error: `Screenshot is too old (${Math.round(ageMs / 1000)}s, maximum ${Math.round(maxAgeMs / 1000)}s).`,
      };
    }
    evidence.push(`age_ms=${Math.round(ageMs)}`);

    // Check format
    const ext = extname(params.filePath).toLowerCase();
    const validFormats = [".png", ".jpg", ".jpeg", ".bmp", ".tiff", ".webp"];
    if (!validFormats.includes(ext)) {
      return {
        success: false,
        evidence,
        error: `Unsupported screenshot format: ${ext}. Expected: ${validFormats.join(", ")}`,
      };
    }
    evidence.push(`format=${ext.slice(1)}`);

    // Read file header to verify it's a valid image
    const header = await readFile(params.filePath, { encoding: undefined });
    const isValidImage = validateImageHeader(header);
    if (!isValidImage) {
      return {
        success: false,
        evidence,
        error: "File header is not a valid image format.",
      };
    }

    return {
      success: true,
      evidence: [
        `Desktop screenshot verified: ${basename(params.filePath)}`,
        ...evidence,
      ],
      metadata: {
        size: fileStat.size,
        ageMs,
        format: ext.slice(1),
      },
    };
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return {
        success: false,
        evidence,
        error: `Screenshot file not found: ${params.filePath}`,
      };
    }
    return {
      success: false,
      evidence,
      error: `Screenshot verification failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function validateImageHeader(buffer: Buffer): boolean {
  if (buffer.length < 8) return false;

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return true;
  }

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return true;
  }

  // BMP: 42 4D
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) {
    return true;
  }

  // WebP: RIFF....WEBP
  if (
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return true;
  }

  return false;
}

export interface DesktopAccessibilityNode {
  role: string;
  name?: string;
  description?: string;
  value?: string;
  enabled: boolean;
  focused: boolean;
  children: DesktopAccessibilityNode[];
  /** Platform-specific identifier. */
  platformId?: string;
  /** Bounding rectangle if available. */
  bounds?: { x: number; y: number; width: number; height: number };
}

export interface DesktopObservationResult {
  success: boolean;
  application: string;
  title?: string;
  tree?: DesktopAccessibilityNode[];
  /** Flat list of interactive elements for quick scanning. */
  interactiveElements?: Array<{
    role: string;
    name?: string;
    description?: string;
    enabled: boolean;
    platformId?: string;
  }>;
  evidence: string[];
  error?: string;
}
