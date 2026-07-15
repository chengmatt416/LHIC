import type { ActionMethod } from "@lhic/schema";
import type { Locator, Page } from "playwright";

export interface ResolvedTarget {
  locator: Locator;
  method: Extract<ActionMethod, "dom" | "accessibility">;
  description: string;
}

async function hasMatch(locator: Locator): Promise<boolean> {
  try {
    return (await locator.count()) > 0;
  } catch {
    return false;
  }
}

export async function resolveTarget(
  page: Page,
  target: string,
): Promise<ResolvedTarget> {
  const selector = page.locator(target).first();
  if (await hasMatch(selector)) {
    return {
      locator: selector,
      method: "dom",
      description: `selector ${target}`,
    };
  }

  const accessibleCandidates: Array<[string, Locator]> = [
    ["label", page.getByLabel(target, { exact: true }).first()],
    ["button", page.getByRole("button", { name: target, exact: true }).first()],
    ["link", page.getByRole("link", { name: target, exact: true }).first()],
    [
      "textbox",
      page.getByRole("textbox", { name: target, exact: true }).first(),
    ],
    [
      "combobox",
      page.getByRole("combobox", { name: target, exact: true }).first(),
    ],
    ["text", page.getByText(target, { exact: true }).first()],
  ];

  for (const [kind, locator] of accessibleCandidates) {
    if (await hasMatch(locator)) {
      return {
        locator,
        method: "accessibility",
        description: `${kind} named ${target}`,
      };
    }
  }

  throw new Error(
    `No DOM or accessibility target matched ${JSON.stringify(target)}.`,
  );
}
