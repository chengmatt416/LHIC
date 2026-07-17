import type { VerificationResult } from "@lhic/schema";
import type { Page } from "playwright";

export interface DOMVerificationParams {
  selector?: string;
  text?: string;
  role?: string;
  name?: string;
  state?: "exists" | "visible" | "enabled" | "disabled";
}

export async function verifyDom(
  page: Page,
  params: DOMVerificationParams,
  timeoutMs = 5_000,
): Promise<VerificationResult> {
  if (!params.selector && !params.text && !params.role) {
    return {
      success: false,
      evidence: [],
      error: "DOM verification requires a selector, text, or role.",
    };
  }

  try {
    const locator = params.selector
      ? page.locator(params.selector).first()
      : params.role
        ? page
            .getByRole(params.role as Parameters<Page["getByRole"]>[0], {
              ...(params.name === undefined ? {} : { name: params.name }),
            })
            .first()
        : page.getByText(params.text ?? "").first();
    const description =
      params.selector ??
      params.text ??
      `${params.role}${params.name ? `:${params.name}` : ""}`;
    const state =
      params.state ?? (params.text || params.role ? "visible" : "exists");

    if (state === "visible") {
      await locator.waitFor({ state: "visible", timeout: timeoutMs });
      return {
        success: true,
        evidence: [`DOM target is visible (${description}).`],
      };
    }

    const count = await locator.count();
    if (count === 0) {
      return {
        success: false,
        evidence: [],
        error: `DOM target was not found (${description}).`,
      };
    }
    if (state === "enabled" && !(await locator.isEnabled())) {
      return {
        success: false,
        evidence: [],
        error: `DOM target is disabled (${description}).`,
      };
    }
    if (state === "disabled" && (await locator.isEnabled())) {
      return {
        success: false,
        evidence: [],
        error: `DOM target is enabled (${description}).`,
      };
    }

    return {
      success: true,
      evidence: [`DOM target satisfies ${state} (${description}).`],
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
