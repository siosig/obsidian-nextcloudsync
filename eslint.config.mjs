import tseslint from "typescript-eslint";
import obsidianmd from "eslint-plugin-obsidianmd";
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
    rules: {
      // The sentence-case rule's autosuggest naively lowercases proper nouns
      // (Nextcloud, WebDAV) and mangles URLs. Allowlist them so the rule only
      // flags genuine Title Case. (The directory reviewer does not block on this.)
      "obsidianmd/ui/sentence-case": [
        "error",
        {
          ignoreWords: ["Nextcloud", "WebDAV", "Obsidian", "URL", "JSON", "YAML", "ID", "v2"],
          ignoreRegex: ["https?://", "\\.obsidian", "data\\.json", "bookmarks\\.json"],
        },
      ],
    },
  },
]);
