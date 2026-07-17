import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  test: {
    testTimeout: 15_000,
    hookTimeout: 15_000,
    fileParallelism: false,
  },
  resolve: {
    alias: {
      "@lhic/schema": source("./packages/schema/src/index.ts"),
      "@lhic/trace": source("./packages/trace/src/index.ts"),
      "@lhic/security": source("./packages/security/src/index.ts"),
      "@lhic/game-training": source("./packages/game-training/src/index.ts"),
      "@lhic/game-training-2d": source(
        "./packages/game-training-2d/src/index.ts",
      ),
      "@lhic/game-training-3d": source(
        "./packages/game-training-3d/src/index.ts",
      ),
      "@lhic/browser": source("./packages/browser/src/index.ts"),
      "@lhic/verifier": source("./packages/verifier/src/index.ts"),
      "@lhic/skills": source("./packages/skills/src/index.ts"),
      "@lhic/controller": source("./packages/controller/src/index.ts"),
      "@lhic/memory": source("./packages/memory/src/index.ts"),
      "@lhic/shared-skills": source("./packages/shared-skills/src/index.ts"),
    },
  },
});
