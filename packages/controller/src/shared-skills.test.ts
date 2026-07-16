import { describe, expect, it } from "vitest";

import { createMemoryDatabase, SharedSkillStore } from "@lhic/memory";

import {
  createSharedSkillFingerprint,
  createSharedSkillPublication,
  SharedSkillResolver,
} from "./shared-skills.js";
import { FastPathRouter } from "./fast-path-router.js";

const request = {
  taskId: "shared-1",
  userIntent: {
    goal: "Search for notebooks",
    constraints: { operation: "search", query: "notebooks" },
    riskLevel: "low" as const,
    requiresConfirmation: false,
    missingInformation: [],
  },
  uiState: {
    surface: "browser" as const,
    url: "https://example.test/catalogue",
    objects: [
      {
        id: "search",
        role: "textbox",
        label: "Search",
        enabled: true,
        source: "dom" as const,
      },
    ],
    signals: {},
    capturedAt: "2026-07-16T00:00:00.000Z",
  },
  recentTrace: [],
  reason: "low_confidence" as const,
};

const learnedSkill = {
  name: "slow-path-shared-search",
  lifecycle: "verified" as const,
  successCount: 1,
  failureCount: 0,
  definition: {
    compiler: "slow-path-v1",
    actions: [
      {
        type: "fill",
        intent: "fill search query",
        target: "Search",
        value: "notebooks",
        methodPreference: ["accessibility"],
        riskLevel: "low",
      },
      {
        type: "press",
        intent: "submit search",
        target: "Search",
        value: "Enter",
        methodPreference: ["keyboard"],
        riskLevel: "low",
      },
    ],
    verification: [],
  },
};

describe("shared skill publication and resolver", () => {
  it("templates constraint values and resolves one exact local cache match", () => {
    const publication = createSharedSkillPublication(request, learnedSkill);
    expect(publication).toMatchObject({ fastPathEligible: true });
    expect(JSON.stringify(publication)).not.toContain("notebooks");
    expect(publication?.definition).toMatchObject({
      actions: [
        expect.objectContaining({ value: "{{constraints.query}}" }),
        expect.any(Object),
      ],
    });

    const database = createMemoryDatabase();
    try {
      const store = new SharedSkillStore(database);
      store.applySnapshot("registry", {
        skills: [
          {
            registryId: "registry",
            skillId: "published-search",
            version: "v1",
            name: publication!.name,
            operationKey: publication!.operationKey,
            fingerprint: publication!.fingerprint,
            definition: publication!.definition,
            fastPathEligible: publication!.fastPathEligible,
            contentHash: publication!.contentHash,
            updatedAt: "2026-07-16T00:00:00.000Z",
          },
        ],
        revokedSkillIds: [],
      });
      const resolver = new SharedSkillResolver(store, "registry");
      const resolved = resolver.resolve(
        {
          ...request.userIntent,
          constraints: { operation: "search", query: "books" },
        },
        request.uiState,
      );
      expect(resolved).toMatchObject({
        skillId: "published-search",
        actions: [
          expect.objectContaining({ type: "fill", value: "books" }),
          expect.any(Object),
        ],
      });

      const routed = new FastPathRouter(undefined, undefined, resolver).route(
        { predictedIntent: "unknown", confidence: 0.3, evidence: [] },
        {
          ...request.userIntent,
          constraints: { operation: "search", query: "books" },
        },
        request.uiState,
      );
      expect(routed).toMatchObject({
        decision: { path: "fast", confidence: 0.9 },
        plan: { source: "shared", skillName: "slow-path-shared-search" },
      });
    } finally {
      database.close();
    }
  });

  it("fails closed for ambiguous matches and high-risk intents", () => {
    const database = createMemoryDatabase();
    try {
      const store = new SharedSkillStore(database);
      const fingerprint = createSharedSkillFingerprint(request.uiState);
      const shared = {
        registryId: "registry",
        version: "v1",
        name: "shared",
        operationKey: "operation:search",
        fingerprint,
        definition: {
          actions: [
            {
              type: "click",
              intent: "open result",
              target: "Result",
              methodPreference: ["accessibility"],
              riskLevel: "low",
            },
          ],
        },
        fastPathEligible: true,
        contentHash: "hash",
        updatedAt: "2026-07-16T00:00:00.000Z",
      };
      store.applySnapshot("registry", {
        skills: [
          { ...shared, skillId: "one" },
          { ...shared, skillId: "two", contentHash: "hash-2" },
        ],
        revokedSkillIds: [],
      });
      const resolver = new SharedSkillResolver(store, "registry");
      expect(
        resolver.resolve(request.userIntent, request.uiState),
      ).toBeUndefined();
      expect(
        resolver.resolve(
          {
            ...request.userIntent,
            riskLevel: "high",
            requiresConfirmation: true,
          },
          request.uiState,
        ),
      ).toBeUndefined();
    } finally {
      database.close();
    }
  });

  it("fails closed when an approved record contains an unbound redacted value", () => {
    const database = createMemoryDatabase();
    try {
      const store = new SharedSkillStore(database);
      store.applySnapshot("registry", {
        skills: [
          {
            registryId: "registry",
            skillId: "redacted-value",
            version: "v1",
            name: "unsafe shared search",
            operationKey: "operation:search",
            fingerprint: createSharedSkillFingerprint(request.uiState),
            definition: {
              actions: [
                {
                  type: "fill",
                  intent: "fill search query",
                  target: "Search",
                  value: "[REDACTED_EMAIL]",
                  methodPreference: ["accessibility"],
                  riskLevel: "low",
                },
              ],
            },
            fastPathEligible: true,
            contentHash: "hash",
            updatedAt: "2026-07-16T00:00:00.000Z",
          },
        ],
        revokedSkillIds: [],
      });

      expect(
        new SharedSkillResolver(store, "registry").resolve(
          request.userIntent,
          request.uiState,
        ),
      ).toBeUndefined();
    } finally {
      database.close();
    }
  });
});
