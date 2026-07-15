import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createActionApproval, signActionApproval } from "./action-approval.js";
import { KmsKeyManager } from "./kms.js";

describe("KmsKeyManager", () => {
  it("authenticates using AWS/GCP/Vault provider simulation and local key fallback", async () => {
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

    const awsManager = new KmsKeyManager({ provider: "aws" });
    const awsKey = await awsManager.fetchPublicKey("aws-key");
    expect(awsKey).toContain("MOCKAWSKMSKEY");

    const gcpManager = new KmsKeyManager({ provider: "gcp" });
    const gcpKey = await gcpManager.fetchPublicKey("gcp-key");
    expect(gcpKey).toContain("MOCKGCPKMSKEY");

    const vaultManager = new KmsKeyManager({ provider: "vault" });
    const vaultKey = await vaultManager.fetchPublicKey("vault-key");
    expect(vaultKey).toContain("MOCKVAULTKEY");
  });
});
