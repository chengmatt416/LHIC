import { createInterface } from "node:readline/promises";

import { validateDemoModelEndpoint } from "./demo-model-endpoint.js";

export interface CliPrompter {
  readonly interactive: boolean;
  prompt(message: string, defaultValue?: string): Promise<string>;
  promptSecret(message: string): Promise<string>;
  close(): void;
}

export const cliUsage =
  "Usage: lhic [install <cli|desktop> | start [memory-database] | demo [--safe] [--viewable] [--endpoint <URL>] | gui [demo|mcp] [--no-open] | shared <enable|login|disable|status|sync|list> [options] | train public-web <wikipedia-search|mdn-search|github-issue-filter|openstreetmap-place-search> --query <safe-public-query> [--database <path>] [--viewable] | train game env <setup|doctor> [--root <path>] [--python <path>] | train game <2d|3d> <setup|lease|record|fit|evaluate|play> <star-trooper|nemesis> [options] | preflight | global doctor | run action <action-file> [approval-file] | run plan <plan-file> [approvals-file] [--var name=value] | bench internal [--output <path>] | bench simulate resilience [task-count] [seed] | bench readiness <workarena|webarena> | bench validate-evidence <file> | mcp config <antigravity|codex|claude-code|vscode> [workspace-root] | trace inspect <trace-file>]";

export function createTerminalPrompter(): CliPrompter {
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const readline = interactive
    ? createInterface({ input: process.stdin, output: process.stdout })
    : undefined;

  return {
    interactive,
    async prompt(message: string, defaultValue?: string): Promise<string> {
      if (!readline) {
        throw new Error(
          "Interactive guidance requires a terminal. Supply the required arguments explicitly.",
        );
      }
      const suffix = defaultValue ? ` [${defaultValue}]` : "";
      const answer = await readline.question(`${message}${suffix}: `);
      return answer.trim() || defaultValue || "";
    },
    async promptSecret(message: string): Promise<string> {
      if (!readline) {
        throw new Error(
          "Interactive guidance requires a terminal. Supply the required arguments explicitly.",
        );
      }
      const answer = await readline.question(`${message}: \u001B[8m`);
      process.stdout.write("\u001B[0m\n");
      return answer.trim();
    },
    close(): void {
      readline?.close();
    },
  };
}

export async function guideCliArguments(
  argumentsList: string[],
  prompter: CliPrompter,
): Promise<string[]> {
  let guided = [...argumentsList];
  const selectedFromRootMenu = guided.length === 0;
  if (guided.length === 0) {
    guided = await chooseRootCommand(prompter);
  }

  switch (guided[0]) {
    case "demo":
      return selectedFromRootMenu ? guideDemoCommand(guided, prompter) : guided;
    case "gui":
      return selectedFromRootMenu ? guideGuiCommand(guided, prompter) : guided;
    case "install":
      return guideInstallCommand(guided, prompter);
    case "shared":
      return guideSharedCommand(guided, prompter);
    case "train":
      return guideTrainingCommand(guided, prompter);
    case "global":
      return guideGlobalCommand(guided);
    case "run":
      return guideRunCommand(guided, prompter);
    case "bench":
      return guideBenchmarkCommand(guided, prompter);
    case "mcp":
      return guideMcpCommand(guided, prompter);
    case "trace":
      return guideTraceCommand(guided, prompter);
    default:
      return guided;
  }
}

async function guideDemoCommand(
  argumentsList: string[],
  prompter: CliPrompter,
): Promise<string[]> {
  const mode = await askChoice(prompter, "Demo mode", [
    "interactive learning",
    "safe fixture",
  ]);
  if (mode === "safe fixture") {
    argumentsList.push("--safe");
    const browserMode = await askChoice(prompter, "Safe demo browser", [
      "viewable",
      "headless",
    ]);
    if (browserMode === "viewable") argumentsList.push("--viewable");
    return argumentsList;
  }

  const endpoint = await askOptionalDemoEndpoint(prompter);
  if (endpoint) argumentsList.push("--endpoint", endpoint);
  return argumentsList;
}

async function guideGuiCommand(
  argumentsList: string[],
  prompter: CliPrompter,
): Promise<string[]> {
  const tab = await askChoice(prompter, "GUI companion screen", [
    "demo",
    "mcp",
  ]);
  argumentsList.push(tab);
  const browser = await askChoice(prompter, "Open the local GUI now", [
    "yes",
    "no",
  ]);
  if (browser === "no") argumentsList.push("--no-open");
  return argumentsList;
}

async function askOptionalDemoEndpoint(
  prompter: CliPrompter,
): Promise<string | undefined> {
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

async function chooseRootCommand(prompter: CliPrompter): Promise<string[]> {
  const choice = await askChoice(prompter, "What would you like LHIC to do", [
    "start",
    "install",
    "demo",
    "gui",
    "preflight",
    "global doctor",
    "run action",
    "run plan",
    "shared",
    "train",
    "bench",
    "mcp",
    "trace",
  ]);
  return choice.split(" ");
}

async function guideInstallCommand(
  argumentsList: string[],
  prompter: CliPrompter,
): Promise<string[]> {
  const guided = [...argumentsList];
  guided[1] ??= await askChoice(prompter, "Install LHIC", ["cli", "desktop"]);
  return guided;
}

async function guideTrainingCommand(
  argumentsList: string[],
  prompter: CliPrompter,
): Promise<string[]> {
  const guided = [...argumentsList];
  if (guided[1] === "game") return guided;
  guided[1] ??= "public-web";
  if (guided[1] !== "public-web") return guided;
  if (!guided[2]) {
    guided[2] = await askChoice(prompter, "Public website", [
      "wikipedia-search",
      "mdn-search",
      "github-issue-filter",
      "openstreetmap-place-search",
    ]);
  }
  await promptForSharedOption(
    guided,
    "--query",
    "Safe public search query (no personal or credential data)",
    prompter,
  );
  return guided;
}

async function guideSharedCommand(
  argumentsList: string[],
  prompter: CliPrompter,
): Promise<string[]> {
  const guided = [...argumentsList];
  const command =
    guided[1] ??
    (await askChoice(prompter, "Shared skills action", [
      "enable",
      "login",
      "disable",
      "status",
      "sync",
      "list",
    ]));
  guided[1] = command;

  if (command === "enable") {
    await promptForSharedOption(
      guided,
      "--endpoint",
      "Appwrite endpoint (for example, https://<region>.cloud.appwrite.io/v1)",
      prompter,
    );
    await promptForSharedOption(
      guided,
      "--project",
      "Appwrite project ID",
      prompter,
    );
    await promptForSharedOption(
      guided,
      "--function-url",
      "Appwrite Function URL",
      prompter,
    );
    await promptForSharedOption(
      guided,
      "--email",
      "Email address for Magic URL sign-in",
      prompter,
    );
  }

  if (command === "login") {
    await promptForSharedOption(
      guided,
      "--email",
      "Email address for Magic URL sign-in",
      prompter,
    );
  }

  return guided;
}

async function guideGlobalCommand(argumentsList: string[]): Promise<string[]> {
  const guided = [...argumentsList];
  guided[1] ??= "doctor";
  return guided;
}

async function guideRunCommand(
  argumentsList: string[],
  prompter: CliPrompter,
): Promise<string[]> {
  const guided = [...argumentsList];
  guided[1] ??= "action";
  if (!guided[2] && (guided[1] === "action" || guided[1] === "plan")) {
    guided[2] = await askRequired(
      prompter,
      guided[1] === "plan"
        ? "Path to browser plan JSON file"
        : "Path to action JSON file",
    );
  }
  return guided;
}

async function guideBenchmarkCommand(
  argumentsList: string[],
  prompter: CliPrompter,
): Promise<string[]> {
  const guided = [...argumentsList];
  const command =
    guided[1] ??
    (await askChoice(prompter, "Benchmark action", [
      "internal",
      "simulate resilience",
      "readiness",
      "validate-evidence",
    ]));
  const commandParts = command.split(" ");
  guided[1] = commandParts[0]!;
  if (commandParts[1]) {
    guided[2] ??= commandParts[1];
  }

  if (guided[1] === "simulate") {
    guided[2] ??= "resilience";
  }
  if (guided[1] === "readiness" && !guided[2]) {
    guided[2] = await askChoice(prompter, "Benchmark target", [
      "workarena",
      "webarena",
    ]);
  }
  if (guided[1] === "validate-evidence" && !guided[2]) {
    guided[2] = await askRequired(prompter, "Path to benchmark evidence file");
  }
  return guided;
}

async function guideMcpCommand(
  argumentsList: string[],
  prompter: CliPrompter,
): Promise<string[]> {
  const guided = [...argumentsList];
  guided[1] ??= "config";
  if (guided[1] === "config" && !guided[2]) {
    guided[2] = await askChoice(prompter, "MCP client", [
      "antigravity",
      "codex",
      "claude-code",
      "vscode",
    ]);
  }
  return guided;
}

async function guideTraceCommand(
  argumentsList: string[],
  prompter: CliPrompter,
): Promise<string[]> {
  const guided = [...argumentsList];
  guided[1] ??= "inspect";
  if (guided[1] === "inspect" && !guided[2]) {
    guided[2] = await askRequired(prompter, "Path to trace file");
  }
  return guided;
}

async function promptForSharedOption(
  argumentsList: string[],
  option: string,
  message: string,
  prompter: CliPrompter,
): Promise<void> {
  const index = argumentsList.indexOf(option);
  if (index >= 0 && optionValue(argumentsList, index)) {
    return;
  }
  const value = await askRequired(prompter, message);
  if (index >= 0) {
    argumentsList.splice(index + 1, 0, value);
  } else {
    argumentsList.push(option, value);
  }
}

function optionValue(
  argumentsList: string[],
  index: number,
): string | undefined {
  const value = argumentsList[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

async function askChoice(
  prompter: CliPrompter,
  message: string,
  choices: readonly string[],
): Promise<string> {
  const question = `${message} (${choices.join(", ")})`;
  while (true) {
    const choice = await askRequired(prompter, question);
    if (choices.includes(choice)) {
      return choice;
    }
  }
}

async function askRequired(
  prompter: CliPrompter,
  message: string,
): Promise<string> {
  if (!prompter.interactive) {
    throw new Error(`Missing required input for ${message}. ${cliUsage}`);
  }
  while (true) {
    const value = await prompter.prompt(message);
    if (value.trim()) {
      return value.trim();
    }
  }
}
