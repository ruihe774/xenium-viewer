import js from "@eslint/js";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // `.venv` and the sample data sit in the working tree but are not ours.
  { ignores: ["dist", "node_modules", ".venv", "*.zarr", "slide01_annotations"] },

  // Applies to every config below, including the plugin presets.
  { settings: { react: { version: "detect" } } },

  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  react.configs.flat.recommended,
  react.configs.flat["jsx-runtime"],
  reactHooks.configs.flat.recommended,

  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      // Type-aware linting: the value of a linter here is mostly in catching
      // floating promises and unsafe `any` flow across the worker boundary,
      // none of which is visible without types.
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.browser, ...globals.worker },
    },
    linterOptions: {
      // An `eslint-disable` that no longer suppresses anything is a stale claim
      // about the code. Reject it rather than letting it rot.
      reportUnusedDisableDirectives: "error",
    },
    rules: {
      // Enabled so the directive in RangeSlider is a real, checked exemption
      // rather than a comment referencing a rule nothing runs.
      "react/no-array-index-key": "error",
      // Unused args are usually a signal, but leading underscore is the
      // conventional opt-out and TypeScript already flags the rest.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },

  // Config files run in Node and are outside the app's tsconfig.
  {
    files: ["*.config.{js,ts}"],
    languageOptions: {
      globals: globals.node,
      parserOptions: { projectService: false },
    },
    extends: [tseslint.configs.disableTypeChecked],
  },
);
