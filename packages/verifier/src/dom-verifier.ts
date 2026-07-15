import type { VerificationResult } from "@lhic/schema";
import type { Page } from "playwright";

export interface DOMVerificationParams {
  selector?: string;
  text?: string;
  state?: "exists" | "visible" | "enabled" | "disabled";
}

export async function verifyDom(
  page: Page,
  params: DOMVerificationParams,
  timeoutMs = 5_000,
): Promise<VerificationResult> {
  if (!params.selector && !params.text) {
    return {
      success: false,
      evidence: [],
      error: "DOM verification requires a selector or text.",
    };
  }

  try {
    const locator = params.selector
      ? page.locator(params.selector).first()
      : page.getByText(params.text ?? "").first();
    const state = params.state ?? (params.text ? "visible" : "exists");

    if (state === "visible") {
      await locator.waitFor({ state: "visible", timeout: timeoutMs });
      return {
        success: true,
        evidence: [
          `DOM target is visible (${params.selector ?? params.text}).`,
        ],
      };
    }

    const count = await locator.count();
    if (count === 0) {
      return {
        success: false,
        evidence: [],
        error: `DOM target was not found (${params.selector ?? params.text}).`,
      };
    }
    if (state === "enabled" && !(await locator.isEnabled())) {
      return {
        success: false,
        evidence: [],
        error: `DOM target is disabled (${params.selector ?? params.text}).`,
      };
    }
    if (state === "disabled" && (await locator.isEnabled())) {
      return {
        success: false,
        evidence: [],
        error: `DOM target is enabled (${params.selector ?? params.text}).`,
      };
    }

    return {
      success: true,
      evidence: [
        `DOM target satisfies ${state} (${params.selector ?? params.text}).`,
      ],
    };
  } catch (error) {
    return {
      success: false,
      evidence: [],
      error:
        error instanceof Error ? error.message : "DOM verification failed.",
    };
  }
}
