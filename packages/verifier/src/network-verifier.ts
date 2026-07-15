import type { NetworkObservation } from "@lhic/browser";
import type { VerificationResult } from "@lhic/schema";

export interface NetworkVerificationParams {
  requestSucceeded?: boolean;
  noFailedRequests?: boolean;
}

export function verifyNetwork(
  observation: NetworkObservation,
  params: NetworkVerificationParams,
): VerificationResult {
  const evidence = [
    `completed=${observation.completedRequests}`,
    `failed=${observation.failedRequests}`,
    `pending=${observation.pendingRequests}`,
  ];
  if (params.requestSucceeded && observation.completedRequests === 0) {
    return {
      success: false,
      evidence,
      error: "No completed network request was observed.",
    };
  }
  if (params.noFailedRequests && observation.failedRequests > 0) {
    return {
      success: false,
      evidence,
      error: "Failed network requests were observed.",
    };
  }
  if (!params.requestSucceeded && !params.noFailedRequests) {
    return {
      success: false,
      evidence,
      error: "Network verification requires a condition.",
    };
  }
  return { success: true, evidence };
}
