// ESLint flat config — new workspace lint. Keep it strict but additive:
// the preserved repo root (scripts/, vendor/, schemas/, tests/) stays lint-clean
// without being rewritten by this config (it is covered by format + sanitizer gates).
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "target/**",
      "apps/*/dist/**",
      "apps/*/node_modules/**",
      "apps/*/src-tauri/target/**",
      "apps/*/src-tauri/gen/**",
      "vendor/**",
      "poc-output/**",
      "local-scripts/**",
      "renders/**",
      "3D-Projects/**",
      ".husky/**",
      // Preserved legacy root: JS/.mjs kept lint-clean via format + sanitizer +
      // tests (S5-002 freezes it). The typed lint targets the NEW workspace only.
      "scripts/**",
      "tools/**",
      "tests/**",
      "ui/**",
      "presets/**",
      "schemas/**",
      "resources/**",
      "skills/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["apps/editor/src/**/*.{ts,tsx}"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }],
      // S6-001 AC: no `any` in new workspace code.
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
);
