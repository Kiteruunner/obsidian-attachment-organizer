// eslint.config.mjs
import tsparser from "@typescript-eslint/parser";
import tseslint from "@typescript-eslint/eslint-plugin";
import obsidianmd from "eslint-plugin-obsidianmd";

export default [
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tsparser,
      parserOptions: { 
        project: "./tsconfig.json",
        ecmaVersion: 2020,
        sourceType: "module",
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
      "obsidianmd": obsidianmd,
    },
    rules: {
      // TypeScript rules
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": ["error", { "args": "none" }],
      "@typescript-eslint/ban-ts-comment": "off",
      "no-prototype-builtins": "off",
      "@typescript-eslint/no-empty-function": "off",
      
      // Obsidian-specific rules (from recommended)
      "obsidianmd/detach-leaves": "warn",
      "obsidianmd/no-forbidden-elements": "warn",
      "obsidianmd/no-plugin-as-component": "warn",
      "obsidianmd/no-sample-code": "warn",
      "obsidianmd/no-static-styles-assignment": "warn",
      "obsidianmd/no-tfile-tfolder-cast": "warn",
      "obsidianmd/no-view-references-in-plugin": "warn",
      "obsidianmd/platform": "warn",
      "obsidianmd/regex-lookbehind": "warn",
      "obsidianmd/validate-manifest": "warn",
      "obsidianmd/settings-tab/no-manual-html-headings": "warn",
      "obsidianmd/settings-tab/no-problematic-settings-headings": "warn",
      "obsidianmd/ui/sentence-case": "warn",
      "obsidianmd/commands/no-command-in-command-id": "warn",
      "obsidianmd/commands/no-command-in-command-name": "warn",
      "obsidianmd/commands/no-plugin-id-in-command-id": "warn",
      "obsidianmd/commands/no-plugin-name-in-command-name": "warn",
      
      // Turn off sample-names since we already renamed
      "obsidianmd/sample-names": "off",
    },
  },
];
