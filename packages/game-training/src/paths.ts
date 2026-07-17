import { join, resolve } from "node:path";

import type { GameCoreId, GameTrainingPaths } from "./types.js";

export function gameTrainingPaths(
  core: GameCoreId,
  root = ".lhic/game-training",
): GameTrainingPaths {
  const resolvedRoot = resolve(root);
  const coreRoot = join(resolvedRoot, core);
  return {
    root: resolvedRoot,
    coreRoot,
    datasetsRoot: join(coreRoot, "datasets"),
    skillsRoot: join(coreRoot, "skills"),
    reportsRoot: join(coreRoot, "reports"),
    tracesRoot: join(coreRoot, "traces"),
    targetsRoot: join(coreRoot, "targets"),
    environmentRoot: join(resolvedRoot, "venv"),
  };
}
