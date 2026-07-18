import { describe, expect, it } from "vitest";

import { getGameTargetProfile } from "@lhic/game-training";

import {
  encodeGame3dInput,
  game3dFrameSpec,
  game3dReward,
  validateGame3dProfile,
} from "./core.js";

describe("3D game-training core", () => {
  it("uses a four-frame FPS policy with bounded relative look", () => {
    const profile = getGameTargetProfile("nemesis");
    expect(game3dFrameSpec).toMatchObject({
      width: 96,
      height: 96,
      history: 4,
    });
    expect(
      encodeGame3dInput(
        {
          timestampMs: 1,
          heldKeys: ["KeyW", "KeyA"],
          primaryDown: true,
          pointerDeltaX: 99,
          pointerDeltaY: -99,
        },
        profile,
      ),
    ).toMatchObject({
      movement: ["KeyW", "KeyA"],
      fire: true,
      look: { deltaX: 48, deltaY: -48 },
    });
  });

  it("rejects 2D profiles and applies terminal penalties", () => {
    expect(() =>
      validateGame3dProfile(getGameTargetProfile("star-trooper")),
    ).toThrow("3D");
    expect(
      game3dReward({
        previousScore: 0,
        score: 100,
        previousHealth: 100,
        health: 100,
        terminal: true,
      }),
    ).toBeCloseTo(-0.001);
  });
});
