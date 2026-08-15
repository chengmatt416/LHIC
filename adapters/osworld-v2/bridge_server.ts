import { createHash } from "node:crypto";
import { createInterface } from "node:readline";

import { SplitExecutionBoundary } from "../../src/boundary.ts";
import { FileSideEffectLedger } from "../../src/ledger.ts";
import type {
  ApprovalRecord,
  ObservationOutcome,
  ResearchAction,
  VerificationEvidence,
} from "../../src/model.ts";

interface BeforeDispatchCommand {
  id: string;
  op: "before_dispatch";
  taskId: string;
  actionIndex: number;
  action: string;
}

interface ActionCommand {
  id: string;
  op: "after_response" | "after_lost_response" | "state";
  actionId: string;
}

interface RecoverCommand {
  id: string;
  op: "recover";
  actionId: string;
  observation: ObservationOutcome;
  evidence?: VerificationEvidence;
}

type Command = BeforeDispatchCommand | ActionCommand | RecoverCommand;

const ledgerPath = process.argv[2];
if (!ledgerPath) throw new Error("Usage: bridge_server.ts <ledger-file>");

const ledger = new FileSideEffectLedger(ledgerPath);
await ledger.load();
const boundary = new SplitExecutionBoundary(ledger);

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function researchAction(command: BeforeDispatchCommand): ResearchAction {
  const actionId = `osworld:${command.taskId}:${command.actionIndex}`;
  return {
    actionId,
    taskId: command.taskId,
    surface: "desktop",
    tool: "pyautogui",
    intent: "execute OSWorld benchmark action",
    target: command.action,
    actionHash: sha256(`${actionId}\n${command.action}`),
  };
}

function exactApproval(action: ResearchAction): ApprovalRecord {
  return {
    approvalId: `osworld-approval:${action.actionId}`,
    approvedBy: "osworld-benchmark-harness",
    authority: "operator",
    createdAt: new Date().toISOString(),
    scope: {
      type: "exact_action",
      actionHash: action.actionHash,
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    },
  };
}

async function handle(command: Command): Promise<unknown> {
  switch (command.op) {
    case "before_dispatch": {
      const action = researchAction(command);
      return boundary.prepare(action, exactApproval(action));
    }
    case "after_response":
      return boundary.recordResponse(command.actionId);
    case "after_lost_response":
      return boundary.recordLostResponse(command.actionId);
    case "recover":
      return boundary.recover(command.actionId, command.observation, command.evidence);
    case "state":
      return boundary.state(command.actionId) ?? null;
  }
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  if (!line.trim()) continue;
  let command: Command | undefined;
  try {
    command = JSON.parse(line) as Command;
    const result = await handle(command);
    process.stdout.write(`${JSON.stringify({ id: command.id, ok: true, result })}\n`);
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({
        id: command?.id ?? null,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })}\n`,
    );
  }
}
