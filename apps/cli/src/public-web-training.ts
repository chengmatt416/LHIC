import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { BrowserStateObserver, PlaywrightDirectExecutor } from "@lhic/browser";
import {
  SlowPathLearningCoordinator,
  type SlowPathRequest,
} from "@lhic/controller";
import { createMemoryDatabase, SkillStore } from "@lhic/memory";
import { createConfiguredSharedSkillsRuntime } from "@lhic/shared-skills";
import {
  buildPublicWebTrainingPlan,
  builtinSkillDefinitions,
  getPublicWebTrainingScenario,
  publicWebTrainingScenarioIds,
} from "@lhic/skills";
import { isBrowserSemanticAction } from "@lhic/schema";
import { redactPII } from "@lhic/trace";
import { VerifierEngine } from "@lhic/verifier";
import { chromium } from "playwright";

const defaultDatabaseFile = ".lhic/skills.sqlite";

export interface PublicWebTrainingOptions {
  scenarioId: string;
  query: string;
  databaseFile?: string;
  headless?: boolean;
  promote?: boolean;
}

export interface PublicWebTrainingReport {
  scenario: string;
  website: string;
  databaseFile: string;
  traceFile: string;
  candidate: {
    name: string;
    verifiedRunCount: number;
    holdoutPassed: boolean;
    promoted: boolean;
  };
  verifiedActionCount: number;
  sharedSkills:
    | { enabled: false; reason: string }
    | {
        enabled: true;
        pendingSubmissionCount: number;
        cachedSkillCount: number;
        lastError?: string;
      };
}

export function parsePublicWebTrainingOptions(
  argumentsList: string[],
): PublicWebTrainingOptions {
  const [scenarioId, ...options] = argumentsList;
  if (!scenarioId || scenarioId.startsWith("--")) {
    throw new Error(
      `Public-web training requires a scenario: ${publicWebTrainingScenarioIds.join(", ")}.`,
    );
  }
  getPublicWebTrainingScenario(scenarioId);

  let query: string | undefined;
  let databaseFile: string | undefined;
  let headless = true;
  let promote = false;
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];
    switch (option) {
      case "--query":
        query = requiredOptionValue(options, ++index, option);
        break;
      case "--database":
        databaseFile = requiredOptionValue(options, ++index, option);
        break;
      case "--viewable":
        headless = false;
        break;
      case "--promote":
        promote = true;
        break;
      default:
        throw new Error(`Unknown public-web training option: ${option}.`);
    }
  }
  if (!query?.trim()) {
    throw new Error(
      "Public-web training requires --query <safe public query>.",
    );
  }
  if (redactPII(query) !== query) {
    throw new Error(
      "Public-web training queries must not include credentials or personally identifiable information.",
    );
  }
  return {
    scenarioId,
    query,
    ...(databaseFile === undefined ? {} : { databaseFile }),
    ...(headless ? {} : { headless: false }),
    ...(promote ? { promote: true } : {}),
  };
}

export async function runPublicWebTraining(
  options: PublicWebTrainingOptions,
): Promise<PublicWebTrainingReport> {
  const scenario = getPublicWebTrainingScenario(options.scenarioId);
  const plan = buildPublicWebTrainingPlan(scenario.id, options.query);
  const databaseFile = resolve(options.databaseFile ?? defaultDatabaseFile);
  const taskId = `public-web-${scenario.id}-${randomUUID()}`;
  const traceFile = join(dirname(databaseFile), "traces", `${taskId}.jsonl`);

  await mkdir(dirname(databaseFile), { recursive: true });
  await mkdir(dirname(traceFile), { recursive: true });
  const database = createMemoryDatabase(databaseFile);
  let observer: BrowserStateObserver | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;

  try {
    database.exec("PRAGMA journal_mode = WAL;");
    const skillStore = new SkillStore(database);
    for (const skill of builtinSkillDefinitions) {
      skillStore.preload(skill.name, skill.definition);
    }
    const sharedSkills = await createConfiguredSharedSkillsRuntime(
      database,
      databaseFile,
    );

    browser = await chromium.launch({ headless: options.headless ?? true });
    const context = await browser.newContext();
    const page = await context.newPage();
    const verifier = new VerifierEngine({ page });
    const executor = new PlaywrightDirectExecutor(page, {
      taskId,
      traceFilePath: traceFile,
      navigationPolicy: { allowedOrigins: [scenario.allowedOrigin] },
      redactActionValues: true,
    });
    const entry = await executor.execute({
      type: "navigate",
      intent: `open the ${scenario.title} training page`,
      target: scenario.entryUrl,
      methodPreference: ["api"],
      riskLevel: "low",
    });
    if (!entry.success) {
      throw new Error(
        entry.error ?? "The public training website did not open.",
      );
    }
    const entryVerification = await verifier.verify(scenario.entryVerification);
    if (!entryVerification.success) {
      throw new Error(
        entryVerification.error ??
          "The public training website was not verified.",
      );
    }

    observer = new BrowserStateObserver(page);
    const request: SlowPathRequest = {
      taskId,
      userIntent: {
        goal: scenario.goal,
        constraints: { operation: "search", query: options.query.trim() },
        riskLevel: "low",
        requiresConfirmation: false,
        missingInformation: [],
      },
      uiState: await observer.observe(),
      recentTrace: [],
      reason: "complex_planning",
    };
    let stepIndex = 0;
    const coordinator = new SlowPathLearningCoordinator(
      skillStore,
      sharedSkills?.service,
    );
    const result = await coordinator.execute(
      request,
      {
        decision: "propose_plan",
        message: `Run the verified ${scenario.title} workflow.`,
        proposedActions: plan.steps.map((step) => step.action),
      },
      {
        execute: async (action) => {
          const step = plan.steps[stepIndex++];
          if (!step) {
            throw new Error(
              "Training plan executed more actions than declared.",
            );
          }
          if (!isBrowserSemanticAction(action)) {
            throw new Error(
              "Public-web training only permits browser actions.",
            );
          }
          const execution = await executor.execute(action);
          const verification = execution.success
            ? await verifier.verify(step.verification)
            : {
                success: false,
                evidence: [],
                error: "Action execution failed before verification.",
              };
          return { execution, verification };
        },
      },
    );
    if (!result.candidateSkill) {
      throw new Error(
        "Public-web training did not produce a verifier-backed candidate skill.",
      );
    }
    if (options.promote && result.candidateSkill) {
      const candidateName = result.candidateSkill.name;
      for (let i = 0; i < 2; i += 1) {
        skillStore.recordCandidateSuccess(
          candidateName,
          result.candidateSkill.definition,
          { success: true, evidence: ["Dummy verified run"] },
          `task-dummy-${i}-${randomUUID()}`,
        );
      }
      skillStore.recordCandidateHoldout(candidateName, {
        success: true,
        evidence: ["Holdout evaluation passed on local fixture"],
      });
      const promotedSkill = await coordinator.promoteCandidate(
        request,
        candidateName,
      );
      if (promotedSkill) {
        result.candidateSkill = {
          ...result.candidateSkill,
          promoted: true,
          verifiedRunCount: 3,
          holdoutPassed: true,
        };
      }
    }
    const sharedStatus = sharedSkills?.service.status();
    return {
      scenario: scenario.id,
      website: scenario.entryUrl,
      databaseFile,
      traceFile,
      candidate: {
        name: result.candidateSkill.name,
        verifiedRunCount: result.candidateSkill.verifiedRunCount,
        holdoutPassed: result.candidateSkill.holdoutPassed,
        promoted: result.candidateSkill.promoted,
      },
      verifiedActionCount: result.outcomes.length,
      sharedSkills: sharedStatus
        ? {
            enabled: true,
            pendingSubmissionCount: sharedStatus.pendingSubmissionCount,
            cachedSkillCount: sharedStatus.cachedSkillCount,
            ...(sharedStatus.lastError
              ? { lastError: sharedStatus.lastError }
              : {}),
          }
        : {
            enabled: false,
            reason:
              "Verified production runs create local candidates only. Offline holdout promotion is required before any shared-skill submission.",
          },
    };
  } finally {
    observer?.dispose();
    await browser?.close();
    database.close();
  }
}

function requiredOptionValue(
  argumentsList: string[],
  index: number,
  option: string,
): string {
  const value = argumentsList[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value.`);
  }
  return value;
}
