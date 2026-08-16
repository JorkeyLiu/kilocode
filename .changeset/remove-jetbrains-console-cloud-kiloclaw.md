---
"@kilocode/cli": minor
"kilo-code": minor
"@kilocode/kilo-gateway": minor
---

Permanently remove the JetBrains IDE plugin, the web Console, cloud-sessions (preview/import/fork), and KiloClaw. The CLI no longer ships the `console`, `cloud-fork`, or KiloClaw chat commands or their TUI surfaces, the VS Code extension drops the KiloClaw provider, cloud session import/preview, and related commands, and the gateway removes the cloud-session endpoints. Remote sessions, generic session import, the EventServiceClient/presence bridge, and the current `kilo serve` HTTP/SSE/SDK migration bridge remain unchanged. The Kilo Code extension continues to be installed from the VS Code Marketplace and the CLI from npm.
