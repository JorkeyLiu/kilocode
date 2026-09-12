---
title: "MCP Overview"
description: "Overview of the Model Context Protocol"
---

# Model Context Protocol (MCP)

The Model Context Protocol (MCP) is a standard for extending Kilo Code's capabilities by connecting to external tools and services. MCP servers provide additional tools and resources that help Kilo Code accomplish tasks beyond its built-in capabilities, such as accessing databases, custom APIs, and specialized functionality.

Configure MCP servers locally in `kilo.jsonc` under the `mcp` key, or in Settings > Agent Behaviour > MCP Servers.

## MCP Documentation

This documentation is organized into several sections:

- [**Using MCP in Kilo Code**](using-in-kilo-code) - Comprehensive guide to configuring, enabling, and managing MCP servers with Kilo Code. Includes server settings, tool approval, and troubleshooting.

- [**MCP Tool Permissions**](using-in-kilo-code#auto-approve-tools) - Control which MCP tools auto-approve, prompt, or are blocked entirely using the same `allow` / `ask` / `deny` permission system as built-in tools.

- [**What is MCP?**](what-is-mcp) - Clear explanation of the Model Context Protocol, its client-server architecture, and how it enables AI systems to interact with external tools.

- [**STDIO & SSE Transports**](server-transports) - Detailed comparison of local (STDIO) and remote (SSE) transport mechanisms with deployment considerations for each approach.

- [**MCP vs API**](mcp-vs-api) - Analysis of the fundamental distinction between MCP and REST APIs, explaining how they operate at different layers of abstraction for AI systems.

For more details on contributing to Kilo Code, see the [Contributing Guide](/docs/contributing).
