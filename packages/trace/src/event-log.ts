import { constants } from "node:fs";
import { lstat, mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import { isTraceEvent, type TraceEvent } from "@lhic/schema";

import { redactPII } from "./redact.js";

export async function appendTraceEvent(
  filePath: string,
  event: TraceEvent,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  await assertSafeTraceFile(filePath);
  const redactedEvent = redactPII(event);
  const file = await open(filePath, traceAppendFlags(), 0o600);
  try {
    const fileStats = await file.stat();
    if (!fileStats.isFile()) {
      throw new Error("Trace path must refer to a regular file.");
    }
    if (process.platform !== "win32") {
      await file.chmod(0o600);
    }
    await file.write(`${JSON.stringify(redactedEvent)}\n`);
  } finally {
    await file.close();
  }
}

export async function readTraceEvents(filePath: string): Promise<TraceEvent[]> {
  try {
    const content = await readFile(filePath, "utf8");
    return content
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as unknown)
      .filter(isTraceEvent);
  } catch (error: unknown) {
    if (
      typeof error === "object" &&
      error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return [];
    }
    throw error;
  }
}

async function assertSafeTraceFile(filePath: string): Promise<void> {
  try {
    const fileStats = await lstat(filePath);
    if (fileStats.isSymbolicLink()) {
      throw new Error("Trace paths must not be symbolic links.");
    }
    if (!fileStats.isFile()) {
      throw new Error("Trace path must refer to a regular file.");
    }
  } catch (error) {
    if (hasCode(error, "ENOENT")) {
      return;
    }
    throw error;
  }
}

function traceAppendFlags(): number {
  let flags = constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY;
  if (process.platform !== "win32") {
    flags |= constants.O_NOFOLLOW;
  }
  return flags;
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}
