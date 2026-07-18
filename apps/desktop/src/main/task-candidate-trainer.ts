import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { createMemoryDatabase, SkillStore } from "@lhic/memory";
import type { BrowserExecutionPlan } from "@lhic/schema";

/**
 * Records only a verified, local Slow Path browser plan as a candidate. A
 * candidate is not executable on the Fast Path until its existing independent
 * run and offline-holdout promotion gates have passed.
 */
export async function recordTaskCandidate(
  workspaceRoot: string,
  taskId: string,
  plan: BrowserExecutionPlan,
): Promise<{ name: string; verifiedRunCount: number }> {
  const databaseFile = resolve(workspaceRoot, ".lhic/skills.sqlite");
  await mkdir(dirname(databaseFile), { recursive: true });
  const database = createMemoryDatabase(databaseFile);
  try {
    const store = new SkillStore(database);
    const name = candidateName(plan);
    const candidate = store.recordCandidateSuccess(
      name,
      {
        compiler: "desktop-slow-path-browser-v1",
        plan,
        trainingBoundary:
          "Created from local verifier success; no provider receives execution data.",
      },
      {
        success: true,
        evidence: ["Local browser verifier completed every planned step."],
      },
      taskId,
    );
    return {
      name: candidate.name,
      verifiedRunCount: candidate.verifiedRunCount,
    };
  } finally {
    database.close();
  }
}

function candidateName(plan: BrowserExecutionPlan): string {
  const signature = plan.steps.map((step) => ({
    type: step.action.type,
    intent: step.action.intent,
    target: step.action.target,
    methodPreference: step.action.methodPreference,
    riskLevel: step.action.riskLevel,
  }));
  const digest = createHash("sha256")
    .update(JSON.stringify(signature))
    .digest("hex")
    .slice(0, 16);
  return `desktop-slow-path-${digest}`;
}
