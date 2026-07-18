import { createHash } from "node:crypto";

import type {
  CandidateSkillRecord,
  SkillRecord,
  SkillStore,
} from "@lhic/memory";
import type {
  ActionExecutionResult,
  SemanticAction,
  VerificationResult,
} from "@lhic/schema";

import type { SlowPathRequest, SlowPathResponse } from "./slow-path.js";
import {
  createSharedSkillPublication,
  type SharedSkillPublisher,
} from "./shared-skills.js";

export interface SlowPathActionOutcome {
  execution: ActionExecutionResult;
  verification: VerificationResult;
}

export interface SlowPathActionExecutor {
  execute(action: SemanticAction): Promise<SlowPathActionOutcome>;
}

export interface SlowPathLearningResult {
  response: SlowPathResponse;
  outcomes: SlowPathActionOutcome[];
  candidateSkill?: CandidateSkillRecord;
  learnedSkill?: SkillRecord;
}

export interface CompiledSlowPathSkill extends Record<string, unknown> {
  compiler: "slow-path-v1";
  goal: string;
  domain?: string;
  constraints: Record<string, unknown>;
  actions: SemanticAction[];
  verification: Array<{
    actionIndex: number;
    actionType: SemanticAction["type"];
    evidence: string[];
  }>;
}

export class SlowPathLearningCoordinator {
  public constructor(
    private readonly skillStore: SkillStore,
    private readonly sharedSkillPublisher?: SharedSkillPublisher,
  ) {}

  public async execute(
    request: SlowPathRequest,
    response: SlowPathResponse,
    executor: SlowPathActionExecutor,
  ): Promise<SlowPathLearningResult> {
    const actions = response.proposedActions ?? [];
    if (
      (response.decision !== "propose_plan" &&
        response.decision !== "retry_with_action") ||
      actions.length === 0
    ) {
      return { response, outcomes: [] };
    }

    const outcomes: SlowPathActionOutcome[] = [];
    for (const action of actions) {
      const outcome = await executor.execute(action);
      outcomes.push(outcome);
      if (!isVerifiedSuccess(outcome)) {
        return { response, outcomes };
      }
    }

    const definition = compileSlowPathSkill(request, actions, outcomes);
    const candidateSkill = this.skillStore.recordCandidateSuccess(
      createSlowPathSkillName(actions),
      definition,
      {
        success: true,
        evidence: outcomes.flatMap((outcome) => outcome.verification.evidence),
      },
      request.taskId,
    );
    return { response, outcomes, candidateSkill };
  }

  /**
   * Promotion is deliberately separate from production execution. Call this
   * only after an offline holdout evaluator recorded its evidence.
   */
  public async promoteCandidate(
    request: SlowPathRequest,
    name: string,
  ): Promise<SkillRecord | undefined> {
    const learnedSkill = this.skillStore.promoteCandidate(name);
    if (!learnedSkill) {
      return undefined;
    }
    const publication = createSharedSkillPublication(request, learnedSkill);
    if (publication && this.sharedSkillPublisher) {
      try {
        await this.sharedSkillPublisher.publish(publication);
      } catch {
        // Remote sharing must never turn a local Fast Path promotion into a failure.
      }
    }
    return learnedSkill;
  }
}

export function compileSlowPathSkill(
  request: SlowPathRequest,
  actions: SemanticAction[],
  outcomes: SlowPathActionOutcome[],
): CompiledSlowPathSkill {
  if (
    actions.length === 0 ||
    actions.length !== outcomes.length ||
    outcomes.some((outcome) => !isVerifiedSuccess(outcome))
  ) {
    throw new Error(
      "Slow Path skills require successful execution and verifier evidence for every action.",
    );
  }
  return {
    compiler: "slow-path-v1",
    goal: request.userIntent.goal,
    ...(request.userIntent.domain ? { domain: request.userIntent.domain } : {}),
    constraints: request.userIntent.constraints,
    actions,
    verification: outcomes.map((outcome, actionIndex) => ({
      actionIndex,
      actionType: actions[actionIndex]!.type,
      evidence: outcome.verification.evidence,
    })),
  };
}

function createSlowPathSkillName(actions: SemanticAction[]): string {
  const signature = actions.map((action) => ({
    type: action.type,
    intent: action.intent,
    target: action.target,
    methodPreference: action.methodPreference,
    riskLevel: action.riskLevel,
  }));
  const digest = createHash("sha256")
    .update(JSON.stringify(signature))
    .digest("hex")
    .slice(0, 16);
  return `slow-path-${digest}`;
}

function isVerifiedSuccess(outcome: SlowPathActionOutcome): boolean {
  return (
    outcome.execution.success &&
    outcome.verification.success &&
    outcome.verification.evidence.length > 0
  );
}
