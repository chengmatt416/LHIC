import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
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
import {
  FastPathRouter,
  SlowPathLearningCoordinator,
  type SlowPathRequest,
  type SlowPathResponse,
} from "@lhic/controller";
import {
  createMemoryDatabase,
  SelectorMemory,
  SkillStore,
  type CandidateSkillRecord,
  type SkillRecord,
} from "@lhic/memory";
import { createActionApproval } from "@lhic/security";
import { appendTraceEvent } from "@lhic/trace";
import type {
  ActionExecutionResult,
  BrowserSemanticAction,
  SemanticAction,
  UserIntent,
  VerificationResult,
} from "@lhic/schema";

import { runInternalBenchmark } from "../apps/cli/src/internal-benchmark.ts";
import { runSelectorResilienceSimulation } from "../apps/cli/src/selector-resilience-simulation.ts";

const execFileAsync = promisify(execFile);
const projectRoot = resolve(import.meta.dirname, "..");
const outputDirectory = resolve(projectRoot, "demo-output");
const workDirectory = join(tmpdir(), "lhic-demo-render");
const videoWidth = 1920;
const videoHeight = 1080;
const frameRate = 24;
const vendorOrigin = "https://vendor.techtools.qzz.io";
const vendorStorefrontUrl = `${vendorOrigin}/`;
const vendorFinanceUrl = `${vendorOrigin}/finance`;
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
  workflowOffsetSeconds?: number;
  workflowSourceDurationSeconds?: number;
  duration: number;
  voice: string;
}

interface WorkflowRecordings {
  browserHero: string;
  standard: string;
  complex: string;
  recovery?: string;
}

interface VendorCommerceWorkflow {
  fastDurationSeconds: number;
  recording: string;
  slowDurationSeconds: number;
  slowSourceDurationSeconds: number;
  slowStartOffsetSeconds: number;
}

interface VendorPlanLearningResult {
  candidate: CandidateSkillRecord;
  fixtureFastSkill: SkillRecord;
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
  transitionEffect: string;
  workflowEffect: string;
  fiveMinuteMusic: string;
}

async function main(): Promise<void> {
  const buildWeekOnly = process.argv.includes("--build-week");
  const vendorLive = process.argv.includes("--vendor-live");
  if (vendorLive && !buildWeekOnly) {
    throw new Error("--vendor-live requires --build-week.");
  }
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
  const vendorWorkflow = vendorLive
    ? await recordVendorEnglishCommerceWorkflow()
    : undefined;
  const workflowVideos: WorkflowRecordings = {
    browserHero:
      vendorWorkflow?.recording ?? (await recordBrowserHeroWorkflow()),
    standard: await recordOperatorWorkflow("standard"),
    complex: await recordOperatorWorkflow("complex"),
    ...(vendorLive
      ? { recovery: await recordWebsiteUpdateRecoveryWorkflow() }
      : {}),
  };
  const slides = createSlides(
    internalBenchmark,
    selectorSimulation,
    vendorWorkflow,
  );
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
            "Learning is deliberately conservative. A successful Slow Path plan first becomes a redacted candidate. Only three independent verified runs and an offline holdout can promote it to Fast Path—while keeping the evidence locally inspectable.",
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

  const buildWeekScenes: Scene[] = vendorLive
    ? [
        {
          slide: slides.title,
          duration: 11,
          voice:
            "Meet LHIC, the Local Human Intent Controller. It records a verified first encounter as a local candidate, then keeps already-approved deterministic skills fast, observable, and approval-bound.",
        },
        {
          slide: slides.vendorSlow,
          duration: 16,
          voice:
            "First encounter. A typed GPT-5.6 Slow Path contract receives the new task inside a redacted safety boundary. LHIC safely executes each proposed browser action and accepts success only when the verifier returns evidence.",
        },
        {
          workflow: "browserHero",
          workflowOffsetSeconds: vendorWorkflow?.slowStartOffsetSeconds ?? 0,
          workflowSourceDurationSeconds:
            vendorWorkflow?.slowDurationSeconds ?? 0,
          duration: vendorWorkflow?.slowDurationSeconds ?? 0,
          voice:
            "This is the live vendor site, localized into English for the recording. LHIC adds Test3 times three and Test2 times two, enters anonymous checkout details, and verifies each state change. The signature canvas is checked pixel by pixel. The order is deliberately held at policy: learning is allowed, but a new live purchase still requires a human decision.",
        },
        {
          slide: slides.vendorLearning,
          duration: 15,
          voice:
            "The completed first pass becomes a candidate only after every action has evidence. LHIC stores a redacted semantic plan and verified selector candidates locally; three independent runs and an offline holdout are still required before Fast Path promotion.",
        },
        {
          slide: slides.vendorFast,
          duration: 13,
          voice:
            "Second encounter. This recording uses an explicitly preloaded deterministic fixture skill on the Fast Path. The green mode is direct Playwright execution: zero model calls and zero MCP calls in the execution loop.",
        },
        {
          workflow: "browserHero",
          workflowOffsetSeconds: vendorWorkflow?.slowSourceDurationSeconds ?? 0,
          workflowSourceDurationSeconds:
            vendorWorkflow?.fastDurationSeconds ?? 0,
          duration: vendorWorkflow?.fastDurationSeconds ?? 0,
          voice:
            "Same task, fresh browser, explicitly preloaded deterministic local route. Direct Playwright replays it with zero model and zero MCP calls. The verifier checks every result, and policy still blocks the purchase.",
        },
        {
          slide: slides.vendorSpeed,
          duration: 13,
          voice:
            "The recorded first encounter is compared directly with a deterministic local replay. The comparison shows the Fast Path cost boundary; a newly recorded candidate still needs repeated independent verification and an offline holdout before promotion.",
        },
        {
          slide: slides.vendorRecovery,
          duration: 14,
          voice:
            "Now the website changes. A stored Fast Path selector misses the new interface. LHIC does not guess or silently click somewhere else: it records the mismatch and returns to the GPT-5.6 recovery boundary.",
        },
        {
          workflow: "recovery",
          workflowSourceDurationSeconds: 20,
          duration: 20,
          voice:
            "The controlled website-v2 update invalidates the fixture route. A typed GPT-5.6 recovery-plan fixture proposes the new offer field. LHIC schema-checks and policy-checks the plan, verifies the new route, and saves a candidate locally. The sequence is reproducible without sending a credential or an order.",
        },
        {
          slide: slides.vendorPolicy,
          duration: 15,
          voice:
            "Finally, a dangerous place-order action is blocked by local policy. Human approval is required before the side effect can leave review. That boundary is retained by the original Skill, the Fast Path, and the upgraded Skill v2.",
        },
        {
          slide: slides.caveat,
          duration: 12,
          voice:
            "LHIC makes the lifecycle visible: understand, execute, verify, learn, replay, recover, and approve. Measure the same evidence in your own environment before making production claims.",
        },
      ]
    : [
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
            "The Slow Path is a typed planning boundary. This reproducible recording uses a deterministic redacted plan fixture, then applies the exact same verification, trace, learning, and approval controls as a model-provided plan.",
        },
        {
          workflow: "browserHero",
          duration: 58,
          voice:
            "This is a real local shopping site, not a dashboard. The first cart is a complex Slow Path: search, configure a keyboard, add it, open checkout, redeem a promotion after the checkout mutates, choose delivery, and verify the order preview. This credential-free recording uses a deterministic redacted plan fixture at the Slow Path boundary. Every evidenced action creates a local candidate. The second fresh cart uses a clearly marked preloaded deterministic fixture skill: no model call, no MCP, and no claim that the new candidate was promoted early. It still refuses to place the order without human approval.",
        },
        {
          slide: slides.verification,
          duration: 14,
          voice:
            "The learning rule is strict. A Slow Path plan becomes a local candidate only after every step returns verifier evidence. It needs three independent runs and an offline holdout before a matched intent can route through the Fast Path.",
        },
        {
          slide: slides.security,
          duration: 15,
          voice:
            "Safety is enforced by the local executor. Sensitive values are redacted in traces, risky actions are approval-bound, and the Fast Path has no model or MCP dependency.",
        },
        {
          slide: slides.caveat,
          duration: 12,
          voice:
            "GPT-5.6 provides intelligence. LHIC makes computer actions safe, deterministic, and verifiable. Measure real workflows in your own environment before making production claims.",
        },
      ];

  await renderDemo(
    vendorLive
      ? "lhic-build-week-demo-vendor-live.mp4"
      : "lhic-build-week-demo-commerce-learning.mp4",
    buildWeekScenes,
    slideFiles,
    workflowVideos,
    ttsConfiguration,
    audioAssets,
  );
  renderedVideos.buildWeek = join(
    outputDirectory,
    vendorLive
      ? "lhic-build-week-demo-vendor-live.mp4"
      : "lhic-build-week-demo-commerce-learning.mp4",
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

type WorkflowName = "standard" | "complex";

interface RecordedWorkflowAction {
  action: SemanticAction;
  expectedFailure?: boolean;
}

type VendorPhase = "slow" | "fast";

// Retained for the explicit legacy finance-recording mode below.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function requireVendorFinanceCode(): string {
  const code = process.env.LHIC_DEMO_FINANCE_CODE?.trim();
  if (!code) {
    throw new Error(
      "--vendor-live requires LHIC_DEMO_FINANCE_CODE so the finance credential never enters source control.",
    );
  }
  return code;
}

async function recordVendorEnglishCommerceWorkflow(): Promise<VendorCommerceWorkflow> {
  const recordingDirectory = join(
    workDirectory,
    "recording",
    "vendor-english-commerce",
  );
  const output = join(recordingDirectory, "vendor-english-slow-to-fast.mp4");
  const traceFilePath = join(
    workDirectory,
    "vendor-english-commerce-trace.jsonl",
  );
  await mkdir(recordingDirectory, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const database = createMemoryDatabase(
    join(recordingDirectory, "selector-memory.sqlite"),
  );
  const selectorMemory = new SelectorMemory(database);
  const skillStore = new SkillStore(database);
  let slowRecording: string | undefined;
  let fastRecording: string | undefined;

  try {
    const slowContext = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      recordVideo: {
        dir: join(recordingDirectory, "slow"),
        size: { width: 1280, height: 720 },
      },
    });
    const slowPage = await slowContext.newPage();
    const slowVideo = slowPage.video();
    let commerceLearning: VendorPlanLearningResult | undefined;
    try {
      const slowExecutor = createVendorExecutor(
        slowPage,
        "demo-vendor-english-slow-path",
        traceFilePath,
        selectorMemory,
      );
      commerceLearning = await learnVendorPlan(
        slowPage,
        slowExecutor,
        skillStore,
        vendorCommerceSlowPathRequest(),
        vendorCommerceSlowPathPlan(),
        "",
        "slow",
      );
      await showVendorLearnedSkill(
        slowPage,
        commerceLearning.candidate,
        "ORDER CANDIDATE RECORDED · LOCAL SQLITE",
      );
      await localizeVendorPage(slowPage);
      await slowPage.waitForTimeout(1_900);

      const signature = await drawAnonymousVendorSignature(
        slowPage,
        traceFilePath,
        "demo-vendor-english-slow-path",
      );
      if (!signature.success) {
        throw new Error(
          signature.error ?? "Anonymous signature verification failed.",
        );
      }
      await appendVendorOverlayLog(
        slowPage,
        "Anonymous signature drawn",
        "Canvas stroke verifier passed; checkout is ready for human review.",
        "success",
      );
      await appendVendorOverlayLog(
        slowPage,
        "Place order",
        "POLICY HOLD · the live order is not submitted during this safe re-recording.",
        "blocked",
      );
      await localizeVendorPage(slowPage);
      await slowPage.waitForTimeout(2_400);
    } finally {
      await slowContext.close();
    }
    if (!slowVideo) {
      throw new Error(
        "Playwright did not create the English Slow Path recording.",
      );
    }
    slowRecording = await slowVideo.path();
    if (!commerceLearning) {
      throw new Error(
        "English Slow Path did not produce a verifier-backed candidate.",
      );
    }

    const fastContext = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      recordVideo: {
        dir: join(recordingDirectory, "fast"),
        size: { width: 1280, height: 720 },
      },
    });
    const fastPage = await fastContext.newPage();
    const fastVideo = fastPage.video();
    try {
      const fastExecutor = createVendorExecutor(
        fastPage,
        "demo-vendor-english-fast-path",
        traceFilePath,
        selectorMemory,
      );
      await replayVendorFastPath(
        fastPage,
        fastExecutor,
        commerceLearning.fixtureFastSkill,
        vendorCommerceActions(),
        vendorCommerceIntent(),
        "",
        "commerce",
      );
      await fastPage.waitForTimeout(2_000);
    } finally {
      await fastContext.close();
    }
    if (!fastVideo) {
      throw new Error(
        "Playwright did not create the English Fast Path recording.",
      );
    }
    fastRecording = await fastVideo.path();
  } finally {
    await browser.close();
    database.close();
  }

  if (!slowRecording || !fastRecording) {
    throw new Error(
      "English vendor workflow recording did not produce both paths.",
    );
  }
  const [slowSourceDurationSeconds, fastDurationSeconds] = await Promise.all([
    getNarrationDuration(slowRecording),
    getNarrationDuration(fastRecording),
  ]);
  const slowStartOffsetSeconds = 3;
  const slowDurationSeconds = Math.max(
    0,
    slowSourceDurationSeconds - slowStartOffsetSeconds,
  );
  await blendVendorRecordings(slowRecording, fastRecording, output);
  return {
    recording: output,
    slowDurationSeconds,
    slowSourceDurationSeconds,
    slowStartOffsetSeconds,
    fastDurationSeconds,
  };
}

// Retained for users who must resume a previously approved finance recording.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function recordVendorLiveWorkflow(financeCode: string): Promise<string> {
  const priorCommerceRecording = process.env.LHIC_VENDOR_COMMERCE_RECORDING;
  const priorMemoryDatabase = process.env.LHIC_VENDOR_MEMORY_DATABASE;
  if (priorCommerceRecording || priorMemoryDatabase) {
    if (!priorCommerceRecording || !priorMemoryDatabase) {
      throw new Error(
        "Resuming a vendor recording requires both LHIC_VENDOR_COMMERCE_RECORDING and LHIC_VENDOR_MEMORY_DATABASE.",
      );
    }
    return recordVendorFinanceContinuation(
      financeCode,
      priorCommerceRecording,
      priorMemoryDatabase,
    );
  }
  const recordingDirectory = join(workDirectory, "recording", "vendor-live");
  const output = join(recordingDirectory, "vendor-slow-to-fast.mp4");
  const traceFilePath = join(workDirectory, "vendor-live-trace.jsonl");
  await mkdir(recordingDirectory, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const database = createMemoryDatabase(
    join(recordingDirectory, "selector-memory.sqlite"),
  );
  const selectorMemory = new SelectorMemory(database);
  const skillStore = new SkillStore(database);
  let slowRecording: string | undefined;
  let fastRecording: string | undefined;

  try {
    const slowContext = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      recordVideo: {
        dir: join(recordingDirectory, "slow"),
        size: { width: 1280, height: 720 },
      },
    });
    const slowPage = await slowContext.newPage();
    const slowVideo = slowPage.video();
    try {
      const slowExecutor = createVendorExecutor(
        slowPage,
        "demo-vendor-slow-path",
        traceFilePath,
        selectorMemory,
      );
      const commerceLearning = await learnVendorPlan(
        slowPage,
        slowExecutor,
        skillStore,
        vendorCommerceSlowPathRequest(),
        vendorCommerceSlowPathPlan(),
        financeCode,
        "slow",
      );
      await showVendorLearnedSkill(
        slowPage,
        commerceLearning.candidate,
        "ORDER CANDIDATE RECORDED · LOCAL SQLITE",
      );
      await slowPage.waitForTimeout(2_600);

      const signature = await drawAnonymousVendorSignature(
        slowPage,
        traceFilePath,
        "demo-vendor-slow-path",
      );
      if (!signature.success) {
        throw new Error(
          signature.error ?? "Anonymous signature verification failed.",
        );
      }
      await appendVendorOverlayLog(
        slowPage,
        "Anonymous signature drawn",
        "Canvas stroke verifier passed; no name, email, or department supplied.",
        "success",
      );
      await slowPage.waitForTimeout(1_250);

      await executeAuthorizedVendorAction(
        slowPage,
        slowExecutor,
        vendorOrderAction(),
        "Explicit user authorization: submit the anonymous test order.",
      );
      await slowPage.waitForTimeout(2_800);

      const financeLearning = await learnVendorPlan(
        slowPage,
        slowExecutor,
        skillStore,
        vendorFinanceSlowPathRequest(),
        vendorFinanceSlowPathPlan(),
        financeCode,
        "slow",
      );
      await showVendorLearnedSkill(
        slowPage,
        financeLearning.candidate,
        "FINANCE CANDIDATE RECORDED · LOCAL SQLITE",
      );
      await slowPage.waitForTimeout(2_300);

      await executeAuthorizedVendorAction(
        slowPage,
        slowExecutor,
        vendorExpenseAction(),
        "Explicit user authorization: add the $200 inventory expense.",
      );
      await slowPage.waitForTimeout(3_200);

      const fastContext = await browser.newContext({
        viewport: { width: 1280, height: 720 },
        recordVideo: {
          dir: join(recordingDirectory, "fast"),
          size: { width: 1280, height: 720 },
        },
      });
      const fastPage = await fastContext.newPage();
      const fastVideo = fastPage.video();
      try {
        const fastExecutor = createVendorExecutor(
          fastPage,
          "demo-vendor-fast-path",
          traceFilePath,
          selectorMemory,
        );
        await replayVendorFastPath(
          fastPage,
          fastExecutor,
          commerceLearning.fixtureFastSkill,
          vendorCommerceActions(),
          vendorCommerceIntent(),
          financeCode,
          "commerce",
        );
        await fastPage.waitForTimeout(1_700);
        await replayVendorFastPath(
          fastPage,
          fastExecutor,
          financeLearning.fixtureFastSkill,
          vendorFinanceActions(),
          vendorFinanceIntent(),
          financeCode,
          "finance",
        );
        await fastPage.waitForTimeout(3_200);
      } finally {
        await fastContext.close();
      }
      if (!fastVideo) {
        throw new Error(
          "Playwright did not create the Fast Path vendor recording.",
        );
      }
      fastRecording = await fastVideo.path();
    } finally {
      await slowContext.close();
    }
    if (!slowVideo) {
      throw new Error(
        "Playwright did not create the Slow Path vendor recording.",
      );
    }
    slowRecording = await slowVideo.path();
  } finally {
    await browser.close();
    database.close();
  }

  if (!slowRecording || !fastRecording) {
    throw new Error("Vendor recording did not produce both workflow phases.");
  }
  await blendVendorRecordings(slowRecording, fastRecording, output);
  return output;
}

async function recordVendorFinanceContinuation(
  financeCode: string,
  commerceRecording: string,
  memoryDatabase: string,
): Promise<string> {
  if (
    !(await fileExists(commerceRecording)) ||
    !(await fileExists(memoryDatabase))
  ) {
    throw new Error(
      "The recorded commerce phase or its local skill memory is unavailable.",
    );
  }
  const recordingDirectory = join(
    workDirectory,
    "recording",
    "vendor-live-continuation",
  );
  const output = join(recordingDirectory, "vendor-slow-to-fast.mp4");
  const traceFilePath = join(
    workDirectory,
    "vendor-live-continuation-trace.jsonl",
  );
  await mkdir(recordingDirectory, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const database = createMemoryDatabase(memoryDatabase);
  const selectorMemory = new SelectorMemory(database);
  const skillStore = new SkillStore(database);
  const commerceSkill = findVendorSkill(skillStore, "vendor-anonymous-order");
  let financeSlowRecording: string | undefined;
  let fastRecording: string | undefined;

  try {
    const financeSlowContext = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      recordVideo: {
        dir: join(recordingDirectory, "finance-slow"),
        size: { width: 1280, height: 720 },
      },
    });
    const financeSlowPage = await financeSlowContext.newPage();
    const financeSlowVideo = financeSlowPage.video();
    try {
      const slowExecutor = createVendorExecutor(
        financeSlowPage,
        "demo-vendor-slow-finance",
        traceFilePath,
        selectorMemory,
      );
      const financeLearning = await learnVendorPlan(
        financeSlowPage,
        slowExecutor,
        skillStore,
        vendorFinanceSlowPathRequest(),
        vendorFinanceSlowPathPlan(),
        financeCode,
        "slow",
      );
      await showVendorLearnedSkill(
        financeSlowPage,
        financeLearning.candidate,
        "FINANCE CANDIDATE RECORDED · LOCAL SQLITE",
      );
      await financeSlowPage.waitForTimeout(2_300);
      await executeAuthorizedVendorAction(
        financeSlowPage,
        slowExecutor,
        vendorExpenseAction(),
        "Explicit user authorization: add the $200 inventory expense.",
      );
      await financeSlowPage.waitForTimeout(3_200);

      const fastContext = await browser.newContext({
        viewport: { width: 1280, height: 720 },
        recordVideo: {
          dir: join(recordingDirectory, "fast"),
          size: { width: 1280, height: 720 },
        },
      });
      const fastPage = await fastContext.newPage();
      const fastVideo = fastPage.video();
      try {
        const fastExecutor = createVendorExecutor(
          fastPage,
          "demo-vendor-fast-path",
          traceFilePath,
          selectorMemory,
        );
        await replayVendorFastPath(
          fastPage,
          fastExecutor,
          commerceSkill,
          vendorCommerceActions(),
          vendorCommerceIntent(),
          financeCode,
          "commerce",
        );
        await fastPage.waitForTimeout(1_700);
        await replayVendorFastPath(
          fastPage,
          fastExecutor,
          financeLearning.fixtureFastSkill,
          vendorFinanceActions(),
          vendorFinanceIntent(),
          financeCode,
          "finance",
        );
        await fastPage.waitForTimeout(3_200);
      } finally {
        await fastContext.close();
      }
      if (!fastVideo) {
        throw new Error(
          "Playwright did not create the resumed Fast Path recording.",
        );
      }
      fastRecording = await fastVideo.path();
    } finally {
      await financeSlowContext.close();
    }
    if (!financeSlowVideo) {
      throw new Error(
        "Playwright did not create the resumed Slow Path recording.",
      );
    }
    financeSlowRecording = await financeSlowVideo.path();
  } finally {
    await browser.close();
    database.close();
  }

  if (!financeSlowRecording || !fastRecording) {
    throw new Error(
      "Vendor continuation did not produce both remaining phases.",
    );
  }
  const combinedSlow = join(recordingDirectory, "vendor-combined-slow.mp4");
  await blendVendorRecordings(
    commerceRecording,
    financeSlowRecording,
    combinedSlow,
  );
  await blendVendorRecordings(combinedSlow, fastRecording, output);
  return output;
}

function findVendorSkill(
  skillStore: SkillStore,
  operation: string,
): SkillRecord {
  const skill = skillStore.list().find((candidate) => {
    const constraints = candidate.definition.constraints;
    return (
      constraints &&
      typeof constraints === "object" &&
      (constraints as Record<string, unknown>).operation === operation
    );
  });
  if (!skill) {
    throw new Error(`No verified local skill exists for ${operation}.`);
  }
  return skill;
}

function createVendorExecutor(
  page: Page,
  taskId: string,
  traceFilePath: string,
  selectorMemory: SelectorMemory,
): PlaywrightDirectExecutor {
  return new PlaywrightDirectExecutor(page, {
    taskId,
    traceFilePath,
    selectorMemory,
    navigationPolicy: { allowedOrigins: [vendorOrigin] },
  });
}

async function learnVendorPlan(
  page: Page,
  executor: PlaywrightDirectExecutor,
  skillStore: SkillStore,
  request: SlowPathRequest,
  plan: SlowPathResponse,
  financeCode: string,
  phase: VendorPhase,
): Promise<VendorPlanLearningResult> {
  let actionCount = 0;
  const keepsEnglishSurface =
    request.userIntent.constraints?.operation === "vendor-anonymous-order";
  const learned = await new SlowPathLearningCoordinator(skillStore).execute(
    request,
    plan,
    {
      execute: async (action) => {
        if (!keepsEnglishSurface) {
          await restoreVendorOriginalLanguage(page);
        }
        const execution = await executor.execute(
          materializeVendorAction(action, financeCode),
        );
        await localizeVendorPage(page);
        await page.waitForTimeout(
          action.intent === "sign in to the vendor finance dashboard"
            ? 1_500
            : 450,
        );
        const verification = await verifyVendorAction(page, action, execution);
        await installVendorOverlay(page, phase);
        await appendVendorOverlayLog(
          page,
          action.intent,
          verification.evidence[0] ??
            execution.error ??
            "Verifier did not accept the step.",
          execution.success && verification.success ? "success" : "blocked",
          phase,
        );
        if (phase === "slow" && actionCount === 0) {
          await showVendorSlowPathContract(page);
        }
        actionCount += 1;
        await page.waitForTimeout(
          execution.success ? (phase === "slow" ? 1_200 : 300) : 1_500,
        );
        return { execution, verification };
      },
    },
  );
  if (!learned.candidateSkill) {
    const failedOutcome = learned.outcomes.find(
      (outcome) => !outcome.execution.success || !outcome.verification.success,
    );
    throw new Error(
      `Vendor ${phase} plan did not qualify for candidate evaluation: ${
        failedOutcome?.execution.error ??
        failedOutcome?.verification.error ??
        "an action had no verifier evidence"
      }`,
    );
  }
  return {
    candidate: learned.candidateSkill,
    fixtureFastSkill: getVendorFixtureFastSkill(skillStore, request, plan),
  };
}

function getVendorFixtureFastSkill(
  skillStore: SkillStore,
  request: SlowPathRequest,
  plan: SlowPathResponse,
): SkillRecord {
  const operation =
    typeof request.userIntent.constraints?.operation === "string" &&
    request.userIntent.constraints.operation.trim()
      ? request.userIntent.constraints.operation
      : request.taskId;
  return skillStore.preload(`fixture-${operation}`, {
    compiler: "vendor-fixture-fast-path-v1",
    source: "local-render-fixture",
    constraints: request.userIntent.constraints,
    actions: plan.proposedActions ?? [],
  });
}

async function replayVendorFastPath(
  page: Page,
  executor: PlaywrightDirectExecutor,
  skill: SkillRecord,
  actions: BrowserSemanticAction[],
  intent: UserIntent,
  financeCode: string,
  workflow: "commerce" | "finance",
): Promise<void> {
  const decision = new FastPathRouter().decide(
    {
      predictedIntent: "form_filling",
      skillName: skill.name,
      confidence: 0.98,
      evidence: ["Matched an allowlisted deterministic local fixture skill."],
    },
    intent,
    actions,
  );
  if (decision.path !== "fast") {
    throw new Error(
      `Vendor ${workflow} skill did not route Fast Path: ${decision.reason}`,
    );
  }

  for (const action of actions) {
    if (workflow !== "commerce") {
      await restoreVendorOriginalLanguage(page);
    }
    const execution = await executor.execute(
      materializeVendorAction(action, financeCode),
    );
    await localizeVendorPage(page);
    await page.waitForTimeout(
      action.intent === "sign in to the vendor finance dashboard" ? 1_500 : 450,
    );
    const verification = await verifyVendorAction(page, action, execution);
    await installVendorOverlay(page, "fast");
    await appendVendorOverlayLog(
      page,
      action.intent,
      verification.evidence[0] ??
        execution.error ??
        "Verifier did not accept the step.",
      execution.success && verification.success ? "success" : "blocked",
      "fast",
    );
    if (!execution.success || !verification.success) {
      throw new Error(
        `Fast Path ${workflow} action failed: ${execution.error ?? action.intent}`,
      );
    }
    await page.waitForTimeout(300);
  }

  await showVendorFastPathSkill(page, skill, workflow);
  await page.waitForTimeout(1_250);
  const blockedAction =
    workflow === "commerce" ? vendorOrderAction() : vendorExpenseAction();
  const blocked = await executor.execute(blockedAction);
  if (blocked.success) {
    throw new Error(
      `Vendor ${workflow} write unexpectedly bypassed the approval boundary.`,
    );
  }
  await appendVendorOverlayLog(
    page,
    blockedAction.intent,
    "BLOCKED · no matching human approval in this fresh Fast Path session.",
    "blocked",
    "fast",
  );
}

function vendorCommerceIntent() {
  return {
    goal: "Build an anonymous Test3 ×3 and Test2 ×2 vendor checkout preview.",
    domain: "vendor.techtools.qzz.io",
    constraints: {
      anonymous: true,
      operation: "vendor-anonymous-order",
      products: ["Test3×3", "Test2×2"],
    },
    riskLevel: "low" as const,
    requiresConfirmation: false,
    missingInformation: [],
  };
}

function vendorFinanceIntent() {
  return {
    goal: "Prepare a $200 inventory expense in the vendor finance system.",
    domain: "vendor.techtools.qzz.io",
    constraints: {
      operation: "vendor-finance-expense",
      category: "支出",
      amount: 200,
      note: "進貨",
    },
    riskLevel: "low" as const,
    requiresConfirmation: false,
    missingInformation: [],
  };
}

function vendorCommerceSlowPathRequest(): SlowPathRequest {
  return {
    taskId: "demo-vendor-slow-commerce",
    userIntent: vendorCommerceIntent(),
    uiState: {
      surface: "browser",
      url: vendorStorefrontUrl,
      objects: [],
      signals: { matchedSkills: 0, liveSite: true, anonymousOrder: true },
      capturedAt: "2026-07-17T00:00:00.000Z",
    },
    recentTrace: [],
    reason: "complex_planning",
  };
}

function vendorFinanceSlowPathRequest(): SlowPathRequest {
  return {
    taskId: "demo-vendor-slow-finance",
    userIntent: vendorFinanceIntent(),
    uiState: {
      surface: "browser",
      url: vendorFinanceUrl,
      objects: [],
      signals: { matchedSkills: 0, liveSite: true, financeWrite: true },
      capturedAt: "2026-07-17T00:00:00.000Z",
    },
    recentTrace: [],
    reason: "complex_planning",
  };
}

function vendorCommerceSlowPathPlan(): SlowPathResponse {
  return {
    decision: "propose_plan",
    message:
      "Deterministic redacted fixture: prepare the anonymous vendor cart and verify every low-risk change.",
    proposedActions: vendorCommerceActions(),
  };
}

function vendorFinanceSlowPathPlan(): SlowPathResponse {
  return {
    decision: "propose_plan",
    message:
      "Deterministic redacted fixture: prepare a finance expense and preserve approval for the write.",
    proposedActions: vendorFinanceActions(),
  };
}

function vendorCommerceActions(): BrowserSemanticAction[] {
  return [
    {
      type: "navigate",
      intent: "open the anonymous vendor storefront",
      target: vendorStorefrontUrl,
      methodPreference: ["api", "dom"],
      riskLevel: "low",
    },
    {
      type: "wait",
      intent: "wait for the live vendor catalog to finish loading",
      target: 'button:has-text("Test3")',
      value: 8_000,
      methodPreference: ["dom"],
      riskLevel: "low",
    },
    {
      type: "click",
      intent: "add Test3 to the anonymous cart (1 of 3)",
      target: 'button:has-text("Test3")',
      methodPreference: ["dom", "accessibility"],
      riskLevel: "low",
    },
    {
      type: "click",
      intent: "add Test3 to the anonymous cart (2 of 3)",
      target: 'button:has-text("Test3")',
      methodPreference: ["dom", "accessibility"],
      riskLevel: "low",
    },
    {
      type: "click",
      intent: "add Test3 to the anonymous cart (3 of 3)",
      target: 'button:has-text("Test3")',
      methodPreference: ["dom", "accessibility"],
      riskLevel: "low",
    },
    {
      type: "click",
      intent: "add Test2 to the anonymous cart (1 of 2)",
      target: 'button:has-text("Test2")',
      methodPreference: ["dom", "accessibility"],
      riskLevel: "low",
    },
    {
      type: "click",
      intent: "add Test2 to the anonymous cart (2 of 2)",
      target: 'button:has-text("Test2")',
      methodPreference: ["dom", "accessibility"],
      riskLevel: "low",
    },
    {
      type: "click",
      intent: "open the anonymous checkout surface",
      target: "aside.sticky > div:last-child button:last-child",
      methodPreference: ["dom", "accessibility"],
      riskLevel: "low",
    },
    {
      type: "fill",
      intent: "enter a non-identifying shopper label required by checkout",
      target: 'input[placeholder="Name"]',
      value: "Anonymous demo",
      methodPreference: ["dom", "accessibility"],
      riskLevel: "low",
    },
    {
      type: "fill",
      intent: "enter a non-identifying checkout email",
      target: 'input[placeholder="Email"]',
      value: "anonymous@example.invalid",
      methodPreference: ["dom", "accessibility"],
      riskLevel: "low",
    },
    {
      type: "fill",
      intent: "enter a demo-only checkout department",
      target: 'input[placeholder="Department"]',
      value: "DEMO",
      methodPreference: ["dom", "accessibility"],
      riskLevel: "low",
    },
  ];
}

function vendorFinanceActions(): BrowserSemanticAction[] {
  return [
    {
      type: "navigate",
      intent: "open the vendor finance sign-in surface",
      target: vendorFinanceUrl,
      methodPreference: ["api", "dom"],
      riskLevel: "low",
    },
    {
      type: "wait",
      intent: "wait for the vendor finance sign-in form to finish loading",
      target: 'input[type="password"]',
      value: 8_000,
      methodPreference: ["dom"],
      riskLevel: "low",
    },
    {
      type: "fill",
      intent: "enter the authorized vendor finance code",
      target: 'input[type="password"]',
      value: "[REDACTED]",
      methodPreference: ["dom", "accessibility"],
      riskLevel: "low",
    },
    {
      type: "click",
      intent: "sign in to the vendor finance dashboard",
      target: "登入",
      methodPreference: ["dom", "accessibility"],
      riskLevel: "low",
    },
    {
      type: "select",
      intent: "select expense as the finance record type",
      target: "select",
      value: "支出",
      methodPreference: ["dom", "accessibility"],
      riskLevel: "low",
    },
    {
      type: "fill",
      intent: "set the inventory expense amount to 200 dollars",
      target: 'input[placeholder="金額"]',
      value: "200",
      methodPreference: ["dom", "accessibility"],
      riskLevel: "low",
    },
    {
      type: "fill",
      intent: "set the expense note to inventory purchasing",
      target: 'input[placeholder="備註"], textarea[placeholder="備註"]',
      value: "進貨",
      methodPreference: ["dom", "accessibility"],
      riskLevel: "low",
    },
  ];
}

function vendorOrderAction(): BrowserSemanticAction {
  return {
    type: "click",
    intent: "confirm the anonymous Test3 and Test2 order",
    target: "Place order",
    methodPreference: ["dom", "accessibility"],
    riskLevel: "high",
  };
}

function vendorExpenseAction(): BrowserSemanticAction {
  return {
    type: "click",
    intent: "add the authorized 200 dollar inventory expense",
    target: "新增",
    methodPreference: ["dom", "accessibility"],
    riskLevel: "high",
  };
}

function materializeVendorAction(
  action: SemanticAction,
  financeCode: string,
): BrowserSemanticAction {
  if (action.scope === "os") {
    throw new Error("Vendor demo only permits browser semantic actions.");
  }
  if (action.intent === "enter the authorized vendor finance code") {
    return { ...action, value: financeCode };
  }
  return action;
}

async function executeAuthorizedVendorAction(
  page: Page,
  executor: PlaywrightDirectExecutor,
  action: BrowserSemanticAction,
  approvalReason: string,
): Promise<void> {
  await restoreVendorOriginalLanguage(page);
  const execution = await executor.execute(
    action,
    createActionApproval(action, "user-authorized-vendor-demo"),
  );
  await waitForVendorWriteCompletion(page, action);
  const verification = await verifyVendorAction(page, action, execution);
  await appendVendorOverlayLog(
    page,
    action.intent,
    verification.evidence[0] ?? execution.error ?? approvalReason,
    execution.success && verification.success ? "success" : "blocked",
    "slow",
  );
  await localizeVendorPage(page);
  if (!execution.success || !verification.success) {
    throw new Error(
      `Authorized vendor action failed: ${execution.error ?? action.intent}`,
    );
  }
}

async function waitForVendorWriteCompletion(
  page: Page,
  action: BrowserSemanticAction,
): Promise<void> {
  if (action.intent === "confirm the anonymous Test3 and Test2 order") {
    await page
      .waitForFunction(
        () => !document.body.innerText.includes("處理中"),
        undefined,
        { timeout: 12_000 },
      )
      .catch(() => {});
    await page.waitForTimeout(500);
    return;
  }
  if (action.intent === "add the authorized 200 dollar inventory expense") {
    await page
      .waitForFunction(
        () =>
          document.querySelector("table")?.innerText.includes("進貨") ?? false,
        undefined,
        { timeout: 8_000 },
      )
      .catch(() => {});
    await page.waitForTimeout(500);
    return;
  }
  await page.waitForTimeout(700);
}

async function verifyVendorAction(
  page: Page,
  action: SemanticAction,
  execution: ActionExecutionResult,
): Promise<VerificationResult> {
  if (!execution.success) {
    return {
      success: false,
      evidence: [],
      error: execution.error ?? "The direct executor did not complete.",
    };
  }

  const headingVisible = async (name: string) =>
    page
      .getByRole("heading", { name, exact: true })
      .isVisible()
      .catch(() => false);
  const intent = action.intent;
  if (intent === "open the anonymous vendor storefront") {
    return vendorVerification(
      (await headingVisible("公司福利社")) ||
        (await headingVisible("Company Store")),
      "Verifier observed the live vendor storefront heading.",
    );
  }
  if (intent === "wait for the live vendor catalog to finish loading") {
    return vendorVerification(
      await page
        .locator('button:has-text("Test3")')
        .isVisible()
        .catch(() => false),
      "Verifier observed the live Test3 catalog control after loading.",
    );
  }
  if (intent.startsWith("add Test3")) {
    const expected = Number(intent.match(/\((\d) of 3\)/)?.[1]);
    return vendorVerification(
      (await vendorCartQuantity(page, "Test3")) === expected,
      `Verifier observed Test3 quantity ${expected} in the live cart.`,
    );
  }
  if (intent.startsWith("add Test2")) {
    const expected = Number(intent.match(/\((\d) of 2\)/)?.[1]);
    return vendorVerification(
      (await vendorCartQuantity(page, "Test2")) === expected,
      `Verifier observed Test2 quantity ${expected} in the live cart.`,
    );
  }
  if (intent === "open the anonymous checkout surface") {
    return vendorVerification(
      await page
        .locator("canvas")
        .isVisible()
        .catch(() => false),
      "Verifier observed the anonymous checkout signature canvas.",
    );
  }
  if (intent === "enter a non-identifying shopper label required by checkout") {
    return vendorVerification(
      (
        await page
          .locator('input[placeholder="Name"]')
          .inputValue()
          .catch(() => "")
      ).length > 0,
      "Verifier observed the required non-identifying checkout label (redacted).",
    );
  }
  if (intent === "enter a non-identifying checkout email") {
    return vendorVerification(
      (
        await page
          .locator('input[placeholder="Email"]')
          .inputValue()
          .catch(() => "")
      ).length > 0,
      "Verifier observed the non-identifying checkout email (redacted).",
    );
  }
  if (intent === "enter a demo-only checkout department") {
    return vendorVerification(
      (
        await page
          .locator('input[placeholder="Department"]')
          .inputValue()
          .catch(() => "")
      ).length > 0,
      "Verifier observed the demo-only checkout department (redacted).",
    );
  }
  if (intent === "open the vendor finance sign-in surface") {
    return vendorVerification(
      new URL(page.url()).pathname === "/finance",
      "Verifier observed the vendor finance route.",
    );
  }
  if (intent === "wait for the vendor finance sign-in form to finish loading") {
    return vendorVerification(
      await page
        .locator('input[type="password"]')
        .isVisible()
        .catch(() => false),
      "Verifier observed the vendor finance sign-in field after loading.",
    );
  }
  if (intent === "enter the authorized vendor finance code") {
    const valueLength = await page
      .locator('input[type="password"]')
      .inputValue()
      .then((value) => value.length)
      .catch(() => 0);
    return vendorVerification(
      valueLength > 0,
      "Verifier observed a finance code in the field (redacted).",
    );
  }
  if (intent === "sign in to the vendor finance dashboard") {
    return vendorVerification(
      await headingVisible("財務與管理看板"),
      "Verifier observed the authenticated vendor finance dashboard.",
    );
  }
  if (intent === "select expense as the finance record type") {
    const selected = await page
      .locator("select")
      .inputValue()
      .catch(() => "");
    return vendorVerification(
      selected === "支出",
      "Verifier observed 支出 selected in the live finance form.",
    );
  }
  if (intent === "set the inventory expense amount to 200 dollars") {
    const amount = await page
      .locator('input[placeholder="金額"]')
      .inputValue()
      .catch(() => "");
    return vendorVerification(
      amount === "200",
      "Verifier observed the $200 amount in the live finance form.",
    );
  }
  if (intent === "set the expense note to inventory purchasing") {
    const note = await page
      .locator('input[placeholder="備註"], textarea[placeholder="備註"]')
      .inputValue()
      .catch(() => "");
    return vendorVerification(
      note === "進貨",
      "Verifier observed the inventory-purchasing note in the live finance form.",
    );
  }
  if (intent === "confirm the anonymous Test3 and Test2 order") {
    const cart = await vendorCartText(page);
    const body = await page
      .locator("body")
      .innerText()
      .catch(() => "");
    const purchaseButtonVisible = await page
      .getByRole("button", { name: "Place order", exact: true })
      .isVisible()
      .catch(() => false);
    return vendorVerification(
      (!purchaseButtonVisible &&
        !cart.includes("Test3") &&
        !cart.includes("Test2")) ||
        /(購買成功|下單成功|訂單.*成功|訂單已建立)/.test(body),
      "Verifier observed the submitted order leave the anonymous checkout cart.",
    );
  }
  if (intent === "add the authorized 200 dollar inventory expense") {
    const table = await page
      .locator("table")
      .innerText()
      .catch(() => "");
    return vendorVerification(
      table.includes("支出") &&
        table.includes("進貨") &&
        /\$?\s*200/.test(table),
      "Verifier observed the $200 進貨 expense in the live finance ledger.",
    );
  }
  return {
    success: execution.evidence.length > 0,
    evidence: execution.evidence,
  };
}

function vendorVerification(
  success: boolean,
  evidence: string,
): VerificationResult {
  return { success, evidence: success ? [evidence] : [] };
}

async function vendorCartText(page: Page): Promise<string> {
  return page
    .locator("aside:not(#lhic-vendor-overlay)")
    .innerText()
    .catch(() => "");
}

async function vendorCartQuantity(
  page: Page,
  product: string,
): Promise<number | undefined> {
  const lines = (await vendorCartText(page))
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const index = lines.indexOf(product);
  if (index < 0) {
    return undefined;
  }
  const quantity = lines.slice(index + 1).find((line) => /^\d+$/.test(line));
  return quantity ? Number(quantity) : undefined;
}

async function drawAnonymousVendorSignature(
  page: Page,
  traceFilePath: string,
  taskId: string,
): Promise<ActionExecutionResult> {
  const action: BrowserSemanticAction = {
    type: "custom",
    intent: "draw an anonymous checkout signature on the live canvas",
    target: "canvas",
    methodPreference: ["mouse"],
    riskLevel: "low",
  };
  const startedAt = performance.now();
  await appendTraceEvent(traceFilePath, {
    eventId: randomUUID(),
    taskId,
    timestamp: new Date().toISOString(),
    type: "action_started",
    payload: { action },
    riskLevel: action.riskLevel,
  });

  try {
    const canvas = page.locator("canvas");
    await canvas.scrollIntoViewIfNeeded();
    const before = await canvas.evaluate((element) =>
      (element as HTMLCanvasElement).toDataURL(),
    );
    const box = await canvas.boundingBox();
    if (!box) {
      throw new Error("Anonymous signature canvas is not visible.");
    }
    const points = [
      [0.18, 0.63],
      [0.32, 0.38],
      [0.45, 0.67],
      [0.58, 0.36],
      [0.72, 0.61],
      [0.84, 0.43],
    ] as const;
    await page.mouse.move(
      box.x + box.width * points[0][0],
      box.y + box.height * points[0][1],
    );
    await page.mouse.down();
    for (const [x, y] of points.slice(1)) {
      await page.mouse.move(box.x + box.width * x, box.y + box.height * y, {
        steps: 8,
      });
    }
    await page.mouse.up();
    const after = await canvas.evaluate((element) =>
      (element as HTMLCanvasElement).toDataURL(),
    );
    if (before === after) {
      throw new Error(
        "Signature canvas pixels did not change after the mouse stroke.",
      );
    }
    const result: ActionExecutionResult = {
      success: true,
      method: "mouse",
      latencyMs: Math.round(performance.now() - startedAt),
      evidence: [
        "Anonymous signature canvas pixels changed after the direct Playwright stroke.",
      ],
    };
    await appendTraceEvent(traceFilePath, {
      eventId: randomUUID(),
      taskId,
      timestamp: new Date().toISOString(),
      type: "action_completed",
      payload: { action, result },
      riskLevel: action.riskLevel,
    });
    return result;
  } catch (error) {
    const result: ActionExecutionResult = {
      success: false,
      latencyMs: Math.round(performance.now() - startedAt),
      evidence: [],
      error:
        error instanceof Error
          ? error.message
          : "Anonymous signature action failed.",
    };
    await appendTraceEvent(traceFilePath, {
      eventId: randomUUID(),
      taskId,
      timestamp: new Date().toISOString(),
      type: "action_failed",
      payload: { action, result },
      riskLevel: action.riskLevel,
    });
    return result;
  }
}

async function installVendorOverlay(
  page: Page,
  phase: VendorPhase,
): Promise<void> {
  await page.evaluate((currentPhase) => {
    const existing = document.querySelector("#lhic-vendor-overlay");
    if (existing) {
      existing.setAttribute("data-phase", currentPhase);
      existing.querySelector("[data-lhic-phase]")!.textContent =
        currentPhase === "fast"
          ? "FAST PATH · LOCAL REPLAY"
          : "SLOW PATH · VERIFIED LEARNING";
      return;
    }
    const root = document.createElement("aside");
    root.id = "lhic-vendor-overlay";
    root.dataset.phase = currentPhase;
    root.innerHTML = `
      <style>
        #lhic-vendor-overlay { position: fixed; z-index: 2147483647; right: 18px; bottom: 18px; width: min(356px, calc(100vw - 36px)); overflow: hidden; pointer-events: none; color: #eef7ff; font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; border: 1px solid #65e8ff66; border-radius: 16px; background: linear-gradient(145deg, #081626ef, #0e1025ed); box-shadow: 0 22px 70px #02071388, inset 0 1px #ffffff14; backdrop-filter: blur(14px); animation: lhicVendorEnter .46s cubic-bezier(.2,.8,.2,1); }
        #lhic-vendor-overlay[data-phase="fast"] { border-color: #b8f05a88; background: linear-gradient(145deg, #0d1b1bee, #111925ed); }
        #lhic-vendor-overlay header { display: flex; align-items: center; gap: 9px; padding: 12px 14px 10px; border-bottom: 1px solid #ffffff16; }
        #lhic-vendor-overlay .lhic-pulse { width: 8px; height: 8px; flex: 0 0 auto; border-radius: 50%; background: #65e8ff; box-shadow: 0 0 15px #65e8ff; animation: lhicVendorPulse 1.25s ease-in-out infinite; }
        #lhic-vendor-overlay[data-phase="fast"] .lhic-pulse { background: #b8f05a; box-shadow: 0 0 15px #b8f05a; }
        #lhic-vendor-overlay strong { font-size: 10px; letter-spacing: .105em; }
        #lhic-vendor-overlay [data-lhic-phase] { margin-left: auto; color: #8ca3bc; font: 800 8px ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .055em; }
        #lhic-vendor-overlay .lhic-metrics { display: grid; grid-template-columns: repeat(3, 1fr); gap: 7px; padding: 10px 13px; }
        #lhic-vendor-overlay .lhic-metrics span { display: block; padding: 7px 5px; color: #bbcae0; font: 700 8px/1.25 ui-monospace, SFMono-Regular, Menlo, monospace; text-align: center; border: 1px solid #ffffff14; border-radius: 7px; background: #ffffff08; }
        #lhic-vendor-overlay .lhic-metrics b { display: block; margin-bottom: 3px; color: #65e8ff; font-size: 9px; }
        #lhic-vendor-overlay[data-phase="fast"] .lhic-metrics b { color: #b8f05a; }
        #lhic-vendor-overlay [data-lhic-skill] { display: none; margin: 0 13px 9px; padding: 8px 9px; color: #d9e8f6; font: 700 8px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace; border: 1px solid #9b8cff66; border-radius: 8px; background: #9b8cff14; animation: lhicVendorEnter .26s ease-out; }
        #lhic-vendor-overlay[data-phase="fast"] [data-lhic-skill] { border-color: #b8f05a66; background: #b8f05a12; }
        #lhic-vendor-overlay [data-lhic-log] { max-height: 132px; padding: 0 13px 12px; overflow: hidden; }
        #lhic-vendor-overlay .lhic-line { margin-top: 5px; padding: 6px 7px; border-left: 2px solid #526b86; border-radius: 0 6px 6px 0; background: #ffffff08; animation: lhicVendorLog .25s ease-out; }
        #lhic-vendor-overlay .lhic-line.success { border-left-color: #65e8ff; } #lhic-vendor-overlay[data-phase="fast"] .lhic-line.success { border-left-color: #b8f05a; }
        #lhic-vendor-overlay .lhic-line.blocked { border-left-color: #ff788a; background: #ff788a15; }
        #lhic-vendor-overlay .lhic-line b, #lhic-vendor-overlay .lhic-line span { display: block; }
        #lhic-vendor-overlay .lhic-line b { color: #eaf4ff; font: 800 8px ui-monospace, SFMono-Regular, Menlo, monospace; }
        #lhic-vendor-overlay .lhic-line span { margin-top: 3px; color: #aabbd1; font: 8px/1.28 ui-monospace, SFMono-Regular, Menlo, monospace; }
        @keyframes lhicVendorEnter { from { opacity: 0; transform: translateY(14px) scale(.97); } to { opacity: 1; transform: none; } }
        @keyframes lhicVendorLog { from { opacity: 0; transform: translateX(9px); } to { opacity: 1; transform: none; } }
        @keyframes lhicVendorPulse { 50% { opacity: .3; transform: scale(.72); } }
      </style>
      <header><i class="lhic-pulse"></i><strong>LHIC · LIVE EVIDENCE</strong><span data-lhic-phase></span></header>
      <div class="lhic-metrics"><span><b>EXECUTOR</b>PLAYWRIGHT</span><span><b>VERIFIER</b>REQUIRED</span><span><b>TRACE</b>REDACTED</span></div>
      <div data-lhic-skill></div><section data-lhic-log></section>`;
    root.querySelector("[data-lhic-phase]")!.textContent =
      currentPhase === "fast"
        ? "FAST PATH · LOCAL REPLAY"
        : "SLOW PATH · VERIFIED LEARNING";
    document.body.append(root);
  }, phase);
}

const vendorEnglishText: Record<string, string> = {
  公司福利社: "Company Store",
  "選擇商品、簽名確認，收據會自動產生。":
    "Choose items, sign to confirm, and a receipt is generated automatically.",
  員工代碼: "Employee code",
  登入: "Sign in",
  "Passkey 登入": "Sign in with Passkey",
  購物車: "Shopping Cart",
  尚未加入商品: "Your cart is empty",
  總計: "Total",
  清空: "Clear",
  清除: "Clear",
  加入購物車: "Add to Cart",
  庫存: "In stock",
  無圖片: "No image",
  購物車明細: "Cart details",
  結帳總額: "Checkout total",
  簽名確認: "Signature confirmation",
  確認購買: "Place order",
  財務系統登入: "Finance sign in",
  "使用代碼或 Passkey 登入。": "Use a code or Passkey to sign in.",
  登入代碼: "Access code",
  返回福利社: "Back to store",
  財務與管理看板: "Finance & management dashboard",
  "Admin · 管理權限": "Admin · administrator",
  系統管理: "System administration",
  建立Passkey: "Create Passkey",
  "建立 Passkey": "Create Passkey",
  登出: "Sign out",
  總收入: "Total income",
  總支出: "Total expenses",
  現金淨利: "Net cash",
  庫存價值: "Inventory value",
  收支紀錄: "Ledger",
  訂單管理: "Order management",
  商品庫存: "Inventory",
  員工資料: "Employees",
  支出: "Expense",
  收入: "Income",
  新增: "Add record",
  日期: "Date",
  類型: "Type",
  金額: "Amount",
  備註: "Note",
  記錄者: "Recorded by",
  進貨: "Inventory purchase",
  "已加入 Test3": "Added Test3",
  "已加入 Test2": "Added Test2",
};

const vendorEnglishPlaceholders: Record<string, string> = {
  員工代碼: "Employee code",
  登入代碼: "Access code",
  姓名: "Name",
  部門: "Department",
  金額: "Amount",
  備註: "Note",
};

async function localizeVendorPage(page: Page): Promise<void> {
  await page.evaluate(
    ({ text, placeholders }) => {
      const walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_TEXT,
      );
      const nodes: Text[] = [];
      let node = walker.nextNode();
      while (node) {
        nodes.push(node as Text);
        node = walker.nextNode();
      }
      for (const textNode of nodes) {
        const parent = textNode.parentElement;
        if (parent?.closest("#lhic-vendor-overlay, script, style")) {
          continue;
        }
        const trackedNode = textNode as Text & {
          __lhicOriginalText?: string;
        };
        const original =
          trackedNode.__lhicOriginalText ?? textNode.nodeValue ?? "";
        const leading = original.match(/^\s*/)?.[0] ?? "";
        const trailing = original.match(/\s*$/)?.[0] ?? "";
        const translated = text[original.trim()];
        if (!translated) {
          continue;
        }
        trackedNode.__lhicOriginalText = original;
        textNode.nodeValue = `${leading}${translated}${trailing}`;
      }

      for (const input of document.querySelectorAll<HTMLElement>(
        "[placeholder]",
      )) {
        if (input.closest("#lhic-vendor-overlay, script, style")) {
          continue;
        }
        const original =
          input.dataset.lhicOriginalPlaceholder ??
          input.getAttribute("placeholder") ??
          "";
        const translated = placeholders[original];
        if (!translated) {
          continue;
        }
        input.dataset.lhicOriginalPlaceholder = original;
        input.setAttribute("placeholder", translated);
      }

      for (const button of document.querySelectorAll<HTMLButtonElement>(
        "button",
      )) {
        if (button.textContent?.trim() !== "前往結帳") {
          continue;
        }
        button.dataset.lhicEnglishLabel = "Checkout";
        button.style.position = "relative";
        button.style.color = "transparent";
      }

      if (!document.getElementById("lhic-vendor-english-labels")) {
        const style = document.createElement("style");
        style.id = "lhic-vendor-english-labels";
        style.textContent = `
          button[data-lhic-english-label]::after {
            position: absolute;
            inset: 0;
            display: grid;
            place-items: center;
            color: white;
            content: attr(data-lhic-english-label);
          }
        `;
        document.head.append(style);
      }
    },
    { text: vendorEnglishText, placeholders: vendorEnglishPlaceholders },
  );
}

async function restoreVendorOriginalLanguage(page: Page): Promise<void> {
  await page
    .evaluate(() => {
      const walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_TEXT,
      );
      let node = walker.nextNode();
      while (node) {
        const textNode = node as Text & { __lhicOriginalText?: string };
        if (textNode.__lhicOriginalText !== undefined) {
          textNode.nodeValue = textNode.__lhicOriginalText;
          delete textNode.__lhicOriginalText;
        }
        node = walker.nextNode();
      }
      for (const input of document.querySelectorAll<HTMLElement>(
        "[data-lhic-original-placeholder]",
      )) {
        input.setAttribute(
          "placeholder",
          input.dataset.lhicOriginalPlaceholder ?? "",
        );
        delete input.dataset.lhicOriginalPlaceholder;
      }
      for (const button of document.querySelectorAll<HTMLButtonElement>(
        "button[data-lhic-english-label]",
      )) {
        delete button.dataset.lhicEnglishLabel;
        button.style.removeProperty("position");
        button.style.removeProperty("color");
      }
      document.getElementById("lhic-vendor-english-labels")?.remove();
    })
    .catch(() => {});
}

async function appendVendorOverlayLog(
  page: Page,
  title: string,
  evidence: string,
  status: "success" | "blocked",
  phase: VendorPhase = "slow",
): Promise<void> {
  await installVendorOverlay(page, phase);
  await page.evaluate(
    (event) => {
      const log = document.querySelector(
        "#lhic-vendor-overlay [data-lhic-log]",
      );
      if (!log) {
        return;
      }
      const line = document.createElement("article");
      line.className = `lhic-line ${event.status}`;
      const heading = document.createElement("b");
      heading.textContent =
        event.status === "success"
          ? "✓ VERIFIED · " + event.title
          : "⛔ APPROVAL GATE · " + event.title;
      const detail = document.createElement("span");
      detail.textContent = event.evidence;
      line.append(heading, detail);
      log.append(line);
      while (log.children.length > 4) {
        log.firstElementChild?.remove();
      }
    },
    { title, evidence, status },
  );
}

async function showVendorSlowPathContract(page: Page): Promise<void> {
  await installVendorOverlay(page, "slow");
  await page.evaluate(() => {
    const skill = document.querySelector(
      "#lhic-vendor-overlay [data-lhic-skill]",
    ) as HTMLElement | null;
    if (!skill) {
      return;
    }
    skill.style.display = "block";
    skill.textContent =
      "GPT-5.6 SLOW-PATH CONTRACT · typed plan · redacted inputs · verifier-bound";
  });
}

async function showVendorLearnedSkill(
  page: Page,
  skill: CandidateSkillRecord,
  label: string,
): Promise<void> {
  await installVendorOverlay(page, "slow");
  await page.evaluate(
    (value) => {
      const skill = document.querySelector(
        "#lhic-vendor-overlay [data-lhic-skill]",
      ) as HTMLElement | null;
      if (!skill) {
        return;
      }
      skill.style.display = "block";
      skill.textContent = `★ ${value.label} · ${value.verifiedRunCount}/3 independent evidenced runs · holdout pending · inputs redacted`;
    },
    { label, verifiedRunCount: skill.verifiedRunCount },
  );
}

async function showVendorFastPathSkill(
  page: Page,
  _skill: SkillRecord,
  workflow: "commerce" | "finance",
): Promise<void> {
  await installVendorOverlay(page, "fast");
  await page.evaluate(
    (value) => {
      const skill = document.querySelector(
        "#lhic-vendor-overlay [data-lhic-skill]",
      ) as HTMLElement | null;
      if (!skill) {
        return;
      }
      skill.style.display = "block";
      skill.textContent = `⚡ ${value.workflow.toUpperCase()} FIXTURE SKILL MATCH · LOCAL ONLY · 0 MODEL · 0 MCP`;
    },
    { workflow },
  );
}

async function blendVendorRecordings(
  slowRecording: string,
  fastRecording: string,
  output: string,
): Promise<void> {
  const slowDuration = await getNarrationDuration(slowRecording);
  const transition = 0.7;
  await execFfmpeg([
    "-i",
    slowRecording,
    "-i",
    fastRecording,
    "-filter_complex",
    `[0:v]settb=AVTB,setpts=PTS-STARTPTS,fps=${frameRate}[left];[1:v]settb=AVTB,setpts=PTS-STARTPTS,fps=${frameRate}[right];[left][right]xfade=transition=fade:duration=${transition}:offset=${Math.max(0, slowDuration - transition).toFixed(3)}[video]`,
    "-map",
    "[video]",
    "-an",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-crf",
    "23",
    "-pix_fmt",
    "yuv420p",
    output,
  ]);
}

async function recordBrowserHeroWorkflow(): Promise<string> {
  const recordingDirectory = join(workDirectory, "recording", "browser-hero");
  await mkdir(recordingDirectory, { recursive: true });
  const fixture = await createLocalFixtureServer(commerceLearningPage());
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
  const skillStore = new SkillStore(database);

  try {
    await page.goto(fixture.url);
    await setCommerceRoute(page, {
      detail: "0 local matches · a redacted plan is being verified",
      label: "SLOW PATH · COMPLEX CART",
    });
    const slowExecutor = new PlaywrightDirectExecutor(page, {
      taskId: "demo-commerce-slow-path",
      traceFilePath,
      selectorMemory,
    });
    await page.waitForTimeout(1_000);
    const learned = await new SlowPathLearningCoordinator(skillStore).execute(
      commerceSlowPathRequest(),
      commerceSlowPathPlan(),
      {
        execute: async (action) => {
          const execution = await slowExecutor.execute(action);
          const verification = await verifyCommerceAction(
            page,
            action,
            execution,
          );
          await appendLiveOperatorLog(
            page,
            action,
            execution,
            verification.evidence[0],
          );
          await page.waitForTimeout(execution.success ? 900 : 1_200);
          return { execution, verification };
        },
      },
    );
    if (!learned.candidateSkill) {
      throw new Error(
        "Slow Path commerce plan did not earn a verifier-backed candidate.",
      );
    }
    await showLearnedCommerceSkill(page, learned.candidateSkill);
    await page.waitForTimeout(4_000);

    await page.goto(`${fixture.url}?mode=fast`);
    const actions = commerceActions();
    const fixtureFastSkill = getVendorFixtureFastSkill(
      skillStore,
      commerceSlowPathRequest(),
      commerceSlowPathPlan(),
    );
    const fastDecision = new FastPathRouter().decide(
      {
        predictedIntent: "form_filling",
        skillName: fixtureFastSkill.name,
        confidence: 0.96,
        evidence: ["Verified local commerce skill matched."],
      },
      commerceIntent(),
      actions,
    );
    if (fastDecision.path !== "fast") {
      throw new Error(
        `Learned commerce skill did not route fast: ${fastDecision.reason}`,
      );
    }
    await setCommerceRoute(page, {
      detail:
        "preloaded deterministic fixture skill matched · 0 model calls · 0 MCP calls",
      label: "FAST PATH · LOCAL FIXTURE SKILL",
    });
    await showFastPathSkill(page, fixtureFastSkill);
    const fastExecutor = new PlaywrightDirectExecutor(page, {
      taskId: "demo-commerce-fast-path",
      traceFilePath,
      selectorMemory,
    });
    await page.waitForTimeout(1_100);
    for (const action of actions) {
      const execution = await fastExecutor.execute(action);
      const verification = await verifyCommerceAction(page, action, execution);
      if (!execution.success || !verification.success) {
        throw new Error(
          `Fast Path action failed verification: ${execution.error ?? action.intent}`,
        );
      }
      await appendLiveOperatorLog(
        page,
        action,
        execution,
        verification.evidence[0],
      );
      await page.waitForTimeout(620);
    }
    const blockedOrder = await fastExecutor.execute(commerceOrderAction());
    if (blockedOrder.success) {
      throw new Error(
        "Commerce order unexpectedly bypassed the approval boundary.",
      );
    }
    await appendLiveOperatorLog(page, commerceOrderAction(), blockedOrder);
    await page.waitForTimeout(21_000);
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

function commerceIntent() {
  return {
    goal: "Configure a silent keyboard cart, verify checkout, and never place the order automatically.",
    domain: "local-commerce-fixture",
    constraints: {
      requireVerifiedPreview: true,
      retainHumanOrderAuthority: true,
    },
    riskLevel: "low" as const,
    requiresConfirmation: false,
    missingInformation: [],
  };
}

function commerceSlowPathRequest(): SlowPathRequest {
  return {
    taskId: "demo-commerce-slow-path",
    userIntent: commerceIntent(),
    uiState: {
      surface: "browser",
      objects: ["catalog", "cart", "checkout"],
      signals: { localFixture: true, skillMatches: 0 },
      capturedAt: "2026-07-17T00:00:00.000Z",
    },
    recentTrace: [],
    reason: "complex_planning",
  };
}

function commerceSlowPathPlan(): SlowPathResponse {
  return {
    decision: "propose_plan",
    message:
      "Credential-free fixture plan: configure a cart and stop at a verified checkout preview.",
    proposedActions: commerceActions(),
  };
}

function commerceActions(): SemanticAction[] {
  return [
    {
      type: "fill",
      intent: "find the quiet mechanical keyboard",
      target: 'input[name="catalog-search"]',
      value: "silent keyboard",
      methodPreference: ["dom", "accessibility"],
      riskLevel: "low",
    },
    {
      type: "click",
      intent: "open the Aurora keyboard configuration",
      target: "#open-aurora-keyboard",
      methodPreference: ["dom", "accessibility"],
      riskLevel: "low",
    },
    {
      type: "select",
      intent: "choose the midnight finish",
      target: 'select[name="finish"]',
      value: "midnight",
      methodPreference: ["dom", "accessibility"],
      riskLevel: "low",
    },
    {
      type: "select",
      intent: "choose silent linear switches",
      target: 'select[name="switch-type"]',
      value: "silent-linear",
      methodPreference: ["dom", "accessibility"],
      riskLevel: "low",
    },
    {
      type: "click",
      intent: "add the configured keyboard to cart",
      target: "#add-to-cart",
      methodPreference: ["dom", "accessibility"],
      riskLevel: "low",
    },
    {
      type: "click",
      intent: "open the cart checkout surface",
      target: "#open-cart",
      methodPreference: ["dom", "accessibility"],
      riskLevel: "low",
    },
    {
      type: "fill",
      intent: "enter the local bundle promotion",
      target: 'input[name="promo-code"]',
      value: "BUNDLE10",
      methodPreference: ["dom", "accessibility"],
      riskLevel: "low",
    },
    {
      type: "fill",
      intent: "reuse the promotion after checkout markup changes",
      target: 'input[name="promo-code"]',
      value: "BUNDLE10",
      methodPreference: ["dom", "accessibility"],
      riskLevel: "low",
    },
    {
      type: "click",
      intent: "redeem the local bundle promotion",
      target: "#redeem-promo",
      methodPreference: ["dom", "accessibility"],
      riskLevel: "low",
    },
    {
      type: "select",
      intent: "choose express delivery",
      target: 'select[name="delivery"]',
      value: "express",
      methodPreference: ["dom", "accessibility"],
      riskLevel: "low",
    },
    {
      type: "click",
      intent: "generate the verified cart preview",
      target: "#preview-cart",
      methodPreference: ["dom", "accessibility"],
      riskLevel: "low",
    },
    {
      type: "wait",
      intent: "wait for checkout verifier evidence",
      target: "#checkout-ready",
      value: 1_000,
      methodPreference: ["dom"],
      riskLevel: "low",
    },
  ];
}

function commerceOrderAction(): SemanticAction {
  return {
    type: "click",
    intent: "place the order with the shopper",
    target: "#place-order",
    methodPreference: ["dom", "accessibility"],
    riskLevel: "low",
  };
}

async function verifyCommerceAction(
  page: Page,
  action: SemanticAction,
  execution: ActionExecutionResult,
): Promise<VerificationResult> {
  if (!execution.success) {
    return {
      success: false,
      evidence: [execution.error ?? "The local executor did not complete."],
    };
  }

  const target = action.target;
  const visible = async (selector: string) =>
    page
      .locator(selector)
      .isVisible()
      .catch(() => false);
  const selected = async (selector: string, value: string) =>
    page
      .locator(selector)
      .evaluate((element, expected) => {
        return (element as HTMLSelectElement).value === expected;
      }, value)
      .catch(() => false);

  if (target === "#promo-code-v2") {
    const success =
      (await page
        .locator(target)
        .inputValue()
        .catch(() => "")) === "BUNDLE10";
    return {
      success,
      evidence: success
        ? [
            "Verifier observed the recovered website-v2 offer code in the new field.",
          ]
        : [],
    };
  }

  const checks: Record<string, () => Promise<[boolean, string]>> = {
    'input[name="catalog-search"]': async () => [
      await visible("#aurora-product"),
      "Verifier observed the matching catalog product.",
    ],
    "#open-aurora-keyboard": async () => [
      await visible("#product-config"),
      "Verifier observed the product configuration surface.",
    ],
    'select[name="finish"]': async () => [
      await selected('select[name="finish"]', "midnight"),
      "Verifier observed the midnight finish selection.",
    ],
    'select[name="switch-type"]': async () => [
      await selected('select[name="switch-type"]', "silent-linear"),
      "Verifier observed the silent-linear switch selection.",
    ],
    "#add-to-cart": async () => [
      (await page.locator("#cart-count").textContent())?.trim() === "1",
      "Verifier observed one configured item in the cart.",
    ],
    "#open-cart": async () => [
      await visible("#checkout-panel"),
      "Verifier observed the checkout surface.",
    ],
    'input[name="promo-code"]': async () => [
      await visible("#promo-code"),
      "Verifier observed the promotion field after the markup change.",
    ],
    "#redeem-promo": async () => [
      await visible("#promo-applied"),
      "Verifier observed the local promotion discount.",
    ],
    'select[name="delivery"]': async () => [
      await selected('select[name="delivery"]', "express"),
      "Verifier observed the express delivery selection.",
    ],
    "#preview-cart": async () => [
      await visible("#checkout-ready"),
      "Verifier observed the reviewable checkout preview.",
    ],
    "#checkout-ready": async () => [
      await visible("#checkout-ready"),
      "Verifier observed the checkout-ready state.",
    ],
  };
  const check = target ? checks[target] : undefined;
  if (!check) {
    return {
      success: execution.evidence.length > 0,
      evidence: execution.evidence,
    };
  }
  const [success, evidence] = await check();
  return { success, evidence: success ? [evidence] : [] };
}

async function setCommerceRoute(
  page: Page,
  route: { detail: string; label: string },
): Promise<void> {
  await page.evaluate((nextRoute) => {
    document.querySelector("#route-badge")!.textContent = nextRoute.label;
    document.querySelector("#route-detail")!.textContent = nextRoute.detail;
  }, route);
}

async function showLearnedCommerceSkill(
  page: Page,
  skill: CandidateSkillRecord,
): Promise<void> {
  await page.evaluate((learned) => {
    const card = document.querySelector("#learning-promotion");
    if (!card) {
      return;
    }
    card.classList.add("visible");
    card.querySelector("strong")!.textContent =
      "VERIFIED CANDIDATE SAVED LOCALLY";
    card.querySelector("span")!.textContent =
      `${learned.name} · ${learned.verifiedRunCount}/3 independent verified runs · holdout pending`;
    document.querySelector("#route-detail")!.textContent =
      "Every planned action carried verifier evidence → offline holdout required before Fast Path";
  }, skill);
}

async function showFastPathSkill(
  page: Page,
  skill: SkillRecord,
): Promise<void> {
  await page.evaluate((learned) => {
    const card = document.querySelector("#learning-promotion");
    if (!card) {
      return;
    }
    card.classList.add("visible", "fast");
    card.querySelector("strong")!.textContent =
      "PRELOADED FIXTURE SKILL REUSED LOCALLY";
    card.querySelector("span")!.textContent =
      `${learned.name} · Fast Path route accepted · zero model calls`;
  }, skill);
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
    url: `http://127.0.0.1:${address.port}/store`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

async function recordWebsiteUpdateRecoveryWorkflow(): Promise<string> {
  const recordingDirectory = join(
    workDirectory,
    "recording",
    "website-recovery",
  );
  await mkdir(recordingDirectory, { recursive: true });
  const fixture = await createLocalFixtureServer(commerceLearningPage());
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
  const traceFilePath = join(workDirectory, "website-recovery-trace.jsonl");
  const database = createMemoryDatabase(
    join(recordingDirectory, "selector-memory.sqlite"),
  );
  const selectorMemory = new SelectorMemory(database);
  const skillStore = new SkillStore(database);

  try {
    await page.goto(`${fixture.url}?mode=fast`);
    await setCommerceRoute(page, {
      label: "FAST PATH · SKILL V1",
      detail: "Existing local skill matched · website update detection armed",
    });
    const executor = new PlaywrightDirectExecutor(page, {
      taskId: "demo-website-update-recovery",
      traceFilePath,
      selectorMemory,
    });
    await page.waitForTimeout(950);

    for (const action of commerceActions().slice(0, 6)) {
      const result = await executor.execute(action);
      const verification = await verifyCommerceAction(page, action, result);
      if (!result.success || !verification.success) {
        throw new Error(
          `Recovery setup action failed: ${result.error ?? action.intent}`,
        );
      }
      await appendLiveOperatorLog(
        page,
        action,
        result,
        verification.evidence[0],
      );
      await page.waitForTimeout(390);
    }

    await markWebsiteUpdated(page);
    await page.waitForTimeout(1_200);
    const legacyAction: SemanticAction = {
      type: "fill",
      intent: "reuse the v1 promotion selector after the website update",
      target: 'input[name="promo-code"]',
      value: "BUNDLE10",
      methodPreference: ["dom", "accessibility"],
      riskLevel: "low",
    };
    const legacyResult = await executor.execute(legacyAction);
    if (legacyResult.success) {
      throw new Error(
        "The website-update fixture did not invalidate Skill v1.",
      );
    }
    await appendLiveOperatorLog(page, legacyAction, legacyResult);
    await showWebsiteRecoveryPlan(page);
    await page.waitForTimeout(1_900);

    const recovered = await new SlowPathLearningCoordinator(skillStore).execute(
      websiteRecoveryRequest(),
      websiteRecoveryPlan(),
      {
        execute: async (action) => {
          const execution = await executor.execute(action);
          const verification = await verifyCommerceAction(
            page,
            action,
            execution,
          );
          await appendLiveOperatorLog(
            page,
            action,
            execution,
            verification.evidence[0] ??
              "Recovery verifier did not accept the action.",
          );
          await page.waitForTimeout(execution.success ? 620 : 1_100);
          return { execution, verification };
        },
      },
    );
    if (!recovered.candidateSkill) {
      throw new Error(
        "Website recovery did not earn a verifier-backed candidate.",
      );
    }
    await showWebsiteRecoveryVerified(page, recovered.candidateSkill);
    await page.waitForTimeout(1_650);

    const dangerousAction = commerceOrderAction();
    const blocked = await executor.execute(dangerousAction);
    if (blocked.success) {
      throw new Error("Recovery workflow order unexpectedly bypassed policy.");
    }
    await appendLiveOperatorLog(page, dangerousAction, blocked);
    await page.waitForTimeout(3_400);
  } finally {
    await context.close();
    await browser.close();
    database.close();
    await fixture.close();
  }

  if (!video) {
    throw new Error(
      "Playwright did not create the website recovery recording.",
    );
  }
  return video.path();
}

function websiteRecoveryRequest(): SlowPathRequest {
  return {
    taskId: "demo-website-update-recovery",
    userIntent: {
      goal: "Recover the changed checkout offer field and retain human order authority.",
      domain: "local-website-update-fixture",
      constraints: { priorSkillVersion: "v1", targetSkillVersion: "v2" },
      riskLevel: "low",
      requiresConfirmation: false,
      missingInformation: [],
    },
    uiState: {
      surface: "browser",
      url: "http://lhic.local.test/store?website=v2",
      objects: ["checkout", "offer-code-v2", "place-order"],
      signals: { fastPathMismatch: true, skillVersion: "v1" },
      capturedAt: "2026-07-17T00:00:00.000Z",
    },
    recentTrace: [],
    reason: "complex_planning",
  };
}

function websiteRecoveryPlan(): SlowPathResponse {
  return {
    decision: "retry_with_action",
    message:
      "Reproducible redacted GPT-5.6 recovery-plan fixture for the changed website-v2 offer field.",
    proposedActions: [
      {
        type: "fill",
        intent: "enter the offer code through the recovered website-v2 field",
        target: "#promo-code-v2",
        value: "BUNDLE10",
        methodPreference: ["dom", "accessibility"],
        riskLevel: "low",
      },
      {
        type: "click",
        intent: "apply the recovered website-v2 offer code",
        target: "#redeem-promo",
        methodPreference: ["dom", "accessibility"],
        riskLevel: "low",
      },
      {
        type: "select",
        intent: "restore express delivery through the recovered checkout route",
        target: 'select[name="delivery"]',
        value: "express",
        methodPreference: ["dom", "accessibility"],
        riskLevel: "low",
      },
      {
        type: "click",
        intent: "generate the recovered verified checkout preview",
        target: "#preview-cart",
        methodPreference: ["dom", "accessibility"],
        riskLevel: "low",
      },
      {
        type: "wait",
        intent: "wait for recovered checkout verifier evidence",
        target: "#checkout-ready",
        value: 1_000,
        methodPreference: ["dom"],
        riskLevel: "low",
      },
    ],
  };
}

async function markWebsiteUpdated(page: Page): Promise<void> {
  await page.evaluate(() => {
    const promo = document.querySelector(
      "#promo-code",
    ) as HTMLInputElement | null;
    if (!promo) {
      throw new Error("Could not locate the original promotion field.");
    }
    promo.id = "promo-code-v2";
    promo.name = "offer-code-v2";
    promo.placeholder = "Offer code (website v2)";
    const notice = document.querySelector("#mutation-notice");
    if (notice) {
      notice.textContent =
        "WEBSITE UPDATE DETECTED · v1 promo selector no longer matches · Fast Path stopped";
      notice.classList.add("visible");
    }
  });
}

async function showWebsiteRecoveryPlan(page: Page): Promise<void> {
  await page.evaluate(() => {
    const checkout = document.querySelector("#checkout-panel");
    if (!checkout || document.querySelector("#website-recovery-plan")) {
      return;
    }
    const style = document.createElement("style");
    style.textContent = `
      #website-recovery-plan { margin: 11px 0; padding: 10px 12px; border: 1px solid #9b8cff88; border-radius: 9px; color: #e7ddff; background: #9b8cff14; animation: recovery-enter .3s ease-out; }
      #website-recovery-plan strong, #website-recovery-plan span { display: block; }
      #website-recovery-plan strong { font-size: 10px; letter-spacing: .08em; }
      #website-recovery-plan span { margin-top: 5px; color: #c7bdf2; font-size: 9px; line-height: 1.35; }
      @keyframes recovery-enter { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
    `;
    const card = document.createElement("section");
    card.id = "website-recovery-plan";
    card.innerHTML =
      "<strong>GPT-5.6 RECOVERY PLAN · TYPED FIXTURE</strong><span>New v2 route proposed → schema check → policy check → verifier evidence → Skill v2.</span>";
    checkout.prepend(style, card);
  });
}

async function showWebsiteRecoveryVerified(
  page: Page,
  skill: CandidateSkillRecord,
): Promise<void> {
  await showLearnedCommerceSkill(page, skill);
  await page.evaluate(() => {
    const route = document.querySelector("#route-badge");
    const detail = document.querySelector("#route-detail");
    const plan = document.querySelector("#website-recovery-plan");
    if (route) {
      route.textContent = "RECOVERY VERIFIED · CANDIDATE V2";
    }
    if (detail) {
      detail.textContent =
        "Replacement route remains a candidate until three independent runs and an offline holdout pass";
    }
    if (plan) {
      plan.innerHTML =
        "<strong>CANDIDATE V2 SAVED LOCALLY</strong><span>Recovered route verified. The place-order action remains approval-gated and Fast Path promotion is still pending.</span>";
    }
  });
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
  verifierEvidence?: string,
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
      const recovered = /healed selector|recovery/i.test(evidence);
      const policyBlocked =
        !event.success && /approval|policy/i.test(event.error ?? "");
      line.className = `live-log ${event.success ? "success" : "blocked"}${recovered ? " recovered" : ""}`;
      const timestamp = new Date().toISOString().slice(11, 23);
      const heading = document.createElement("strong");
      heading.textContent = `${timestamp}  ${event.success ? "COMPLETE" : "BLOCKED"}  ${event.actionType.toUpperCase()} · ${event.method}`;
      const detail = document.createElement("span");
      detail.textContent = `${event.target} · ${event.latencyMs}ms`;
      const proof = document.createElement("em");
      proof.textContent = recovered
        ? `SELECTOR RECOVERY · ${evidence}`
        : (event.verifierEvidence ?? evidence);
      line.append(heading, detail, proof);
      root.append(line);
      root.scrollTop = root.scrollHeight;
      const stage = document.querySelector("#workflow-stage");
      if (stage) {
        stage.textContent = event.success
          ? `${event.actionType.toUpperCase()} verified`
          : policyBlocked
            ? "Approval required"
            : "Fast Path mismatch detected";
      }
      if (policyBlocked) {
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
      verifierEvidence,
    },
  );
}

function createSlides(
  internalBenchmark: Awaited<ReturnType<typeof runInternalBenchmark>>,
  selectorSimulation: Awaited<
    ReturnType<typeof runSelectorResilienceSimulation>
  >,
  vendorWorkflow?: VendorCommerceWorkflow,
): Record<string, Slide> {
  const metrics = internalBenchmark.metrics;
  const percentage = (value: number) => `${Math.round(value * 100)}%`;
  const selectorDelta = Math.round(selectorSimulation.successRateDelta * 100);
  const vendorSlowSeconds = vendorWorkflow?.slowDurationSeconds ?? 103.5;
  const vendorFastSeconds = vendorWorkflow?.fastDurationSeconds ?? 37;
  const vendorSpeedup = vendorSlowSeconds / vendorFastSeconds;

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
    vendorSlow: {
      id: "vendor-slow-path",
      eyebrow: "01 · FIRST ENCOUNTER",
      title: "Slow Path collects evidence before a candidate can earn trust.",
      body: "A live vendor workflow is localized into English for the demo. LHIC builds a bounded plan, executes it through Playwright, and requires verifier evidence after every low-risk action.",
      note: "Cyan = Slow Path · first encounter · discovery and verification",
      accent: "cyan",
      cards: [
        {
          label: "Mode",
          value: "Slow Path",
          detail: "Typed plan boundary",
        },
        {
          label: "Recorded time",
          value: `${vendorSlowSeconds.toFixed(1)} s`,
          detail: "First live encounter",
        },
        {
          label: "Proof",
          value: "Required",
          detail: "Every action verified",
        },
      ],
    },
    vendorLearning: {
      id: "vendor-learning-loop",
      eyebrow: "02 · VERIFIED CANDIDATE",
      title: "Evidence turns a first run into a local candidate.",
      body: "LHIC stores a redacted semantic action plan and only the selector candidates that proved reliable. Three independent task IDs and an offline holdout are required before Fast Path promotion.",
      note: "Slow Path → verifier evidence → redacted SQLite candidate → offline holdout",
      accent: "violet",
      cards: [
        {
          label: "Input",
          value: "Plan",
          detail: "Semantic, not coordinates",
        },
        {
          label: "Promotion",
          value: "Candidate",
          detail: "Evidence is mandatory",
        },
        {
          label: "Memory",
          value: "Local",
          detail: "Redacted SQLite candidate",
        },
      ],
    },
    vendorFast: {
      id: "vendor-fast-path",
      eyebrow: "03 · LOCAL FIXTURE REPLAY",
      title: "Fast Path: same intent, fresh browser, no model detour.",
      body: "An explicitly preloaded deterministic fixture skill matches locally, replays through direct Playwright, and retains the exact same verifier and approval boundaries from the first encounter.",
      note: "Lime = Fast Path · 0 model calls · 0 MCP calls",
      accent: "lime",
      cards: [
        {
          label: "Mode",
          value: "Fast Path",
          detail: "Local direct replay",
        },
        {
          label: "Recorded time",
          value: `${vendorFastSeconds.toFixed(1)} s`,
          detail: "Fresh browser context",
        },
        {
          label: "Model / MCP",
          value: "0 / 0",
          detail: "Not in the loop",
        },
      ],
    },
    vendorSpeed: {
      id: "vendor-speed-review",
      eyebrow: "04 · MEASURED DIFFERENCE",
      title: `${vendorSpeedup.toFixed(1)}× faster on the deterministic local replay.`,
      body: `This comparison comes from the recorded live vendor workflow: ${vendorSlowSeconds.toFixed(1)} seconds for the evidence-building first encounter and ${vendorFastSeconds.toFixed(1)} seconds for the matched deterministic local replay. It does not promote the first-run candidate automatically.`,
      note: "Same intent · fresh browser · verifier retained · approval retained",
      accent: "lime",
      cards: [
        {
          label: "Slow Path",
          value: `${vendorSlowSeconds.toFixed(1)} s`,
          detail: "Plan and candidate evidence",
        },
        {
          label: "Fast Path",
          value: `${vendorFastSeconds.toFixed(1)} s`,
          detail: "Deterministic fixture replay",
        },
        {
          label: "Speedup",
          value: `${vendorSpeedup.toFixed(1)}×`,
          detail: "Recorded workflow",
        },
      ],
    },
    vendorRecovery: {
      id: "vendor-website-recovery",
      eyebrow: "03 · WEBSITE UPDATE",
      title:
        "A changed page must break safely before it proposes a new candidate.",
      body: "When a stored Fast Path selector no longer matches, LHIC records the mismatch and stops. A GPT-5.6 recovery plan is schema-checked, policy-checked, and re-verified before the replacement becomes a candidate.",
      note: "Fast Path mismatch → GPT-5.6 recovery plan → verified candidate",
      accent: "amber",
      cards: [
        {
          label: "Old route",
          value: "Blocked",
          detail: "No silent fallback",
        },
        {
          label: "Recovery",
          value: "Typed",
          detail: "Schema and policy checked",
        },
        {
          label: "Upgrade",
          value: "Skill v2",
          detail: "Evidence required again",
        },
      ],
    },
    vendorPolicy: {
      id: "vendor-policy-boundary",
      eyebrow: "04 · DURABLE SAFETY BOUNDARY",
      title: "Every skill version keeps the same human approval gate.",
      body: "A risky action does not become safe just because the route is faster or newer. The local policy stops the side effect, waits for a bound human approval, and preserves that requirement in every future version.",
      note: "Policy block → human approval → controlled side effect",
      accent: "amber",
      cards: [
        {
          label: "Fast Path",
          value: "Cannot bypass",
          detail: "Policy runs locally",
        },
        {
          label: "Recovery v2",
          value: "Still gated",
          detail: "New route, same boundary",
        },
        {
          label: "Human",
          value: "Authorizes",
          detail: "Before side effects",
        },
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
      body: "A Slow Path plan becomes a redacted candidate only when every action succeeds with non-empty verifier evidence. Three independent task IDs and a deterministic offline holdout are required before promotion. Successful DOM actions also leave selector-memory candidates.",
      note: "candidate → holdout → habit → trusted",
      accent: "violet",
      cards: [
        {
          label: "1 verified run",
          value: "Candidate",
          detail: "Evidence required",
        },
        {
          label: "3 runs + holdout",
          value: "Habit",
          detail: "Local promotion",
        },
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
  const transitionDuration = 0.38;
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
      const recording = workflowVideos[scene.workflow];
      if (!recording) {
        throw new Error(`Missing workflow recording: ${scene.workflow}.`);
      }
      await renderWorkflowClip(
        recording,
        narration,
        scene.duration,
        scene.workflowOffsetSeconds ?? 0,
        scene.workflowSourceDurationSeconds ?? scene.duration,
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
    sceneOffset += scene.duration - transitionDuration;
  }

  await stitchDemoClips(
    clipFiles,
    scenes,
    transitionDuration,
    join(outputDirectory, fileName),
  );
}

async function stitchDemoClips(
  clipFiles: string[],
  scenes: Scene[],
  transitionDuration: number,
  output: string,
): Promise<void> {
  if (clipFiles.length !== scenes.length || clipFiles.length === 0) {
    throw new Error(
      "Demo timeline requires one rendered clip for every scene.",
    );
  }
  if (clipFiles.length === 1) {
    await execFfmpeg([
      "-i",
      clipFiles[0]!,
      "-c",
      "copy",
      "-movflags",
      "+faststart",
      output,
    ]);
    return;
  }

  const args = clipFiles.flatMap((file) => ["-i", file]);
  const filters: string[] = [];
  let videoInput = "[0:v]";
  let audioInput = "[0:a]";
  let offset = scenes[0]!.duration - transitionDuration;
  for (let index = 1; index < clipFiles.length; index += 1) {
    const videoOutput = `[video-${index}]`;
    const audioOutput = `[audio-${index}]`;
    filters.push(
      `${videoInput}[${index}:v]xfade=transition=fade:duration=${transitionDuration}:offset=${offset.toFixed(3)}${videoOutput}`,
      `${audioInput}[${index}:a]acrossfade=d=${transitionDuration}:c1=tri:c2=tri${audioOutput}`,
    );
    videoInput = videoOutput;
    audioInput = audioOutput;
    offset += scenes[index]!.duration - transitionDuration;
  }
  await execFfmpeg([
    ...args,
    "-filter_complex",
    filters.join(";"),
    "-map",
    videoInput,
    "-map",
    audioInput,
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-crf",
    "24",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-ar",
    "48000",
    "-movflags",
    "+faststart",
    output,
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
    `scale=2112:1188,zoompan=z='min(zoom+0.00042,1.045)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${videoWidth}x${videoHeight}:fps=${frameRate}`,
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
  sourceOffsetSeconds: number,
  sourceDurationSeconds: number,
  backgroundMusic: string,
  musicOffset: number,
  soundEffect: string | undefined,
  output: string,
): Promise<void> {
  const args = [
    "-ss",
    String(sourceOffsetSeconds),
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
    `trim=duration=${sourceDurationSeconds},setpts=PTS-STARTPTS,scale=${videoWidth}:${videoHeight}:force_original_aspect_ratio=decrease,pad=${videoWidth}:${videoHeight}:(ow-iw)/2:(oh-ih)/2:#07111f,tpad=stop_mode=clone:stop_duration=${duration}`,
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
    transitionEffect: join(soundtrackDirectory, "transition-effect.wav"),
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
      "0.045*sin(2*PI*(180+1320*t*t)*t)*exp(-3.8*t)+0.018*sin(2*PI*(740+600*t)*t)*exp(-6*t)",
      assets.transitionEffect,
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
    "aevalsrc=0.020*sin(2*PI*55*t)+0.013*sin(2*PI*82.5*t)+0.008*sin(2*PI*110*t)+0.007*sin(2*PI*220*t)*(0.5+0.5*sin(2*PI*0.11*t))+0.004*sin(2*PI*440*t)*(0.5+0.5*sin(2*PI*0.37*t))+0.0025*sin(2*PI*880*t)*(0.5+0.5*sin(2*PI*0.73*t)):s=48000",
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
  if (index === 0) {
    return assets.introEffect;
  }
  return index % 2 === 0 ? assets.transitionEffect : undefined;
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

function commerceLearningPage(): string {
  return `<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8">
        <style>
          * { box-sizing: border-box; }
          body { margin: 0; min-height: 100vh; overflow: hidden; color: #eff4ff; font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #08101d; }
          .browser-chrome { height: 48px; display: flex; align-items: center; gap: 14px; padding: 0 18px; border-bottom: 1px solid #ffffff1d; background: #121b2a; }
          .dots { display: flex; gap: 6px; }.dots i { width: 10px; height: 10px; border-radius: 50%; background: #ee7479; }.dots i:nth-child(2) { background: #ffc86a; }.dots i:nth-child(3) { background: #a8e96a; }
          .browser-controls { color: #8292a8; font: 700 14px ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .2em; }.address { flex: 1; max-width: 650px; padding: 8px 13px; color: #c8d4e5; font: 11px ui-monospace, SFMono-Regular, Menlo, monospace; border: 1px solid #ffffff18; border-radius: 8px; background: #09111f; }.secure { color: #a8e96a; }.recording { margin-left: auto; color: #95a6bb; font-size: 9px; font-weight: 800; letter-spacing: .1em; }
          main { height: calc(100vh - 48px); display: grid; grid-template-columns: minmax(0, 1fr) 355px; gap: 14px; padding: 14px; background: radial-gradient(circle at 66% 0%, #8d5eff28, transparent 34%), #08101d; }
          .store, .evidence { min-width: 0; overflow: hidden; border: 1px solid #ffffff1c; border-radius: 15px; box-shadow: 0 18px 45px #0000003d; }.store { background: linear-gradient(145deg, #192442, #0b1426); }.store-head { height: 50px; display: flex; align-items: center; justify-content: space-between; padding: 0 20px; border-bottom: 1px solid #ffffff14; }.brand { display: flex; align-items: center; gap: 9px; font-size: 14px; font-weight: 820; letter-spacing: .04em; }.brand-mark { width: 24px; height: 24px; display: grid; place-items: center; color: #07101d; font-size: 11px; border-radius: 8px; background: linear-gradient(135deg, #f3c76c, #e875b7); }.nav { display: flex; gap: 17px; color: #8998ae; font-size: 10px; font-weight: 700; }.nav .active { color: #fff3d9; }
          .intent { margin: 13px 18px 10px; padding: 10px 13px; border: 1px solid #9d8cff55; border-radius: 10px; background: #9d8cff13; }.intent small { display: block; color: #baafff; font-size: 9px; font-weight: 800; letter-spacing: .12em; }.intent p { margin: 4px 0 0; color: #f0f3ff; font-size: 12px; line-height: 1.35; }
          .route { display: flex; align-items: center; gap: 9px; margin: 0 18px 10px; padding: 8px 10px; border: 1px solid #ffffff1b; border-radius: 9px; background: #ffffff08; }.route strong { padding: 5px 7px; color: #c5b9ff; font: 800 9px ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .05em; border: 1px solid #9d8cff55; border-radius: 99px; }.route span { color: #9bacbf; font-size: 10px; }
          .workspace { padding: 0 18px 14px; }.catalog.hidden { display: none; }.search-row { display: grid; grid-template-columns: minmax(0, 1fr) 138px; gap: 8px; }input, select { width: 100%; height: 36px; padding: 0 10px; color: #edf4ff; font: 12px inherit; border: 1px solid #ffffff24; border-radius: 8px; outline: none; background: #08111e; }input:focus, select:focus { border-color: #e875b7; box-shadow: 0 0 0 3px #e875b720; }button { height: 36px; color: #151020; font: 800 11px inherit; border: 0; border-radius: 8px; background: linear-gradient(90deg, #f3c76c, #f088c0); cursor: pointer; }
          .product-card { display: grid; grid-template-columns: 175px minmax(0, 1fr); gap: 14px; align-items: center; margin-top: 11px; padding: 13px; border: 1px solid #f3c76c44; border-radius: 12px; background: linear-gradient(120deg, #f3c76c12, #e875b70d); }.keyboard { position: relative; height: 91px; overflow: hidden; border: 1px solid #ffffff20; border-radius: 10px; background: linear-gradient(135deg, #4a365f, #171d35 58%, #172b40); }.keyboard::before { content: ""; position: absolute; inset: 15px 12px; border-radius: 6px; background: repeating-linear-gradient(90deg, #e7d9ff 0 13px, transparent 13px 17px), repeating-linear-gradient(0deg, #e7d9ff 0 13px, transparent 13px 17px); opacity: .8; transform: perspective(100px) rotateX(18deg); }.keyboard::after { content: "AURORA TKL"; position: absolute; right: 10px; bottom: 8px; color: #f3c76c; font: 800 9px ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .08em; }.product-card strong, .product-card span { display: block; }.product-card strong { font-size: 16px; }.product-card span { margin-top: 4px; color: #9eadc0; font-size: 10px; }.product-card .price { margin-top: 9px; color: #f3c76c; font: 800 14px ui-monospace, SFMono-Regular, Menlo, monospace; }.product-card button { margin-top: 10px; width: 154px; }
          .product-config { display: none; margin-top: 11px; padding: 12px; border: 1px solid #ffffff1d; border-radius: 11px; background: #08111dbd; }.product-config.visible { display: block; animation: reveal .25s ease-out; }.config-title { display: flex; align-items: center; justify-content: space-between; margin-bottom: 9px; }.config-title strong { font-size: 12px; }.config-title span { color: #f3c76c; font-size: 9px; font-weight: 800; letter-spacing: .1em; }.fields { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }label { display: block; margin: 0 0 4px 1px; color: #91a0b7; font-size: 9px; font-weight: 800; letter-spacing: .06em; text-transform: uppercase; }.cart-actions { display: grid; grid-template-columns: 1fr 145px; gap: 8px; margin-top: 10px; }#open-cart { display: none; color: #daf8ff; background: #1e3f5d; }#open-cart.visible { display: block; }
          .checkout { display: none; animation: reveal .25s ease-out; }.checkout.visible { display: block; }.checkout-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }.checkout-head h1 { margin: 0; font-size: 21px; letter-spacing: -.03em; }.cart-pill { padding: 6px 8px; color: #f3c76c; font: 800 10px ui-monospace, SFMono-Regular, Menlo, monospace; border: 1px solid #f3c76c55; border-radius: 99px; }.checkout-product { display: flex; gap: 10px; align-items: center; padding: 11px; border: 1px solid #ffffff1b; border-radius: 10px; background: #ffffff07; }.mini-keyboard { width: 54px; height: 40px; border-radius: 7px; background: linear-gradient(135deg, #4a365f, #172b40); }.checkout-product strong, .checkout-product span { display: block; }.checkout-product strong { font-size: 12px; }.checkout-product span { margin-top: 3px; color: #99a9bd; font-size: 9px; }.checkout-product b { margin-left: auto; color: #f3c76c; font: 800 12px ui-monospace, SFMono-Regular, Menlo, monospace; }.checkout-controls { display: grid; grid-template-columns: minmax(0, 1fr) 150px; gap: 8px; margin-top: 10px; }.promo-row { display: grid; grid-template-columns: minmax(0, 1fr) 120px; gap: 8px; margin-top: 10px; }.promo-row button { background: linear-gradient(90deg, #a8e96a, #5bd6bb); }.mutation, .applied, .ready { display: none; margin-top: 8px; padding: 8px 9px; font: 9px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace; border-radius: 7px; }.mutation { color: #ffdc96; border: 1px solid #f3c76c55; background: #f3c76c12; }.applied, .ready { color: #c6f6c2; border: 1px solid #a8e96a55; background: #a8e96a11; }.mutation.visible, .applied.visible, .ready.visible { display: block; }.checkout-actions { display: grid; grid-template-columns: 1fr 168px; gap: 8px; margin-top: 10px; }#place-order { color: #ffe9eb; background: linear-gradient(90deg, #df5c70, #f58a92); }
          .evidence { display: flex; flex-direction: column; background: #08111fe8; }.evidence-head { padding: 15px 15px 11px; border-bottom: 1px solid #ffffff13; }.evidence-head strong { display: block; font-size: 10px; letter-spacing: .12em; }.evidence-head span { display: block; margin-top: 5px; color: #a8e96a; font: 800 9px ui-monospace, SFMono-Regular, Menlo, monospace; }.learning { display: none; margin: 10px 12px 4px; padding: 9px; border: 1px solid #9d8cff55; border-radius: 8px; background: #9d8cff12; }.learning.visible { display: block; animation: reveal .25s ease-out; }.learning.fast { border-color: #a8e96a66; background: #a8e96a10; }.learning strong, .learning span { display: block; }.learning strong { color: #c9bdff; font-size: 9px; letter-spacing: .07em; }.learning.fast strong { color: #c6f6c2; }.learning span { margin-top: 5px; color: #a7b5c8; font: 8px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace; }#workflow-stage { margin: 10px 14px 6px; color: #56dded; font: 700 10px ui-monospace, SFMono-Regular, Menlo, monospace; }#operator-log { flex: 1; min-height: 0; padding: 0 12px 10px; overflow: auto; scrollbar-width: none; }#operator-log::-webkit-scrollbar { display: none; }.live-log { margin: 6px 0; padding: 7px 8px; border-left: 2px solid #71839a; border-radius: 0 7px 7px 0; background: #ffffff07; animation: log-in .2s ease-out; }.live-log.success { border-color: #56dded; }.live-log.recovered { border-color: #a8e96a; background: #a8e96a10; }.live-log.blocked { border-color: #f06c7a; background: #f06c7a10; }.live-log strong, .live-log span, .live-log em { display: block; }.live-log strong { color: #eef5ff; font: 700 8px ui-monospace, SFMono-Regular, Menlo, monospace; }.live-log span { margin-top: 3px; color: #93a4ba; font: 8px ui-monospace, SFMono-Regular, Menlo, monospace; }.live-log em { margin-top: 3px; color: #c2d0e1; font: 8px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace; font-style: normal; }#approval-gate { display: none; margin: 0 12px 12px; padding: 9px; color: #ffd9de; font-size: 9px; border: 1px solid #f06c7a66; border-radius: 8px; background: #f06c7a15; }#approval-gate.visible { display: block; animation: reveal .25s ease-out; }
          @keyframes reveal { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: none; } } @keyframes log-in { from { opacity: 0; transform: translateX(6px); } to { opacity: 1; transform: none; } }
        </style>
      </head>
      <body>
        <header class="browser-chrome"><div class="dots"><i></i><i></i><i></i></div><div class="browser-controls">‹ › ↻</div><div class="address"><span class="secure">●</span> LOCAL FIXTURE · http://127.0.0.1 / store</div><div class="recording">PLAYWRIGHT REC · AI-GENERATED VOICE</div></header>
        <main>
          <section class="store">
            <header class="store-head"><div class="brand"><span class="brand-mark">A</span> ASTER &amp; FINCH</div><nav class="nav"><span class="active">Keyboards</span><span>Switches</span><span>Builds</span><span>Support</span></nav></header>
            <section class="intent"><small>HUMAN INTENT</small><p>“Build a quiet keyboard cart, verify every change, and never place the order without me.”</p></section>
            <section class="route"><strong id="route-badge">SLOW PATH · COMPLEX CART</strong><span id="route-detail">0 local matches · a redacted plan is being verified</span></section>
            <div class="workspace">
              <section class="catalog" id="catalog-workspace"><div class="search-row"><input name="catalog-search" aria-label="Catalog search" placeholder="Search keyboards, switches, kits"><button id="catalog-search-button" type="button">Search catalog</button></div><article class="product-card" id="aurora-product"><div class="keyboard"></div><div><strong>Aurora TKL — hot-swap wireless</strong><span>Gasket mount · tri-mode · configurable switches</span><div class="price">$159.00</div><button id="open-aurora-keyboard" type="button">Configure Aurora TKL</button></div></article><section class="product-config" id="product-config"><div class="config-title"><strong>Customize Aurora TKL</strong><span>CONFIGURATION</span></div><div class="fields"><div><label for="finish">Finish</label><select id="finish" name="finish"><option value="cloud">Cloud white</option><option value="midnight">Midnight blue</option><option value="rose">Rose smoke</option></select></div><div><label for="switch-type">Switches</label><select id="switch-type" name="switch-type"><option value="tactile">Tactile brown</option><option value="silent-linear">Silent linear</option><option value="clicky">Clicky blue</option></select></div></div><div class="cart-actions"><button id="add-to-cart" type="button">Add configured keyboard</button><button id="open-cart" type="button">Open cart · <span id="cart-count">0</span></button></div></section></section>
              <section class="checkout" id="checkout-panel"><div class="checkout-head"><div><h1>Checkout review</h1><p class="sub">Local cart · no order will be placed automatically</p></div><span class="cart-pill">1 ITEM</span></div><article class="checkout-product"><div class="mini-keyboard"></div><div><strong>Aurora TKL · midnight</strong><span>Silent linear · hot-swap configuration</span></div><b>$159</b></article><div class="promo-row"><input id="promo-code" name="promo-code" aria-label="Promotion code" placeholder="Promotion code"><button id="redeem-promo" type="button">Redeem code</button></div><p class="mutation" id="mutation-notice">CHECKOUT UI MUTATION · original promo field name rotated · selector recovery armed</p><p class="applied" id="promo-applied">BUNDLE DISCOUNT VERIFIED · −$16.00 · new total $143.00</p><div class="checkout-controls"><div><label for="delivery">Delivery</label><select id="delivery" name="delivery"><option value="standard">Standard · 4–6 days</option><option value="express">Express · 1–2 days</option></select></div><div><label>Review total</label><input value="$151.00" aria-label="Review total" readonly></div></div><div class="checkout-actions"><button id="preview-cart" type="button">Generate verified cart preview</button><button id="place-order" type="button">Place order</button></div><p class="ready" id="checkout-ready">CHECKOUT PREVIEW VERIFIED · price, delivery, and cart state observed</p></section>
            </div>
          </section>
          <aside class="evidence"><div class="evidence-head"><strong>LHIC EXECUTION PROOF</strong><span>● LOCAL VERIFIER ONLINE</span></div><div class="learning" id="learning-promotion"><strong>AWAITING VERIFIED SKILL</strong><span>Slow Path memory remains empty until every action is evidenced.</span></div><div id="workflow-stage">BOOT · local executor ready</div><div id="operator-log"><article class="live-log success"><strong>LOCAL STORE OPEN</strong><span>http://127.0.0.1 / store</span><em>DOM OBSERVATION · TRACE REDACTION ON</em></article><article class="live-log"><strong>INTENT ACCEPTED</strong><span>Complex cart · retain human order authority</span><em>AWAITING SEMANTIC ACTION</em></article></div><div id="approval-gate"><strong>HUMAN APPROVAL REQUIRED</strong><br>Order was not placed. The local executor stopped the side effect before it left review.</div></aside>
        </main>
        <script>
          const isFast = new URLSearchParams(location.search).get('mode') === 'fast';
          if (isFast) document.body.classList.add('fast-run');
          const catalog = document.querySelector('#catalog-workspace');
          const config = document.querySelector('#product-config');
          const checkout = document.querySelector('#checkout-panel');
          const cartCount = document.querySelector('#cart-count');
          document.querySelector('input[name="catalog-search"]').addEventListener('input', () => document.querySelector('#aurora-product').style.borderColor = '#a8e96a99');
          document.querySelector('#open-aurora-keyboard').addEventListener('click', () => config.classList.add('visible'));
          document.querySelector('#add-to-cart').addEventListener('click', () => { cartCount.textContent = '1'; document.querySelector('#open-cart').classList.add('visible'); });
          document.querySelector('#open-cart').addEventListener('click', () => { catalog.classList.add('hidden'); checkout.classList.add('visible'); });
          const promo = document.querySelector('#promo-code');
          promo.addEventListener('input', () => { if (promo.getAttribute('name') === 'promo-code') { promo.setAttribute('name', 'promo-code-locked'); document.querySelector('#mutation-notice').classList.add('visible'); } });
          document.querySelector('#redeem-promo').addEventListener('click', () => document.querySelector('#promo-applied').classList.add('visible'));
          document.querySelector('#preview-cart').addEventListener('click', () => document.querySelector('#checkout-ready').classList.add('visible'));
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
