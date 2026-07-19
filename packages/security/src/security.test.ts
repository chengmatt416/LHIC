import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createActionApproval,
  evaluateRisk,
  guardCredentials,
  parseRuntimeConfig,
  signActionApproval,
  validateActionApproval,
} from "./index.js";

describe("risk policy", () => {
  it("requires confirmation for high, unknown, custom, and destructive actions", () => {
    expect(
      evaluateRisk({
        type: "click",
        intent: "delete account",
        riskLevel: "low",
      }).requiresConfirmation,
    ).toBe(true);
    expect(
      evaluateRisk({ type: "click", intent: "continue", riskLevel: "unknown" })
        .requiresConfirmation,
    ).toBe(true);
    expect(
      evaluateRisk({ type: "custom", intent: "custom step", riskLevel: "low" })
        .requiresConfirmation,
    ).toBe(true);
    expect(
      evaluateRisk({ type: "fill", intent: "fill profile", riskLevel: "low" }),
    ).toMatchObject({
      allowed: true,
      requiresConfirmation: false,
    });
    expect(
      evaluateRisk({
        type: "click",
        intent: "send_external_email to customer",
        riskLevel: "low",
      }).requiresConfirmation,
    ).toBe(true);
    expect(
      evaluateRisk({
        type: "click",
        intent: "production_write record",
        riskLevel: "low",
      }).requiresConfirmation,
    ).toBe(true);
    expect(
      evaluateRisk({
        type: "click",
        intent: "open account menu",
        target: "Delete account",
        riskLevel: "low",
      }).requiresConfirmation,
    ).toBe(true);
    expect(
      evaluateRisk({
        type: "fill",
        intent: "fill internal note",
        target: "Delete reason",
        riskLevel: "low",
      }).requiresConfirmation,
    ).toBe(false);
    expect(
      evaluateRisk({
        type: "click",
        intent: "continue form flow",
        target: "Submit application",
        riskLevel: "low",
      }).requiresConfirmation,
    ).toBe(true);
  });
});

describe("runtime configuration", () => {
  it("requires a strict HTTPS allowlist in production", () => {
    const { publicKey } = generateKeyPairSync("ed25519");
    const approvalPublicKey = publicKey
      .export({ format: "pem", type: "spki" })
      .toString();
    expect(() => parseRuntimeConfig({ LHIC_ENV: "production" })).toThrow(
      "LHIC_ALLOWED_ORIGINS",
    );
    expect(() =>
      parseRuntimeConfig({
        LHIC_ENV: "production",
        LHIC_ALLOWED_ORIGINS: "http://example.test",
      }),
    ).toThrow("HTTPS origins");
    expect(() =>
      parseRuntimeConfig({
        LHIC_ENV: "production",
        LHIC_ALLOWED_ORIGINS: "https://example.test",
      }),
    ).toThrow("LHIC_APPROVAL_PUBLIC_KEY");
    expect(() =>
      parseRuntimeConfig({
        LHIC_ENV: "production",
        LHIC_ALLOWED_ORIGINS: "https://example.test",
        LHIC_APPROVAL_PUBLIC_KEY: "not-a-public-key",
      }),
    ).toThrow("Ed25519");
    expect(
      parseRuntimeConfig({
        LHIC_ENV: "production",
        LHIC_ALLOWED_ORIGINS: "https://example.test,https://app.example.test",
        LHIC_APPROVAL_PUBLIC_KEY: approvalPublicKey,
        LHIC_ACTION_TIMEOUT_MS: "15000",
      }),
    ).toMatchObject({
      environment: "production",
      allowedOrigins: ["https://example.test", "https://app.example.test"],
      actionTimeoutMs: 15_000,
      allowPrivateNetwork: false,
    });
  });

  it("loads a production approval key from an explicitly configured file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lhic-approval-key-"));
    const publicKeyPath = join(directory, "approval-public.pem");
    const { publicKey } = generateKeyPairSync("ed25519");
    const approvalPublicKey = publicKey
      .export({ format: "pem", type: "spki" })
      .toString();
    try {
      await writeFile(publicKeyPath, approvalPublicKey, { mode: 0o600 });
      expect(
        parseRuntimeConfig({
          LHIC_ENV: "production",
          LHIC_ALLOWED_ORIGINS: "https://app.example.test",
          LHIC_APPROVAL_PUBLIC_KEY_FILE: publicKeyPath,
        }),
      ).toMatchObject({ approvalPublicKey: approvalPublicKey.trim() });
      expect(() =>
        parseRuntimeConfig({
          LHIC_ENV: "production",
          LHIC_ALLOWED_ORIGINS: "https://app.example.test",
          LHIC_APPROVAL_PUBLIC_KEY: approvalPublicKey,
          LHIC_APPROVAL_PUBLIC_KEY_FILE: publicKeyPath,
        }),
      ).toThrow("only one");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("credential guard", () => {
  it("never returns raw passwords or tokens in safe values", () => {
    const result = guardCredentials({
      password: "correct-horse-battery-staple",
      nested: { token: "tok_sensitive" },
    });
    expect(result.containsCredentials).toBe(true);
    expect(JSON.stringify(result.safe)).not.toContain(
      "correct-horse-battery-staple",
    );
    expect(JSON.stringify(result.safe)).not.toContain("tok_sensitive");
  });
});

describe("action approval", () => {
  const highRiskAction = {
    type: "click" as const,
    intent: "delete account",
    target: "#delete",
    methodPreference: ["dom" as const],
    riskLevel: "high" as const,
  };

  it("binds approval to one high-risk action and expiry", () => {
    const now = new Date("2026-07-15T00:00:00.000Z");
    const approval = createActionApproval(
      highRiskAction,
      "operator@example.test",
      {
        now,
        expiresInMs: 1_000,
      },
    );

    expect(validateActionApproval(highRiskAction, approval, now)).toMatchObject(
      {
        allowed: true,
        approvalId: approval.approvalId,
      },
    );
    expect(
      validateActionApproval(
        { ...highRiskAction, intent: "delete all accounts" },
        approval,
        now,
      ),
    ).toMatchObject({
      allowed: false,
      reason: expect.stringContaining("does not match"),
    });
    expect(
      validateActionApproval(
        highRiskAction,
        approval,
        new Date("2026-07-15T00:00:02.000Z"),
      ),
    ).toMatchObject({
      allowed: false,
      reason: expect.stringContaining("expired"),
    });
  });

  it("only accepts short-lived approvals that are currently valid", () => {
    const now = new Date("2026-07-15T00:00:00.000Z");
    const approval = createActionApproval(
      highRiskAction,
      "operator@example.test",
      {
        now,
        expiresInMs: 5 * 60_000,
      },
    );

    expect(() =>
      createActionApproval(highRiskAction, "operator@example.test", {
        now,
        expiresInMs: 5 * 60_000 + 1,
      }),
    ).toThrow("five minutes");
    expect(
      validateActionApproval(
        highRiskAction,
        {
          ...approval,
          approvedAt: "2026-07-15T00:00:31.000Z",
          expiresAt: "2026-07-15T00:01:00.000Z",
        },
        now,
      ),
    ).toMatchObject({
      allowed: false,
      reason: expect.stringContaining("not valid yet"),
    });
    expect(
      validateActionApproval(
        highRiskAction,
        {
          ...approval,
          expiresAt: "2026-07-15T00:05:00.001Z",
        },
        now,
      ),
    ).toMatchObject({
      allowed: false,
      reason: expect.stringContaining("exceeds five minutes"),
    });
    expect(
      validateActionApproval(
        highRiskAction,
        {
          ...approval,
          expiresAt: approval.approvedAt,
        },
        now,
      ),
    ).toMatchObject({
      allowed: false,
      reason: expect.stringContaining("must be after"),
    });
  });

  it("requires non-empty approval and approver identifiers before replay protection", () => {
    const now = new Date("2026-07-15T00:00:00.000Z");
    const approval = createActionApproval(
      highRiskAction,
      "operator@example.test",
      { now, expiresInMs: 1_000 },
    );

    expect(
      validateActionApproval(
        highRiskAction,
        { ...approval, approvalId: "" },
        now,
      ),
    ).toMatchObject({
      allowed: false,
      reason: expect.stringContaining("approval identifier"),
    });
    expect(
      validateActionApproval(
        highRiskAction,
        { ...approval, approvedBy: "  " },
        now,
      ),
    ).toMatchObject({
      allowed: false,
      reason: expect.stringContaining("approver identifier"),
    });
  });

  it("can require an approval after executor-side target inspection", () => {
    const now = new Date("2026-07-15T00:00:00.000Z");
    const opaqueTargetAction = {
      type: "click" as const,
      intent: "open account menu",
      target: "#account-action",
      methodPreference: ["dom" as const],
      riskLevel: "low" as const,
    };
    const approval = createActionApproval(
      opaqueTargetAction,
      "operator@example.test",
      { now },
    );
    const options = {
      forceConfirmation: true,
      confirmationReason: "The resolved target may be destructive.",
    };

    expect(
      validateActionApproval(opaqueTargetAction, undefined, now, options),
    ).toMatchObject({
      allowed: false,
      reason: expect.stringContaining("resolved target"),
    });
    expect(
      validateActionApproval(opaqueTargetAction, approval, now, options),
    ).toMatchObject({ allowed: true, approvalId: approval.approvalId });
  });

  it("requires a valid Ed25519 signature when production validation is enabled", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const now = new Date("2026-07-15T00:00:00.000Z");
    const approval = createActionApproval(
      highRiskAction,
      "operator@example.test",
      { now },
    );

    expect(
      validateActionApproval(highRiskAction, approval, now, {
        publicKey,
        requireSignature: true,
      }),
    ).toMatchObject({
      allowed: false,
      reason: expect.stringContaining("signature"),
    });
    expect(
      validateActionApproval(
        highRiskAction,
        signActionApproval(approval, privateKey),
        now,
        { publicKey, requireSignature: true },
      ),
    ).toMatchObject({ allowed: true });
  });
});
