import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { chromium } from "playwright";

import {
  isGlobalComputerAction,
  isSemanticAction,
  type ActionExecutionResult,
  type SemanticAction,
} from "@lhic/schema";
import {
  parseRuntimeConfig,
  type ActionApproval,
  type EnvironmentSource,
} from "@lhic/security";
import { createProductionExecutor } from "@lhic/browser";
import { GlobalComputerExecutor } from "@lhic/skills";

export async function runActionFile(
  actionFilePath: string,
  approvalFilePath?: string,
  environment: EnvironmentSource = process.env,
): Promise<ActionExecutionResult> {
  const action = await readSemanticAction(actionFilePath);
  const approval = approvalFilePath
    ? await readActionApproval(approvalFilePath)
    : undefined;
  const taskId = basename(actionFilePath).replace(/\.[^.]+$/, "");
  const config = parseRuntimeConfig(environment);

  if (isGlobalComputerAction(action)) {
    const executor = new GlobalComputerExecutor({
      taskId,
      traceFilePath: join(config.traceDirectory, `${taskId}.jsonl`),
      approvalValidation: {
        requireSignature: config.environment === "production",
        ...(config.approvalPublicKey
          ? { publicKey: config.approvalPublicKey }
          : {}),
      },
    });
    return executor.execute(action, approval);
  }

  const browser = await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage();
    const executor = createProductionExecutor(page, config, { taskId });
    return await executor.execute(action, approval);
  } finally {
    await browser.close();
  }
}

async function readSemanticAction(filePath: string): Promise<SemanticAction> {
  const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
  if (!isSemanticAction(parsed)) {
    throw new Error("Action file does not contain a valid SemanticAction.");
  }
  return parsed;
}

async function readActionApproval(filePath: string): Promise<ActionApproval> {
  const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
  if (!isActionApproval(parsed)) {
    throw new Error("Approval file does not contain a valid ActionApproval.");
  }
  return parsed;
}

function isActionApproval(value: unknown): value is ActionApproval {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<ActionApproval>;
  return (
    typeof candidate.approvalId === "string" &&
    typeof candidate.actionHash === "string" &&
    typeof candidate.approvedBy === "string" &&
    typeof candidate.approvedAt === "string" &&
    typeof candidate.expiresAt === "string" &&
    (candidate.signature === undefined ||
      typeof candidate.signature === "string")
  );
}
