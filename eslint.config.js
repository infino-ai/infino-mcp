// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// Lint configuration: the recommended rule sets for JavaScript and TypeScript,
// Node globals everywhere, and the built output ignored. Warnings fail CI
// (`--max-warnings 0` in the lint script), so a rule is either on or off.

import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "node_modules/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.js", "**/*.mjs", "**/*.ts"],
    languageOptions: { globals: globals.node },
  },
);
