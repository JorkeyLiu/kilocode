---
"kilo-code": minor
---

Simplify Agent Manager to local-only sessions and remove worktree management. Child sessions are now fully interactive — you can type and continue the conversation directly in any spawned session. The Agent Manager sidebar shows a pure historical session tree with no worktree creation, promotion, diff, or merge workflows. Removed the New Worktree dialog, multi-model selector, apply/merge conflict UI, setup script configuration, section management, and all git worktree operations.
