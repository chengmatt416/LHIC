import { runGameTrainingCommand } from "@pinyencheng/lhic/dist/game-training.js";

const encodedArguments = process.argv[2];
if (!encodedArguments) {
  throw new Error("Game worker requires a structured command payload.");
}

const argumentsList = JSON.parse(encodedArguments) as unknown;
if (
  !Array.isArray(argumentsList) ||
  argumentsList.some(
    (argument) => typeof argument !== "string" || argument.includes("\0"),
  )
) {
  throw new Error("Game worker command payload is invalid.");
}

const report = await runGameTrainingCommand(argumentsList);
process.stdout.write(`${JSON.stringify(report)}\n`);
