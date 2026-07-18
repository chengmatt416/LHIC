import { randomUUID } from "node:crypto";

import type { StageRoute, TaskBudgetUsage } from "@lhic/schema";

import { appendTraceEvent } from "./event-log.js";

/** Records route selection without persisting model inputs, screenshots, or secrets. */
export async function appendStageRouteEvent(
  filePath: string,
  taskId: string,
  route: StageRoute,
  usage: TaskBudgetUsage,
): Promise<void> {
  await appendTraceEvent(filePath, {
    eventId: randomUUID(),
    taskId,
    timestamp: new Date().toISOString(),
    type: "stage_routed",
    payload: {
      stage: route.stage,
      path: route.path,
      reason: route.reason,
      confidence: route.confidence,
      profile: route.profile,
      remainingBudget: route.remainingBudget,
      usage,
      ...(route.fallbackFrom ? { fallbackFrom: route.fallbackFrom } : {}),
      ...(route.shadow ? { shadow: true } : {}),
    },
  });
}
