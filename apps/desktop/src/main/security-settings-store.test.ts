import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  SecuritySettingsStore,
  validateSecurityConfiguration,
} from "./security-settings-store.js";

describe("SecuritySettingsStore", () => {
  it("persists the Slow Path profile while retaining mandatory controls", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lhic-security-settings-"));
    try {
      const store = new SecuritySettingsStore(directory);
      await expect(store.load()).resolves.toMatchObject({
        slowPathProfile: "balanced",
        requireInteractiveApproval: true,
        redactSensitiveData: true,
        fastPathModelFree: true,
      });

      await expect(
        store.save({ slowPathProfile: "fast_only" }),
      ).resolves.toMatchObject({
        slowPathProfile: "fast_only",
        requireInteractiveApproval: true,
      });
      const persisted = await readFile(
        join(directory, ".lhic/security-settings.json"),
        "utf8",
      );
      expect(persisted).not.toMatch(/secret|token|password/i);
      await expect(store.load()).resolves.toMatchObject({
        slowPathProfile: "fast_only",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects persisted configurations that weaken mandatory controls", async () => {
    expect(() =>
      validateSecurityConfiguration({
        slowPathProfile: "balanced",
        requireInteractiveApproval: false,
        redactSensitiveData: true,
        fastPathModelFree: true,
        updatedAt: "2026-07-18T00:00:00.000Z",
      }),
    ).toThrow("cannot weaken");
  });
});
