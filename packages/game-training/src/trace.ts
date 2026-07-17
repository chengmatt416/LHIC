import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { appendTraceEvent } from "@lhic/trace";

import { gameTrainingPaths } from "./paths.js";
import type { GameTraceMetadata } from "./types.js";

export async function appendGameTrainingTrace(
  root: string,
  metadata: GameTraceMetadata,
  type: string,
  payload: Record<string, unknown> = {},
): Promise<void> {
  const paths = gameTrainingPaths(metadata.core, root);
  await appendTraceEvent(
    join(paths.tracesRoot, `${metadata.sessionId}.jsonl`),
    {
      eventId: randomUUID(),
      taskId: metadata.sessionId,
      timestamp: new Date().toISOString(),
      type,
      payload: {
        core: metadata.core,
        profileId: metadata.profileId,
        surface: metadata.surface,
        ...payload,
      },
      riskLevel: "medium",
    },
  );
}
