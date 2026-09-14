import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Vendored minified opus-recorder encoder worker (served statically).
    "public/opus/**",
    // Untracked vendored copies of the command-board app, bundled dist/
    // and .next/ included. Not this project's code; linting them reported
    // 15 errors from files nobody here maintains.
    "project-command-board/**",
    "tools/**",
  ]),
]);

export default eslintConfig;
