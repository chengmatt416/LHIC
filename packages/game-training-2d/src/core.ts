import type { GameInputSample, GameTargetProfile } from "@lhic/game-training";

export const game2dFrameSpec = {
  width: 128,
  height: 128,
  channels: 3 as const,
  history: 2,
};

export const game2dActionCodec = "game-2d-action-v1";
export const game2dPreprocessingVersion = "game-2d-rgb-128-history-2-v1";

export const game2dMovementKeys = ["KeyW", "KeyA", "KeyS", "KeyD"] as const;

export interface Game2dAction {
  movement: Array<(typeof game2dMovementKeys)[number]>;
  fire: boolean;
  /** Normalized target position for profiles with absolute pointer aiming. */
  aim?: { x: number; y: number };
}

export interface Game2dRewardTransition {
  previousScore?: number;
  score?: number;
  previousHealth?: number;
  health?: number;
  terminal: boolean;
}

export function validateGame2dProfile(profile: GameTargetProfile): void {
  if (profile.core !== "2d") {
    throw new Error("2D training only accepts 2D target profiles.");
  }
  if (profile.control.aimMode === "relative") {
    throw new Error(
      "2D training does not accept relative pointer-look controls.",
    );
  }
}

export function encodeGame2dInput(
  input: GameInputSample,
  profile: GameTargetProfile,
): Game2dAction {
  validateGame2dProfile(profile);
  const movement = game2dMovementKeys.filter((key) =>
    input.heldKeys.includes(key),
  );
  assertNoOpposingMovement(movement);
  const action: Game2dAction = {
    movement: [...movement],
    fire:
      input.heldKeys.includes("Space") ||
      (profile.control.allowPrimaryClick && input.primaryDown),
  };
  if (profile.control.aimMode === "absolute") {
    if (
      input.pointerX === undefined ||
      input.pointerY === undefined ||
      input.pointerX < 0 ||
      input.pointerX > 1 ||
      input.pointerY < 0 ||
      input.pointerY > 1
    ) {
      throw new Error(
        "2D absolute-aim samples require normalized pointer coordinates.",
      );
    }
    action.aim = { x: input.pointerX, y: input.pointerY };
  }
  return action;
}

export function game2dReward(transition: Game2dRewardTransition): number {
  const scoreGain = (transition.score ?? 0) - (transition.previousScore ?? 0);
  const healthLoss = Math.max(
    0,
    (transition.previousHealth ?? transition.health ?? 0) -
      (transition.health ?? transition.previousHealth ?? 0),
  );
  return (
    scoreGain / 100 - healthLoss * 0.01 - 0.001 + (transition.terminal ? -1 : 0)
  );
}

export function randomGame2dAction(
  random: () => number,
  profile: GameTargetProfile,
): Game2dAction {
  validateGame2dProfile(profile);
  const directions = [
    [] as Game2dAction["movement"],
    ["KeyW"] as Game2dAction["movement"],
    ["KeyA"] as Game2dAction["movement"],
    ["KeyS"] as Game2dAction["movement"],
    ["KeyD"] as Game2dAction["movement"],
    ["KeyW", "KeyA"] as Game2dAction["movement"],
    ["KeyW", "KeyD"] as Game2dAction["movement"],
    ["KeyS", "KeyA"] as Game2dAction["movement"],
    ["KeyS", "KeyD"] as Game2dAction["movement"],
  ];
  const movement = directions[Math.floor(random() * directions.length)]!;
  const action: Game2dAction = {
    movement: [...movement],
    fire:
      (profile.control.allowedKeys.includes("Space") ||
        profile.control.allowPrimaryClick) &&
      random() >= 0.5,
  };
  if (profile.control.aimMode === "absolute") {
    action.aim = { x: random(), y: random() };
  }
  return action;
}

function assertNoOpposingMovement(movement: readonly string[]): void {
  if (
    (movement.includes("KeyW") && movement.includes("KeyS")) ||
    (movement.includes("KeyA") && movement.includes("KeyD"))
  ) {
    throw new Error("2D actions cannot hold opposing movement keys.");
  }
}
