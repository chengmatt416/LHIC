import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";

import { TaskSourceAdapter } from "../../apps/desktop/src/main/task-source-adapter.js";
import { validateTaskSourceConfig } from "../../apps/desktop/src/shared/policy.js";
import type { TaskSourceConfig } from "../../apps/desktop/src/shared/contracts.js";
import type { GlobalComputerAction } from "@lhic/schema";

const PROTOCOL_VERSION = "lhic-osworld-bridge-v1";
const MAX_MESSAGE_BYTES = 2_000_000;
const SUPPORTED_NODE_MAJOR = 24;

type ReceiptStatus = "proposed" | "dispatched" | "terminated" | "error";

interface BridgeConfig {
  schemaVersion: typeof PROTOCOL_VERSION;
  benchmarkRevision: string;
  seed: number;
  source: TaskSourceConfig;
  credentialEnv?: string;
  workspaceRoot: string;
  resultPath: string;
  stepTimeoutMs: number;
}

interface EpisodeState {
  episodeId: string;
  instruction: string;
  step: number;
  startedAt: string;
  harnessConfig: Record<string, unknown>;
}

interface StepReceipt {
  receiptId: string;
  episodeId: string;
  step: number;
  status: ReceiptStatus;
  actionType: string;
  createdAt: string;
  error?: string;
}

interface StartMessage {
  type: "start_episode";
  protocolVersion: typeof PROTOCOL_VERSION;
  episodeId: string;
  instruction: string;
  seed: number;
  benchmarkRevision: string;
  harnessConfig?: Record<string, unknown>;
}

interface StepMessage {
  type: "step";
  protocolVersion: typeof PROTOCOL_VERSION;
  episodeId: string;
  observation: {
    accessibilityTree: string;
    screenshotSha256?: string;
    screenshotBytes?: number;
    screenWidth?: number;
    screenHeight?: number;
  };
  previousReceipt?: {
    receiptId: string;
    status: "dispatched" | "terminated" | "error";
    error?: string;
  };
}

interface EndMessage {
  type: "end_episode";
  protocolVersion: typeof PROTOCOL_VERSION;
  episodeId: string;
  terminal: "done" | "fail" | "error" | "max_steps" | "harness_reset";
  error?: string;
}

type BridgeMessage = StartMessage | StepMessage | EndMessage;

const configPath = requiredArgument("--config");
const preflightOnly = process.argv.includes("--preflight");
const config = await loadConfig(configPath);
await preflight(config);

if (preflightOnly) {
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      protocolVersion: PROTOCOL_VERSION,
      benchmarkRevision: config.benchmarkRevision,
      seed: config.seed,
      sourceKind: config.source.kind,
    })}\n`,
  );
  process.exit(0);
}

const credential = config.credentialEnv
  ? process.env[config.credentialEnv]
  : undefined;
const adapter = new TaskSourceAdapter({
  credentialFor: async () => credential,
});
let episode: EpisodeState | undefined;

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  if (!line.trim()) continue;
  try {
    if (Buffer.byteLength(line, "utf8") > MAX_MESSAGE_BYTES) {
      throw new Error(`Bridge message exceeds ${MAX_MESSAGE_BYTES} bytes.`);
    }
    const message = parseMessage(line);
    const response = await handleMessage(message);
    process.stdout.write(`${JSON.stringify(response)}\n`);
  } catch (error) {
    const detail = safeError(error);
    if (episode) {
      await record(config, {
        event: "episode_error",
        episodeId: episode.episodeId,
        step: episode.step,
        error: detail,
      });
    }
    process.stdout.write(
      `${JSON.stringify({ ok: false, error: detail, protocolVersion: PROTOCOL_VERSION })}\n`,
    );
    process.exitCode = 1;
    input.close();
    break;
  }
}

async function handleMessage(message: BridgeMessage): Promise<object> {
  if (message.type === "start_episode") {
    if (episode) {
      throw new Error(
        `Episode ${episode.episodeId} is still active; end it before starting another.`,
      );
    }
    if (message.seed !== config.seed) {
      throw new Error(
        `Harness seed ${message.seed} does not match configured seed ${config.seed}.`,
      );
    }
    if (message.benchmarkRevision !== config.benchmarkRevision) {
      throw new Error("Harness and bridge benchmark revisions do not match.");
    }
    episode = {
      episodeId: requiredText(message.episodeId, "episodeId"),
      instruction: requiredText(message.instruction, "instruction"),
      step: 0,
      startedAt: new Date().toISOString(),
      harnessConfig: message.harnessConfig ?? {},
    };
    await record(config, {
      event: "episode_started",
      episodeId: episode.episodeId,
      instructionSha256: sha256(episode.instruction),
      harnessConfig: episode.harnessConfig,
    });
    return {
      ok: true,
      protocolVersion: PROTOCOL_VERSION,
      episodeId: episode.episodeId,
    };
  }

  if (!episode || message.episodeId !== episode.episodeId) {
    throw new Error("Message does not match the active episode boundary.");
  }

  if (message.type === "end_episode") {
    const endedEpisode = episode;
    await record(config, {
      event: "episode_ended",
      episodeId: endedEpisode.episodeId,
      steps: endedEpisode.step,
      terminal: message.terminal,
      ...(message.error ? { error: message.error.slice(0, 1_000) } : {}),
    });
    episode = undefined;
    return {
      ok: true,
      protocolVersion: PROTOCOL_VERSION,
      episodeId: endedEpisode.episodeId,
      terminal: message.terminal,
    };
  }

  if (!message.observation.accessibilityTree.trim()) {
    throw new Error(
      "OSWorld must provide a non-empty accessibility_tree observation; screenshot-only runs are unsupported.",
    );
  }
  if (
    message.observation.screenshotSha256 !== undefined &&
    !/^[a-f0-9]{64}$/.test(message.observation.screenshotSha256)
  ) {
    throw new Error("screenshotSha256 must be a lowercase SHA-256 digest.");
  }

  const step = episode.step;
  const decision = await adapter.proposeDesktopStep(
    config.source,
    episode.instruction,
    {
      accessibilityTree: message.observation.accessibilityTree,
      screenshotSha256: message.observation.screenshotSha256,
      screenWidth: message.observation.screenWidth,
      screenHeight: message.observation.screenHeight,
      previousReceipt: message.previousReceipt,
    },
    resolve(config.workspaceRoot),
    { signal: AbortSignal.timeout(config.stepTimeoutMs) },
  );
  const action =
    decision.status === "action"
      ? toOSWorldAction(decision.action)
      : decision.status.toUpperCase();
  const receipt: StepReceipt = {
    receiptId: randomUUID(),
    episodeId: episode.episodeId,
    step,
    status:
      decision.status === "done" || decision.status === "fail"
        ? "terminated"
        : "proposed",
    actionType:
      decision.status === "action" ? decision.action.type : decision.status,
    createdAt: new Date().toISOString(),
  };
  episode.step += 1;
  await record(config, {
    event: "step_proposed",
    episodeId: episode.episodeId,
    step,
    observation: {
      accessibilityTreeSha256: sha256(message.observation.accessibilityTree),
      screenshotSha256: message.observation.screenshotSha256,
      screenshotBytes: message.observation.screenshotBytes,
      screenWidth: message.observation.screenWidth,
      screenHeight: message.observation.screenHeight,
    },
    previousReceipt: message.previousReceipt,
    decision: {
      status: decision.status,
      reason: decision.reason,
      actionType:
        decision.status === "action" ? decision.action.type : undefined,
    },
    receipt,
  });
  return {
    ok: true,
    protocolVersion: PROTOCOL_VERSION,
    episodeId: episode.episodeId,
    step,
    decision,
    osworldAction: action,
    receipt,
  };
}

function toOSWorldAction(action: GlobalComputerAction): object {
  switch (action.type) {
    case "os_click":
      if (!Number.isInteger(action.x) || !Number.isInteger(action.y)) {
        throw new Error("OSWorld bridge requires coordinates for os_click.");
      }
      return {
        action_type: "CLICK",
        x: action.x,
        y: action.y,
        button: "left",
        num_clicks: 1,
      };
    case "os_type":
      if (action.text === undefined) {
        throw new Error("OSWorld bridge requires text for os_type.");
      }
      return { action_type: "TYPING", text: action.text };
    case "os_press":
      if (!action.key)
        throw new Error("OSWorld bridge requires a key for os_press.");
      return { action_type: "PRESS", key: action.key.toLowerCase() };
    case "os_scroll": {
      const amount = action.scrollAmount ?? 3;
      switch (action.scrollDirection ?? "down") {
        case "up":
          return { action_type: "SCROLL", dx: 0, dy: amount };
        case "down":
          return { action_type: "SCROLL", dx: 0, dy: -amount };
        case "left":
          return { action_type: "SCROLL", dx: -amount, dy: 0 };
        case "right":
          return { action_type: "SCROLL", dx: amount, dy: 0 };
      }
      throw new Error(
        "OSWorld bridge received an unsupported scroll direction.",
      );
    }
    default:
      throw new Error(
        `GlobalComputerExecutor action ${action.type} cannot be delegated to the OSWorld computer_13 action space.`,
      );
  }
}

function parseMessage(line: string): BridgeMessage {
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch {
    throw new Error("Bridge input is not valid JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Bridge input must be a JSON object.");
  }
  const candidate = value as Partial<BridgeMessage>;
  if (candidate.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error(`protocolVersion must be ${PROTOCOL_VERSION}.`);
  }
  if (
    candidate.type !== "start_episode" &&
    candidate.type !== "step" &&
    candidate.type !== "end_episode"
  ) {
    throw new Error("Unknown bridge message type.");
  }
  return candidate as BridgeMessage;
}

async function loadConfig(path: string): Promise<BridgeConfig> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(resolve(path), "utf8")) as unknown;
  } catch (error) {
    throw new Error(`Could not read bridge config: ${safeError(error)}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Bridge config must be a JSON object.");
  }
  const value = raw as Partial<BridgeConfig>;
  if (value.schemaVersion !== PROTOCOL_VERSION) {
    throw new Error(`Bridge config schemaVersion must be ${PROTOCOL_VERSION}.`);
  }
  if (!Number.isSafeInteger(value.seed) || (value.seed as number) < 0) {
    throw new Error("Bridge config seed must be a non-negative safe integer.");
  }
  if (!value.source) throw new Error("Bridge config requires source.");
  const source = validateTaskSourceConfig(value.source);
  if (!source.enabled)
    throw new Error("Configured TaskSource must be enabled.");
  const credentialEnv = value.credentialEnv;
  if (credentialEnv !== undefined && !/^[A-Z][A-Z0-9_]*$/.test(credentialEnv)) {
    throw new Error(
      "credentialEnv must be an uppercase environment variable name.",
    );
  }
  return {
    schemaVersion: PROTOCOL_VERSION,
    benchmarkRevision: requiredText(
      value.benchmarkRevision,
      "benchmarkRevision",
    ),
    seed: value.seed as number,
    stepTimeoutMs: optionalPositiveInteger(
      value.stepTimeoutMs,
      60_000,
      "stepTimeoutMs",
    ),
    source,
    ...(credentialEnv ? { credentialEnv } : {}),
    workspaceRoot: requiredText(value.workspaceRoot, "workspaceRoot"),
    resultPath: requiredText(value.resultPath, "resultPath"),
  };
}

async function preflight(value: BridgeConfig): Promise<void> {
  const major = Number(process.versions.node.split(".")[0]);
  if (major !== SUPPORTED_NODE_MAJOR) {
    throw new Error(
      `OSWorld bridge requires Node ${SUPPORTED_NODE_MAJOR}; found ${process.versions.node}.`,
    );
  }
  if (
    value.credentialEnv &&
    !process.env[value.credentialEnv] &&
    !value.source.kind.endsWith("-cli")
  ) {
    throw new Error(
      `Required credential environment variable ${value.credentialEnv} is unset.`,
    );
  }
  if (!value.credentialEnv && !value.source.kind.endsWith("-cli")) {
    throw new Error("HTTP TaskSource configurations require credentialEnv.");
  }
  await mkdir(dirname(resolve(value.resultPath)), {
    recursive: true,
    mode: 0o700,
  });
}

async function record(value: BridgeConfig, payload: object): Promise<void> {
  await appendFile(
    resolve(value.resultPath),
    `${JSON.stringify({
      protocolVersion: PROTOCOL_VERSION,
      timestamp: new Date().toISOString(),
      benchmarkRevision: value.benchmarkRevision,
      seed: value.seed,
      source: {
        id: value.source.id,
        kind: value.source.kind,
        model: value.source.model,
        endpoint: value.source.endpoint,
      },
      ...payload,
    })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

function requiredArgument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing required ${name} argument.`);
  }
  return value;
}

function requiredText(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return value;
}

function optionalPositiveInteger(
  value: unknown,
  fallback: number,
  name: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
  return value as number;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeError(error: unknown): string {
  return error instanceof Error
    ? error.message.slice(0, 1_000)
    : "Unknown bridge error.";
}
