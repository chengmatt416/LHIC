import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import { isTraceEvent, type TraceEvent } from "@lhic/schema";

import { redactPII } from "./redact.js";

export async function appendTraceEvent(
  filePath: string,
  event: TraceEvent,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const redactedEvent = redactPII(event);
  await appendFile(filePath, `${JSON.stringify(redactedEvent)}\n`, "utf8");
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
