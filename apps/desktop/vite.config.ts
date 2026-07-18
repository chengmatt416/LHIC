import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    outDir: "dist/renderer",
    emptyOutDir: false,
  },
  resolve: {
    alias: {
      "@desktop": source("./src"),
    },
  },
});
