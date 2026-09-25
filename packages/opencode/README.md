# Kilo Code Server (internal)

Internal runtime that powers the Kilo Code VS Code extension. The `kilo-serve` binary and its platform resources are bundled into the extension via the internal `kilo-cli.tar.zst` artifact and published as VSIX — not as a standalone CLI/TUI product.

Kilo is the all-in-one agentic engineering platform. Build, ship, and iterate faster with the open source coding agent in [VS Code](https://kilo.ai/landing/vs-code).

[Website](https://kilo.ai) · [VS Code Extension](https://marketplace.visualstudio.com/items?itemName=kilocode.Kilo-Code) · [Docs](https://kilo.ai/docs) · [Models](https://kilo.ai/leaderboard) · [Gateway](https://kilo.ai/gateway) · [Pricing](https://kilo.ai/pricing)

## Internal usage

This package is not installed via `npm`, `brew`, or GitHub release archives. The VS Code extension build consumes the output of `packages/opencode/script/build.ts` (packed as `kilo-cli.tar.zst`) and bundles `kilo-serve` per platform into the VSIX.

For local development:

```bash
bun run --conditions=browser ./src/index.ts
# or build the serve artifact
./script/build.ts
```

See root `AGENTS.md` and `packages/kilo-docs/pages/contributing/architecture/cli-runtime.md` for runtime and config lifecycle details.

## Features (internal)

- **Code generation** — describe what you want in natural language
- **Terminal commands** — the agent can run shell commands on your behalf
- **500+ AI models** — use models from OpenAI, Anthropic, Google, and more
- **MCP servers** — extend agent capabilities with the Model Context Protocol
- **Multiple modes** — Plan with Architect, code with Coder, debug with Debugger, or create your own
- **Sessions** — resume previous conversations and export transcripts
- **API keys optional** — bring your own keys or use Kilo credits

Internal commands are served via `kilo-serve` and exposed through the extension; run `kilo-serve --help` from a built artifact for the current command list.

## Documentation

- [Docs](https://kilo.ai/docs)
- [VS Code Extension](https://kilo.ai/docs/code-with-ai/platforms/vscode)
- [Architecture — CLI Runtime](https://kilo.ai/docs/contributing/architecture/cli-runtime)

## Links

- [GitHub](https://github.com/Kilo-Org/kilocode)
- [Discord](https://kilo.ai/discord)
- [VS Code Extension](https://kilo.ai/vscode-marketplace)
- [Website](https://kilo.ai)

## License

MIT
