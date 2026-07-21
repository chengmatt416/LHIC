import { randomUUID } from "node:crypto";

import {
  isBrowserExecutionPlan,
  isDesktopExecutionPlan,
  isExecutionProfile,
} from "@lhic/schema";
import { TaskBudgetTracker } from "@lhic/controller";

import type {
  CommandEvent,
  TaskApproval,
  TaskSourceConfig,
  TaskSourceKind,
} from "../shared/contracts.js";
import { taskSourceKinds } from "../shared/contracts.js";
import { validateTaskSourceConfig } from "../shared/policy.js";
import {
  DesktopBrowserRunner,
  summarizePlan,
  type BrowserReadiness,
  type BrowserRunResult,
} from "./desktop-browser-runner.js";
import {
  DesktopGlobalRunner,
  summarizeDesktopPlan,
  type GlobalRunResult,
} from "./desktop-global-runner.js";
import { compileLocalFastPath } from "./fast-path-planner.js";
import type { DesktopCredentialStore } from "./keyring.js";
import {
  TaskSourceAdapter,
  type TaskExecutionPlan,
} from "./task-source-adapter.js";
import { recordTaskCandidate } from "./task-candidate-trainer.js";
import { TaskJournalStore } from "./task-journal-store.js";
import { TaskSourceStore } from "./task-source-store.js";

interface PendingTask {
  goal: string;
  startUrl?: string;
  source?: TaskSourceConfig;
  phase: "source" | "execution";
  plan?: TaskExecutionPlan;
  budget?: TaskBudgetTracker;
  providerAbort?: AbortController | undefined;
}

interface TaskServiceOptions {
  sourceStore?: Pick<TaskSourceStore, "load" | "save">;
  journalStore?: Pick<TaskJournalStore, "load" | "save">;
  sourceBudget?: () => TaskBudgetTracker;
}

/**
 * Coordinates task admission. It intentionally never invokes a model from the
 * Fast Path: non-deterministic sources are recorded as Slow Path proposals and
 * require an approval before a browser executor can be admitted.
 */
export class TaskService {
  private readonly events = new Map<string, CommandEvent>();
  private readonly listeners = new Set<(event: CommandEvent) => void>();
  private readonly sources = new Map<string, TaskSourceConfig>();
  private readonly pending = new Map<string, PendingTask>();
  private readonly sourcesAdapter: TaskSourceAdapter;
  private readonly browserRunner: DesktopBrowserRunner;
  private readonly globalRunner: DesktopGlobalRunner;
  private readonly sourceStore: Pick<TaskSourceStore, "load" | "save">;
  private readonly journalStore: Pick<TaskJournalStore, "load" | "save">;
  private readonly sourceBudgetOverride: (() => TaskBudgetTracker) | undefined;
  private persistence: Promise<void> = Promise.resolve();
  private slowPathProfile: "fast_only" | "balanced" | "deliberative" =
    "balanced";
  private initialization: Promise<void> | undefined;

  public constructor(
    private readonly workspaceRoot: string,
    credentials: DesktopCredentialStore,
    sourcesAdapter?: TaskSourceAdapter,
    options: TaskServiceOptions = {},
  ) {
    this.sourcesAdapter =
      sourcesAdapter ??
      new TaskSourceAdapter({ credentialFor: (id) => credentials.get(id) });
    this.browserRunner = new DesktopBrowserRunner(workspaceRoot);
    this.globalRunner = new DesktopGlobalRunner(workspaceRoot);
    this.sourceStore =
      options.sourceStore ?? new TaskSourceStore(workspaceRoot);
    this.journalStore =
      options.journalStore ?? new TaskJournalStore(workspaceRoot);
    this.sourceBudgetOverride = options.sourceBudget;
    for (const kind of taskSourceKinds) {
      const source = defaultSource(kind);
      this.sources.set(source.id, source);
    }
  }

  public listSources(): TaskSourceConfig[] {
    return [...this.sources.values()].map((source) => ({ ...source }));
  }

  public setSlowPathProfile(
    profile: "fast_only" | "balanced" | "deliberative",
  ): void {
    if (!isExecutionProfile(profile)) {
      throw new Error("Slow Path safety profile is unsupported.");
    }
    this.slowPathProfile = profile;
  }

  public async initialize(): Promise<void> {
    this.initialization ??= Promise.all([
      this.loadConfiguredSources(),
      this.loadJournal(),
    ]).then(() => undefined);
    return this.initialization;
  }

  public async configure(source: TaskSourceConfig): Promise<TaskSourceConfig> {
    await this.initialize();
    const validated = validateTaskSourceConfig(source);
    this.sources.set(validated.id, validated);
    await this.sourceStore.save(this.listSources());
    return { ...validated };
  }

  public async autoConfigureSources(): Promise<TaskSourceConfig[]> {
    await this.initialize();
    const detected = await this.sourcesAdapter.discoverCliSources(
      this.workspaceRoot,
    );
    for (const source of detected) {
      const current = this.sources.get(source.id);
      if (!current?.enabled) this.sources.set(source.id, source);
    }
    await this.sourceStore.save(this.listSources());
    return this.listSources();
  }

  public async start(input: {
    goal: string;
    startUrl?: string;
    sourceId?: string;
    fastOnly?: boolean;
  }): Promise<CommandEvent> {
    await this.initialize();
    if (!input.goal.trim() || input.goal.length > 12_000) {
      throw new Error(
        "A task goal between 1 and 12000 characters is required.",
      );
    }
    const startUrl = normalizeStartUrl(input.startUrl);
    const normalizedInput = {
      ...input,
      ...(startUrl ? { startUrl } : {}),
    };
    const plan = compileLocalFastPath(normalizedInput);
    if (plan) {
      const event: CommandEvent = {
        commandId: randomUUID(),
        status: "proposed",
        message:
          "A deterministic local Fast Path was compiled. It has not executed; start the browser session to continue through the normal approval and verifier gates.",
        createdAt: new Date().toISOString(),
        evidence: [
          "Fast Path compiled locally with zero LLM calls and zero MCP calls.",
          `Compiled ${plan.steps.length} browser steps with verifier conditions.`,
        ],
        proposal: summarizePlan(plan),
      };
      this.update(event);
      this.pending.set(event.commandId, {
        goal: input.goal,
        phase: "execution",
        plan,
      });
      this.queuePersist();
      return event;
    }
    if (input.fastOnly) {
      const event: CommandEvent = {
        commandId: randomUUID(),
        status: "blocked",
        message:
          "Fast Path stopped because no matching deterministic local Skill was available. Slow Path fallback is disabled for this run.",
        createdAt: new Date().toISOString(),
        evidence: [
          "Fast-only admission made zero LLM calls and zero MCP calls.",
          "No provider approval request was created.",
        ],
      };
      this.update(event);
      return event;
    }
    const source = input.sourceId
      ? this.sources.get(input.sourceId)
      : this.automaticSource();
    if (!source?.enabled) {
      const event: CommandEvent = {
        commandId: randomUUID(),
        status: "blocked",
        message:
          "No deterministic local Skill matched this task, and no configured Slow Path source is available.",
        createdAt: new Date().toISOString(),
        evidence: ["No LLM or MCP call was made on the Fast Path."],
      };
      this.update(event);
      return event;
    }
    const commandId = randomUUID();
    const event: CommandEvent = {
      commandId,
      status: "awaiting_approval",
      message: `${source.label} may receive the task description to produce one guarded task-plan proposal. Approve this provider request to continue.`,
      createdAt: new Date().toISOString(),
      evidence: [
        "Slow Path sources do not receive browser, MCP, or OS control handles.",
        "Any returned plan is schema-validated before an execution approval can be requested.",
      ],
    };
    this.update(event);
    this.pending.set(commandId, {
      goal: input.goal,
      ...(startUrl ? { startUrl } : {}),
      source,
      phase: "source",
      budget: this.createSourceBudget(),
    });
    this.queuePersist();
    return event;
  }

  public async approve(
    commandId: string,
    approval?: TaskApproval,
  ): Promise<CommandEvent> {
    const event = this.require(commandId);
    const pending = this.pending.get(commandId);
    if (!pending) {
      throw new Error(
        "The task does not have an approval waiting to be recorded.",
      );
    }
    if (pending.phase === "execution") {
      const plan = pending.plan;
      if (!plan) {
        throw new Error("The task execution plan is unavailable.");
      }
      if (event.status !== "awaiting_approval") {
        throw new Error(
          "The task is not waiting for an execution action approval.",
        );
      }
      return isBrowserExecutionPlan(plan)
        ? this.recordBrowserResult(
            commandId,
            await this.browserRunner.approve(commandId, approval),
          )
        : this.recordGlobalResult(
            commandId,
            await this.globalRunner.approve(commandId, approval),
          );
    }
    if (event.status !== "awaiting_approval") {
      throw new Error("Only a pending provider approval may be accepted.");
    }
    const stage = pending.budget?.beginStage();
    const reservation = pending.budget?.reserveSlowPath(pending.goal.length);
    if (stage && !stage.allowed) {
      return this.blockForBudget(commandId, event, stage.reason);
    }
    if (reservation && !reservation.allowed) {
      return this.blockForBudget(commandId, event, reservation.reason);
    }
    this.update({
      ...event,
      status: "running",
      message: `${pending.source!.label} is preparing a guarded task-plan proposal.`,
      evidence: [...(event.evidence ?? []), "Provider request approved."],
    });
    try {
      const startedAt = performance.now();
      const providerAbort = new AbortController();
      pending.providerAbort = providerAbort;
      const plan = await this.sourcesAdapter.propose(
        pending.source!,
        pending.goal,
        this.workspaceRoot,
        {
          signal: providerAbort.signal,
          ...(pending.startUrl ? { startUrl: pending.startUrl } : {}),
        },
      );
      if (
        providerAbort.signal.aborted ||
        this.require(commandId).status === "cancelled"
      ) {
        return this.require(commandId);
      }
      pending.providerAbort = undefined;
      pending.budget?.recordSlowPathLatency(performance.now() - startedAt);
      const budgetEvidence = pending.budget
        ? `Slow Path budget remaining: ${pending.budget.snapshot().remaining.maxSlowPathCalls} provider call(s), ${pending.budget.snapshot().remaining.maxSlowPathInputChars} input characters.`
        : undefined;
      const proposed: CommandEvent = {
        ...event,
        status: "proposed",
        message: isBrowserExecutionPlan(plan)
          ? "The proposal satisfies browser-plan-v1 validation. It has not executed; review and approve each required action in the browser executor."
          : "The proposal satisfies desktop-plan-v1 validation. It has not executed; each OS action needs a matching approval and local verifier.",
        createdAt: new Date().toISOString(),
        evidence: [
          ...(event.evidence ?? []),
          "Provider request approved.",
          `Schema validation accepted ${plan.steps.length} ${isBrowserExecutionPlan(plan) ? "browser" : "desktop"} steps with verifier conditions.`,
          "No browser or OS action was performed while creating the proposal.",
          ...(budgetEvidence ? [budgetEvidence] : []),
        ],
        proposal: summarizeTaskPlan(plan),
      };
      this.pending.set(commandId, { ...pending, phase: "execution", plan });
      this.update(proposed);
      this.queuePersist();
      return proposed;
    } catch (error) {
      if (
        pending.providerAbort?.signal.aborted ||
        this.require(commandId).status === "cancelled"
      ) {
        return this.require(commandId);
      }
      pending.providerAbort = undefined;
      const failed: CommandEvent = {
        ...event,
        status: "failed",
        message: safeError(error),
        createdAt: new Date().toISOString(),
        evidence: [...(event.evidence ?? []), "Provider request approved."],
      };
      this.update(failed);
      return failed;
    }
  }

  public async execute(commandId: string): Promise<CommandEvent> {
    const event = this.require(commandId);
    const pending = this.pending.get(commandId);
    if (!pending?.plan || pending.phase !== "execution") {
      throw new Error(
        "A validated browser-plan-v1 or desktop-plan-v1 proposal is required before execution.",
      );
    }
    if (event.status !== "proposed") {
      throw new Error(
        "Only an unexecuted proposal may start an execution session.",
      );
    }
    const plan = pending.plan;
    try {
      return isBrowserExecutionPlan(plan)
        ? this.recordBrowserResult(
            commandId,
            await this.browserRunner.execute(commandId, plan),
          )
        : this.recordGlobalResult(
            commandId,
            this.globalRunner.execute(commandId, plan),
          );
    } catch (error) {
      // Cancellation owns the terminal state. A browser close or provider
      // teardown can reject an in-flight operation after cancel() has already
      // published the cancelled event; never let that rejection resurrect it.
      if (this.require(commandId).status === "cancelled") {
        return this.require(commandId);
      }
      throw error;
    }
  }

  public async cancel(commandId: string): Promise<void> {
    const event = this.require(commandId);
    const pending = this.pending.get(commandId);
    pending?.providerAbort?.abort();
    this.update({
      ...event,
      status: "cancelled",
      message: "Task cancelled before execution.",
    });
    this.pending.delete(commandId);
    await this.browserRunner.cancel(commandId);
    this.globalRunner.cancel(commandId);
    this.queuePersist();
    await this.persistence;
  }

  public recentEvents(limit = 8): CommandEvent[] {
    return [...this.events.values()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit);
  }

  public browserReadiness(): Promise<BrowserReadiness> {
    return this.browserRunner.readiness();
  }

  public subscribe(listener: (event: CommandEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private require(commandId: string): CommandEvent {
    const event = this.events.get(commandId);
    if (!event) throw new Error("The requested task does not exist.");
    return event;
  }

  private blockForBudget(
    commandId: string,
    event: CommandEvent,
    reason: string,
  ): CommandEvent {
    const blocked: CommandEvent = {
      ...event,
      status: "blocked",
      message: reason,
      createdAt: new Date().toISOString(),
      evidence: [...(event.evidence ?? []), "No provider request was sent."],
    };
    this.update(blocked);
    this.pending.delete(commandId);
    this.queuePersist();
    return blocked;
  }

  public close(): Promise<void> {
    return this.browserRunner.close().then(() => this.persistence);
  }

  private async loadJournal(): Promise<void> {
    const snapshot = await this.journalStore.load();
    for (const event of snapshot.events) {
      this.events.set(event.commandId, event);
    }
    for (const persisted of snapshot.pending) {
      const event = this.events.get(persisted.commandId);
      const source = persisted.source
        ? safeTaskSource(persisted.source)
        : undefined;
      const startUrl = safeStartUrl(persisted.startUrl);
      const plan =
        persisted.plan && validTaskPlan(persisted.plan)
          ? persisted.plan
          : undefined;
      if (
        !event ||
        (persisted.source && !source) ||
        (persisted.startUrl && !startUrl)
      )
        continue;
      if (
        persisted.phase === "source" &&
        source &&
        event.status === "awaiting_approval"
      ) {
        this.pending.set(persisted.commandId, {
          goal: persisted.goal,
          ...(startUrl ? { startUrl } : {}),
          source,
          phase: "source",
          budget: this.createSourceBudget(),
        });
        continue;
      }
      if (
        persisted.phase === "execution" &&
        plan &&
        event.status === "proposed"
      ) {
        this.pending.set(persisted.commandId, {
          goal: persisted.goal,
          ...(startUrl ? { startUrl } : {}),
          ...(source ? { source } : {}),
          phase: "execution",
          plan,
        });
      }
    }
  }

  private async loadConfiguredSources(): Promise<void> {
    const configured = await this.sourceStore.load();
    for (const source of configured) {
      this.sources.set(source.id, source);
    }
    const detector = this.sourcesAdapter as TaskSourceAdapter & {
      discoverCliSources?: (
        workspaceRoot: string,
      ) => Promise<TaskSourceConfig[]>;
    };
    if (!detector.discoverCliSources) return;
    for (const source of await detector.discoverCliSources(
      this.workspaceRoot,
    )) {
      if (!configured.some((item) => item.id === source.id)) {
        this.sources.set(source.id, source);
      }
    }
  }

  private createSourceBudget(): TaskBudgetTracker {
    return (
      this.sourceBudgetOverride?.() ??
      new TaskBudgetTracker(this.slowPathProfile)
    );
  }

  private recordBrowserResult(
    commandId: string,
    result: BrowserRunResult,
  ): CommandEvent {
    const existing = this.require(commandId);
    if (existing.status === "cancelled") return existing;
    const pending = this.pending.get(commandId);
    const candidateEvidence =
      result.status === "completed" &&
      pending?.source &&
      pending.plan &&
      isBrowserExecutionPlan(pending.plan)
        ? "Verified Slow Path browser plan is being recorded as a local candidate Skill; Fast Path promotion still requires three independent runs and an offline holdout."
        : undefined;
    const event: CommandEvent = {
      ...existing,
      status: result.status,
      message: result.message,
      createdAt: new Date().toISOString(),
      evidence: [
        ...result.evidence,
        ...(candidateEvidence ? [candidateEvidence] : []),
      ],
      proposal: result.proposal,
    };
    this.update(event);
    if (
      result.status === "completed" &&
      pending?.source &&
      pending.plan &&
      isBrowserExecutionPlan(pending.plan)
    ) {
      void recordTaskCandidate(
        this.workspaceRoot,
        commandId,
        pending.plan,
      ).catch(() => undefined);
    }
    if (result.status === "completed" || result.status === "failed") {
      this.pending.delete(commandId);
      this.queuePersist();
    }
    return event;
  }

  private recordGlobalResult(
    commandId: string,
    result: GlobalRunResult,
  ): CommandEvent {
    const existing = this.require(commandId);
    if (existing.status === "cancelled") return existing;
    const event: CommandEvent = {
      ...existing,
      status: result.status,
      message: result.message,
      createdAt: new Date().toISOString(),
      evidence: result.evidence,
      proposal: result.proposal,
    };
    this.update(event);
    if (result.status === "completed" || result.status === "failed") {
      this.pending.delete(commandId);
      this.queuePersist();
    }
    return event;
  }

  private automaticSource(): TaskSourceConfig | undefined {
    return [...this.sources.values()].find((source) => source.enabled);
  }

  private update(event: CommandEvent): void {
    const snapshot: CommandEvent = {
      ...event,
      ...(event.evidence ? { evidence: [...event.evidence] } : {}),
      ...(event.proposal
        ? {
            proposal: {
              ...event.proposal,
              steps: event.proposal.steps.map((step) => ({ ...step })),
            },
          }
        : {}),
    };
    this.events.set(event.commandId, snapshot);
    for (const listener of this.listeners) listener(snapshot);
    this.queuePersist();
  }

  private queuePersist(): void {
    const snapshot = {
      events: [...this.events.values()],
      pending: [...this.pending.entries()].map(([commandId, pending]) => ({
        commandId,
        goal: pending.goal,
        ...(pending.startUrl ? { startUrl: pending.startUrl } : {}),
        ...(pending.source ? { source: pending.source } : {}),
        phase: pending.phase,
        ...(pending.plan ? { plan: pending.plan } : {}),
      })),
    };
    this.persistence = this.persistence
      .then(() => this.journalStore.save(snapshot))
      .catch(() => undefined);
  }
}

function summarizeTaskPlan(plan: TaskExecutionPlan) {
  return isBrowserExecutionPlan(plan)
    ? summarizePlan(plan)
    : summarizeDesktopPlan(plan);
}

function safeError(error: unknown): string {
  const message =
    error instanceof Error ? error.message : "Task proposal failed.";
  return message
    .replace(
      /\b(?:sk|pk|tok|api)[_-][A-Za-z0-9_-]{12,}\b/gi,
      "[REDACTED_TOKEN]",
    )
    .slice(0, 1_000);
}

function safeTaskSource(value: TaskSourceConfig): TaskSourceConfig | undefined {
  try {
    return validateTaskSourceConfig(value);
  } catch {
    return undefined;
  }
}

function validTaskPlan(value: unknown): value is TaskExecutionPlan {
  return isBrowserExecutionPlan(value) || isDesktopExecutionPlan(value);
}

function normalizeStartUrl(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("The task start URL must be an absolute HTTP(S) URL.");
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password
  ) {
    throw new Error(
      "The task start URL must use HTTP(S) without embedded credentials.",
    );
  }
  return url.toString();
}

function safeStartUrl(value: string | undefined): string | undefined {
  try {
    return normalizeStartUrl(value);
  } catch {
    return undefined;
  }
}

function defaultSource(kind: TaskSourceKind): TaskSourceConfig {
  const labels: Record<TaskSourceKind, string> = {
    "codex-cli": "Codex CLI",
    "antigravity-cli": "Antigravity CLI",
    "claude-code-cli": "Claude Code CLI",
    "openai-responses": "OpenAI Responses API",
    gemini: "Gemini API",
    "anthropic-messages": "Claude API",
    "openai-compatible": "OpenAI-compatible API",
  };
  return { id: kind, kind, label: labels[kind], enabled: false };
}
