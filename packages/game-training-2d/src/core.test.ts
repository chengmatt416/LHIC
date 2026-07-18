import { describe, expect, it } from "vitest";

import { getGameTargetProfile } from "@lhic/game-training";

import {
  encodeGame2dInput,
  game2dFrameSpec,
  game2dReward,
  validateGame2dProfile,
} from "./core.js";

describe("2D game-training core", () => {
  it("uses a two-frame policy and maps Star Trooper's space key to fire", () => {
    const profile = getGameTargetProfile("star-trooper");
    expect(game2dFrameSpec).toMatchObject({
      width: 128,
      height: 128,
      history: 2,
    });
    expect(
      encodeGame2dInput(
        {
          timestampMs: 1,
          heldKeys: ["KeyW", "Space"],
          primaryDown: false,
        },
        profile,
      ),
    ).toEqual({ movement: ["KeyW"], fire: true });
  });

  it("rejects 3D profiles and rewards score gain while penalizing damage", () => {
    expect(() =>
      validateGame2dProfile(getGameTargetProfile("nemesis")),
    ).toThrow("2D");
    expect(
      game2dReward({
        previousScore: 0,
        score: 100,
        previousHealth: 100,
        health: 90,
        terminal: false,
      }),
    ).toBeCloseTo(0.899);
  });
});
