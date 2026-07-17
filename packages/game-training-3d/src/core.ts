import type { GameInputSample, GameTargetProfile } from "@lhic/game-training";

export const game3dFrameSpec = {
  width: 96,
  height: 96,
  channels: 3 as const,
  history: 4,
};

export const game3dActionCodec = "game-3d-fps-action-v1";
export const game3dPreprocessingVersion = "game-3d-rgb-96-history-4-v1";

export const game3dMovementKeys = ["KeyW", "KeyA", "KeyS", "KeyD"] as const;

export const game3dLookBins = [-48, -32, -16, 0, 16, 32, 48] as const;

export interface Game3dAction {
  movement: Array<(typeof game3dMovementKeys)[number]>;
  fire: boolean;
  look: {
    deltaX: (typeof game3dLookBins)[number];
    deltaY: (typeof game3dLookBins)[number];
  };
}

export interface Game3dRewardTransition {
  previousScore?: number;
  score?: number;
  previousHealth?: number;
  health?: number;
  terminal: boolean;
}

export function validateGame3dProfile(profile: GameTargetProfile): void {
  if (profile.core !== "3d") {
    throw new Error("3D training only accepts 3D target profiles.");
  }
  if (
    profile.control.aimMode !== "relative" ||
    !profile.control.maxPointerDelta
  ) {
    throw new Error(
      "3D training requires bounded relative pointer-look controls.",
    );
  }
}

export function encodeGame3dInput(
  input: GameInputSample,
  profile: GameTargetProfile,
): Game3dAction {
  validateGame3dProfile(profile);
  const movement = game3dMovementKeys.filter((key) =>
    input.heldKeys.includes(key),
  );
  assertNoOpposingMovement(movement);
  const maximum = profile.control.maxPointerDelta!;
  const deltaX = clamp(input.pointerDeltaX ?? 0, -maximum, maximum);
  const deltaY = clamp(input.pointerDeltaY ?? 0, -maximum, maximum);
  return {
    movement: [...movement],
    fire: input.primaryDown,
    look: {
      deltaX: closestLookBin(deltaX),
      deltaY: closestLookBin(deltaY),
    },
  };
}

export function game3dReward(transition: Game3dRewardTransition): number {
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

export function randomGame3dAction(
  random: () => number,
  profile: GameTargetProfile,
): Game3dAction {
  validateGame3dProfile(profile);
  const directions = [
    [] as Game3dAction["movement"],
    ["KeyW"] as Game3dAction["movement"],
    ["KeyA"] as Game3dAction["movement"],
    ["KeyS"] as Game3dAction["movement"],
    ["KeyD"] as Game3dAction["movement"],
    ["KeyW", "KeyA"] as Game3dAction["movement"],
    ["KeyW", "KeyD"] as Game3dAction["movement"],
    ["KeyS", "KeyA"] as Game3dAction["movement"],
    ["KeyS", "KeyD"] as Game3dAction["movement"],
  ];
  const randomBin = () =>
    game3dLookBins[Math.floor(random() * game3dLookBins.length)]!;
  return {
    movement: [...directions[Math.floor(random() * directions.length)]!],
    fire: random() >= 0.5,
    look: { deltaX: randomBin(), deltaY: randomBin() },
  };
}

function closestLookBin(value: number): (typeof game3dLookBins)[number] {
  return game3dLookBins.reduce((closest, candidate) =>
    Math.abs(candidate - value) < Math.abs(closest - value)
      ? candidate
      : closest,
  );
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function assertNoOpposingMovement(movement: readonly string[]): void {
  if (
    (movement.includes("KeyW") && movement.includes("KeyS")) ||
    (movement.includes("KeyA") && movement.includes("KeyD"))
  ) {
    throw new Error("3D actions cannot hold opposing movement keys.");
  }
}
