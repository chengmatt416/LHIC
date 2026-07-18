import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createActionApproval, signActionApproval } from "./action-approval.js";
import { KmsKeyManager } from "./kms.js";

describe("KmsKeyManager", () => {
  it("authenticates with a configured local Ed25519 key and never invents remote keys", async () => {
    const manager = new KmsKeyManager({ provider: "local" });
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");

    const action = {
      type: "click" as const,
      intent: "high risk click",
      target: "#delete",
      methodPreference: ["dom" as const],
      riskLevel: "high" as const,
    };
    const approval = createActionApproval(action, "admin@example.test");
    const signedApproval = signActionApproval(approval, privateKey);

    process.env.LHIC_KMS_KEY_TESTKEY = publicKey.export({
      type: "spki",
      format: "pem",
    }) as string;

    const payload = JSON.stringify({
      approvalId: signedApproval.approvalId,
      actionHash: signedApproval.actionHash,
      approvedBy: signedApproval.approvedBy,
      approvedAt: signedApproval.approvedAt,
      expiresAt: signedApproval.expiresAt,
    });

    const isVerified = await manager.verifyKmsSignature(
      payload,
      signedApproval.signature!,
      "testkey",
    );
    expect(isVerified).toBe(true);

    const cachedKey = await manager.fetchPublicKey("testkey");
    expect(cachedKey).toBeDefined();

    await expect(
      new KmsKeyManager({ provider: "aws" }).fetchPublicKey("aws-key"),
    ).rejects.toThrow("SigV4-authenticated");
    await expect(
      new KmsKeyManager({ provider: "gcp" }).fetchPublicKey("gcp-key"),
    ).rejects.toThrow("endpoint is required");
    await expect(
      new KmsKeyManager({ provider: "vault" }).fetchPublicKey("vault-key"),
    ).rejects.toThrow("endpoint is required");
  });

  it("rejects remote responses that do not contain a valid Ed25519 key", async () => {
    const manager = new KmsKeyManager({
      provider: "gcp",
      endpoint: "https://kms.example.test",
      gcpAccessToken: "test-token",
      fetchImplementation: async () =>
        new Response(JSON.stringify({ pem: "invalid" })),
    });

    await expect(
      manager.fetchPublicKey("projects/test/keys/key"),
    ).rejects.toThrow("valid Ed25519 public key");
  });
});
