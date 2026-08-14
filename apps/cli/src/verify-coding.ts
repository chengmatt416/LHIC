import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { CodingVerificationCondition } from "@lhic/schema";
import { runCodingVerification } from "@lhic/verifier";

/**
 * `lhic verify coding <condition-file> [--workspace <dir>]` — runs one
 * objective coding verification condition and prints the evidence. Used to
 * attach verifier evidence to action receipts; the evidence is never
 * fabricated and OMP execution authority is never relabeled.
 */
export async function runVerifyCodingCommand(
  argumentsList: string[],
): Promise<number> {
  const conditionFile = argumentsList[0];
  if (!conditionFile) {
    throw new Error("verify coding requires a condition file.");
  }
  let workspaceRoot = resolve(process.cwd());
  for (let index = 1; index < argumentsList.length; index += 1) {
    if (argumentsList[index] === "--workspace" && argumentsList[index + 1]) {
      workspaceRoot = resolve(argumentsList[index + 1]!);
      index += 1;
    }
  }
  const parsed = JSON.parse(await readFile(conditionFile, "utf8")) as unknown;
  const condition = parsed as CodingVerificationCondition;
  const { evidence, passed } = await runCodingVerification(condition, {
    workspaceRoot,
  });
  console.log(JSON.stringify({ passed, evidence }, null, 2));
  return passed ? 0 : 1;
}
