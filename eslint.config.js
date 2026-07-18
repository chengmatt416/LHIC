import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "coverage/**",
      "demo-output/**",
      "playwright-report/**",
      "test-results/**",
      ".lhic/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["docs-site/i18n-data.js"],
    rules: {
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
  {
    files: ["apps/desktop/src/preload/preload.cjs"],
    languageOptions: {
      globals: {
        require: "readonly",
      },
    },
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  {
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
        performance: "readonly",
        fetch: "readonly",
        URL: "readonly",
        document: "readonly",
        CSS: "readonly",
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
);
