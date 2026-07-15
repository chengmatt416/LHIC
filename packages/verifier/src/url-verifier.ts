import type { VerificationResult } from "@lhic/schema";
import type { Page } from "playwright";

export interface URLVerificationParams {
  contains?: string;
  equals?: string;
  notContains?: string;
}

export function verifyUrl(
  page: Page,
  params: URLVerificationParams,
): VerificationResult {
  const url = page.url();
  if (params.equals !== undefined && url !== params.equals) {
    return {
      success: false,
      evidence: [`Observed URL: ${url}`],
      error: `URL does not equal ${params.equals}.`,
    };
  }
  if (params.contains !== undefined && !url.includes(params.contains)) {
    return {
      success: false,
      evidence: [`Observed URL: ${url}`],
      error: `URL does not contain ${params.contains}.`,
    };
  }
  if (params.notContains !== undefined && url.includes(params.notContains)) {
    return {
      success: false,
      evidence: [`Observed URL: ${url}`],
      error: `URL unexpectedly contains ${params.notContains}.`,
    };
  }
  if (
    params.equals === undefined &&
    params.contains === undefined &&
    params.notContains === undefined
  ) {
    return {
      success: false,
      evidence: [`Observed URL: ${url}`],
      error: "URL verification requires a comparison.",
    };
  }
  return { success: true, evidence: [`URL verified: ${url}`] };
}
