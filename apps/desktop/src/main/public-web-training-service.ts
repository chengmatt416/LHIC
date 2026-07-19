import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { BrowserStateObserver, PlaywrightDirectExecutor } from "@lhic/browser";
import {
  SlowPathLearningCoordinator,
  type SlowPathRequest,
} from "@lhic/controller";
import { createMemoryDatabase, SkillStore } from "@lhic/memory";
import { isBrowserSemanticAction } from "@lhic/schema";
import { createConfiguredSharedSkillsRuntime } from "@lhic/shared-skills";
import {
  buildPublicWebTrainingPlan,
  builtinSkillDefinitions,
  getPublicWebTrainingScenario,
  publicWebTrainingScenarioIds,
} from "@lhic/skills";
import { redactPII } from "@lhic/trace";
import { VerifierEngine } from "@lhic/verifier";
import { chromium, type Browser } from "playwright";

import type {
  PublicWebTrainingRequest,
  TrainingJob,
} from "../shared/contracts.js";

interface PublicWebTrainingServiceOptions {
  run?: (
    jobId: string,
    input: PublicWebTrainingRequest,
    signal: AbortSignal,
  ) => Promise<Record<string, unknown>>;
}

/**
 * Runs allowlisted, read-only public-web Skill training in the desktop main
 * process. No LLM or MCP endpoint participates in this workflow.
 */
export class PublicWebTrainingService {
  private readonly jobs = new Map<string, TrainingJob>();
  private readonly cancellations = new Map<string, AbortController>();
  private readonly browsers = new Map<string, Browser>();
  private readonly listeners = new Set<(job: TrainingJob) => void>();
  private readonly runWorkflow: NonNullable<
    PublicWebTrainingServiceOptions["run"]
  >;

  public constructor(
    private readonly workspaceRoot: string,
    options: PublicWebTrainingServiceOptions = {},
  ) {
    this.runWorkflow =
      options.run ?? ((jobId, input, signal) => this.run(jobId, input, signal));
  }

  public async start(input: PublicWebTrainingRequest): Promise<TrainingJob> {
    const normalized = validatePublicWebTrainingRequest(input);
    const id = randomUUID();
    const cancellation = new AbortController();
    const job: TrainingJob = {
      id,
      kind: "public-web",
      status: "running",
      startedAt: new Date().toISOString(),
      command: ["desktop", "skills", "train-public-web", normalized.scenarioId],
    };
    this.update(job);
    this.cancellations.set(id, cancellation);
    void this.runWorkflow(id, normalized, cancellation.signal).then(
      (report) => this.complete(id, report),
      (error) => this.fail(id, error),
    );
    return job;
  }

  public status(id: string): TrainingJob {
    const job = this.jobs.get(id);
    if (!job)
      throw new Error("The requested public-web training job does not exist.");
    return { ...job, command: [...job.command] };
  }

  public subscribe(listener: (job: TrainingJob) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async cancel(id: string): Promise<void> {
    const cancellation = this.cancellations.get(id);
    if (!cancellation) return;
    cancellation.abort();
    const job = this.jobs.get(id);
    if (job?.status === "running") {
      this.update({
        ...job,
        status: "cancelled",
        finishedAt: new Date().toISOString(),
      });
    }
    await this.browsers
      .get(id)
      ?.close()
      .catch(() => undefined);
  }

  private async run(
    jobId: string,
    input: PublicWebTrainingRequest,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const scenario = getPublicWebTrainingScenario(input.scenarioId);
    const plan = buildPublicWebTrainingPlan(scenario.id, input.query);
    const databaseFile = resolve(this.workspaceRoot, ".lhic/skills.sqlite");
    const traceFile = join(
      dirname(databaseFile),
      "traces",
      `public-web-${scenario.id}-${jobId}.jsonl`,
    );
    await mkdir(dirname(databaseFile), { recursive: true });
    await mkdir(dirname(traceFile), { recursive: true });
    const database = createMemoryDatabase(databaseFile);
    let observer: BrowserStateObserver | undefined;
    let browser: Browser | undefined;

    try {
      assertNotCancelled(signal);
      database.exec("PRAGMA journal_mode = WAL;");
      const skillStore = new SkillStore(database);
      for (const skill of builtinSkillDefinitions) {
        skillStore.preload(skill.name, skill.definition);
      }
      const sharedSkills = await createConfiguredSharedSkillsRuntime(
        database,
        databaseFile,
      );
      browser = await chromium.launch({ headless: !input.viewable });
      this.browsers.set(jobId, browser);
      const context = await browser.newContext();
      const page = await context.newPage();
      const verifier = new VerifierEngine({ page });
      const executor = new PlaywrightDirectExecutor(page, {
        taskId: `public-web-${scenario.id}-${jobId}`,
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
      const entryVerification = await verifier.verify(
        scenario.entryVerification,
      );
      if (!entryVerification.success) {
        throw new Error(
          entryVerification.error ??
            "The public training website was not verified.",
        );
      }

      observer = new BrowserStateObserver(page);
      const request: SlowPathRequest = {
        taskId: `public-web-${scenario.id}-${jobId}`,
        userIntent: {
          goal: scenario.goal,
          constraints: { operation: "search", query: input.query },
          riskLevel: "low",
          requiresConfirmation: false,
          missingInformation: [],
        },
        uiState: await observer.observe(),
        recentTrace: [],
        reason: "complex_planning",
      };
      let stepIndex = 0;
      const result = await new SlowPathLearningCoordinator(
        skillStore,
        sharedSkills?.service,
      ).execute(
        request,
        {
          decision: "propose_plan",
          message: `Run the verified ${scenario.title} workflow.`,
          proposedActions: plan.steps.map((step) => step.action),
        },
        {
          execute: async (action) => {
            assertNotCancelled(signal);
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
            assertNotCancelled(signal);
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
        { source: "public_web", environment: "public_read_only" },
      );
      if (!result.candidateSkill) {
        throw new Error(
          "Training did not produce a verifier-backed candidate Skill.",
        );
      }
      return {
        scenario: scenario.id,
        candidate: result.candidateSkill.name,
        verifiedRunCount: result.candidateSkill.verifiedRunCount,
        holdoutPassed: result.candidateSkill.holdoutPassed,
        promoted: result.candidateSkill.promoted,
        verifiedActionCount: result.outcomes.length,
        trace: traceFile,
        sharedLibraryConfigured: sharedSkills !== undefined,
        localOnly: true,
      };
    } finally {
      this.browsers.delete(jobId);
      observer?.dispose();
      await browser?.close().catch(() => undefined);
      database.close();
    }
  }

  private complete(id: string, report: Record<string, unknown>): void {
    this.cancellations.delete(id);
    const job = this.jobs.get(id);
    if (!job || job.status === "cancelled") return;
    this.update({
      ...job,
      status: "completed",
      finishedAt: new Date().toISOString(),
      report,
    });
  }

  private fail(id: string, error: unknown): void {
    this.cancellations.delete(id);
    const job = this.jobs.get(id);
    if (!job || job.status === "cancelled") return;
    this.update({
      ...job,
      status: "failed",
      finishedAt: new Date().toISOString(),
      report: {
        error: safeError(
          error instanceof Error ? error.message : String(error),
        ),
      },
    });
  }

  private update(job: TrainingJob): void {
    const snapshot: TrainingJob = {
      ...job,
      command: [...job.command],
      ...(job.report ? { report: { ...job.report } } : {}),
    };
    this.jobs.set(job.id, snapshot);
    for (const listener of this.listeners) listener(snapshot);
  }
}

export function validatePublicWebTrainingRequest(
  input: PublicWebTrainingRequest,
): PublicWebTrainingRequest {
  if (!publicWebTrainingScenarioIds.includes(input.scenarioId as never)) {
    throw new Error("Public-web training scenario is unsupported.");
  }
  const query = input.query.trim();
  if (!query || query.length > 256) {
    throw new Error(
      "Public-web training requires a query of 1 to 256 characters.",
    );
  }
  if (redactPII(query) !== query) {
    throw new Error(
      "Public-web training queries must not contain credentials or personal data.",
    );
  }
  return {
    scenarioId: input.scenarioId,
    query,
    ...(input.viewable ? { viewable: true } : {}),
  };
}

function assertNotCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("Public-web training was cancelled.");
}

function safeError(value: string): string {
  return value
    .replace(
      /\b(?:sk|pk|tok|api)[_-][A-Za-z0-9_-]{12,}\b/gi,
      "[REDACTED_TOKEN]",
    )
    .slice(0, 1_000);
}
