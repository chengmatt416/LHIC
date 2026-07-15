import type { Locator } from "playwright";

import {
  createSkillTrace,
  skillFailure,
  type SkillContext,
  type SkillResult,
} from "./skill-types.js";

export interface SearchInput {
  query: string;
  expectedText?: string;
}

async function firstMatch(candidates: Locator[]): Promise<Locator | undefined> {
  for (const candidate of candidates) {
    if ((await candidate.count()) > 0) {
      return candidate.first();
    }
  }
  return undefined;
}

export async function search(
  context: SkillContext,
  input: SearchInput,
): Promise<SkillResult> {
  const trace = createSkillTrace(context);
  await trace.emit("search_started", { queryLength: input.query.length });
  const beforeUrl = context.page.url();

  try {
    const field = await firstMatch([
      context.page.getByRole("searchbox"),
      context.page.getByRole("textbox", { name: /search|find|query/i }),
      context.page.locator(
        'input[type="search"], input[name*="search" i], input[placeholder*="search" i]',
      ),
    ]);
    if (!field) {
      return skillFailure(trace, "A search field could not be located.");
    }
    await field.fill(input.query);
    const button = await firstMatch([
      context.page.getByRole("button", { name: /search|find/i }),
      context.page.locator('button[type="submit"], input[type="submit"]'),
    ]);
    if (button) {
      await button.click();
      await trace.emit("search_submitted", { method: "button" });
    } else {
      await field.press("Enter");
      await trace.emit("search_submitted", { method: "keyboard" });
    }

    if (input.expectedText) {
      const verification = await context.verifier.verify({
        type: "dom",
        description: "Expected search result is visible.",
        params: { text: input.expectedText },
      });
      if (!verification.success) {
        return skillFailure(
          trace,
          verification.error ?? "Expected search result was not visible.",
        );
      }
      await trace.emit("search_verified", { verifier: "expected_text" });
      return {
        success: true,
        evidence: verification.evidence,
        traces: trace.events,
      };
    }
    if (context.page.url() !== beforeUrl) {
      await trace.emit("search_verified", { verifier: "url_changed" });
      return {
        success: true,
        evidence: [`Search changed URL to ${context.page.url()}.`],
        traces: trace.events,
      };
    }
    if ((await field.inputValue()) === input.query) {
      await trace.emit("search_verified", { verifier: "query_retained" });
      return {
        success: true,
        evidence: ["Search query was entered and submitted."],
        traces: trace.events,
      };
    }
    return skillFailure(
      trace,
      "Search action completed but no result-state verifier was available.",
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Search failed.";
    await trace.emit("search_failed", { error: message });
    return skillFailure(trace, message);
  }
}
