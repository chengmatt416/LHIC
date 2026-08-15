import { describe, expect, it } from "vitest";

import type { SemanticAction } from "@lhic/schema";
import { hashState } from "@lhic/trace";

import { validateActionApproval } from "./action-approval.js";
import {
  approvalScopeString,
  createScopedApproval,
  parseApprovalScope,
  validateApprovalScope,
} from "./approval-scope.js";

const action: SemanticAction = {
  type: "click",
  intent: "Click submit",
  target: "submit",
  methodPreference: ["dom"],
  riskLevel: "high",
};

describe("approval scopes", () => {
  it("round-trips scope strings through canonical JSON", () => {
    const scope = {
      type: "exact_action" as const,
      actionHash: hashState(action),
    };
    expect(parseApprovalScope(approvalScopeString(scope))).toEqual(scope);
    expect(parseApprovalScope("{not json")).toBeUndefined();
    expect(
      parseApprovalScope(JSON.stringify({ type: "allow_all" })),
    ).toBeUndefined();
  });

  it("binds an exact_action scope to the action hash", () => {
    const approval = createScopedApproval(action, {
      approvedBy: "matt",
      scope: { type: "exact_action", actionHash: hashState(action) },
      sideEffectClass: "external_write",
    });
    const decision = validateActionApproval(action, approval, new Date(), {
      expectedScope: approvalScopeString({
        type: "exact_action",
        actionHash: hashState(action),
      }),
    });
    expect(decision.allowed).toBe(true);
    const scopeDecision = validateApprovalScope(
      { type: "exact_action", actionHash: hashState(action) },
      approval,
      { sideEffectClass: "external_write" },
    );
    expect(scopeDecision.valid).toBe(true);
  });

  it("rejects a scope bound to a different action", () => {
    const approval = createScopedApproval(action, {
      approvedBy: "matt",
      scope: {
        type: "exact_action",
        actionHash: "0".repeat(64),
      },
      sideEffectClass: "external_write",
    });
    // Step 1: base approval validation (the approval itself is well-formed).
    const decision = validateActionApproval(action, approval, new Date(), {
      expectedScope: approvalScopeString({
        type: "exact_action",
        actionHash: "0".repeat(64),
      }),
    });
    expect(decision.allowed).toBe(true);
    // Step 2: structured scope validation rejects the hash mismatch.
    const scopeDecision = validateApprovalScope(
      { type: "exact_action", actionHash: "0".repeat(64) },
      approval,
      { sideEffectClass: "external_write" },
    );
    expect(scopeDecision.valid).toBe(false);
    expect(scopeDecision.reason).toMatch(/different action hash/);
  });

  it("enforces read-only scopes for read actions only", () => {
    const scope = {
      type: "task_readonly" as const,
      taskId: "task-1",
      expiresAt: "2099-01-01T00:00:00.000Z",
    };
    expect(
      validateApprovalScope(scope, { actionHash: "x" } as never, {
        sideEffectClass: "read",
      }).valid,
    ).toBe(true);
    expect(
      validateApprovalScope(scope, { actionHash: "x" } as never, {
        sideEffectClass: "local_edit",
      }).valid,
    ).toBe(false);
  });

  it("expires read-only and origin scopes", () => {
    const expired = {
      type: "task_readonly" as const,
      taskId: "task-1",
      expiresAt: "2020-01-01T00:00:00.000Z",
    };
    expect(
      validateApprovalScope(expired, { actionHash: "x" } as never, {
        sideEffectClass: "read",
      }).valid,
    ).toBe(false);
  });

  it("refuses reusable scopes for high-risk classes at creation", () => {
    expect(() =>
      createScopedApproval(action, {
        approvedBy: "matt",
        scope: {
          type: "origin_action_class",
          origin: "https://shop.example.com",
          sideEffectClass: "purchase",
          expiresAt: "2099-01-01T00:00:00.000Z",
          maxActions: 3,
        },
        sideEffectClass: "purchase",
      }),
    ).toThrow(/High-risk side-effect classes/);
    expect(() =>
      createScopedApproval(action, {
        approvedBy: "matt",
        scope: {
          type: "task_readonly",
          taskId: "task-1",
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
        sideEffectClass: "credential_change",
      }),
    ).toThrow(/High-risk side-effect classes/);
  });

  it("enforces origin and class matching on reusable scopes", () => {
    const scope = {
      type: "origin_action_class" as const,
      origin: "https://example.com",
      sideEffectClass: "read" as const,
      expiresAt: "2099-01-01T00:00:00.000Z",
      maxActions: 2,
    };
    expect(
      validateApprovalScope(scope, { actionHash: "x" } as never, {
        sideEffectClass: "read",
        resolvedOrigin: "https://example.com/page",
        usageCount: 1,
      }).valid,
    ).toBe(true);
    expect(
      validateApprovalScope(scope, { actionHash: "x" } as never, {
        sideEffectClass: "read",
        resolvedOrigin: "https://evil.example.net",
        usageCount: 1,
      }).valid,
    ).toBe(false);
    expect(
      validateApprovalScope(scope, { actionHash: "x" } as never, {
        sideEffectClass: "download",
        resolvedOrigin: "https://example.com",
        usageCount: 1,
      }).valid,
    ).toBe(false);
    expect(
      validateApprovalScope(scope, { actionHash: "x" } as never, {
        sideEffectClass: "read",
        resolvedOrigin: "https://example.com",
        usageCount: 2,
      }).valid,
    ).toBe(false); // budget exhausted
  });

  it("fails closed on an unknown scope shape", () => {
    expect(
      validateApprovalScope(undefined, { actionHash: "x" } as never, {
        sideEffectClass: "read",
      }).valid,
    ).toBe(false);
  });
});
