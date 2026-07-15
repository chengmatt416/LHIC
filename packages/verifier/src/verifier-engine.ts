import type { ConsoleNetworkObserver } from "@lhic/browser";
import type { VerificationCondition, VerificationResult } from "@lhic/schema";
import type { Page } from "playwright";

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
      case "screenshot":
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
