export const guiCompanionTabs = ["demo", "mcp"] as const;

export type GuiCompanionTab = (typeof guiCompanionTabs)[number];

export interface GuiCommandOptions {
  initialTab: GuiCompanionTab;
  openBrowser: boolean;
}

export function parseGuiCommandOptions(
  argumentsList: readonly string[],
): GuiCommandOptions {
  let initialTab: GuiCompanionTab = "demo";
  let tabSelected = false;
  let openBrowser = true;

  for (const argument of argumentsList) {
    if (argument === "--no-open") {
      if (!openBrowser) throw new Error("gui accepts --no-open only once.");
      openBrowser = false;
      continue;
    }
    if (guiCompanionTabs.includes(argument as GuiCompanionTab)) {
      if (tabSelected) throw new Error("gui accepts one initial tab only.");
      initialTab = argument as GuiCompanionTab;
      tabSelected = true;
      continue;
    }
    throw new Error(
      `Unknown gui option ${argument}. Use demo, mcp, or --no-open.`,
    );
  }

  return { initialTab, openBrowser };
}
