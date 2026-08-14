import typescriptEslint from "typescript-eslint"
import eslintConfigPrettier from "eslint-config-prettier"

export default [
  {
    files: ["**/*.ts", "**/*.tsx"],
  },
  {
    plugins: {
      "@typescript-eslint": typescriptEslint.plugin,
    },

    languageOptions: {
      parser: typescriptEslint.parser,
      ecmaVersion: 2022,
      sourceType: "module",
    },

    rules: {
      "@typescript-eslint/naming-convention": [
        "warn",
        {
          selector: "import",
          format: ["camelCase", "PascalCase"],
        },
      ],

      curly: "warn",
      eqeqeq: "warn",
      "no-throw-literal": "warn",
      "max-lines": ["error", 3000],
      complexity: ["error", 20],
    },
  },

  // ── Complexity exceptions ─────────────────────────────────────────
  // Existing complexity violations are capped at their current max.
  // New code must stay ≤ 20. Do not raise complexity caps; refactor instead.
  {
    files: ["src/KiloProvider.ts"],
    // This is the extension integration surface; do not gate feature work on line-count churn.
    rules: { complexity: ["error", 150], "max-lines": "off" },
  },
  {
    files: ["webview-ui/agent-manager/AgentManagerApp.tsx"],
    // Raised from 3100 → 3200 for the experimental terminal tabs feature.
    // ~600 lines of terminal logic were extracted to ./terminal/* and
    // ./tab-rendering.tsx; the remaining ~75 lines are signal bindings,
    // a stacking-container wrapper required by the hydration invariant
    // (canvases must never leave the paint tree — see render.tsx), and
    // render-call wiring that must live at the top of
    // `AgentManagerContent` alongside the existing selection/session state.
    // Raised from 3200 → 3210 for the per-message feedback `FeedbackProvider`
    // wiring, which sits inside the provider chain and cannot be extracted
    // without adding an intermediate wrapper component.
    rules: { complexity: ["error", 74], "max-lines": ["error", 3210] },
  },
  {
    files: ["src/agent-manager/AgentManagerProvider.ts"],
    rules: { complexity: ["error", 64] },
  },
  {
    files: ["webview-ui/src/components/chat/PromptInput.tsx"],
    rules: { complexity: ["error", 48] },
  },
  {
    files: ["src/legacy-migration/migration-service.ts"],
    rules: { complexity: ["error", 45] },
  },
  {
    files: ["webview-ui/src/components/migration/MigrationWizard.tsx"],
    rules: { complexity: ["error", 37] },
  },
  {
    files: ["webview-ui/src/context/session.tsx"],
    // Raised from the default 3000 as this session context grew past the cap;
    // kept as a targeted override rather than loosening the global limit.
    // Raised 3100 → 3220 for the session lifecycle precedence wiring
    // (LOCK-002..005): explicit fresh-composer picks promoted through the
    // draft/session lifecycle and recovered no-variant tri-state handling are
    // reactive provider-chain state that cannot be extracted without an
    // intermediate provider layer; pure helpers already live in
    // session-model-store.ts, session-variant-store.ts, and session-pending.ts.
    // Raised 3220 → 3350 because the count is enforced on the prettier-
    // formatted file (CI runs `bun run format:check` on the same file); the
    // prettier expansion alone accounts for the growth. Picks are still
    // reseeded through the extracted seedPendingChoices helper (LOCK-002).
    rules: { complexity: ["error", 31], "max-lines": ["error", 3350] },
  },
  {
    files: ["src/services/autocomplete/classic-auto-complete/AutocompleteInlineCompletionProvider.ts"],
    rules: { complexity: ["error", 30] },
  },
  {
    files: ["webview-ui/src/components/chat/QuestionDock.tsx"],
    rules: { complexity: ["error", 28] },
  },
  {
    files: [
      "src/kilo-provider-utils.ts",
      "src/services/autocomplete/continuedev/core/autocomplete/postprocessing/index.ts",
    ],
    rules: { complexity: ["error", 27] },
  },
  {
    files: ["webview-ui/src/utils/errorUtils.ts"],
    rules: { complexity: ["error", 23] },
  },
  {
    files: ["src/services/autocomplete/continuedev/core/autocomplete/filtering/BracketMatchingService.ts"],
    rules: { complexity: ["error", 22] },
  },
  {
    files: ["webview-ui/src/context/server.tsx"],
    rules: { complexity: ["error", 21] },
  },

  eslintConfigPrettier,
]
