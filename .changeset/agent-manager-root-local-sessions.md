---
"kilo-code": minor
---

Remove managed worktrees, setup/run scripts, multi-version comparison, and branch/PR import from Agent Manager. The `agent_manager` tool now only starts sessions; it no longer inspects or prompts existing managed sessions. Agent Manager sessions now share the workspace root, and the custom diff viewer is removed in favor of native VS Code diffs and `@git-changes`.
