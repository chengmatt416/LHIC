import { createHash } from "node:crypto";

import type {
  CandidateSkillRecord,
  CandidateRunEnvironment,
  CandidateRunSource,
  SkillRecord,
  SkillStore,
} from "@lhic/memory";
import type { BrowserExecutionPlan, NormalizedUIState } from "@lhic/schema";
import { hashState, redactPII } from "@lhic/trace";

import type { BrowserPlanStepOutcome } from "./browser-plan-runner.js";

const embeddingModel = "Xenova/all-MiniLM-L6-v2";
const safePressValues = new Set([
  "Enter",
  "Escape",
  "Tab",
  "ArrowDown",
  "ArrowUp",
  "ArrowLeft",
  "ArrowRight",
  "Space",
]);

export interface LocalEmbeddingEngine {
  embed(input: string): Promise<number[]>;
}

export interface DemoLearnedSkillDefinition extends Record<string, unknown> {
  compiler: "demo-learned-skill-v1";
  taskTemplate: string;
  origin: string;
  uiFingerprint: string;
  uiShape: string[];
  embedding: number[];
  plan: BrowserExecutionPlan;
}

export interface DemoSkillMatch {
  skill: SkillRecord;
  definition: DemoLearnedSkillDefinition;
  similarity: number;
  uiSimilarity: number;
}

export interface DemoLearningOptions {
  source?: Extract<CandidateRunSource, "interactive_demo" | "mcp_batch">;
  environment?: CandidateRunEnvironment;
}

/** Lazily downloads once, then uses a locally cached transformer model. */
export class TransformersEmbeddingEngine implements LocalEmbeddingEngine {
  private extractorPromise:
    Promise<(input: string) => Promise<number[]>> | undefined;

  public embed(input: string): Promise<number[]> {
    this.extractorPromise ??= this.createExtractor();
    return this.extractorPromise.then((extractor) => extractor(input));
  }

  private async createExtractor(): Promise<
    (input: string) => Promise<number[]>
  > {
    const transformers = await import("@huggingface/transformers");
    const extractor = await transformers.pipeline(
      "feature-extraction",
      embeddingModel,
      {
        dtype: "fp32",
      },
    );
    return async (input: string) => {
      const output = await extractor(input, {
        pooling: "mean",
        normalize: true,
      });
      return Array.from(output.data as Float32Array);
    };
  }
}

export async function learnDemoSkill(
  skillStore: SkillStore,
  embeddingEngine: LocalEmbeddingEngine,
  taskId: string,
  task: string,
  initialState: NormalizedUIState,
  plan: BrowserExecutionPlan,
  outcomes: readonly BrowserPlanStepOutcome[],
  options: DemoLearningOptions = {},
): Promise<CandidateSkillRecord> {
  if (
    outcomes.length !== plan.steps.length ||
    outcomes.some(
      (outcome) =>
        !outcome.execution.success ||
        !outcome.verification.success ||
        outcome.verification.evidence.length === 0,
    )
  ) {
    throw new Error(
      "Demo learning requires verified evidence for every plan step.",
    );
  }
  // Preserve semantic action intent for model context, but never the raw task
  // prompt that a user typed. The embedding retains similarity locally.
  const taskTemplate = plan.steps
    .map((step) => redactPII(step.action.intent))
    .join(" → ");
  const origin = getOrigin(initialState);
  const uiShape = shapeFor(initialState);
  const definition: DemoLearnedSkillDefinition = {
    compiler: "demo-learned-skill-v1",
    taskTemplate,
    origin,
    uiFingerprint: fingerprint(origin, uiShape),
    uiShape,
    embedding: await embeddingEngine.embed(redactPII(task)),
    plan: templatePlan(plan),
  };
  const name = `demo-${createHash("sha256")
    .update(`${origin}:${definition.uiFingerprint}:${taskTemplate}`)
    .digest("hex")
    .slice(0, 16)}`;
  return skillStore.recordCandidateSuccess(
    name,
    definition,
    {
      success: true,
      evidence: outcomes.flatMap((outcome) => outcome.verification.evidence),
    },
    taskId,
    {
      source: options.source ?? "interactive_demo",
      environment: options.environment ?? "allowlisted_sandbox",
      origin,
      uiFingerprint: definition.uiFingerprint,
      traceSha256: hashState(
        redactPII({
          taskId,
          plan: definition.plan,
          outcomes: outcomes.map((outcome) => ({
            stepId: outcome.stepId,
            execution: outcome.execution.success,
            verification: outcome.verification,
          })),
        }),
      ),
      verifierVersion: "lhic-verifier-v1",
    },
  );
}

export async function findSimilarDemoSkill(
  skillStore: SkillStore,
  embeddingEngine: LocalEmbeddingEngine,
  task: string,
  state: NormalizedUIState,
  options: { minimumSimilarity?: number; minimumUiSimilarity?: number } = {},
): Promise<DemoSkillMatch | undefined> {
  const taskEmbedding = await embeddingEngine.embed(redactPII(task));
  const origin = getOrigin(state);
  const uiShape = shapeFor(state);
  const minimumSimilarity = options.minimumSimilarity ?? 0.8;
  const minimumUiSimilarity = options.minimumUiSimilarity ?? 0.6;
  const matches = skillStore
    .list(1_000)
    .flatMap((skill) => {
      const definition = parseDemoDefinition(skill.definition);
      if (!definition || definition.origin !== origin) return [];
      const similarity = cosineSimilarity(taskEmbedding, definition.embedding);
      const uiSimilarity = jaccardSimilarity(uiShape, definition.uiShape);
      return [{ skill, definition, similarity, uiSimilarity }];
    })
    .filter(
      (match) =>
        match.similarity >= minimumSimilarity &&
        match.uiSimilarity >= minimumUiSimilarity,
    )
    .sort(
      (left, right) =>
        right.similarity - left.similarity ||
        right.uiSimilarity - left.uiSimilarity,
    );
  return matches[0];
}

export function toModelSafeUiState(
  state: NormalizedUIState,
): NormalizedUIState {
  const safe = redactPII(state);
  return {
    surface: safe.surface,
    ...(safe.url ? { url: safe.url } : {}),
    ...(safe.title ? { title: safe.title } : {}),
    objects: safe.objects.map((object) => {
      const safeObject = { ...object };
      delete safeObject.value;
      return safeObject;
    }),
    signals: {},
    capturedAt: safe.capturedAt,
  };
}

function templatePlan(plan: BrowserExecutionPlan): BrowserExecutionPlan {
  let variableIndex = 0;
  const requiredVariables = [...plan.requiredVariables];
  const variableNames = new Set(
    requiredVariables.map((variable) => variable.name),
  );
  return {
    ...plan,
    requiredVariables,
    steps: plan.steps.map((step) => {
      const value = step.action.value;
      const shouldTemplate =
        typeof value === "string" &&
        !safePressValues.has(value) &&
        (step.action.type === "fill" || step.action.type === "select");
      if (!shouldTemplate) {
        return { ...step, action: { ...step.action } };
      }
      let name: string;
      do {
        variableIndex += 1;
        name = `input-${variableIndex}`;
      } while (variableNames.has(name));
      variableNames.add(name);
      requiredVariables.push({
        name,
        prompt: `Provide the value for ${redactPII(step.action.intent)}.`,
      });
      return {
        ...step,
        action: { ...step.action, value: `{{variables.${name}}}` },
      };
    }),
  };
}

function parseDemoDefinition(
  value: Record<string, unknown>,
): DemoLearnedSkillDefinition | undefined {
  if (
    value.compiler !== "demo-learned-skill-v1" ||
    typeof value.taskTemplate !== "string" ||
    typeof value.origin !== "string" ||
    typeof value.uiFingerprint !== "string" ||
    !Array.isArray(value.uiShape) ||
    !value.uiShape.every((item) => typeof item === "string") ||
    !Array.isArray(value.embedding) ||
    !value.embedding.every((item) => typeof item === "number") ||
    !value.plan ||
    typeof value.plan !== "object"
  )
    return undefined;
  return value as DemoLearnedSkillDefinition;
}

function getOrigin(state: NormalizedUIState): string {
  if (!state.url) throw new Error("Demo learning requires a browser URL.");
  return new URL(state.url).origin;
}

function shapeFor(state: NormalizedUIState): string[] {
  return state.objects
    .map(
      (object) =>
        `${object.role ?? "unknown"}:${redactPII(object.label ?? "")}:${object.enabled ?? true}`,
    )
    .sort();
}

function fingerprint(origin: string, shape: readonly string[]): string {
  return createHash("sha256")
    .update(JSON.stringify({ origin, shape }))
    .digest("hex");
}

function cosineSimilarity(
  left: readonly number[],
  right: readonly number[],
): number {
  if (left.length === 0 || left.length !== right.length) return -1;
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index]!;
    const rightValue = right[index]!;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }
  return leftMagnitude && rightMagnitude
    ? dot / Math.sqrt(leftMagnitude * rightMagnitude)
    : -1;
}

function jaccardSimilarity(
  left: readonly string[],
  right: readonly string[],
): number {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  const union = new Set([...leftSet, ...rightSet]);
  if (union.size === 0) return 1;
  let intersection = 0;
  for (const item of leftSet) if (rightSet.has(item)) intersection += 1;
  return intersection / union.size;
}
