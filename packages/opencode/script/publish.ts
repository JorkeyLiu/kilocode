#!/usr/bin/env bun
// VSCode-only target: CLI public publishing disabled.
// This file previously published @kilocode/cli npm packages, Docker images to
// ghcr.io/kilo-org/kilocode, AUR (kilo-bin), and Homebrew tap formulae, and
// calculated SHAs from per-platform kilo-*.tar.gz/zip GH release archives.
// Those public distribution paths are removed for the VSCode-only cut.
// Build-cli remains serve-only artifact supplier to VSIX via the internal
// kilo-cli.tar.zst artifact (packages/opencode/dist packed in publish.yml),
// not via GH release archives. SDK/plugin and VSIX publishing remain in the
// root script/publish.ts. Do not re-enable NPM/Homebrew/AUR/Docker execution
// or GHCR/AUR secrets without restoring the public archive distribution model
// and external smoke harness compatibility (smoke-test.yml / kilo-bench).
// Retained as a no-op stub so root publish.ts import (now disabled) and direct
// invocations fail safe. See git history for the removed implementation.

console.log("=== cli publish skipped: VSCode-only target ===")
console.log("CLI public publishing (npm/Homebrew/AUR/Docker/GH release archives/GHCR) disabled; VSIX is the release artifact")
