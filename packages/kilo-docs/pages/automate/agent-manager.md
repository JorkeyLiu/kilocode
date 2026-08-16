---
title: "Agent Manager"
description: "Manage and orchestrate multiple AI agents"
---

# Agent Manager

The Agent Manager is a control panel for running and orchestrating multiple Kilo Code agents in parallel.

The Agent Manager is a **full-panel editor tab** built directly into the extension. It uses the extension's embedded runtime, so no separate Kilo CLI installation or CLI authentication setup is required. It supports:

- Multiple parallel sessions at the workspace root, each in its own tab
- Topic-first session navigation in the sidebar, with child sessions grouped under their root session
- Dedicated VS Code integrated terminals per session
- The same providers, BYOK keys, custom providers, and extension features supported in the editor-tab chat

{% callout type="warning" %}
All Agent Manager sessions run in the **same workspace directory**. There is no per-session git worktree isolation: sessions share the branch, the files, and the terminal roots. Sessions that edit the same files can conflict, so delegate distinct areas of work to each session.
{% /callout %}

{% callout type="tip" %}
New to running multiple agents in parallel? The [Agent Manager Workflows](/docs/automate/agent-manager-workflows) guide walks through when to use a single chat session vs. the Agent Manager, how to pick tasks that parallelize well, and how to coordinate shared-directory sessions.
{% /callout %}

## Opening the Agent Manager

- Keyboard shortcut: `Cmd+Shift+M` (macOS) / `Ctrl+Shift+M` (Windows/Linux)
- Command Palette: "Kilo Code: Agent Manager"

The panel opens as an editor tab and stays active across focus changes.

## Requirements

- Open a VS Code workspace folder

## Providers and Authentication

Agent Manager uses the same sign-in, provider settings, models, BYOK keys, custom providers, MCP servers, and permission rules as the editor-tab chat. Configure them from extension Settings and they apply to Agent Manager as well.

See [Authentication](/docs/getting-started/setup-authentication), [AI Providers](/docs/ai-providers), and [Bring Your Own Key](/docs/getting-started/byok) for setup details.

## Sessions, Tabs, and Topics

Each session is a full conversation in its own tab. Multiple sessions run concurrently and share the workspace directory.

- **New session:** Click **New Tab** in the tab bar, or press `Cmd+T` (macOS) / `Ctrl+T` (Windows/Linux), then type your first message.
- **New terminal:** Press `Cmd+Shift+T` (macOS) / `Ctrl+Shift+T` (Windows/Linux) to open a terminal tab for the current session.
- **Close tab:** Press `Cmd+W` (macOS) / `Ctrl+W` (Windows/Linux).
- **Rename:** Double-click a session title to edit it inline, or use the session's context menu.
- **Fork:** Use **Fork Session** to spawn a new session seeded with an existing conversation, then steer it differently without losing the original.

The sidebar groups sessions into **topics**: each root session defines a topic, and child sessions (created through sub-agent delegation) are listed beneath it. Topics are derived from the session's runtime facts — there is no manual section management. The active session's topic is highlighted and expanded automatically.

## Starting Sessions From Chat

Kilo can start Agent Manager sessions from chat with the `agent_manager` tool. It is available by default only in the VS Code extension because Agent Manager is an extension feature.

The tool starts sessions directly: provide a `tasks` array with 1–20 tasks. Each task must include a `prompt` or a display `name`. Sessions always run at the workspace root, concurrently, without worktree isolation.

Prompted tasks inherit the model and reasoning variant used by the chat turn that starts them. A task can override that selection with a `model` (by name, e.g. `Claude Opus 4.1`) when you explicitly request a different model, or with one of the current model's reasoning `variant` values when you request a different variant. Agent Manager resolves the provider for a model override, preferring the provider used by the current turn and falling back to the Kilo Gateway; a qualified `provider/model` ID is also accepted to force a specific provider. A model or variant selection requires an initial prompt so the session can persist that selection. Prepared sessions without an initial prompt use the normal model defaults.

The companion `agent_manager_models` tool searches models and their supported reasoning variants on demand. Results are grouped by model name (with the offering providers listed for reference) and limited to 20 per call, so the full catalog is never added to the conversation context.

The tool uses the `agent_manager` permission with the `start` capability.

## Sending Messages, Approvals, and Control

- **Continue the conversation:** Send a follow-up message to the running agent
- **Approvals:** The Permission Dock shows tool approval prompts — approve once, approve always, or deny
- **Cancel:** Sends a cooperative stop signal to the agent
- **Stop:** Force-terminates the session and marks it as stopped

## Reviewing Changes and Checkpoints

Each agent turn that modified files reports a static count of the modified files. To review the actual changes, open the files in VS Code's native Source Control diff, or attach the current working-tree changes to a prompt with the `@git-changes` mention.

You can also review and roll back work at any point in the conversation:

- **Revert to here:** Hover over a user message and click the revert button to restore your workspace to the state just before that message was sent and hide the later messages. This is a snapshot-based rollback — the session's earlier state and the checkpoint baseline remain intact.
- **Revert Banner:** After reverting, a banner shows the number of reverted messages and per-file diff stats. Use **Redo** to step forward one message at a time, or **Redo All** to restore the latest state.
- **Make it permanent:** Send a new message while reverted to branch off from that point.

See [Checkpoints](/docs/code-with-ai/features/checkpoints) for the full snapshot and rollback story.

## Terminals

Each session has a dedicated integrated terminal rooted in the workspace directory. Press `Cmd+/` (macOS) / `Ctrl+/` (Windows/Linux) to focus the terminal for the active session.

### Switching Between Terminal and Agent Manager

A common workflow is letting the agent work, then switching to the terminal to run tests or inspect the workspace, then switching back to control the agent:

1. **Agent Manager → Terminal:** Press `Cmd+/` (macOS) / `Ctrl+/` (Windows/Linux) to open and focus the terminal for the current session. Commands like `npm test` or `git status` operate in the shared workspace.
2. **Terminal → Agent Manager:** Press `Cmd+Shift+M` (macOS) / `Ctrl+Shift+M` (Windows/Linux) to bring focus back to the Agent Manager panel and its prompt input. This works from anywhere in VS Code — the terminal or another editor tab.

Because every session shares the workspace directory, be careful with stateful commands in session terminals: ports, caches, build outputs, and local databases are shared, so two sessions can collide on the same resource.

## Session State and Persistence

Agent Manager presentation state (open tabs, active tab, sidebar state, tab order) is persisted through the VS Code webview state API. There is no `.kilo/agent-manager.json` state file and no `.kilo/worktrees/` directory. Sessions themselves are normal CLI sessions stored in the shared Kilo backend, so they persist across reloads and appear in session history.

## Keyboard Shortcuts (Agent Manager Panel)

| Shortcut (macOS) | Shortcut (Windows/Linux) | Action |
|---|---|---|
| `Cmd+Shift+M` | `Ctrl+Shift+M` | Open / focus Agent Manager (works from anywhere) |
| `Cmd+T` | `Ctrl+T` | New tab (session) |
| `Cmd+Shift+T` | `Ctrl+Shift+T` | New terminal |
| `Cmd+W` | `Ctrl+W` | Close current tab |
| `Cmd+Alt+Up` / `Down` | `Ctrl+Alt+Up` / `Down` | Previous / next session |
| `Cmd+Alt+Left` / `Right` | `Ctrl+Alt+Left` / `Right` | Previous / next tab |
| `Cmd+1` … `Cmd+9` | `Ctrl+1` … `Ctrl+9` | Jump to session/tab by index |
| `Cmd+F` | `Ctrl+F` | Search sessions |
| `Cmd+/` | `Ctrl+/` | Focus terminal for current session |
| `Cmd+Shift+/` | `Ctrl+Shift+/` | Show keyboard shortcuts |
| `Cmd+.` | `Ctrl+.` | Cycle agent mode |

## Troubleshooting

- **"Please open a folder…" error** — the Agent Manager requires a VS Code workspace folder
- **Provider or authentication errors** — open extension Settings and verify your sign-in, provider, model, or BYOK configuration. Agent Manager uses the same settings as the rest of the extension.
- **Session history missing cloud sessions** — sign in through the extension and confirm the repository remote matches the sessions you expect to see.

## Related features

- [Agent Manager Workflows](/docs/automate/agent-manager-workflows)
- [Checkpoints](/docs/code-with-ai/features/checkpoints)
- [Sessions](/docs/collaborate/sessions-sharing)
- [Auto-approving Actions](/docs/getting-started/settings/auto-approving-actions)
- [AI Providers](/docs/ai-providers)
- [Bring Your Own Key](/docs/getting-started/byok)
