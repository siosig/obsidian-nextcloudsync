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
      //
      // `brands` REPLACES (not merges with) the rule's own default list, so it is
      // copied here verbatim from eslint-plugin-obsidianmd's DEFAULT_BRANDS, minus
      // "Git". That single entry force-recapitalizes every case-insensitive match of
      // the word "git" to "Git" — including inside our literal, always-lowercase
      // folder name ".git" — which the reviewer flagged as a hard error (its
      // `eslint-disable` for this rule is explicitly disallowed by the Obsidian
      // directory reviewer, unlike a plain rule-option override like this one).
      // Do not reintroduce "Git" here; any future UI text mentioning it should
      // instead avoid claiming a specific capitalization, or use ignoreRegex.
      "obsidianmd/ui/sentence-case": [
        "error",
        {
          ignoreWords: ["Nextcloud", "WebDAV", "Obsidian", "URL", "JSON", "YAML", "ID", "v2", "Wi-Fi"],
          ignoreRegex: ["https?://", "\\.obsidian", "data\\.json", "bookmarks\\.json"],
          brands: [
            "iOS", "iPadOS", "macOS", "Windows", "Android", "Linux",
            "Obsidian", "Obsidian Sync", "Obsidian Publish",
            "Google", "Gemini", "Vertex AI", "OpenAI", "GPT", "Anthropic", "Claude", "Cursor", "Microsoft",
            "Google Drive", "Dropbox", "OneDrive", "iCloud Drive",
            "YouTube", "Slack", "Discord", "Telegram", "WhatsApp", "Twitter", "X",
            "Readwise", "Zotero", "Excalidraw", "Mermaid",
            "Markdown", "LaTeX", "JavaScript", "TypeScript", "Node.js", "npm", "pnpm", "Yarn",
            /* "Git" intentionally omitted — see comment above */ "GitHub", "GitLab",
            "Notion", "Evernote", "Roam Research", "Logseq", "Anki", "Reddit",
            "VS Code", "Visual Studio Code", "IntelliJ IDEA", "WebStorm", "PyCharm",
            "React", "Svelte", "CalDAV", "CardDAV", "WebDAV",
          ],
        },
      ],
    },
  },
]);
