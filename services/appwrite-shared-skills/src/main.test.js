import { describe, expect, it } from "vitest";

import { publicSkill, validateSubmission } from "./main.js";

const validSubmission = {
  schemaVersion: "shared-skill-v1",
  name: "shared search",
  contentHash: "a".repeat(64),
  operationKey: "operation:search",
  fingerprint: "b".repeat(64),
  templateVariables: ["query"],
  definition: {
    compiler: "shared-skill-v1",
    actions: [
      {
        type: "fill",
        intent: "fill search",
        target: "Search",
        value: "{{constraints.query}}",
        methodPreference: ["accessibility"],
        riskLevel: "low",
      },
    ],
    verification: [{ type: "dom" }],
  },
  fastPathEligible: true,
};

describe("Appwrite shared skill Function", () => {
  it("redacts submissions and removes unsafe records from Fast Path", () => {
    expect(validateSubmission(validSubmission)).toMatchObject({
      fastPathEligible: true,
      definition: validSubmission.definition,
    });

    const sensitiveValue = validateSubmission({
      ...validSubmission,
      definition: {
        ...validSubmission.definition,
        actions: [
          { ...validSubmission.definition.actions[0], value: "a@example.test" },
        ],
      },
    });
    expect(sensitiveValue).toMatchObject({
      fastPathEligible: false,
      definition: {
        actions: [expect.objectContaining({ value: "[REDACTED_EMAIL]" })],
      },
    });

    expect(
      validateSubmission({
        ...validSubmission,
        definition: {
          ...validSubmission.definition,
          actions: [
            {
              scope: "os",
              type: "os_type",
              intent: "type sensitive value",
              text: "hello",
              methodPreference: ["keyboard"],
              riskLevel: "low",
            },
          ],
        },
      }).fastPathEligible,
    ).toBe(false);
  });

  it("exposes approved snapshots without verifier data", () => {
    expect(
      publicSkill({
        $id: "skill-id",
        $updatedAt: "2026-07-16T00:00:00.000Z",
        version: "version",
        name: "shared search",
        operationKey: "operation:search",
        fingerprint: "fingerprint",
        fastPathEligible: true,
        contentHash: "hash",
        payload: JSON.stringify(validSubmission),
      }),
    ).toEqual({
      skillId: "skill-id",
      version: "version",
      name: "shared search",
      operationKey: "operation:search",
      fingerprint: "fingerprint",
      definition: {
        compiler: "shared-skill-v1",
        actions: validSubmission.definition.actions,
      },
      fastPathEligible: true,
      contentHash: "hash",
      updatedAt: "2026-07-16T00:00:00.000Z",
    });
  });

  it("rejects malformed submissions before persistence", () => {
    expect(() =>
      validateSubmission({ ...validSubmission, schemaVersion: "wrong" }),
    ).toThrow("schema");
  });
});
