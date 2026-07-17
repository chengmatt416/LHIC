import type { ActionMethod } from "@lhic/schema";
import type { Locator, Page } from "playwright";

export interface ResolvedTarget {
  locator: Locator;
  method: Extract<ActionMethod, "dom" | "accessibility">;
  description: string;
  safetyText: string;
  href?: string;
  memory: SelectorMemoryCandidate;
}

export interface SelectorMemoryCandidate {
  selector: string;
  role?: string;
  label?: string;
}

interface SelectorMemoryLookup extends SelectorMemoryCandidate {
  successCount?: number;
}

type AccessibilityKind =
  "label" | "button" | "link" | "textbox" | "searchbox" | "combobox" | "text";

async function matchCount(locator: Locator): Promise<number> {
  try {
    return await locator.count();
  } catch {
    return 0;
  }
}

export async function resolveTarget(
  page: Page,
  target: string,
  selectorMemory?: {
    find: (skillName: string, target: string) => SelectorMemoryLookup[];
  },
  skillName?: string,
): Promise<ResolvedTarget> {
  const selector = page.locator(target);
  const selectorCount = await matchCount(selector);
  if (selectorCount === 1) {
    return resolvedTarget(selector, "dom", `selector ${target}`, target);
  }
  if (selectorCount > 1) {
    throw new Error(
      `DOM selector ${JSON.stringify(target)} matched ${selectorCount} elements; use a unique target.`,
    );
  }

  const accessibleCandidates = accessibilityCandidatesFor(
    page,
    target,
    skillName,
  );

  for (const [kind, locator] of accessibleCandidates) {
    const count = await matchCount(locator);
    if (count === 1) {
      return resolvedTarget(
        locator,
        "accessibility",
        `${kind} named ${target}`,
        `accessibility:${kind}:${target}`,
        accessibilityMemory(kind, target),
      );
    }
    if (count > 1) {
      throw new Error(
        `Accessibility ${kind} target ${JSON.stringify(target)} matched ${count} elements; use a unique target.`,
      );
    }
  }

  if (selectorMemory && skillName) {
    const historical = selectorMemory.find(skillName, target);
    for (const entry of historical) {
      const historicalTarget = await resolveHistoricalTarget(page, entry);
      if (historicalTarget) {
        return historicalTarget;
      }
    }
  }

  throw new Error(
    `No DOM or accessibility target matched ${JSON.stringify(target)}.`,
  );
}

async function resolvedTarget(
  locator: Locator,
  method: Extract<ActionMethod, "dom" | "accessibility">,
  description: string,
  fallbackSelector: string,
  memory?: SelectorMemoryCandidate,
): Promise<ResolvedTarget> {
  const inspected = await locator.evaluate((element) => {
    const input = element as HTMLInputElement;
    const labelledBy = element.getAttribute("aria-labelledby");
    const labelledText = labelledBy
      ? labelledBy
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent?.trim())
          .filter(Boolean)
          .join(" ")
      : "";
    const selector = element.id
      ? `#${CSS.escape(element.id)}`
      : element.getAttribute("data-testid")
        ? `[data-testid="${CSS.escape(element.getAttribute("data-testid") ?? "")}"]`
        : element.getAttribute("name")
          ? `${element.tagName.toLowerCase()}[name="${CSS.escape(element.getAttribute("name") ?? "")}"]`
          : undefined;
    return {
      safetyText: [
        element.getAttribute("aria-label"),
        labelledText,
        input.labels?.[0]?.textContent?.trim(),
        element.getAttribute("title"),
        element.getAttribute("name"),
        element.id,
        element.textContent?.trim(),
      ]
        .filter(Boolean)
        .join(" "),
      selector,
      href: element.getAttribute("href") ?? undefined,
    };
  });
  return {
    locator,
    method,
    description,
    safetyText: inspected.safetyText,
    ...(inspected.href ? { href: inspected.href } : {}),
    memory: memory ?? { selector: inspected.selector ?? fallbackSelector },
  };
}

function accessibilityMemory(
  kind: AccessibilityKind,
  label: string,
): SelectorMemoryCandidate {
  return {
    selector: `accessibility:${kind}:${label}`,
    role: kind,
    label,
  };
}

async function resolveHistoricalTarget(
  page: Page,
  entry: SelectorMemoryLookup,
): Promise<ResolvedTarget | undefined> {
  const accessible = entry.label
    ? historicalAccessibleLocator(page, entry.role, entry.label)
    : undefined;
  if (accessible && (await matchCount(accessible)) === 1) {
    return resolvedTarget(
      accessible,
      "accessibility",
      `healed accessibility target ${entry.label}`,
      entry.selector,
      entry,
    );
  }

  if (entry.selector.startsWith("accessibility:")) {
    return undefined;
  }
  const selector = page.locator(entry.selector);
  if ((await matchCount(selector)) !== 1) {
    return undefined;
  }
  return resolvedTarget(
    selector,
    "dom",
    `healed selector ${entry.selector}`,
    entry.selector,
    entry,
  );
}

function historicalAccessibleLocator(
  page: Page,
  role: string | undefined,
  label: string,
): Locator | undefined {
  switch (role) {
    case "label":
      return page.getByLabel(label, { exact: true });
    case "button":
      return page.getByRole("button", { name: label, exact: true });
    case "link":
      return page.getByRole("link", { name: label, exact: true });
    case "textbox":
      return page.getByRole("textbox", { name: label, exact: true });
    case "searchbox":
      return page.getByRole("searchbox", { name: label, exact: true });
    case "combobox":
      return page.getByRole("combobox", { name: label, exact: true });
    case "text":
      return page.getByText(label, { exact: true });
    default:
      return undefined;
  }
}

function accessibilityCandidatesFor(
  page: Page,
  target: string,
  actionType: string | undefined,
): Array<[AccessibilityKind, Locator]> {
  const candidates: Record<AccessibilityKind, Locator> = {
    label: page.getByLabel(target, { exact: true }),
    button: page.getByRole("button", { name: target, exact: true }),
    link: page.getByRole("link", { name: target, exact: true }),
    textbox: page.getByRole("textbox", { name: target, exact: true }),
    searchbox: page.getByRole("searchbox", { name: target, exact: true }),
    combobox: page.getByRole("combobox", { name: target, exact: true }),
    text: page.getByText(target, { exact: true }),
  };
  const kinds: readonly AccessibilityKind[] =
    actionType === "fill"
      ? ["label", "textbox", "searchbox", "combobox"]
      : actionType === "select"
        ? ["label", "combobox"]
        : actionType === "press"
          ? [
              "label",
              "textbox",
              "searchbox",
              "combobox",
              "button",
              "link",
              "text",
            ]
          : [
              "button",
              "link",
              "label",
              "textbox",
              "searchbox",
              "combobox",
              "text",
            ];
  return kinds.map((kind): [AccessibilityKind, Locator] => [
    kind,
    candidates[kind],
  ]);
}
