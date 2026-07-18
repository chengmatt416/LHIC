import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import {
  BrowserStateObserver,
  ConsoleNetworkObserver,
  PlaywrightDirectExecutor,
} from "@lhic/browser";
import {
  TransformersEmbeddingEngine,
  createDemoModelProvider,
  executeBrowserPlan,
  learnDemoSkill,
  resolveBrowserPlanVariables,
  toModelSafeUiState,
  type BrowserPlanStepOutcome,
  type DemoModelProviderKind,
  type LocalEmbeddingEngine,
} from "@lhic/controller";
import { createMemoryDatabase, SkillStore } from "@lhic/memory";
import type { BrowserExecutionPlan } from "@lhic/schema";
import { createActionApproval } from "@lhic/security";
import { redactPII } from "@lhic/trace";
import { VerifierEngine } from "@lhic/verifier";
import { chromium, type Browser } from "playwright";

import {
  KeyringDemoCredentialStore,
  type DemoCredentialStore,
} from "./demo-credential-store.js";
import { validateDemoModelEndpoint } from "./demo-model-endpoint.js";
import type { CliPrompter } from "./interactive.js";

const defaultModels: Record<DemoModelProviderKind, string> = {
  openai: "gpt-5.6",
  gemini: "gemini-2.5-flash",
  claude: "claude-sonnet-4-5",
};
const maxSlowPathTurns = 3;

export interface InteractiveDemoOptions {
  credentialStore?: DemoCredentialStore;
  embeddingEngine?: LocalEmbeddingEngine;
  launchBrowser?: () => Promise<Browser>;
  memoryDatabaseFile?: string;
  endpoint?: string;
}

/** Runs the headed, user-owned demo flow. It is intentionally unavailable to CI. */
export async function runInteractiveDemo(
  prompter: CliPrompter,
  options: InteractiveDemoOptions = {},
): Promise<void> {
  if (!prompter.interactive) {
    throw new Error(
      "lhic demo is interactive. Use lhic demo --safe for CI or scripts.",
    );
  }
  const providerKind = await chooseProvider(prompter);
  const endpoint = await readModelEndpoint(prompter, options.endpoint);
  const credentialStore =
    options.credentialStore ?? new KeyringDemoCredentialStore();
  const apiKey = await getApiKey(
    prompter,
    credentialStore,
    providerKind,
    endpoint,
  );
  const model = await requiredPrompt(
    prompter,
    `Model ID for ${providerKind}`,
    defaultModels[providerKind],
  );
  const targetUrl = await readPublicHttpsUrl(prompter);
  await assertPublicDnsTarget(targetUrl);
  const initialTask = await requiredPrompt(prompter, "Slow Path task prompt");
  const provider = createDemoModelProvider({
    provider: providerKind,
    apiKey,
    model,
    ...(endpoint === undefined ? {} : { endpoint }),
  });
  const taskId = `demo-${randomUUID().slice(0, 8)}`;
  const databaseFile =
    options.memoryDatabaseFile ?? join(".lhic", "skills.sqlite");
  await mkdir(".lhic", { recursive: true });
  const database = createMemoryDatabase(databaseFile);
  const skillStore = new SkillStore(database);
  const embeddingEngine =
    options.embeddingEngine ?? new TransformersEmbeddingEngine();
  const browser = await (
    options.launchBrowser ?? (() => chromium.launch({ headless: false }))
  )();

  try {
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();
    const networkObserver = new ConsoleNetworkObserver(page);
    const observer = new BrowserStateObserver(page, networkObserver);
    const executor = new PlaywrightDirectExecutor(page, {
      taskId,
      traceFilePath: join(".lhic", "traces", `${taskId}.jsonl`),
      downloadDirectory: join(".lhic", "demo-downloads", taskId),
      redactActionValues: true,
      navigationPolicy: {
        allowedProtocols: ["https:"],
        allowedOrigins: [targetUrl.origin],
        allowPrivateNetwork: false,
      },
    });
    const verifier = new VerifierEngine({ page, networkObserver });
    const navigation = await executor.execute({
      type: "navigate",
      intent: "Open the user-selected demo website",
      target: targetUrl.toString(),
      methodPreference: ["api"],
      riskLevel: "low",
    });
    if (!navigation.success) {
      throw new Error(
        navigation.error ?? "Could not open the selected public website.",
      );
    }

    console.log(
      "Slow Path started: the model will receive one redacted observation per action.",
    );
    const initialState = await observer.observe();
    const slowOutcomes: BrowserPlanStepOutcome[] = [];
    const slowSteps: BrowserExecutionPlan["steps"] = [];
    const providedVariables: Record<string, string> = {};
    let recentOutcome: string | undefined;
    let slowTurns = 0;

    for (; slowTurns < maxSlowPathTurns; slowTurns += 1) {
      const response = await provider.nextStep({
        task: initialTask,
        uiState: toModelSafeUiState(await observer.observe()),
        ...(recentOutcome ? { recentOutcome } : {}),
        ...(Object.keys(providedVariables).length ? { providedVariables } : {}),
      });
      console.log(
        `Slow Path turn ${slowTurns + 1}: ${redactPII(response.message)}`,
      );
      if (response.status === "complete") break;
      if (response.status === "blocked")
        throw new Error(redactPII(response.message));
      if (response.status === "needs_input") {
        Object.assign(
          providedVariables,
          await collectVariables(prompter, response.requiredVariables),
        );
        continue;
      }
      if (!response.step)
        throw new Error("Slow Path response did not include a browser step.");
      Object.assign(
        providedVariables,
        await collectMissingVariables(
          prompter,
          response.requiredVariables,
          providedVariables,
        ),
      );
      const stepPlan: BrowserExecutionPlan = {
        schemaVersion: "browser-plan-v1",
        goal: initialTask,
        requiredVariables: response.requiredVariables,
        steps: [response.step],
      };
      const resolvedPlan = resolveBrowserPlanVariables(
        stepPlan,
        providedVariables,
      );
      const result = await executePlanWithHumanApprovals(
        resolvedPlan,
        executor,
        verifier,
        prompter,
      );
      slowOutcomes.push(...result);
      slowSteps.push(...resolvedPlan.steps);
      recentOutcome = result
        .flatMap((outcome) => outcome.verification.evidence)
        .join("; ");
    }
    if (slowTurns === maxSlowPathTurns) {
      throw new Error(
        "Slow Path reached its deliberative 3-turn safety limit.",
      );
    }
    if (slowSteps.length === 0) {
      throw new Error(
        "Slow Path completed without a verified browser action, so it cannot learn a skill.",
      );
    }

    const learnedPlan: BrowserExecutionPlan = {
      schemaVersion: "browser-plan-v1",
      goal: initialTask,
      requiredVariables: [],
      steps: slowSteps,
    };
    console.log(
      "Learning the verified task locally (first run may download the embedding model)…",
    );
    const learnedSkill = await learnDemoSkill(
      skillStore,
      embeddingEngine,
      taskId,
      initialTask,
      initialState,
      learnedPlan,
      slowOutcomes,
    );
    console.log(
      `Recorded candidate ${learnedSkill.name} (${learnedSkill.verifiedRunCount}/3 independent verified runs). It is not eligible for Fast Path until a local offline holdout also passes.`,
    );
    await prompter.prompt("Press Enter to close the visible demo browser");
    observer.dispose();
    await context.close();
  } finally {
    database.close();
    await browser.close();
  }
}

async function executePlanWithHumanApprovals(
  plan: BrowserExecutionPlan,
  executor: PlaywrightDirectExecutor,
  verifier: VerifierEngine,
  prompter: CliPrompter,
): Promise<BrowserPlanStepOutcome[]> {
  const approvals: Record<string, ReturnType<typeof createActionApproval>> = {};
  const outcomes: BrowserPlanStepOutcome[] = [];
  let startAt = 0;
  while (startAt < plan.steps.length) {
    const result = await executeBrowserPlan(plan, executor, verifier, {
      startAt,
      approvals,
      requireActivationApproval: true,
      approvedBy: "demo-user",
    });
    outcomes.push(...result.completedSteps);
    if (result.status === "completed") return outcomes;
    if (result.status === "failed") throw new Error(result.error);
    const step = plan.steps[result.nextStepIndex]!;
    const approved = await confirm(
      prompter,
      `Approve ${step.action.type} for ${redactPII(step.action.intent)}? (yes/no)`,
    );
    if (!approved)
      throw new Error("The user declined the pending browser activation.");
    approvals[result.stepId] = createActionApproval(step.action, "demo-user");
    startAt = result.nextStepIndex;
  }
  return outcomes;
}

async function chooseProvider(
  prompter: CliPrompter,
): Promise<DemoModelProviderKind> {
  while (true) {
    const value = await prompter.prompt(
      "Model provider (openai, gemini, claude)",
      "openai",
    );
    if (value === "openai" || value === "gemini" || value === "claude")
      return value;
  }
}

async function getApiKey(
  prompter: CliPrompter,
  credentialStore: DemoCredentialStore,
  provider: DemoModelProviderKind,
  endpoint?: string,
): Promise<string> {
  const stored = await credentialStore.get(provider, endpoint);
  if (
    stored &&
    (await confirm(
      prompter,
      `Use the saved ${provider}${endpoint ? " custom-endpoint" : ""} API key? (yes/no)`,
    ))
  ) {
    return stored;
  }
  const apiKey = await prompter.promptSecret(
    `${provider}${endpoint ? " custom-endpoint" : ""} API key (stored in your OS Keychain)`,
  );
  if (!apiKey)
    throw new Error("An API key is required for the interactive demo.");
  await credentialStore.set(provider, apiKey, endpoint);
  return apiKey;
}

async function readModelEndpoint(
  prompter: CliPrompter,
  suppliedEndpoint?: string,
): Promise<string | undefined> {
  if (suppliedEndpoint !== undefined) {
    return validateDemoModelEndpoint(suppliedEndpoint).toString();
  }
  while (true) {
    const candidate = await prompter.prompt(
      "Custom model endpoint URL (optional; provider-compatible)",
    );
    if (!candidate) return undefined;
    try {
      return validateDemoModelEndpoint(candidate).toString();
    } catch (error) {
      console.log(
        error instanceof Error ? error.message : "Invalid model endpoint URL.",
      );
    }
  }
}

async function readPublicHttpsUrl(prompter: CliPrompter): Promise<URL> {
  while (true) {
    const candidate = await requiredPrompt(
      prompter,
      "Public HTTPS website URL",
    );
    try {
      return validatePublicHttpsUrl(candidate);
    } catch (error) {
      console.log(
        error instanceof Error ? error.message : "Invalid public HTTPS URL.",
      );
    }
  }
}

export function validatePublicHttpsUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("The demo website must be an absolute public HTTPS URL.");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    isPrivateHostname(url.hostname)
  ) {
    throw new Error(
      "The demo website must be public HTTPS and cannot contain credentials or a private host.",
    );
  }
  return url;
}

async function collectVariables(
  prompter: CliPrompter,
  variables: ReadonlyArray<{ name: string; prompt: string }>,
): Promise<Record<string, string>> {
  const values: Record<string, string> = {};
  for (const variable of variables) {
    values[variable.name] = await requiredPrompt(
      prompter,
      redactPII(variable.prompt),
    );
  }
  return values;
}

async function collectMissingVariables(
  prompter: CliPrompter,
  variables: ReadonlyArray<{ name: string; prompt: string }>,
  existing: Readonly<Record<string, string>>,
): Promise<Record<string, string>> {
  return collectVariables(
    prompter,
    variables.filter((variable) => !existing[variable.name]?.trim()),
  );
}

async function requiredPrompt(
  prompter: CliPrompter,
  message: string,
  defaultValue?: string,
): Promise<string> {
  const value = await prompter.prompt(message, defaultValue);
  if (!value.trim()) throw new Error(`${message} is required.`);
  return value.trim();
}

async function confirm(
  prompter: CliPrompter,
  message: string,
): Promise<boolean> {
  while (true) {
    const value = await prompter.prompt(message, "no");
    if (value === "yes") return true;
    if (value === "no") return false;
  }
}

function isPrivateHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (
    normalized === "localhost" ||
    normalized.endsWith(".local") ||
    normalized === "::1"
  )
    return true;
  const ipv4 = normalized.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4)
    return (
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe80:")
    );
  const [first, second] = ipv4.slice(1).map(Number);
  return (
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second !== undefined && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

async function assertPublicDnsTarget(url: URL): Promise<void> {
  if (isPrivateHostname(url.hostname)) return;
  try {
    const addresses = await lookup(url.hostname, { all: true, verbatim: true });
    if (
      addresses.length === 0 ||
      addresses.some((address) => isPrivateHostname(address.address))
    ) {
      throw new Error(
        "The demo website must resolve only to public network addresses.",
      );
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("public network"))
      throw error;
    throw new Error(
      "The demo website hostname could not be resolved as a public address.",
    );
  }
}
