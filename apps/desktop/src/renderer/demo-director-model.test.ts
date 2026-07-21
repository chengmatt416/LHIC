import { describe, expect, it } from "vitest";

import {
  advanceDemoStage,
  elapsedMs,
  initialDemoDirectorState,
} from "./demo-director-model.js";

describe("Demo Director state machine", () => {
  it("keeps slow and fast completion gates deterministic", () => {
    let state = initialDemoDirectorState;
    state = advanceDemoStage(state);
    state = advanceDemoStage(state);
    state = advanceDemoStage(state);
    expect(state.stage).toBe("slow-approval");

    state = { ...state, stage: "slow-live" };
    expect(advanceDemoStage(state).stage).toBe("slow-live");
    expect(advanceDemoStage(state, { slowComplete: true }).stage).toBe(
      "learning",
    );

    state = { ...state, stage: "learning" };
    expect(advanceDemoStage(state).stage).toBe("learning");
    expect(advanceDemoStage(state, { fastEligible: true }).stage).toBe(
      "fast-ready",
    );
  });

  it("measures only observed timer boundaries", () => {
    expect(elapsedMs({}, 500)).toBe(0);
    expect(elapsedMs({ startedAt: 100 }, 500)).toBe(400);
    expect(elapsedMs({ startedAt: 100, completedAt: 250 }, 500)).toBe(150);
  });
});
