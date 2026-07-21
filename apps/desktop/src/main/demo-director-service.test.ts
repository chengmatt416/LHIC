import { afterEach, describe, expect, it, vi } from "vitest";

import { DemoDirectorService } from "./demo-director-service.js";

describe("DemoDirectorService scenario configuration", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("keeps private task values in the main-process launch environment", () => {
    vi.stubEnv("LHIC_DEMO_SLOW_EMPLOYEE", "slow-test-id");
    vi.stubEnv("LHIC_DEMO_SLOW_MANAGER", "slow-manager-id");
    vi.stubEnv("LHIC_DEMO_FAST_EMPLOYEE", "fast-test-id");
    vi.stubEnv("LHIC_DEMO_FAST_MANAGER", "fast-manager-id");
    vi.stubEnv("LHIC_DEMO_CODEX_MODEL", "configured-model");

    const service = new DemoDirectorService("/tmp/lhic-demo", () => true);

    expect(service.scenarioReady()).toBe(true);
    expect(service.codexModel()).toBe("configured-model");
    expect(service.fastGoal()).toContain("fast-test-id");
    expect(service.fastGoal()).toContain("fast-manager-id");
  });

  it("uses the fixed sandbox identities when launch overrides are missing", () => {
    vi.stubEnv("LHIC_DEMO_SLOW_EMPLOYEE", "");
    vi.stubEnv("LHIC_DEMO_SLOW_MANAGER", "");
    vi.stubEnv("LHIC_DEMO_FAST_EMPLOYEE", "");
    vi.stubEnv("LHIC_DEMO_FAST_MANAGER", "");

    const service = new DemoDirectorService("/tmp/lhic-demo", () => true);

    expect(service.scenarioReady()).toBe(true);
    expect(service.fastGoal()).toContain("LHICTEST2");
    expect(service.fastGoal()).toContain("LHICMANAGER2");
    expect(service.codexModel()).toBe("gpt-5.6-luna");
  });
});
