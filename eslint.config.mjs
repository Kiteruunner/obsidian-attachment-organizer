// eslint.config.mjs
import tsparser from "@typescript-eslint/parser";
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
  ...obsidianmd.configs.recommended,

  // 只 lint 你的源码（更干净）
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      parser: tsparser,
      parserOptions: { project: "./tsconfig.json" },
    },
    rules: {
      "obsidianmd/sample-names": "off",
    },
  },


  { files: ["manifest.json"], rules: { "obsidianmd/validate-manifest": "warn" } },
  { files: ["LICENSE"], rules: { "obsidianmd/validate-license": "warn" } },


  {
    ignores: ["dist/**", "build/**", "node_modules/**", ".obsidian/**"],
  },
]);
