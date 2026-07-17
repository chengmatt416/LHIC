import type { VerificationResult } from "@lhic/schema";
import type { Page } from "playwright";

export interface URLVerificationParams {
  contains?: string;
  equals?: string;
  notEquals?: string;
  notContains?: string;
  hasQueryParam?: string;
}

export function verifyUrl(
  page: Page,
  params: URLVerificationParams,
): VerificationResult {
  const url = page.url();
  if (params.equals !== undefined && url !== params.equals) {
    return {
      success: false,
      evidence: [],
      error: "URL does not equal the expected value.",
    };
  }
  if (params.notEquals !== undefined && url === params.notEquals) {
    return {
      success: false,
      evidence: [],
      error: "URL did not change from the expected initial value.",
    };
  }
  if (params.contains !== undefined && !url.includes(params.contains)) {
    return {
      success: false,
      evidence: [],
      error: "URL does not contain the expected value.",
    };
  }
  if (params.notContains !== undefined && url.includes(params.notContains)) {
    return {
      success: false,
      evidence: [],
      error: "URL unexpectedly contains a forbidden value.",
    };
  }
  if (
    params.hasQueryParam !== undefined &&
    !new URL(url).searchParams.has(params.hasQueryParam)
  ) {
    return {
      success: false,
      evidence: [],
      error: "URL does not include the expected query parameter.",
    };
  }
  if (
    params.equals === undefined &&
    params.notEquals === undefined &&
    params.contains === undefined &&
    params.notContains === undefined &&
    params.hasQueryParam === undefined
  ) {
    return {
      success: false,
      evidence: [],
      error: "URL verification requires a comparison.",
    };
  }
  return { success: true, evidence: ["URL verification passed."] };
}
