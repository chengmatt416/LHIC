import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { createMemoryDatabase, SkillStore } from "@lhic/memory";
import type { BrowserExecutionPlan } from "@lhic/schema";
import { hashState, redactPII } from "@lhic/trace";

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
      {
        source: "slow_path",
        environment: "production",
        origin: planOrigin(plan),
        uiFingerprint: hashState(
          redactPII(
            plan.steps.map((step) => ({
              type: step.action.type,
              target: step.action.target,
              verification: step.verification,
            })),
          ),
        ),
        traceSha256: hashState(
          redactPII({ taskId, plan, verifier: "desktop-browser-runner-v1" }),
        ),
        verifierVersion: "desktop-browser-runner-v1",
      },
    );
    return {
      name: candidate.name,
      verifiedRunCount: candidate.verifiedRunCount,
    };
  } finally {
    database.close();
  }
}

function planOrigin(plan: BrowserExecutionPlan): string {
  for (const step of plan.steps) {
    if (step.action.type !== "navigate" || !step.action.target) continue;
    try {
      return new URL(step.action.target).origin;
    } catch {
      // Continue searching for another explicit navigation target.
    }
  }
  return "https://unknown.invalid";
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
