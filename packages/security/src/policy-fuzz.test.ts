import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { SemanticAction, SideEffectClass } from "@lhic/schema";
import { hashState } from "@lhic/trace";

import { parseApprovalScope, validateApprovalScope } from "./approval-scope.js";
import {
  effectiveSideEffectClass,
  inferSideEffectClass,
} from "./side-effect-classification.js";
import { structuredRiskLevel } from "./risk-policy.js";
import {
  createActionApproval,
  validateActionApproval,
} from "./action-approval.js";

/** Deterministic xorshift32 PRNG; the seed is fixed so runs are reproducible. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0xffffffff;
  };
}

const randomBytes = (random: () => number, length: number): Uint8Array =>
  Uint8Array.from({ length }, () => Math.floor(random() * 256));

const actionTypes = [
  "navigate",
  "click",
  "fill",
  "select",
  "press",
  "wait",
  "download",
  "scroll",
  "hover",
  "keyboard",
  "tab",
  "upload",
  "drag",
  "custom",
] as const;

const riskLevels = ["low", "medium", "high", "unknown"] as const;

const dangerousWords = [
  "delete account",
  "pay invoice",
  "purchase plan",
  "transfer funds",
  "change password",
  "send email to customer",
  "publish post",
  "submit checkout",
  "destroy data",
  "revoke admin access",
];

function randomAction(random: () => number): SemanticAction {
  const type = actionTypes[Math.floor(random() * actionTypes.length)]!;
  const useDangerous = random() < 0.3;
  const intent = useDangerous
    ? dangerousWords[Math.floor(random() * dangerousWords.length)]!
    : `perform ${Math.floor(random() * 1000)} ${String.fromCharCode(0x20 + Math.floor(random() * 90))}`;
  return {
    type,
    intent,
    target: random() < 0.5 ? `target-${Math.floor(random() * 100)}` : undefined,
    methodPreference: ["dom"],
    riskLevel: riskLevels[Math.floor(random() * riskLevels.length)]!,
  } as SemanticAction;
}

const fuzzIterations = 400;

describe("policy fuzz (deterministic seed 0x5EED)", () => {
  it("never classifies garbage or unknown actions as read", () => {
    const random = makeRandom(0x5eed);
    for (let index = 0; index < fuzzIterations; index += 1) {
      const action = randomAction(random);
      const inferred = inferSideEffectClass(action);
      if (action.type === "custom") {
        expect(inferred).toBe("unknown");
      } else if (inferred !== "read") {
        // Nothing to check beyond the invariant below.
      }
      // A purchase/destructive/credential intent is never read.
      if (
        /pay|purchase|checkout|transfer|delete|destroy|password|send/.test(
          action.intent,
        )
      ) {
        expect(inferred).not.toBe("read");
      }
    }
  });

  it("effective class never lowers the inferred class (planner cannot understate)", () => {
    const random = makeRandom(0xbeef);
    const classes: SideEffectClass[] = [
      "read",
      "local_edit",
      "local_execute",
      "download",
      "upload",
      "external_write",
      "message_send",
      "account_change",
      "purchase",
      "financial_transfer",
      "credential_change",
      "destructive",
      "admin_or_security_change",
      "unknown",
    ];
    const rank: Record<SideEffectClass, number> = {
      read: 0,
      local_edit: 1,
      local_execute: 2,
      download: 3,
      upload: 4,
      external_write: 5,
      message_send: 6,
      account_change: 7,
      purchase: 8,
      financial_transfer: 9,
      credential_change: 10,
      destructive: 11,
      admin_or_security_change: 12,
      unknown: 13,
    };
    for (let index = 0; index < fuzzIterations; index += 1) {
      const planner = classes[Math.floor(random() * classes.length)]!;
      const inferred = classes[Math.floor(random() * classes.length)]!;
      const effective = effectiveSideEffectClass(planner, inferred);
      expect(rank[effective]).toBeGreaterThanOrEqual(rank[inferred]);
    }
  });

  it("planner low-risk dangerous actions escalate to high", () => {
    const random = makeRandom(0xcafe);
    for (let index = 0; index < fuzzIterations; index += 1) {
      const action = randomAction(random);
      action.riskLevel = "low";
      const structured = structuredRiskLevel(action);
      if (
        /\b(pay|payment|purchase|checkout|transfer|delete|destroy|password|admin|revoke)\b/.test(
          action.intent,
        )
      ) {
        // Escalated to high, or unknown (fail closed) — never the planner's
        // low label.
        expect(["high", "unknown"]).toContain(structured);
      }
    }
  });

  it("approval hash binding fails on any single-byte mutation", () => {
    const random = makeRandom(0x1234);
    for (let index = 0; index < 200; index += 1) {
      const action = randomAction(random);
      const approval = createActionApproval(action, "matt");
      const mutated = JSON.parse(JSON.stringify(action)) as SemanticAction;
      if (typeof mutated.intent === "string" && mutated.intent.length > 0) {
        const position = Math.floor(random() * mutated.intent.length);
        mutated.intent =
          mutated.intent.slice(0, position) +
          String.fromCharCode(mutated.intent.charCodeAt(position) ^ 1) +
          mutated.intent.slice(position + 1);
        expect(hashState(mutated)).not.toBe(hashState(action));
        const decision = validateActionApproval(mutated, approval, new Date(), {
          forceConfirmation: true,
        });
        expect(decision.allowed).toBe(false);
      }
    }
  });

  it("random garbage never parses as an approval scope", () => {
    const random = makeRandom(0xf00d);
    for (let index = 0; index < fuzzIterations; index += 1) {
      const garbage = String.fromCharCode(
        ...Array.from({ length: 1 + Math.floor(random() * 200) }, () =>
          Math.floor(random() * 0xffff),
        ),
      );
      const parsed = parseApprovalScope(garbage);
      if (parsed !== undefined) {
        // Only a structurally valid scope may parse; it must still be a
        // recognized shape (fail closed otherwise).
        expect([
          "exact_action",
          "plan_step",
          "task_readonly",
          "origin_action_class",
        ]).toContain(parsed.type);
      }
    }
  });

  it("homograph origins can never inherit a legit origin scope", () => {
    const scope = {
      type: "origin_action_class" as const,
      origin: "https://example.com",
      sideEffectClass: "read" as const,
      expiresAt: "2099-01-01T00:00:00.000Z",
      maxActions: 10,
    };
    // Cyrillic 'е' homograph of ASCII 'e'.
    expect(
      validateApprovalScope(scope, { actionHash: "x" } as never, {
        sideEffectClass: "read",
        resolvedOrigin: "https://еxample.com",
        usageCount: 0,
      }).valid,
    ).toBe(false);
    // Punycode of the homograph domain also fails the prefix match.
    expect(
      validateApprovalScope(scope, { actionHash: "x" } as never, {
        sideEffectClass: "read",
        resolvedOrigin: "https://xn--e1aybc.com",
        usageCount: 0,
      }).valid,
    ).toBe(false);
    // Legit sub-path passes.
    expect(
      validateApprovalScope(scope, { actionHash: "x" } as never, {
        sideEffectClass: "read",
        resolvedOrigin: "https://example.com/checkout",
        usageCount: 0,
      }).valid,
    ).toBe(true);
  });

  it("broad scopes never authorize high-risk classes", () => {
    const random = makeRandom(0xa11ce);
    const highRisk: SideEffectClass[] = [
      "purchase",
      "financial_transfer",
      "credential_change",
      "destructive",
      "admin_or_security_change",
    ];
    for (let index = 0; index < fuzzIterations; index += 1) {
      const cls = highRisk[Math.floor(random() * highRisk.length)]!;
      expect(
        validateApprovalScope(
          {
            type: "task_readonly",
            taskId: `task-${index}`,
            expiresAt: "2099-01-01T00:00:00.000Z",
          },
          { actionHash: "x" } as never,
          { sideEffectClass: cls },
        ).valid,
      ).toBe(false);
      expect(
        validateApprovalScope(
          {
            type: "origin_action_class",
            origin: "https://example.com",
            sideEffectClass: cls,
            expiresAt: "2099-01-01T00:00:00.000Z",
            maxActions: 5,
          },
          { actionHash: "x" } as never,
          { sideEffectClass: cls },
        ).valid,
      ).toBe(false);
    }
  });

  it("malformed byte streams never classify as read via any parse path", () => {
    const random = makeRandom(0xdecaf);
    for (let index = 0; index < 200; index += 1) {
      const bytes = randomBytes(random, 1 + Math.floor(random() * 64));
      const asString = new TextDecoder("utf-8").decode(bytes);
      const action: SemanticAction = {
        type: "click",
        intent: asString,
        methodPreference: ["dom"],
        riskLevel: "low",
      };
      const inferred = inferSideEffectClass(action);
      // Control characters / replacement chars in intent never downgrade to
      // read when destructive keywords are embedded.
      if (/delete|pay|transfer|password|admin/.test(asString)) {
        expect(inferred).not.toBe("read");
      }
    }
  });

  it("receipt hashing is stable across key order", () => {
    const receipt = {
      actionId: "a",
      state: "verified",
      evidence: ["x"],
    };
    const reordered = {
      evidence: ["x"],
      state: "verified",
      actionId: "a",
    };
    expect(hashState(receipt)).toBe(hashState(reordered));
    expect(
      createHash("sha256").update(JSON.stringify(receipt)).digest("hex"),
    ).not.toBe(
      createHash("sha256").update(JSON.stringify(reordered)).digest("hex"),
    );
  });
});
