import { chmod, mkdir } from "node:fs/promises";

/** Ensures local control-plane state is readable only by the current user. */
export async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  // mkdir's mode is ignored when the directory already exists. Re-apply it so
  // an older install cannot keep a world-readable .lhic directory forever.
  await chmod(path, 0o700);
}
