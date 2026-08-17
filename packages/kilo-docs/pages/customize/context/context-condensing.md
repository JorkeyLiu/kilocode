---
title: "Context Recovery"
description: "How Kilo manages conversation context automatically through internal overflow recovery"
---

# Context Recovery

## Overview

When working on complex tasks, conversations with Kilo Code can grow long and consume a significant portion of the AI model's context window. Kilo Code manages this automatically through **internal overflow recovery** — no manual intervention or configuration is required.

{% tabs %}
{% tab label="VSCode" %}

## How it works

When a conversation approaches the model's context window limit, Kilo automatically compacts the history into an anchored summary that captures:

- The overall goal of the session
- Constraints and preferences you gave along the way
- Progress, key decisions, and next steps
- Critical context needed to continue
- Relevant files and directories

This summary replaces older conversation history while Kilo keeps the most recent turns verbatim when they fit. If a session has already been compacted, Kilo updates the previous summary instead of starting over, preserving still-relevant details and removing stale ones.

## When recovery triggers

Kilo checks provider-reported usage after each response and estimates the outgoing text, system instructions, and tool definitions before contacting the provider. Compaction runs when either count reaches the usable context window (model input limit minus a reserved safety buffer), or when the model reports a context overflow error, whichever happens first.

How the buffer is chosen depends on what the model declares. When the model advertises a separate input limit, the buffer defaults to 20,000 tokens (or the model's maximum output size, whichever is smaller). When the model only declares a single context window, Kilo instead reserves the model's full output cap — up to 32,000 tokens.

Custom models that do not declare a context window are not tracked, and automatic overflow recovery does not run for them.

## Context pruning

Between turns, Kilo also runs a lighter **prune** pass. It walks completed tool outputs outside a 40,000-token recency window and replaces them with `"[Old tool result content cleared]"`. Pruning runs only as part of automatic overflow recovery, not on every turn.

## Plugin hooks

Plugins can hook into the automatic overflow recovery process:

- `experimental.session.compacting` — inject extra context or replace the compaction prompt entirely
- `experimental.compaction.autocontinue` — disable the synthetic "continue" turn that follows compaction

See [Plugins](/docs/automate/extending/plugins) for details.

{% /tab %}
{% tab label="CLI" %}

## How it works

When a conversation approaches the model's context window limit, Kilo automatically compacts the history into an anchored summary that captures:

- The overall goal of the session
- Constraints and preferences you gave along the way
- Progress, key decisions, and next steps
- Critical context needed to continue
- Relevant files and directories

This summary replaces older conversation history while Kilo keeps the most recent turns verbatim when they fit. If a session has already been compacted, Kilo updates the previous summary instead of starting over, preserving still-relevant details and removing stale ones.

## When recovery triggers

Kilo checks provider-reported usage after each response and estimates the outgoing text, system instructions, and tool definitions before contacting the provider. Compaction runs when either count reaches the usable context window (model input limit minus a reserved safety buffer), or when the model reports a context overflow error, whichever happens first.

How the buffer is chosen depends on what the model declares. When the model advertises a separate input limit, the buffer defaults to 20,000 tokens (or the model's maximum output size, whichever is smaller). When the model only declares a single context window, Kilo instead reserves the model's full output cap — up to 32,000 tokens.

[Custom models](/docs/code-with-ai/agents/custom-models) that do not declare a context window are not tracked, and automatic overflow recovery does not run for them.

## Context pruning

Between turns, Kilo also runs a lighter **prune** pass. It walks completed tool outputs outside a 40,000-token recency window and replaces them with `"[Old tool result content cleared]"`. Pruning runs only as part of automatic overflow recovery, not on every turn.

## Plugin hooks

Plugins can hook into the automatic overflow recovery process:

- `experimental.session.compacting` — inject extra context or replace the compaction prompt entirely
- `experimental.compaction.autocontinue` — disable the synthetic "continue" turn that follows compaction

See [Plugins](/docs/automate/extending/plugins) for details.

{% /tab %}
{% /tabs %}

## Best Practices

### Minimize context growth

- **Use AGENTS.md**: Encode persistent project context, coding standards, and conventions in [AGENTS.md](/docs/customize/agents-md) or custom instructions. This avoids repeating the same context in every prompt.
- **Start new sessions for unrelated tasks**: Each fresh session starts with a clean context window.
- **Use `@` mentions selectively**: Include only files directly relevant to the current task.

### Monitor session length

Sessions that grow very long will trigger automatic recovery, which summarizes the conversation. If you need full context continuity for a critical task, start a fresh session and include the relevant files.

## Related Features

- [AGENTS.md](/docs/customize/agents-md) — Persistent context storage across sessions
- [.kilocodeignore](/docs/customize/context/kilocodeignore) — Control which files the agent can access
- [Plugins](/docs/automate/extending/plugins) — Customize the compaction process via plugin hooks
