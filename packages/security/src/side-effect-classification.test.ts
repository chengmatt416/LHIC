import { describe, expect, it } from "vitest";

import type { SemanticAction } from "@lhic/schema";

import {
  effectiveSideEffectClass,
  inferSideEffectClass,
  isHighRiskSideEffectClass,
  isReadOnlySideEffectClass,
} from "./side-effect-classification.js";

function browserAction(partial: Partial<SemanticAction>): SemanticAction {
  return {
    type: "click",
    intent: "Click submit",
    target: "submit",
    methodPreference: ["dom"],
    riskLevel: "medium",
    ...partial,
  } as SemanticAction;
}

describe("independent side-effect classification", () => {
  it("classifies read-only browser actions", () => {
    expect(
      inferSideEffectClass(
        browserAction({ type: "navigate", intent: "Open the docs page" }),
      ),
    ).toBe("read");
    expect(
      inferSideEffectClass(
        browserAction({ type: "wait", intent: "Wait for load" }),
      ),
    ).toBe("read");
  });

  it("classifies downloads and uploads", () => {
    expect(
      inferSideEffectClass(
        browserAction({ type: "download", intent: "Download report" }),
      ),
    ).toBe("download");
    expect(
      inferSideEffectClass(
        browserAction({
          type: "upload",
          intent: "Upload resume",
          target: "file",
          filePath: "/tmp/r.pdf",
        }),
      ),
    ).toBe("upload");
  });

  it("escalates financial intent on activation targets", () => {
    expect(
      inferSideEffectClass(
        browserAction({ intent: "Pay the invoice", target: "pay now" }),
      ),
    ).toBe("purchase");
    expect(
      inferSideEffectClass(
        browserAction({ intent: "Confirm purchase", target: "checkout" }),
      ),
    ).toBe("purchase");
  });

  it("escalates destructive and credential intents", () => {
    expect(
      inferSideEffectClass(
        browserAction({ intent: "Delete the account", target: "delete" }),
      ),
    ).toBe("destructive");
    expect(
      inferSideEffectClass(
        browserAction({ intent: "Update my password", target: "save" }),
      ),
    ).toBe("credential_change");
  });

  it("treats side-effect activation targets as external writes", () => {
    expect(
      inferSideEffectClass(
        browserAction({ intent: "Click it", target: "publish" }),
      ),
    ).toBe("external_write");
  });

  it("fails unknown and custom actions closed", () => {
    expect(inferSideEffectClass(browserAction({ type: "custom" }))).toBe(
      "unknown",
    );
  });

  it("never lets a planner label lower the inferred class", () => {
    // The model marks a purchase as read; the effective class stays purchase.
    expect(effectiveSideEffectClass("read", "purchase")).toBe("purchase");
    // The model marks destructive as local_edit; stays destructive.
    expect(effectiveSideEffectClass("local_edit", "destructive")).toBe(
      "destructive",
    );
    // A planner class may raise the inferred class.
    expect(effectiveSideEffectClass("credential_change", "read")).toBe(
      "credential_change",
    );
    // Unknown is the ceiling.
    expect(effectiveSideEffectClass("read", "unknown")).toBe("unknown");
  });

  it("marks high-risk classes and read-only classes", () => {
    expect(isHighRiskSideEffectClass("purchase")).toBe(true);
    expect(isHighRiskSideEffectClass("financial_transfer")).toBe(true);
    expect(isHighRiskSideEffectClass("credential_change")).toBe(true);
    expect(isHighRiskSideEffectClass("destructive")).toBe(true);
    expect(isHighRiskSideEffectClass("admin_or_security_change")).toBe(true);
    expect(isHighRiskSideEffectClass("read")).toBe(false);
    expect(isHighRiskSideEffectClass("download")).toBe(false);
    expect(isReadOnlySideEffectClass("read")).toBe(true);
    expect(isReadOnlySideEffectClass("local_edit")).toBe(false);
  });
});
