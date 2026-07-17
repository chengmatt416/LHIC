export interface DemoCommandOptions {
  safe: boolean;
  viewable: boolean;
  endpoint?: string;
}

export function parseDemoCommandOptions(
  argumentsList: readonly string[],
): DemoCommandOptions {
  let safe = false;
  let viewable = false;
  let endpoint: string | undefined;

  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--safe") {
      if (safe) throw new Error("demo accepts --safe only once.");
      safe = true;
      continue;
    }
    if (argument === "--viewable" || argument === "--view") {
      if (viewable) throw new Error("demo accepts --viewable only once.");
      viewable = true;
      continue;
    }
    if (argument === "--endpoint") {
      if (endpoint !== undefined)
        throw new Error("demo accepts --endpoint only once.");
      const value = argumentsList[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("demo --endpoint requires an absolute URL.");
      }
      endpoint = value;
      index += 1;
      continue;
    }
    throw new Error(
      `Unknown demo option ${argument}. Use --safe, --viewable, or --endpoint <URL>.`,
    );
  }

  if (safe && endpoint !== undefined) {
    throw new Error("demo --safe does not use a model endpoint.");
  }
  return { safe, viewable, ...(endpoint === undefined ? {} : { endpoint }) };
}
