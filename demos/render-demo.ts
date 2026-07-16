import { execFile } from "node:child_process";
import { createServer } from "node:http";
import {
  access,
  mkdir,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { chromium, type Page } from "playwright";

import { PlaywrightDirectExecutor } from "@lhic/browser";
import { createMemoryDatabase, SelectorMemory } from "@lhic/memory";
import type { ActionExecutionResult, SemanticAction } from "@lhic/schema";

import { runInternalBenchmark } from "../apps/cli/src/internal-benchmark.ts";
import { runSelectorResilienceSimulation } from "../apps/cli/src/selector-resilience-simulation.ts";

const execFileAsync = promisify(execFile);
const projectRoot = resolve(import.meta.dirname, "..");
const outputDirectory = resolve(projectRoot, "demo-output");
const workDirectory = join(tmpdir(), "lhic-demo-render");
const videoWidth = 1920;
const videoHeight = 1080;
const frameRate = 24;
const kokoroPackageVersion = "0.5.0";
const kokoroModelUrl =
  "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.int8.onnx";
const kokoroVoicesUrl =
  "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin";

interface SlideCard {
  label: string;
  value: string;
  detail: string;
}

interface Slide {
  id: string;
  eyebrow: string;
  title: string;
  body: string;
  note: string;
  accent: "cyan" | "violet" | "lime" | "amber";
  cards: SlideCard[];
}

interface Scene {
  slide?: Slide;
  workflow?: keyof WorkflowRecordings;
  duration: number;
  voice: string;
}

interface WorkflowRecordings {
  browserHero: string;
  standard: string;
  complex: string;
}

interface KokoroTtsConfiguration {
  modelPath: string;
  pythonExecutable: string;
  speed: number;
  voice: string;
  voicesPath: string;
}

interface AudioAssets {
  approvalEffect: string;
  introEffect: string;
  oneMinuteMusic: string;
  workflowEffect: string;
  fiveMinuteMusic: string;
}

async function main(): Promise<void> {
  const buildWeekOnly = process.argv.includes("--build-week");
  await assertFfmpegAvailable();
  await mkdir(outputDirectory, { recursive: true });
  const ttsConfiguration = await getKokoroTtsConfiguration();
  await rm(workDirectory, { recursive: true, force: true });
  await mkdir(join(workDirectory, "slides"), { recursive: true });
  await mkdir(join(workDirectory, "clips"), { recursive: true });
  await mkdir(join(workDirectory, "audio"), { recursive: true });

  const [internalBenchmark, selectorSimulation] = await Promise.all([
    runInternalBenchmark(projectRoot),
    runSelectorResilienceSimulation({ taskCount: 20, seed: 20_260_716 }),
  ]);
  const workflowVideos: WorkflowRecordings = {
    browserHero: await recordBrowserHeroWorkflow(),
    standard: await recordOperatorWorkflow("standard"),
    complex: await recordOperatorWorkflow("complex"),
  };
  const slides = createSlides(internalBenchmark, selectorSimulation);
  const slideFiles = await renderSlides(slides);
  const audioAssets = await createAudioAssets();
  const renderedVideos: Record<string, string> = {};

  if (!buildWeekOnly) {
    await renderDemo(
      "lhic-demo-1m.mp4",
      [
        {
          slide: slides.title,
          duration: 6,
          voice:
            "Meet LHIC: local-first browser automation with evidence, not guesswork.",
        },
        {
          slide: slides.fastPath,
          duration: 9,
          voice:
            "On familiar, low-risk workflows, the Fast Path stays local. That removes the model round trip and its token cost.",
        },
        {
          workflow: "standard",
          duration: 15,
          voice:
            "This is a real application screen. The live Operator Console records each semantic action, its execution method, latency, and verifier evidence as the workflow progresses.",
        },
        {
          slide: slides.learning,
          duration: 9,
          voice:
            "LHIC learns only from successful, evidenced execution. Verified patterns can become trusted local skills over time.",
        },
        {
          slide: slides.mcp,
          duration: 8,
          voice:
            "MCP exposes browser control, runtime state, and redacted learning metadata without putting MCP in the Fast Path.",
        },
        {
          slide: slides.resilience,
          duration: 7,
          voice:
            "Semantic targeting is tested against changing layouts in a controlled simulation. The result is observable.",
        },
        {
          slide: slides.cost,
          duration: 6,
          voice:
            "Known Fast Path actions make zero LLM calls and use zero LLM tokens.",
        },
      ],
      slideFiles,
      workflowVideos,
      ttsConfiguration,
      audioAssets,
    );
    renderedVideos.oneMinute = join(outputDirectory, "lhic-demo-1m.mp4");

    await renderDemo(
      "lhic-demo-5m.mp4",
      [
        {
          slide: slides.title,
          duration: 12,
          voice:
            "Welcome to LHIC, the Local Human Intent Controller. It turns intent into deterministic browser actions while keeping the known, low-risk path local, inspectable, and measurable.",
        },
        {
          slide: slides.problem,
          duration: 14,
          voice:
            "Known tasks include queue search, filtering, validation, and review preparation. Sending each one to a model adds latency, token spend, and failure points. LHIC uses model planning only when needed.",
        },
        {
          slide: slides.architecture,
          duration: 16,
          voice:
            "The execution loop is direct. Intent becomes a semantic action. Local Playwright performs it. The verifier returns evidence. Redacted traces and memory preserve what happened. Fast Path has no MCP dependency and no model call in this loop.",
        },
        {
          slide: slides.fastPath,
          duration: 16,
          voice:
            "These figures are from the current local controlled benchmark: fifty fixtures, zero model calls per task, and a fully verified result set. They are reproducible local measurements, not a claim about every website or a market comparison.",
        },
        {
          workflow: "standard",
          duration: 22,
          voice:
            "Here is the first live workflow. The application on the left is the target surface. The Operator Console on the right is not a mock status card: it streams action start, the selected execution method, evidence, and verified completion as the user interface changes.",
        },
        {
          slide: slides.verification,
          duration: 16,
          voice:
            "Verification changes the contract. LHIC does not call a click successful because an agent says so. It records the method, checks the resulting state, and makes failure visible. Without evidence, there is no success signal to promote.",
        },
        {
          slide: slides.learning,
          duration: 18,
          voice:
            "Learning is deliberately conservative. A Slow Path plan becomes a redacted skill only when every proposed action succeeds with non-empty verifier evidence. Repeated evidence promotes a pattern from verified, to habit, to trusted—while keeping it locally inspectable.",
        },
        {
          slide: slides.mcp,
          duration: 16,
          voice:
            "The MCP server exposes the runtime to an external agent. It supports semantic browser actions and read-only inspection of runtime state, skill lifecycle, and selector-memory counters. Requests are serialized to prevent action races.",
        },
        {
          workflow: "complex",
          duration: 36,
          voice:
            "Now we move into a higher-complexity exception workflow. The operator searches a queue, filters to a region, opens a case, assigns an owner, sets priority, runs reconciliation, and waits for the validation state. Every transition appears in the live log with its evidence. Watch the second fill: the application changes the original input name after the first action, and LHIC recovers through an already verified stable selector.",
        },
        {
          slide: slides.selectorMemory,
          duration: 16,
          voice:
            "Selector memory is not a blind cache. After success, LHIC retains a stable local candidate: element identity or semantic strategy. When the original selector fails, the runtime tests that verified candidate and records the healed path as evidence.",
        },
        {
          workflow: "complex",
          duration: 36,
          voice:
            "The same exception task continues through a multi-step review surface. The application updates from queue to detail to reconciliation status, while the console keeps the sequence readable: action, target, execution method, latency, and evidence. This is the difference between automation that merely runs and automation that can explain itself.",
        },
        {
          slide: slides.resilience,
          duration: 18,
          voice:
            "The resilience result comes from an explicitly limited local ablation across five form layouts. Semantic targeting completes twenty of twenty tasks, while the static-selector baseline completes four. This is useful regression evidence—not a substitute for measuring your own production environment.",
        },
        {
          slide: slides.cost,
          duration: 16,
          voice:
            "Cost is precise. Known Fast Path actions make zero LLM calls, so token cost is zero. Browser infrastructure, real sites, and Slow Path planning still cost money. LHIC removes model spend, but not other costs.",
        },
        {
          slide: slides.security,
          duration: 16,
          voice:
            "Speed never overrides policy. Observations omit input values. Traces redact sensitive data. High-risk or side-effecting targets require human approval. The next live segment shows that gate before a publish operation can leave review.",
        },
        {
          workflow: "complex",
          duration: 17,
          voice:
            "The final publish action is intentionally blocked. The console records the reason: a human approval is required. The application stays in review mode, proving that the safety boundary is enforced by the local executor rather than by a presentation layer.",
        },
        {
          slide: slides.quickStart,
          duration: 15,
          voice:
            "To use LHIC locally, install Node and Chromium, start the runtime, run preflight, and print the reviewed MCP configuration. Then measure the workflows that matter in your environment.",
        },
      ],
      slideFiles,
      workflowVideos,
      ttsConfiguration,
      audioAssets,
    );
    renderedVideos.fiveMinute = join(outputDirectory, "lhic-demo-5m.mp4");
  }

  await renderDemo(
    "lhic-build-week-demo-browser-hero.mp4",
    [
      {
        slide: slides.title,
        duration: 8,
        voice:
          "Meet LHIC, the Local Human Intent Controller: computer-use automation with evidence, not guesswork.",
      },
      {
        slide: slides.problem,
        duration: 11,
        voice:
          "Computer-use agents are powerful, but familiar tasks should not need a model round trip. Credentials, changing interfaces, and high-risk actions still need a boundary.",
      },
      {
        slide: slides.gpt56,
        duration: 14,
        voice:
          "GPT-5.6 is LHIC's explicit Slow Path planner for uncertain work. Its structured response is redacted, schema-checked, policy-checked, and never bypasses approval or verification.",
      },
      {
        workflow: "browserHero",
        duration: 30,
        voice:
          "Watch the browser, not a dashboard. LHIC opens a real local Partner Portal and types into live DOM controls. The first edit changes the form underneath it. The next action keeps using the old selector, yet LHIC recovers through verified semantic evidence. Every success is checked. The final proposal send is stopped before it can leave review.",
      },
      {
        slide: slides.verification,
        duration: 12,
        voice:
          "LHIC does not accept an agent's claim that something worked. Each completed action records its method, latency, and verifier evidence. The browser trace shows selector recovery and the safety block.",
      },
      {
        slide: slides.security,
        duration: 15,
        voice:
          "Safety is enforced by the local executor. Sensitive values are redacted in traces, risky actions are approval-bound, and the Fast Path has no model or MCP dependency.",
      },
      {
        slide: slides.fastPath,
        duration: 14,
        voice:
          "The local internal benchmark covers fifty controlled fixtures. Known Fast Path actions make zero model calls and every fixture has verifier evidence. This is scoped regression evidence, not a public-web claim.",
      },
      {
        slide: slides.codex,
        duration: 12,
        voice:
          "I set the product direction, security boundaries, and acceptance criteria. Codex accelerated implementation, testing, debugging, packaging, and this reproducible evidence workflow.",
      },
      {
        slide: slides.quickStart,
        duration: 13,
        voice:
          "Judges can run the safe local demo without an account or credential. Install dependencies, install Chromium, then run npm run demo to see evidence and the approval gate.",
      },
      {
        slide: slides.caveat,
        duration: 12,
        voice:
          "GPT-5.6 provides intelligence. LHIC makes computer actions safe, deterministic, and verifiable. Measure real workflows in your own environment before making production claims.",
      },
    ],
    slideFiles,
    workflowVideos,
    ttsConfiguration,
    audioAssets,
  );
  renderedVideos.buildWeek = join(
    outputDirectory,
    "lhic-build-week-demo-browser-hero.mp4",
  );

  console.log(
    JSON.stringify(
      {
        videos: renderedVideos,
        benchmark: internalBenchmark.metrics,
        selectorSimulation: {
          taskCount: selectorSimulation.taskCount,
          directSuccessRate: selectorSimulation.directSemantic.taskSuccessRate,
          baselineSuccessRate:
            selectorSimulation.staticSelectorBaseline.taskSuccessRate,
        },
      },
      null,
      2,
    ),
  );
}

async function assertFfmpegAvailable(): Promise<void> {
  try {
    await execFileAsync("ffmpeg", ["-version"]);
  } catch {
    throw new Error(
      "ffmpeg is required to render demo videos. Install ffmpeg and retry.",
    );
  }
}

type WorkflowName = Exclude<keyof WorkflowRecordings, "browserHero">;

interface RecordedWorkflowAction {
  action: SemanticAction;
  expectedFailure?: boolean;
}

async function recordBrowserHeroWorkflow(): Promise<string> {
  const recordingDirectory = join(workDirectory, "recording", "browser-hero");
  await mkdir(recordingDirectory, { recursive: true });
  const fixture = await createLocalFixtureServer(browserHeroPage());
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    recordVideo: {
      dir: recordingDirectory,
      size: { width: 1280, height: 720 },
    },
  });
  const page = await context.newPage();
  const video = page.video();
  const traceFilePath = join(workDirectory, "browser-hero-trace.jsonl");
  const database = createMemoryDatabase(
    join(recordingDirectory, "selector-memory.sqlite"),
  );
  const selectorMemory = new SelectorMemory(database);

  try {
    await page.goto(fixture.url);
    const executor = new PlaywrightDirectExecutor(page, {
      taskId: "demo-browser-hero",
      traceFilePath,
      selectorMemory,
    });
    await page.waitForTimeout(1_000);
    for (const step of browserHeroActions()) {
      const result = await executor.execute(step.action);
      if (!result.success && !step.expectedFailure) {
        throw new Error(
          `Browser hero action failed: ${result.error ?? "unknown error"}`,
        );
      }
      await appendLiveOperatorLog(page, step.action, result);
      await page.waitForTimeout(result.success ? 900 : 1_200);
    }
    await page.waitForTimeout(18_000);
  } finally {
    await context.close();
    await browser.close();
    database.close();
    await fixture.close();
  }

  if (!video) {
    throw new Error("Playwright did not create the browser hero recording.");
  }
  return video.path();
}

function browserHeroActions(): RecordedWorkflowAction[] {
  return [
    {
      action: {
        type: "fill",
        intent: "find the EMEA renewal account",
        target: 'input[name="account-search"]',
        value: "Northstar EMEA",
        methodPreference: ["dom", "accessibility"],
        riskLevel: "low",
      },
    },
    {
      action: {
        type: "click",
        intent: "open the Northstar renewal workspace",
        target: "#open-renewal",
        methodPreference: ["dom", "accessibility"],
        riskLevel: "low",
      },
    },
    {
      action: {
        type: "fill",
        intent: "assign the renewal owner",
        target: 'input[name="renewal-owner"]',
        value: "Morgan Lee",
        methodPreference: ["dom", "accessibility"],
        riskLevel: "low",
      },
    },
    {
      action: {
        type: "fill",
        intent: "add the finance reviewer after the form mutation",
        target: 'input[name="renewal-owner"]',
        value: "Morgan Lee · Finance reviewed",
        methodPreference: ["dom", "accessibility"],
        riskLevel: "low",
      },
    },
    {
      action: {
        type: "select",
        intent: "select the twelve month renewal term",
        target: 'select[name="renewal-term"]',
        value: "12-months",
        methodPreference: ["dom", "accessibility"],
        riskLevel: "low",
      },
    },
    {
      action: {
        type: "click",
        intent: "generate the approval-ready proposal preview",
        target: "#preview-proposal",
        methodPreference: ["dom", "accessibility"],
        riskLevel: "low",
      },
    },
    {
      action: {
        type: "wait",
        intent: "wait for proposal verifier evidence",
        target: "#proposal-ready",
        value: 1_000,
        methodPreference: ["dom"],
        riskLevel: "low",
      },
    },
    {
      action: {
        type: "click",
        intent: "send the renewal proposal to the customer",
        target: "#publish-report",
        methodPreference: ["dom", "accessibility"],
        riskLevel: "low",
      },
      expectedFailure: true,
    },
  ];
}

async function createLocalFixtureServer(contents: string): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(contents);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not determine local browser fixture address.");
  }
  return {
    url: `http://127.0.0.1:${address.port}/partner-renewal`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

async function recordOperatorWorkflow(kind: WorkflowName): Promise<string> {
  const recordingDirectory = join(workDirectory, "recording", kind);
  await mkdir(recordingDirectory, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    recordVideo: {
      dir: recordingDirectory,
      size: { width: 1280, height: 720 },
    },
  });
  const page = await context.newPage();
  const video = page.video();
  const traceFilePath = join(workDirectory, `${kind}-workflow-trace.jsonl`);
  const database = createMemoryDatabase(
    join(recordingDirectory, "selector-memory.sqlite"),
  );
  const selectorMemory = new SelectorMemory(database);

  try {
    await page.setContent(operatorWorkflowPage(kind));
    const executor = new PlaywrightDirectExecutor(page, {
      taskId: `demo-${kind}-workflow`,
      traceFilePath,
      selectorMemory,
    });
    await page.waitForTimeout(900);
    for (const step of workflowActions(kind)) {
      const result = await executor.execute(step.action);
      if (!result.success && !step.expectedFailure) {
        throw new Error(
          `Demo action failed: ${result.error ?? "unknown error"}`,
        );
      }
      await appendLiveOperatorLog(page, step.action, result);
      await page.waitForTimeout(result.success ? 720 : 1_100);
    }
    await page.waitForTimeout(kind === "complex" ? 2_300 : 1_500);
  } finally {
    await context.close();
    await browser.close();
    database.close();
  }

  if (video) {
    return video.path();
  }
  const recordings = await readdir(recordingDirectory);
  const recording = recordings.find((file) => file.endsWith(".webm"));
  if (!recording) {
    throw new Error("Playwright did not produce a workflow recording.");
  }
  return join(recordingDirectory, recording);
}

function workflowActions(kind: WorkflowName): RecordedWorkflowAction[] {
  if (kind === "standard") {
    return [
      {
        action: {
          type: "fill",
          intent: "search the operational queue",
          target: 'input[name="case-search"]',
          value: "Q3 vendor variance",
          methodPreference: ["dom", "accessibility"],
          riskLevel: "low",
        },
      },
      {
        action: {
          type: "select",
          intent: "filter to EMEA",
          target: 'select[name="region"]',
          value: "emea",
          methodPreference: ["dom", "accessibility"],
          riskLevel: "low",
        },
      },
      {
        action: {
          type: "click",
          intent: "open the selected exception review",
          target: "#open-review",
          methodPreference: ["dom", "accessibility"],
          riskLevel: "low",
        },
      },
      {
        action: {
          type: "fill",
          intent: "assign the review owner",
          target: 'input[name="owner"]',
          value: "Avery Chen",
          methodPreference: ["dom", "accessibility"],
          riskLevel: "low",
        },
      },
      {
        action: {
          type: "click",
          intent: "validate the review",
          target: "#validate-review",
          methodPreference: ["dom", "accessibility"],
          riskLevel: "low",
        },
      },
      {
        action: {
          type: "wait",
          intent: "wait for validation evidence",
          target: "#validation-ready",
          value: 1_000,
          methodPreference: ["dom"],
          riskLevel: "low",
        },
      },
    ];
  }

  return [
    {
      action: {
        type: "fill",
        intent: "search the exception queue",
        target: 'input[name="queue"]',
        value: "Vendor variance",
        methodPreference: ["dom", "accessibility"],
        riskLevel: "low",
      },
    },
    {
      action: {
        type: "fill",
        intent: "refine the exception queue search after layout mutation",
        target: 'input[name="queue"]',
        value: "Vendor variance / EMEA",
        methodPreference: ["dom", "accessibility"],
        riskLevel: "low",
      },
    },
    {
      action: {
        type: "select",
        intent: "filter complex exception workflow to EMEA",
        target: 'select[name="region"]',
        value: "emea",
        methodPreference: ["dom", "accessibility"],
        riskLevel: "low",
      },
    },
    {
      action: {
        type: "click",
        intent: "open the vendor exception",
        target: "#open-exception",
        methodPreference: ["dom", "accessibility"],
        riskLevel: "low",
      },
    },
    {
      action: {
        type: "fill",
        intent: "assign the exception owner",
        target: 'input[name="owner"]',
        value: "Morgan Lee",
        methodPreference: ["dom", "accessibility"],
        riskLevel: "low",
      },
    },
    {
      action: {
        type: "select",
        intent: "set exception priority",
        target: 'select[name="priority"]',
        value: "high",
        methodPreference: ["dom", "accessibility"],
        riskLevel: "low",
      },
    },
    {
      action: {
        type: "click",
        intent: "run reconciliation preview",
        target: "#run-reconciliation",
        methodPreference: ["dom", "accessibility"],
        riskLevel: "low",
      },
    },
    {
      action: {
        type: "wait",
        intent: "wait for reconciliation evidence",
        target: "#reconciliation-ready",
        value: 1_000,
        methodPreference: ["dom"],
        riskLevel: "low",
      },
    },
    {
      action: {
        type: "click",
        intent: "publish the reconciliation report",
        target: "#publish-report",
        methodPreference: ["dom", "accessibility"],
        riskLevel: "low",
      },
      expectedFailure: true,
    },
  ];
}

async function appendLiveOperatorLog(
  page: Page,
  action: SemanticAction,
  result: ActionExecutionResult,
): Promise<void> {
  await page.evaluate(
    (event) => {
      const root = document.querySelector("#operator-log");
      if (!root) {
        return;
      }
      const line = document.createElement("article");
      const evidence = event.success
        ? (event.evidence[0] ?? "Action completed with verifier evidence.")
        : (event.error ?? "Action was blocked by the local policy.");
      const recovered = evidence.includes("healed selector");
      line.className = `live-log ${event.success ? "success" : "blocked"}${recovered ? " recovered" : ""}`;
      const timestamp = new Date().toISOString().slice(11, 23);
      const heading = document.createElement("strong");
      heading.textContent = `${timestamp}  ${event.success ? "COMPLETE" : "BLOCKED"}  ${event.actionType.toUpperCase()} · ${event.method}`;
      const detail = document.createElement("span");
      detail.textContent = `${event.target} · ${event.latencyMs}ms`;
      const proof = document.createElement("em");
      proof.textContent = recovered
        ? `SELECTOR RECOVERY · ${evidence}`
        : evidence;
      line.append(heading, detail, proof);
      root.append(line);
      root.scrollTop = root.scrollHeight;
      const stage = document.querySelector("#workflow-stage");
      if (stage) {
        stage.textContent = event.success
          ? `${event.actionType.toUpperCase()} verified`
          : "Approval required";
      }
      if (!event.success) {
        document.querySelector("#approval-gate")?.classList.add("visible");
      }
    },
    {
      actionType: action.type,
      target: action.target ?? "browser surface",
      success: result.success,
      method: result.method ?? "policy gate",
      latencyMs: result.latencyMs,
      evidence: result.evidence,
      error: result.error,
    },
  );
}

function createSlides(
  internalBenchmark: Awaited<ReturnType<typeof runInternalBenchmark>>,
  selectorSimulation: Awaited<
    ReturnType<typeof runSelectorResilienceSimulation>
  >,
): Record<string, Slide> {
  const metrics = internalBenchmark.metrics;
  const percentage = (value: number) => `${Math.round(value * 100)}%`;
  const selectorDelta = Math.round(selectorSimulation.successRateDelta * 100);

  return {
    title: {
      id: "title",
      eyebrow: "LOCAL HUMAN INTENT CONTROLLER",
      title: "Make known workflows feel instant.",
      body: "LHIC keeps low-risk, verifiable browser workflows local. Every step is inspectable, evidenced, and ready to improve.",
      note: "Local-first browser automation · Playwright · verifier evidence",
      accent: "cyan",
      cards: [
        { label: "Fast Path", value: "Local", detail: "No LLM round trip" },
        {
          label: "Execution",
          value: "Verified",
          detail: "Evidence every action",
        },
        { label: "Memory", value: "SQLite", detail: "Redacted and local" },
      ],
    },
    problem: {
      id: "problem",
      eyebrow: "THE BOTTLENECK",
      title: "Not every browser action needs model reasoning.",
      body: "Sending familiar, low-risk workflows to a model adds waiting, token spend, and uncertainty. LHIC gives known skills a deterministic local route.",
      note: "Unknown, complex, and high-risk work still uses a Slow Path and human confirmation.",
      accent: "amber",
      cards: [
        { label: "Known flow", value: "Fast Path", detail: "Local execution" },
        {
          label: "Uncertain flow",
          value: "Slow Path",
          detail: "Planning when needed",
        },
        {
          label: "High risk",
          value: "Approval",
          detail: "Human stays in control",
        },
      ],
    },
    architecture: {
      id: "architecture",
      eyebrow: "THE EXECUTION LOOP",
      title: "Intent enters. Evidence remains.",
      body: "Intent → semantic action → local Playwright → verifier evidence → redacted local memory. The Fast Path uses neither MCP nor an LLM.",
      note: "MCP is an external-agent and debugging boundary, not a Fast Path dependency.",
      accent: "violet",
      cards: [
        { label: "Input", value: "Semantic", detail: "No raw coordinates" },
        {
          label: "Output",
          value: "Evidence",
          detail: "DOM / URL / file checks",
        },
        { label: "Trace", value: "Redacted", detail: "No credential logging" },
      ],
    },
    gpt56: {
      id: "gpt-5-6",
      eyebrow: "GPT-5.6 SLOW PATH",
      title: "Model intelligence stays inside a typed safety boundary.",
      body: "For ambiguous work, GPT-5.6 returns a strict structured plan. LHIC redacts sensitive fields before the request, uses store: false, and validates every proposed action before execution.",
      note: "Disabled by default · 30-second fail-closed timeout · schema, policy, approval, and verifier checks remain mandatory.",
      accent: "violet",
      cards: [
        { label: "Output", value: "Structured", detail: "Strict JSON schema" },
        {
          label: "Storage",
          value: "store: false",
          detail: "No request persistence",
        },
        {
          label: "Authority",
          value: "Bounded",
          detail: "Never bypasses policy",
        },
      ],
    },
    fastPath: {
      id: "fast-path",
      eyebrow: "MEASURED LOCALLY",
      title: "50 controlled workflows. Zero model calls.",
      body: "This is the project's current local internal benchmark. The Fast Path runs directly through Playwright and predefined skills—without waiting for a model response.",
      note: "Local controlled benchmark, not an external or market-comparison claim.",
      accent: "lime",
      cards: [
        {
          label: "Median completion",
          value: `${metrics.medianTimeToCompleteMs} ms`,
          detail: "50 local fixtures",
        },
        {
          label: "Model calls / task",
          value: String(metrics.modelCallsPerTask),
          detail: "Fast Path only",
        },
        {
          label: "Verifier pass rate",
          value: percentage(metrics.verifierPassRate),
          detail: "Controlled task set",
        },
      ],
    },
    verification: {
      id: "verification",
      eyebrow: "VERIFY, DON'T GUESS",
      title: "Success is evidence, not a model's guess.",
      body: "Every action returns latency, execution method, and verifier evidence. An outcome that cannot be verified is neither a success nor a learning signal.",
      note: "Action evidence and traces are redacted before persistence.",
      accent: "cyan",
      cards: [
        { label: "DOM", value: "Observed", detail: "State changes inspected" },
        { label: "URL / file", value: "Checked", detail: "Objective outcomes" },
        { label: "Failure", value: "Visible", detail: "No silent success" },
      ],
    },
    learning: {
      id: "learning",
      eyebrow: "VERIFIED LEARNING",
      title: "It does not merely remember. It earns trust through evidence.",
      body: "A Slow Path plan becomes a redacted skill only when every action succeeds with non-empty verifier evidence. Successful DOM actions also leave selector-memory candidates.",
      note: "draft → verified → habit → trusted",
      accent: "violet",
      cards: [
        {
          label: "1 verified run",
          value: "Verified",
          detail: "Evidence required",
        },
        { label: "3 verified runs", value: "Habit", detail: "Local promotion" },
        {
          label: "10 verified runs",
          value: "Trusted",
          detail: "Still inspectable",
        },
      ],
    },
    mcp: {
      id: "mcp",
      eyebrow: "MCP, MADE OPERABLE",
      title: "Connect external agents without losing the boundary.",
      body: "Standards-based stdio MCP exposes semantic browser tools plus runtime status and a redacted skill catalog. One session serializes calls in order, preventing page contention.",
      note: "lhic_runtime_status · lhic_skills_list · lhic_selector_memory_list · start · observe · act · close",
      accent: "cyan",
      cards: [
        {
          label: "Runtime",
          value: "Visible",
          detail: "Browser + memory status",
        },
        { label: "Skills", value: "Redacted", detail: "Lifecycle counts only" },
        { label: "Actions", value: "Semantic", detail: "Approval-aware" },
      ],
    },
    selectorMemory: {
      id: "selector-memory",
      eyebrow: "SEMANTIC RESILIENCE",
      title: "Find meaning first. Remember reliable signals after success.",
      body: "LHIC prioritizes DOM, labels, roles, and accessible names. Only confirmed direct DOM actions retain selector candidates locally for future resolution.",
      note: "No OCR, no raw-coordinate dependency on the Fast Path.",
      accent: "lime",
      cards: [
        { label: "Priority 1", value: "DOM", detail: "Unique target required" },
        { label: "Priority 2", value: "ARIA", detail: "Accessible names" },
        {
          label: "Memory",
          value: "Local",
          detail: "Verified selector candidates",
        },
      ],
    },
    resilience: {
      id: "resilience",
      eyebrow: "CONTROLLED ABLATION",
      title: "Semantic targeting: 20 / 20. Static baseline: 4 / 20.",
      body: "A local controlled simulation covers five form layouts. In this explicitly limited static-selector ablation, the semantic treatment showed a substantial advantage.",
      note: `+${selectorDelta} percentage points in this local simulation; not an external benchmark claim.`,
      accent: "amber",
      cards: [
        {
          label: "Semantic treatment",
          value: percentage(selectorSimulation.directSemantic.taskSuccessRate),
          detail: `${selectorSimulation.directSemantic.successfulTasks}/${selectorSimulation.taskCount} tasks`,
        },
        {
          label: "Static baseline",
          value: percentage(
            selectorSimulation.staticSelectorBaseline.taskSuccessRate,
          ),
          detail: `${selectorSimulation.staticSelectorBaseline.successfulTasks}/${selectorSimulation.taskCount} tasks`,
        },
        {
          label: "Scope",
          value: "Local",
          detail: "Explicitly limited ablation",
        },
      ],
    },
    cost: {
      id: "cost",
      eyebrow: "COST, WITHOUT HAND-WAVING",
      title: "Known Fast Path: zero LLM calls per action.",
      body: "That makes the Fast Path LLM token cost per action $0. It does not claim that browsers, machines, or Slow Path work are free—it means known tasks do not pay for model reasoning.",
      note: "0 model calls is a measured Fast Path property, not a total-cost claim.",
      accent: "lime",
      cards: [
        { label: "Known task", value: "0 calls", detail: "No LLM round trip" },
        { label: "Token cost", value: "$0", detail: "Per Fast Path action" },
        {
          label: "Slow Path",
          value: "Optional",
          detail: "Use only when needed",
        },
      ],
    },
    security: {
      id: "security",
      eyebrow: "SECURITY AS A DEFAULT",
      title: "Automation should not trade safety for speed.",
      body: "Input values are omitted from MCP observations, traces redact sensitive data, and high-risk or potentially side-effecting actions need a bound human approval.",
      note: "Fast does not mean unchecked.",
      accent: "amber",
      cards: [
        {
          label: "PII",
          value: "Redacted",
          detail: "Trace and stored definitions",
        },
        { label: "Risk", value: "Gated", detail: "Approval-bound actions" },
        {
          label: "Browser",
          value: "Local",
          detail: "Policy-enforced executor",
        },
      ],
    },
    quickStart: {
      id: "quick-start",
      eyebrow: "READY TO USE",
      title: "Three steps to connect your local agent.",
      body: "Run npm ci → npm run pw:install → npm start. Then run npm run mcp:config and review the generated configuration snippet in your MCP client.",
      note: "The configuration command prints a reviewable snippet; it never changes a client config automatically.",
      accent: "cyan",
      cards: [
        { label: "1", value: "Install", detail: "Node 24 + Chromium" },
        { label: "2", value: "Verify", detail: "npm run preflight" },
        { label: "3", value: "Connect", detail: "npm run mcp:config" },
      ],
    },
    codex: {
      id: "codex-collaboration",
      eyebrow: "CODEX COLLABORATION",
      title: "Human direction. Codex-assisted engineering.",
      body: "The maintainer set the product, threat-model, and release decisions. Codex accelerated implementation, test repair, package verification, benchmark tooling, and documentation while every delivered claim remained evidence-bound.",
      note: "Official Codex /feedback evidence is recorded separately when it is available.",
      accent: "cyan",
      cards: [
        {
          label: "Human",
          value: "Decides",
          detail: "Product and safety scope",
        },
        {
          label: "Codex",
          value: "Accelerates",
          detail: "Build, test, and docs",
        },
        {
          label: "Evidence",
          value: "Verified",
          detail: "CI and local commands",
        },
      ],
    },
    caveat: {
      id: "caveat",
      eyebrow: "HONEST DEMONSTRATION",
      title: "It is fast because unnecessary paths are removed.",
      body: "The speed and reliability figures in this video come from local controlled tests. Real sites, networks, login flows, and risk policies still affect outcomes; LHIC makes those differences observable and verifiable.",
      note: "Measure in your environment before making production decisions.",
      accent: "violet",
      cards: [
        {
          label: "Benchmark",
          value: "Controlled",
          detail: "Reproducible locally",
        },
        {
          label: "Production",
          value: "Policy",
          detail: "Environment-specific",
        },
        { label: "Outcome", value: "Evidence", detail: "Always inspectable" },
      ],
    },
  };
}

async function renderSlides(
  slides: Record<string, Slide>,
): Promise<Map<string, string>> {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: videoWidth, height: videoHeight },
  });
  const files = new Map<string, string>();
  try {
    for (const slide of Object.values(slides)) {
      const file = join(workDirectory, "slides", `${slide.id}.png`);
      await page.setContent(renderSlide(slide));
      await page.screenshot({ path: file });
      files.set(slide.id, file);
    }
  } finally {
    await browser.close();
  }
  return files;
}

async function renderDemo(
  fileName: string,
  scenes: Scene[],
  slideFiles: Map<string, string>,
  workflowVideos: WorkflowRecordings,
  ttsConfiguration: KokoroTtsConfiguration,
  audioAssets: AudioAssets,
): Promise<void> {
  const clipFiles: string[] = [];
  const narrations = await renderNarrations(fileName, scenes, ttsConfiguration);
  const backgroundMusic = fileName.includes("1m")
    ? audioAssets.oneMinuteMusic
    : audioAssets.fiveMinuteMusic;
  let sceneOffset = 0;
  for (const [index, scene] of scenes.entries()) {
    const clip = join(workDirectory, "clips", `${fileName}-${index}.mp4`);
    const narration = narrations[index];
    if (!narration) {
      throw new Error(`Missing narration for ${fileName} scene ${index}.`);
    }
    const narrationDuration = await getNarrationDuration(narration);
    if (narrationDuration > scene.duration - 0.25) {
      throw new Error(
        `Narration for ${fileName} scene ${index} is ${narrationDuration.toFixed(2)}s, leaving insufficient room in its ${scene.duration}s scene.`,
      );
    }
    if (scene.workflow) {
      await renderWorkflowClip(
        workflowVideos[scene.workflow],
        narration,
        scene.duration,
        backgroundMusic,
        sceneOffset,
        soundEffectForScene(scene, index, audioAssets),
        clip,
      );
    } else if (scene.slide) {
      const slide = slideFiles.get(scene.slide.id);
      if (!slide) {
        throw new Error(`Missing rendered slide: ${scene.slide.id}`);
      }
      await renderSlideClip(
        slide,
        narration,
        scene.duration,
        backgroundMusic,
        sceneOffset,
        soundEffectForScene(scene, index, audioAssets),
        clip,
      );
    } else {
      throw new Error("A demo scene requires a slide or workflow recording.");
    }
    clipFiles.push(clip);
    sceneOffset += scene.duration;
  }

  const concatList = join(workDirectory, `${fileName}.txt`);
  await writeFile(
    concatList,
    clipFiles
      .map((file) => `file '${file.replaceAll("'", "'\\''")}'`)
      .join("\n"),
    "utf8",
  );
  await execFfmpeg([
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    concatList,
    "-c",
    "copy",
    "-movflags",
    "+faststart",
    join(outputDirectory, fileName),
  ]);
}

async function renderSlideClip(
  image: string,
  narration: string,
  duration: number,
  backgroundMusic: string,
  musicOffset: number,
  soundEffect: string | undefined,
  output: string,
): Promise<void> {
  const args = [
    "-loop",
    "1",
    "-framerate",
    String(frameRate),
    "-i",
    image,
    "-i",
    narration,
    "-ss",
    String(musicOffset),
    "-i",
    backgroundMusic,
  ];
  if (soundEffect) {
    args.push("-i", soundEffect);
  }
  args.push(
    "-t",
    String(duration),
    "-vf",
    `scale=${videoWidth}:${videoHeight},fade=t=in:st=0:d=0.55,fade=t=out:st=${Math.max(0, duration - 0.55)}:d=0.55`,
    "-r",
    String(frameRate),
    "-filter_complex",
    mixNarrationAudio(duration, Boolean(soundEffect)),
    "-map",
    "0:v:0",
    "-map",
    "[mixed-audio]",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-crf",
    "25",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-ar",
    "48000",
    output,
  );
  await execFfmpeg(args);
}

async function renderWorkflowClip(
  recording: string,
  narration: string,
  duration: number,
  backgroundMusic: string,
  musicOffset: number,
  soundEffect: string | undefined,
  output: string,
): Promise<void> {
  const args = [
    "-i",
    recording,
    "-i",
    narration,
    "-ss",
    String(musicOffset),
    "-i",
    backgroundMusic,
  ];
  if (soundEffect) {
    args.push("-i", soundEffect);
  }
  args.push(
    "-t",
    String(duration),
    "-vf",
    `scale=${videoWidth}:${videoHeight}:force_original_aspect_ratio=decrease,pad=${videoWidth}:${videoHeight}:(ow-iw)/2:(oh-ih)/2:#07111f,tpad=stop_mode=clone:stop_duration=${duration},fade=t=in:st=0:d=0.55,fade=t=out:st=${Math.max(0, duration - 0.55)}:d=0.55`,
    "-r",
    String(frameRate),
    "-filter_complex",
    mixNarrationAudio(duration, Boolean(soundEffect)),
    "-map",
    "0:v:0",
    "-map",
    "[mixed-audio]",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-crf",
    "25",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-ar",
    "48000",
    output,
  );
  await execFfmpeg(args);
}

async function createAudioAssets(): Promise<AudioAssets> {
  const soundtrackDirectory = join(workDirectory, "soundtrack");
  await mkdir(soundtrackDirectory, { recursive: true });
  const assets: AudioAssets = {
    approvalEffect: join(soundtrackDirectory, "approval-effect.wav"),
    fiveMinuteMusic: join(soundtrackDirectory, "five-minute-bed.wav"),
    introEffect: join(soundtrackDirectory, "intro-effect.wav"),
    oneMinuteMusic: join(soundtrackDirectory, "one-minute-bed.wav"),
    workflowEffect: join(soundtrackDirectory, "workflow-effect.wav"),
  };
  await Promise.all([
    renderAmbientBed(60, assets.oneMinuteMusic),
    renderAmbientBed(300, assets.fiveMinuteMusic),
    renderToneEffect(
      "0.07*sin(2*PI*(430+180*t)*t)*exp(-5*t)+0.025*sin(2*PI*860*t)*exp(-7*t)",
      assets.introEffect,
    ),
    renderToneEffect(
      "0.06*sin(2*PI*880*t)*exp(-7*t)+0.03*sin(2*PI*1320*t)*exp(-11*t)",
      assets.workflowEffect,
    ),
    renderToneEffect(
      "0.055*sin(2*PI*180*t)*exp(-4*t)+0.035*sin(2*PI*135*t)*exp(-6*t)",
      assets.approvalEffect,
    ),
  ]);
  return assets;
}

async function renderAmbientBed(
  duration: number,
  output: string,
): Promise<void> {
  await execFfmpeg([
    "-f",
    "lavfi",
    "-i",
    "aevalsrc=0.024*sin(2*PI*55*t)+0.014*sin(2*PI*82.5*t)+0.008*sin(2*PI*110*t)+0.006*sin(2*PI*220*t)*(0.5+0.5*sin(2*PI*0.12*t)):s=48000",
    "-t",
    String(duration),
    "-af",
    `highpass=f=30,lowpass=f=1600,volume=1.6,afade=t=in:st=0:d=1.4,afade=t=out:st=${Math.max(0, duration - 1.4)}:d=1.4`,
    "-c:a",
    "pcm_s16le",
    output,
  ]);
}

async function renderToneEffect(
  expression: string,
  output: string,
): Promise<void> {
  await execFfmpeg([
    "-f",
    "lavfi",
    "-i",
    `aevalsrc=${expression}:s=48000`,
    "-t",
    "0.65",
    "-af",
    "highpass=f=90,lowpass=f=3400,afade=t=out:st=0.28:d=0.37",
    "-c:a",
    "pcm_s16le",
    output,
  ]);
}

function soundEffectForScene(
  scene: Scene,
  index: number,
  assets: AudioAssets,
): string | undefined {
  if (scene.workflow === "complex" && scene.duration <= 20) {
    return assets.approvalEffect;
  }
  if (scene.workflow) {
    return assets.workflowEffect;
  }
  return index === 0 ? assets.introEffect : undefined;
}

function mixNarrationAudio(duration: number, hasSoundEffect: boolean): string {
  const filters = [
    `[1:a]apad=pad_dur=${duration},atrim=duration=${duration},asplit=2[voice][sidechain]`,
    `[2:a]atrim=duration=${duration},volume=0.78[background]`,
    "[background][sidechain]sidechaincompress=threshold=0.015:ratio=12:attack=20:release=420[ducked-background]",
  ];
  if (hasSoundEffect) {
    filters.push(`[3:a]adelay=180:all=1,atrim=duration=${duration}[effect]`);
    filters.push(
      "[voice][ducked-background][effect]amix=inputs=3:duration=first:normalize=0[mixed-audio]",
    );
  } else {
    filters.push(
      "[voice][ducked-background]amix=inputs=2:duration=first:normalize=0[mixed-audio]",
    );
  }
  return filters.join(";");
}

async function renderNarrations(
  fileName: string,
  scenes: Scene[],
  configuration: KokoroTtsConfiguration,
): Promise<string[]> {
  const narrations = scenes.map((_, index) =>
    join(workDirectory, "audio", `${fileName}-${index}.wav`),
  );
  const manifestPath = join(workDirectory, "audio", `${fileName}.json`);
  await writeFile(
    manifestPath,
    JSON.stringify(
      scenes.map((scene, index) => ({
        text: scene.voice,
        output: narrations[index],
      })),
    ),
    "utf8",
  );
  await execFileAsync(
    configuration.pythonExecutable,
    [
      join(projectRoot, "demos", "kokoro-tts.py"),
      "--manifest",
      manifestPath,
      "--model",
      configuration.modelPath,
      "--voices",
      configuration.voicesPath,
      "--voice",
      configuration.voice,
      "--speed",
      String(configuration.speed),
    ],
    { maxBuffer: 10 * 1024 * 1024 },
  );
  return narrations;
}

async function getKokoroTtsConfiguration(): Promise<KokoroTtsConfiguration> {
  const cacheDirectory = join(outputDirectory, ".kokoro");
  const virtualEnvironment = join(cacheDirectory, "venv");
  const pythonExecutable = join(virtualEnvironment, "bin", "python");
  const modelPath = join(cacheDirectory, "kokoro-v1.0.int8.onnx");
  const voicesPath = join(cacheDirectory, "voices-v1.0.bin");
  const voice = process.env.LHIC_KOKORO_VOICE ?? "af_heart";
  const speed = Number(process.env.LHIC_KOKORO_SPEED ?? "1.15");
  if (!Number.isFinite(speed) || speed <= 0) {
    throw new Error("LHIC_KOKORO_SPEED must be a number greater than zero.");
  }

  await mkdir(cacheDirectory, { recursive: true });
  if (!(await fileExists(pythonExecutable))) {
    const bootstrapPython = await findKokoroBootstrapPython();
    await execFileAsync(bootstrapPython, ["-m", "venv", virtualEnvironment]);
  }
  try {
    await execFileAsync(pythonExecutable, [
      "-c",
      "import kokoro_onnx, soundfile",
    ]);
  } catch {
    await execFileAsync(
      pythonExecutable,
      [
        "-m",
        "pip",
        "install",
        "--upgrade",
        `kokoro-onnx==${kokoroPackageVersion}`,
        "soundfile",
      ],
      { maxBuffer: 10 * 1024 * 1024 },
    );
  }
  await Promise.all([
    downloadKokoroAsset(kokoroModelUrl, modelPath),
    downloadKokoroAsset(kokoroVoicesUrl, voicesPath),
  ]);
  return { modelPath, pythonExecutable, speed, voice, voicesPath };
}

async function findKokoroBootstrapPython(): Promise<string> {
  const candidates = [
    process.env.LHIC_KOKORO_PYTHON,
    "python3.13",
    "python3.12",
    "python3.11",
    "python3",
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    try {
      await execFileAsync(candidate, ["--version"]);
      return candidate;
    } catch {
      // Try the next supported Python executable.
    }
  }
  throw new Error(
    "Kokoro TTS requires Python 3.11 through 3.13. Set LHIC_KOKORO_PYTHON to a supported executable.",
  );
}

async function downloadKokoroAsset(url: string, output: string): Promise<void> {
  if (await fileExists(output)) {
    return;
  }
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Could not download the Kokoro model asset (${response.status}) from ${url}.`,
    );
  }
  const contents = Buffer.from(await response.arrayBuffer());
  if (contents.byteLength < 1024 * 1024) {
    throw new Error(`Downloaded Kokoro asset is unexpectedly small: ${url}.`);
  }
  const temporaryOutput = `${output}.download`;
  await writeFile(temporaryOutput, contents);
  await rename(temporaryOutput, output);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function getNarrationDuration(input: string): Promise<number> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=nw=1:nk=1",
    input,
  ]);
  const duration = Number(String(stdout).trim());
  if (!Number.isFinite(duration)) {
    throw new Error(`Could not determine narration duration for ${input}.`);
  }
  return duration;
}

async function execFfmpeg(args: string[]): Promise<void> {
  await execFileAsync("ffmpeg", ["-y", "-loglevel", "error", ...args], {
    maxBuffer: 10 * 1024 * 1024,
  });
}

function renderSlide(slide: Slide): string {
  const accent = {
    cyan: "#52e5f3",
    violet: "#9b8cff",
    lime: "#b8f05a",
    amber: "#ffc75f",
  }[slide.accent];
  const cards = slide.cards
    .map(
      (card) => `
        <article class="card">
          <p>${escapeHtml(card.label)}</p>
          <strong>${escapeHtml(card.value)}</strong>
          <span>${escapeHtml(card.detail)}</span>
        </article>`,
    )
    .join("");
  return `<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8">
        <style>
          * { box-sizing: border-box; }
          body { margin: 0; width: ${videoWidth}px; height: ${videoHeight}px; overflow: hidden; color: #f2f6ff; font-family: "PingFang TC", "Heiti TC", Arial, sans-serif; background: #07111f; }
          main { position: relative; width: 100%; height: 100%; padding: 106px 128px 88px; overflow: hidden; background: radial-gradient(circle at 82% 13%, ${accent}3a 0, transparent 27%), radial-gradient(circle at 7% 94%, #4853df33 0, transparent 34%), linear-gradient(135deg, #06111f 0%, #0a1729 56%, #090d1c 100%); }
          main::before { content: ""; position: absolute; inset: 0; opacity: .26; background-image: linear-gradient(#ffffff0b 1px, transparent 1px), linear-gradient(90deg, #ffffff0b 1px, transparent 1px); background-size: 46px 46px; mask-image: linear-gradient(to bottom, #000, transparent); }
          .rail { position: absolute; top: 0; bottom: 0; left: 0; width: 10px; background: ${accent}; box-shadow: 0 0 36px ${accent}; }
          .eyebrow { position: relative; color: ${accent}; font-size: 23px; font-weight: 700; letter-spacing: .2em; }
          h1 { position: relative; max-width: 1390px; margin: 28px 0 22px; font-size: 76px; line-height: 1.17; letter-spacing: -.035em; }
          .body { position: relative; max-width: 1330px; margin: 0; color: #b8c7dd; font-size: 31px; line-height: 1.56; }
          .cards { position: absolute; left: 128px; right: 128px; bottom: 154px; display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; }
          .card { min-height: 190px; padding: 28px 30px; border: 1px solid #ffffff26; border-radius: 24px; background: linear-gradient(135deg, #ffffff15, #ffffff08); box-shadow: 0 18px 60px #00000028; backdrop-filter: blur(10px); }
          .card p { margin: 0 0 14px; color: #9fb0c7; font-size: 19px; font-weight: 650; letter-spacing: .04em; text-transform: uppercase; }
          .card strong { display: block; color: ${accent}; font-size: 42px; letter-spacing: -.035em; }
          .card span { display: block; margin-top: 11px; color: #d2dced; font-size: 20px; }
          .note { position: absolute; left: 128px; right: 128px; bottom: 76px; padding-top: 23px; border-top: 1px solid #ffffff24; color: #8d9bb2; font-size: 18px; letter-spacing: .015em; }
          .seal { position: absolute; right: 128px; top: 96px; display: flex; gap: 10px; align-items: center; padding: 10px 16px; color: #d8e6f8; font-size: 17px; border: 1px solid #ffffff29; border-radius: 999px; background: #07111fa8; }
          .seal i { width: 9px; height: 9px; display: inline-block; border-radius: 50%; background: ${accent}; box-shadow: 0 0 14px ${accent}; }
        </style>
      </head>
      <body>
        <main>
          <div class="rail"></div>
          <div class="seal"><i></i> LHIC / LOCAL-FIRST · AI-GENERATED VOICE</div>
          <div class="eyebrow">${escapeHtml(slide.eyebrow)}</div>
          <h1>${escapeHtml(slide.title)}</h1>
          <p class="body">${escapeHtml(slide.body)}</p>
          <section class="cards">${cards}</section>
          <footer class="note">${escapeHtml(slide.note)}</footer>
        </main>
      </body>
    </html>`;
}

function browserHeroPage(): string {
  return `<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8">
        <style>
          * { box-sizing: border-box; }
          body { margin: 0; min-height: 100vh; overflow: hidden; color: #dce8f7; font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #07101d; }
          .browser-chrome { height: 52px; display: flex; align-items: center; gap: 14px; padding: 0 18px; border-bottom: 1px solid #ffffff20; background: #121c2c; }
          .dots { display: flex; gap: 6px; }
          .dots i { width: 10px; height: 10px; border-radius: 50%; background: #e96c70; }
          .dots i:nth-child(2) { background: #ffc75f; }
          .dots i:nth-child(3) { background: #b8f05a; }
          .browser-controls { color: #8391a6; font: 700 14px ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .22em; }
          .address { flex: 1; max-width: 650px; padding: 8px 14px; color: #b9c9dc; font: 11px ui-monospace, SFMono-Regular, Menlo, monospace; border: 1px solid #ffffff18; border-radius: 8px; background: #08111f; }
          .secure { color: #b8f05a; }
          .recording { margin-left: auto; color: #8fa0b6; font-size: 9px; font-weight: 800; letter-spacing: .1em; }
          main { height: calc(100vh - 52px); display: grid; grid-template-columns: minmax(0, 1fr) 365px; gap: 14px; padding: 14px; background: radial-gradient(circle at 72% 0%, #5e72a522, transparent 32%), #07101d; }
          .portal { min-width: 0; overflow: hidden; border: 1px solid #ffffff1d; border-radius: 15px; background: linear-gradient(145deg, #12233a, #0a1626); box-shadow: 0 18px 42px #0000003d; }
          .portal-head { display: flex; align-items: center; justify-content: space-between; padding: 17px 20px; border-bottom: 1px solid #ffffff12; }
          .brand { display: flex; align-items: center; gap: 10px; color: #f0f6ff; font-size: 14px; font-weight: 800; letter-spacing: .03em; }
          .brand-mark { width: 23px; height: 23px; display: grid; place-items: center; color: #08111f; font-size: 10px; border-radius: 7px; background: linear-gradient(135deg, #52e5f3, #b8f05a); }
          .nav { display: flex; gap: 18px; color: #8494ab; font-size: 10px; font-weight: 700; }
          .nav span.active { color: #e5f7ff; }
          .intent { margin: 16px 20px 12px; padding: 13px 15px; border: 1px solid #9b8cff55; border-radius: 11px; background: linear-gradient(100deg, #9b8cff18, #52e5f30d); }
          .intent small { display: block; color: #b9aefe; font-size: 9px; font-weight: 800; letter-spacing: .12em; }
          .intent p { margin: 6px 0 0; color: #edf3ff; font-size: 13px; line-height: 1.35; }
          .workspace { padding: 0 20px 18px; }
          .workspace-top { display: flex; align-items: flex-end; justify-content: space-between; gap: 14px; }
          h1 { margin: 0; color: #f2f7ff; font-size: 25px; letter-spacing: -.035em; }
          .sub { margin: 5px 0 0; color: #8496ad; font-size: 11px; }
          .status { padding: 6px 8px; color: #b8f05a; font-size: 9px; font-weight: 800; letter-spacing: .08em; border: 1px solid #b8f05a55; border-radius: 999px; background: #b8f05a12; }
          .search-row { display: grid; grid-template-columns: minmax(0, 1fr) 132px; gap: 8px; margin-top: 14px; }
          input, select { width: 100%; height: 38px; padding: 0 11px; color: #edf6ff; font: 12px inherit; border: 1px solid #ffffff24; border-radius: 8px; outline: none; background: #07111f; transition: .2s; }
          input:focus, select:focus { border-color: #52e5f3; box-shadow: 0 0 0 3px #52e5f31c; }
          button { height: 38px; color: #07111f; font: 800 11px inherit; border: 0; border-radius: 8px; background: linear-gradient(90deg, #52e5f3, #b8f05a); cursor: pointer; }
          .account { display: grid; grid-template-columns: 43px minmax(0, 1fr) auto; gap: 11px; align-items: center; margin-top: 12px; padding: 12px; border: 1px solid #52e5f344; border-radius: 10px; background: #52e5f30c; }
          .avatar { width: 43px; height: 43px; display: grid; place-items: center; color: #52e5f3; font-size: 12px; font-weight: 800; border: 1px solid #52e5f355; border-radius: 12px; background: #07111f; }
          .account strong, .account span { display: block; }
          .account strong { color: #eaf5ff; font-size: 13px; }
          .account span { margin-top: 3px; color: #8fa1b8; font-size: 10px; }
          .account .amount { color: #b8f05a; font: 800 12px ui-monospace, SFMono-Regular, Menlo, monospace; }
          .renewal { display: none; margin-top: 12px; padding: 14px; border: 1px solid #ffffff1c; border-radius: 11px; background: #081422a8; }
          .renewal.visible { display: block; animation: reveal .25s ease-out; }
          .renewal-title { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
          .renewal-title strong { color: #f0f6ff; font-size: 13px; }
          .renewal-title span { color: #ffc75f; font-size: 9px; font-weight: 800; letter-spacing: .08em; }
          .fields { display: grid; grid-template-columns: minmax(0, 1fr) 174px; gap: 9px; }
          label { display: block; margin: 0 0 5px 1px; color: #91a3b9; font-size: 9px; font-weight: 800; letter-spacing: .06em; text-transform: uppercase; }
          .mutation { display: none; margin-top: 9px; padding: 8px 10px; color: #ffda92; font: 9px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace; border: 1px solid #ffc75f55; border-radius: 7px; background: #ffc75f12; }
          .mutation.visible { display: block; animation: reveal .25s ease-out; }
          .actions { display: grid; grid-template-columns: 1fr 184px; gap: 8px; margin-top: 10px; }
          #publish-report { color: #ffe7ea; background: linear-gradient(90deg, #d85367, #ef7681); }
          .ready { display: none; margin-top: 10px; padding: 9px 10px; color: #b8f05a; font-size: 10px; font-weight: 750; border: 1px solid #b8f05a55; border-radius: 7px; background: #b8f05a10; }
          .ready.visible { display: block; animation: reveal .22s ease-out; }
          .evidence { display: flex; min-width: 0; flex-direction: column; overflow: hidden; border: 1px solid #ffffff1d; border-radius: 15px; background: #08111fe8; box-shadow: 0 18px 42px #00000035; }
          .evidence-head { padding: 15px 15px 11px; border-bottom: 1px solid #ffffff14; }
          .evidence-head strong { display: block; color: #eaf4ff; font-size: 10px; letter-spacing: .11em; }
          .evidence-head span { display: block; margin-top: 5px; color: #b8f05a; font: 800 9px ui-monospace, SFMono-Regular, Menlo, monospace; }
          #workflow-stage { margin: 11px 14px 7px; color: #52e5f3; font: 700 10px ui-monospace, SFMono-Regular, Menlo, monospace; }
          #operator-log { flex: 1; min-height: 0; padding: 0 12px 10px; overflow: auto; scrollbar-width: none; }
          #operator-log::-webkit-scrollbar { display: none; }
          .live-log { margin: 7px 0; padding: 8px 9px; border-left: 2px solid #71839a; border-radius: 0 7px 7px 0; background: #ffffff07; animation: log-in .22s ease-out; }
          .live-log.success { border-color: #52e5f3; }
          .live-log.recovered { border-color: #b8f05a; background: #b8f05a10; }
          .live-log.blocked { border-color: #e95d70; background: #e95d7010; }
          .live-log strong, .live-log span, .live-log em { display: block; }
          .live-log strong { color: #e9f4ff; font: 700 8px ui-monospace, SFMono-Regular, Menlo, monospace; }
          .live-log span { margin-top: 4px; color: #8fa2b9; font: 9px ui-monospace, SFMono-Regular, Menlo, monospace; }
          .live-log em { margin-top: 4px; color: #bbcadc; font: 9px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace; font-style: normal; }
          #approval-gate { display: none; margin: 0 12px 12px; padding: 10px; color: #ffd7dc; font-size: 9px; border: 1px solid #e95d7066; border-radius: 8px; background: #e95d7015; }
          #approval-gate.visible { display: block; animation: reveal .25s ease-out; }
          @keyframes reveal { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: none; } }
          @keyframes log-in { from { opacity: 0; transform: translateX(6px); } to { opacity: 1; transform: none; } }
        </style>
      </head>
      <body>
        <header class="browser-chrome"><div class="dots"><i></i><i></i><i></i></div><div class="browser-controls">‹ › ↻</div><div class="address"><span class="secure">●</span> LOCAL FIXTURE · http://127.0.0.1 / partner-renewal</div><div class="recording">PLAYWRIGHT REC · AI-GENERATED VOICE</div></header>
        <main>
          <section class="portal">
            <header class="portal-head"><div class="brand"><span class="brand-mark">N</span> NORTHSTAR PARTNER PORTAL</div><nav class="nav"><span class="active">Renewals</span><span>Accounts</span><span>Proposals</span></nav></header>
            <section class="intent"><small>HUMAN INTENT</small><p>“Prepare the EMEA renewal proposal, verify every change, but never send without me.”</p></section>
            <div class="workspace">
              <div class="workspace-top"><div><h1>Partner renewal workspace</h1><p class="sub">A real local browser surface — semantic DOM actions only</p></div><span class="status">LOCAL SESSION</span></div>
              <div class="search-row"><input name="account-search" aria-label="Account search" placeholder="Find a partner account"><button id="open-renewal" type="button">Open renewal</button></div>
              <article class="account"><div class="avatar">NC</div><div><strong>Northstar Commerce</strong><span>EMEA · Annual renewal · Finance review ready</span></div><div class="amount">$240k</div></article>
              <section class="renewal" id="renewal-panel"><div class="renewal-title"><strong>FY27 renewal proposal</strong><span>REVIEW MODE</span></div><div class="fields"><div><label for="renewal-owner">Renewal owner</label><input id="renewal-owner" name="renewal-owner" aria-label="Renewal owner" placeholder="Assign proposal owner"></div><div><label for="renewal-term">Term</label><select id="renewal-term" name="renewal-term" aria-label="Renewal term"><option value="6-months">6 months</option><option value="12-months">12 months</option><option value="24-months">24 months</option></select></div></div><p class="mutation" id="mutation-notice">UI MUTATION DETECTED · original name rotated · selector recovery armed</p><div class="actions"><button id="preview-proposal" type="button">Generate verified preview</button><button id="publish-report" type="button">Send proposal to customer</button></div><div class="ready" id="proposal-ready">Proposal preview is ready · verifier observed the review state</div></section>
            </div>
          </section>
          <aside class="evidence"><div class="evidence-head"><strong>LHIC EXECUTION PROOF</strong><span>● LOCAL VERIFIER ONLINE</span></div><div id="workflow-stage">BOOT · local executor ready</div><div id="operator-log"><article class="live-log success"><strong>LOCAL BROWSER OPEN</strong><span>http://127.0.0.1 / partner-renewal</span><em>DOM OBSERVATION · TRACE REDACTION ON</em></article><article class="live-log"><strong>INTENT ACCEPTED</strong><span>Prepare renewal · retain human send authority</span><em>AWAITING SEMANTIC ACTION</em></article></div><div id="approval-gate"><strong>HUMAN APPROVAL REQUIRED</strong><br>Proposal was not sent. The local executor stopped the side effect before it left review.</div></aside>
        </main>
        <script>
          const accountSearch = document.querySelector('input[name="account-search"]');
          const owner = document.querySelector('#renewal-owner');
          accountSearch.addEventListener('input', () => document.querySelector('.account').style.borderColor = '#b8f05a88');
          document.querySelector('#open-renewal').addEventListener('click', () => document.querySelector('#renewal-panel').classList.add('visible'));
          owner.addEventListener('input', () => {
            if (owner.getAttribute('name') === 'renewal-owner') {
              owner.setAttribute('name', 'renewal-owner-locked');
              document.querySelector('#mutation-notice').classList.add('visible');
            }
          });
          document.querySelector('#preview-proposal').addEventListener('click', () => document.querySelector('#proposal-ready').classList.add('visible'));
        </script>
      </body>
    </html>`;
}

function operatorWorkflowPage(kind: WorkflowName): string {
  const complex = kind === "complex";
  const searchName = complex ? "queue" : "case-search";
  const searchId = complex ? "queue-search" : "case-search";
  const openButtonId = complex ? "open-exception" : "open-review";
  const openButtonLabel = complex ? "Open exception" : "Open review";
  const validationButtonId = complex ? "run-reconciliation" : "validate-review";
  const validationButtonLabel = complex
    ? "Run reconciliation preview"
    : "Validate review";
  const validationReadyId = complex
    ? "reconciliation-ready"
    : "validation-ready";
  const mutationScript = complex
    ? `
      search.addEventListener('input', () => {
        if (search.getAttribute('name') === 'queue') search.setAttribute('name', 'queue-locked');
        document.querySelector('#queue-summary').textContent = '12 active exceptions · semantic recovery armed';
      });`
    : `
      search.addEventListener('input', () => {
        document.querySelector('#queue-summary').textContent = '12 matching reviews · queue narrowed locally';
      });`;
  return `<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8">
        <style>
          * { box-sizing: border-box; }
          body { margin: 0; min-height: 100vh; overflow: hidden; color: #eaf2ff; font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: radial-gradient(circle at 76% 5%, #52e5f329, transparent 28%), #06111f; }
          header { height: 62px; display: flex; align-items: center; justify-content: space-between; padding: 0 25px; border-bottom: 1px solid #ffffff16; background: #081525cc; }
          .brand { display: flex; align-items: center; gap: 10px; font-size: 14px; font-weight: 780; letter-spacing: .08em; }
          .dot { width: 10px; height: 10px; border-radius: 50%; background: #52e5f3; box-shadow: 0 0 16px #52e5f3; }
          .header-status { display: flex; align-items: center; gap: 8px; }
          .mode { padding: 7px 11px; color: #b8f05a; font-size: 10px; font-weight: 750; letter-spacing: .08em; border: 1px solid #b8f05a66; border-radius: 99px; }
          .ai-voice { padding: 7px 10px; color: #9fb0c7; font-size: 9px; font-weight: 750; letter-spacing: .07em; border: 1px solid #ffffff24; border-radius: 99px; }
          main { height: calc(100vh - 62px); display: grid; grid-template-columns: minmax(0, 1.78fr) minmax(330px, .92fr); gap: 16px; padding: 16px; }
          .application, .console { min-width: 0; overflow: hidden; border: 1px solid #ffffff1c; border-radius: 17px; background: linear-gradient(145deg, #102139e8, #0a1424e8); box-shadow: 0 16px 48px #00000035; }
          .application { display: grid; grid-template-columns: 132px minmax(0, 1fr); }
          .nav { padding: 18px 12px; border-right: 1px solid #ffffff12; background: #081220b8; }
          .nav-label { margin: 8px 9px 18px; color: #70839d; font-size: 9px; font-weight: 800; letter-spacing: .12em; }
          .nav-item { margin: 6px 0; padding: 10px 9px; color: #8fa1b8; font-size: 11px; border-radius: 8px; }
          .nav-item.active { color: #eaf5ff; background: #52e5f31a; box-shadow: inset 2px 0 #52e5f3; }
          .workbench { padding: 19px 21px; overflow: hidden; }
          .app-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
          h1 { margin: 0; font-size: 23px; letter-spacing: -.035em; }
          .sub { margin: 6px 0 0; color: #91a4bc; font-size: 11px; }
          .stage { padding: 7px 9px; color: #52e5f3; font-size: 10px; font-weight: 750; border: 1px solid #52e5f344; border-radius: 8px; background: #52e5f311; }
          .metrics { display: grid; grid-template-columns: repeat(3, 1fr); gap: 9px; margin: 17px 0; }
          .metric { padding: 11px; border: 1px solid #ffffff15; border-radius: 10px; background: #ffffff08; }
          .metric span { display: block; color: #8193aa; font-size: 9px; font-weight: 700; letter-spacing: .07em; text-transform: uppercase; }
          .metric strong { display: block; margin-top: 6px; color: #eef6ff; font-size: 17px; }
          .filters { display: grid; grid-template-columns: minmax(0, 1fr) 130px; gap: 9px; }
          input, select { width: 100%; height: 37px; padding: 0 11px; color: #edf5ff; font: 12px inherit; border: 1px solid #ffffff22; border-radius: 8px; outline: none; background: #07111f; transition: .2s; }
          input:focus, select:focus { border-color: #52e5f3; box-shadow: 0 0 0 3px #52e5f31c; }
          #queue-summary { margin: 10px 0; color: #93a7c0; font-size: 10px; }
          .table { overflow: hidden; border: 1px solid #ffffff17; border-radius: 10px; }
          .row { display: grid; grid-template-columns: 1.25fr .8fr .65fr .56fr; gap: 8px; align-items: center; min-height: 37px; padding: 0 12px; border-top: 1px solid #ffffff0d; color: #b7c7d9; font-size: 10px; }
          .row:first-child { min-height: 29px; color: #71839a; font-size: 8px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; border-top: 0; background: #07111f99; }
          .tag { width: max-content; padding: 4px 6px; color: #ffc75f; font-size: 8px; font-weight: 800; border-radius: 99px; background: #ffc75f1d; }
          .open { padding: 5px 8px; color: #07111f; font: 800 9px inherit; border: 0; border-radius: 6px; background: #b8f05a; cursor: pointer; }
          .review { display: none; margin-top: 12px; padding: 12px; border: 1px solid #52e5f33d; border-radius: 10px; background: #52e5f30c; }
          .review.visible { display: block; animation: reveal .28s ease-out; }
          .review-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 9px; }
          .review-head strong { font-size: 12px; }
          .review-head span { color: #ffc75f; font-size: 9px; font-weight: 800; }
          .review-controls { display: grid; grid-template-columns: 1fr 118px; gap: 8px; }
          .action-row { display: flex; gap: 8px; margin-top: 9px; }
          .action-row button { flex: 1; height: 34px; color: #07111f; font: 800 10px inherit; border: 0; border-radius: 7px; background: linear-gradient(90deg, #52e5f3, #b8f05a); cursor: pointer; }
          .action-row button.publish { color: #fff2f2; background: #e95d70; }
          .ready { display: none; margin-top: 9px; padding: 8px; color: #b8f05a; font-size: 10px; font-weight: 750; border: 1px solid #b8f05a4d; border-radius: 7px; background: #b8f05a11; }
          .ready.visible { display: block; }
          .console { display: flex; flex-direction: column; background: #07111fde; }
          .console-head { display: flex; align-items: center; justify-content: space-between; padding: 15px 15px 11px; border-bottom: 1px solid #ffffff12; }
          .console-head strong { color: #dcecff; font-size: 10px; letter-spacing: .1em; }
          .live { display: flex; align-items: center; gap: 6px; color: #b8f05a; font-size: 8px; font-weight: 850; letter-spacing: .1em; }
          .live i { width: 7px; height: 7px; border-radius: 50%; background: #b8f05a; box-shadow: 0 0 10px #b8f05a; animation: blink 1.2s infinite; }
          #workflow-stage { margin: 11px 14px 7px; color: #52e5f3; font: 700 10px ui-monospace, SFMono-Regular, Menlo, monospace; }
          #operator-log { flex: 1; min-height: 0; padding: 0 12px 11px; overflow: auto; scrollbar-width: none; }
          #operator-log::-webkit-scrollbar { display: none; }
          .live-log { margin: 7px 0; padding: 8px 9px; border-left: 2px solid #71839a; border-radius: 0 7px 7px 0; background: #ffffff07; animation: log-in .22s ease-out; }
          .live-log.success { border-color: #52e5f3; }
          .live-log.recovered { border-color: #b8f05a; background: #b8f05a10; }
          .live-log.blocked { border-color: #e95d70; background: #e95d7010; }
          .live-log strong, .live-log span, .live-log em { display: block; }
          .live-log strong { color: #e9f4ff; font: 700 8px ui-monospace, SFMono-Regular, Menlo, monospace; }
          .live-log span { margin-top: 4px; color: #8fa2b9; font: 9px ui-monospace, SFMono-Regular, Menlo, monospace; }
          .live-log em { margin-top: 4px; color: #bbcaDC; font: 9px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace; font-style: normal; }
          #approval-gate { display: none; margin: 0 12px 12px; padding: 10px; color: #ffd7dc; font-size: 9px; border: 1px solid #e95d7066; border-radius: 8px; background: #e95d7015; }
          #approval-gate.visible { display: block; animation: reveal .25s ease-out; }
          @keyframes reveal { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: none; } }
          @keyframes log-in { from { opacity: 0; transform: translateX(6px); } to { opacity: 1; transform: none; } }
          @keyframes blink { 50% { opacity: .3; } }
        </style>
      </head>
      <body>
        <header><div class="brand"><span class="dot"></span> LHIC / OPERATOR CONSOLE</div><div class="header-status"><div class="mode">FAST PATH · LOCAL</div><div class="ai-voice">AI-GENERATED VOICE</div></div></header>
        <main>
          <section class="application">
            <nav class="nav"><div class="nav-label">NORTHSTAR OPS</div><div class="nav-item active">Exception queue</div><div class="nav-item">Reviews</div><div class="nav-item">Reconciliation</div><div class="nav-item">Audit trail</div></nav>
            <div class="workbench">
              <div class="app-top"><div><h1>${complex ? "Vendor exception reconciliation" : "Operational review queue"}</h1><p class="sub">Live application surface · ${complex ? "dynamic queue mutation enabled" : "review workspace"}</p></div><span class="stage">LOCAL SESSION</span></div>
              <section class="metrics"><article class="metric"><span>Open queue</span><strong>12</strong></article><article class="metric"><span>At risk</span><strong>3</strong></article><article class="metric"><span>Verified today</span><strong>48</strong></article></section>
              <section class="filters"><input id="${searchId}" name="${searchName}" placeholder="Search exception queue"><select name="region"><option value="global">All regions</option><option value="emea">EMEA</option><option value="apac">APAC</option></select></section>
              <p id="queue-summary">12 active exceptions · awaiting semantic filter</p>
              <section class="table"><div class="row"><span>Case</span><span>Region</span><span>Risk</span><span></span></div><div class="row"><span>VX-204 · vendor variance</span><span>EMEA</span><span class="tag">HIGH</span><button class="open" id="${openButtonId}" type="button">${openButtonLabel}</button></div><div class="row"><span>CR-118 · policy drift</span><span>APAC</span><span class="tag">MED</span><span>Queued</span></div><div class="row"><span>AR-078 · duplicate ledger</span><span>EMEA</span><span class="tag">MED</span><span>Queued</span></div></section>
              <section class="review" id="review-detail"><div class="review-head"><strong>VX-204 · evidence review</strong><span>REVIEW MODE</span></div><div class="review-controls"><input name="owner" placeholder="Assign owner"><select name="priority"><option value="normal">Normal priority</option><option value="high">High priority</option></select></div><div class="action-row"><button id="${validationButtonId}" type="button">${validationButtonLabel}</button>${complex ? '<button id="publish-report" class="publish" type="button">Publish report</button>' : ""}</div><div class="ready" id="${validationReadyId}">${complex ? "Reconciliation preview complete · evidence attached" : "Validation complete · evidence attached"}</div></section>
            </div>
          </section>
          <aside class="console"><div class="console-head"><strong>LIVE OPERATOR CONSOLE</strong><span class="live"><i></i> LIVE</span></div><div id="workflow-stage">BOOT · local executor ready</div><div id="operator-log"><article class="live-log success"><strong>LOCAL RUNTIME READY</strong><span>Playwright direct executor · memory online</span><em>TRACE REDACTION ENABLED</em></article><article class="live-log"><strong>OBSERVE COMPLETE</strong><span>Application surface normalized</span><em>AWAITING SEMANTIC ACTION</em></article></div><div id="approval-gate"><strong>HUMAN APPROVAL REQUIRED</strong><br>Publish action stayed blocked; no external side effect was executed.</div></aside>
        </main>
        <script>
          const search = document.querySelector('#${searchId}');
          ${mutationScript}
          document.querySelector('#${openButtonId}').addEventListener('click', () => document.querySelector('#review-detail').classList.add('visible'));
          document.querySelector('#${validationButtonId}').addEventListener('click', () => document.querySelector('#${validationReadyId}').classList.add('visible'));
        </script>
      </body>
    </html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "'": "&#39;",
      '"': "&quot;",
    };
    return entities[character] ?? character;
  });
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
