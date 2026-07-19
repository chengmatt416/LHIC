import { createHash } from "node:crypto";

import type {
  CandidateSkillRecord,
  CandidateRunEnvironment,
  CandidateRunProvenance,
  CandidateRunSource,
  SkillRecord,
  SkillStore,
} from "@lhic/memory";
import type {
  ActionExecutionResult,
  SemanticAction,
  VerificationResult,
} from "@lhic/schema";
import { hashState, redactPII } from "@lhic/trace";

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

export interface CandidateTrainingOptions {
  source?: CandidateRunSource;
  environment?: CandidateRunEnvironment;
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
    options: CandidateTrainingOptions = {},
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
      createCandidateRunProvenance(request, actions, outcomes, options),
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

export function createCandidateRunProvenance(
  request: SlowPathRequest,
  actions: readonly SemanticAction[],
  outcomes: readonly SlowPathActionOutcome[],
  options: CandidateTrainingOptions = {},
): CandidateRunProvenance {
  const origin = originForState(request.uiState.url);
  const safeUiState = redactPII({
    surface: request.uiState.surface,
    app: request.uiState.app,
    origin,
    title: request.uiState.title,
    screenType: request.uiState.screenType,
    objects: request.uiState.objects.map((object) => ({
      role: object.role,
      label: object.label,
      source: object.source,
      enabled: object.enabled,
    })),
  });
  return {
    source: options.source ?? "slow_path",
    environment: options.environment ?? "production",
    origin,
    uiFingerprint: hashState(safeUiState),
    traceSha256: hashState(
      redactPII({
        taskId: request.taskId,
        actions,
        outcomes: outcomes.map((outcome) => ({
          execution: outcome.execution.success,
          verification: outcome.verification,
        })),
      }),
    ),
    verifierVersion: "lhic-verifier-v1",
  };
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
  const constraintPaths = collectStringConstraintPaths(
    request.userIntent.constraints,
  );
  return {
    compiler: "slow-path-v1",
    goal: request.userIntent.goal,
    ...(request.userIntent.domain ? { domain: request.userIntent.domain } : {}),
    constraints: templateConstraints(request.userIntent.constraints),
    actions: actions.map((action) =>
      templateActionConstraints(action, constraintPaths),
    ),
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

function originForState(value: string | undefined): string {
  if (value) {
    try {
      return new URL(value).origin;
    } catch {
      // The exact page URL is never a requirement for candidate persistence.
    }
  }
  return "https://unknown.invalid";
}

function collectStringConstraintPaths(
  constraints: Record<string, unknown>,
): Map<string, string> {
  const values = new Map<string, string[]>();
  collectConstraintPaths(constraints, "", values);
  return new Map(
    [...values.entries()]
      .filter(([, paths]) => paths.length === 1)
      .map(([value, paths]) => [value, paths[0]!]),
  );
}

function collectConstraintPaths(
  value: unknown,
  prefix: string,
  values: Map<string, string[]>,
): void {
  if (typeof value === "string" && value.trim() && prefix) {
    values.set(value, [...(values.get(value) ?? []), prefix]);
    return;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return;
  }
  for (const [key, child] of Object.entries(value).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    collectConstraintPaths(child, prefix ? `${prefix}.${key}` : key, values);
  }
}

function templateActionConstraints(
  action: SemanticAction,
  constraintPaths: Map<string, string>,
): SemanticAction {
  if ("value" in action && typeof action.value === "string") {
    const path = constraintPaths.get(action.value);
    return path ? { ...action, value: `{{constraints.${path}}}` } : action;
  }
  if ("text" in action && typeof action.text === "string") {
    const path = constraintPaths.get(action.text);
    return path ? { ...action, text: `{{constraints.${path}}}` } : action;
  }
  return action;
}

function templateConstraints(
  constraints: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(constraints)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, templateConstraintValue(value, key)]),
  );
}

function templateConstraintValue(value: unknown, prefix: string): unknown {
  if (typeof value === "string") {
    return prefix === "operation" ? value : `{{constraints.${prefix}}}`;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return `{{constraints.${prefix}}}`;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      templateConstraintValue(item, `${prefix}.${index}`),
    );
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [
        key,
        templateConstraintValue(child, `${prefix}.${key}`),
      ]),
  );
}
