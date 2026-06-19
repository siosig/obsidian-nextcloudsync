import tseslint from "typescript-eslint";
import obsidianmd from "eslint-plugin-obsidianmd";
import eslintComments from "@eslint-community/eslint-plugin-eslint-comments";
import { defineConfig } from "eslint/config";

// Mirrors the Obsidian community-directory reviewer (eslint-plugin-obsidianmd
// recommended, which already composes typescript-eslint recommendedTypeChecked).
// Type-aware rules need the TS project, supplied via parserOptions.project below.
export default defineConfig([
  { ignores: ["main.js", "coverage/", "*.config.mjs", "*.config.js", "tests/"] },
  ...obsidianmd.configs.recommended,
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { "@eslint-community/eslint-comments": eslintComments },
    rules: {
      // Mirror the directory reviewer: every eslint-disable directive must carry a
      // `-- reason` description. The reviewer flags undescribed directives even though
      // obsidianmd/recommended does not, so enforce it here to catch them pre-push.
      "@eslint-community/eslint-comments/require-description": ["error", { ignore: [] }],
      // The sentence-case rule's autosuggest naively lowercases proper nouns
      // (Nextcloud, WebDAV) and mangles URLs. Allowlist them so the rule only
      // flags genuine Title Case. (The directory reviewer does not block on this.)
      "obsidianmd/ui/sentence-case": [
        "error",
        {
          ignoreWords: ["Nextcloud", "WebDAV", "Obsidian", "URL", "JSON", "YAML", "ID", "v2", "Wi-Fi"],
          ignoreRegex: ["https?://", "\\.obsidian", "data\\.json", "bookmarks\\.json"],
        },
      ],
    },
  },
]);
