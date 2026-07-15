import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  test: {
    testTimeout: 15_000,
  },
  resolve: {
    alias: {
      "@lhic/schema": source("./packages/schema/src/index.ts"),
      "@lhic/trace": source("./packages/trace/src/index.ts"),
      "@lhic/security": source("./packages/security/src/index.ts"),
      "@lhic/browser": source("./packages/browser/src/index.ts"),
      "@lhic/verifier": source("./packages/verifier/src/index.ts"),
      "@lhic/skills": source("./packages/skills/src/index.ts"),
      "@lhic/controller": source("./packages/controller/src/index.ts"),
      "@lhic/memory": source("./packages/memory/src/index.ts"),
    },
  },
});
