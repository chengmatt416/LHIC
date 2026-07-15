import { readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

/**
 * Prunes trace files (.jsonl, .jpg, .png) older than maxAgeDays in the specified trace directory.
 */
export async function pruneTraces(
  traceDir: string,
  maxAgeDays: number,
): Promise<{ deletedCount: number; errors: string[] }> {
  let deletedCount = 0;
  const errors: string[] = [];
  const now = Date.now();
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;

  try {
    const entries = await readdir(traceDir, { withFileTypes: true });
    for (const entry of entries) {
      if (
        entry.isFile() &&
        (entry.name.endsWith(".jsonl") ||
          entry.name.endsWith(".jpg") ||
          entry.name.endsWith(".png"))
      ) {
        const filePath = join(traceDir, entry.name);
        try {
          const stats = await stat(filePath);
          if (now - stats.mtimeMs > maxAgeMs) {
            await unlink(filePath);
            deletedCount++;
          }
        } catch (error) {
          errors.push(
            error instanceof Error
              ? error.message
              : `Failed to stat or unlink ${entry.name}`,
          );
        }
      }
    }
  } catch (error) {
    errors.push(
      error instanceof Error
        ? error.message
        : `Failed to read directory ${traceDir}`,
    );
  }

  return { deletedCount, errors };
}
