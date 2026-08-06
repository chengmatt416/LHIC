import type { ConsoleNetworkObserver } from "@lhic/browser";
import {
  isVerificationCondition,
  type VerificationCondition,
  type VerificationResult,
} from "@lhic/schema";
import type { Page } from "playwright";

import {
  verifyDesktopObservation,
  type DesktopObservation,
  type DesktopObservationVerificationParams,
} from "./desktop-observation-verifier.js";
import {
  verifyDesktopScreenshot,
  type DesktopScreenshotVerificationParams,
} from "./desktop-verifier.js";
import { verifyDom, type DOMVerificationParams } from "./dom-verifier.js";
import { verifyFile, type FileVerificationParams } from "./file-verifier.js";
import {
  verifyNetwork,
  type NetworkVerificationParams,
} from "./network-verifier.js";
import { verifyUrl, type URLVerificationParams } from "./url-verifier.js";

export interface VerifierContext {
  page?: Page;
  networkObserver?: ConsoleNetworkObserver;
}

export class VerifierEngine {
  public constructor(private readonly context: VerifierContext) {}

  public async verify(
    condition: VerificationCondition,
  ): Promise<VerificationResult> {
    if (!isVerificationCondition(condition)) {
      return {
        success: false,
        evidence: [],
        error: "Verification condition does not satisfy the verifier contract.",
      };
    }
    switch (condition.type) {
      case "dom":
        return this.context.page
          ? verifyDom(
              this.context.page,
              condition.params as DOMVerificationParams,
              condition.timeoutMs,
            )
          : this.missingContext("page", condition.type);
      case "url":
        return this.context.page
          ? verifyUrl(
              this.context.page,
              condition.params as URLVerificationParams,
            )
          : this.missingContext("page", condition.type);
      case "network":
        return this.context.networkObserver
          ? verifyNetwork(
              this.context.networkObserver.snapshot(),
              condition.params as NetworkVerificationParams,
            )
          : this.missingContext("network observer", condition.type);
      case "file":
        return verifyFile(condition.params as FileVerificationParams);
      case "screenshot": {
        const params = condition.params as unknown as DesktopScreenshotVerificationParams;
        if (!params.filePath) {
          return {
            success: false,
            evidence: [],
            error: "Screenshot verification requires a filePath parameter.",
          };
        }
        return verifyDesktopScreenshot(params);
      }
      case "desktop_observation": {
        const params = condition.params as unknown as DesktopObservationVerificationParams & {
          observation: DesktopObservation | undefined;
        };
        if (!params.observation) {
          return {
            success: false,
            evidence: [],
            error:
              "Desktop observation verification requires an observation parameter.",
          };
        }
        return verifyDesktopObservation(params.observation, params);
      }
      case "custom":
        return {
          success: false,
          evidence: [],
          error: `${condition.type} verification is unavailable in verifier v0.`,
        };
    }
  }

  private missingContext(required: string, type: string): VerificationResult {
    return {
      success: false,
      evidence: [],
      error: `${type} verification requires a ${required}.`,
    };
  }
}
