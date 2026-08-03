#!/usr/bin/env bun
/**
 * Unified local packaging command (LOCK-006).
 *
 * Builds the current-platform native CLI via the opencode `build --single`
 * flow, then invokes the existing production VSIX builder for exactly one
 * target. The production builder performs native-binary and VSIX archive
 * validation before and after packaging (see script/build.ts), so a source
 * wrapper, `.cli-version` marker, or wrong-architecture binary fails here.
 *
 * Usage:
 *   bun run package:vsix -- --target <target>
 *
 * The requested target must equal the current Bun platform/arch target
 * (e.g. darwin-arm64 on Apple Silicon), because `build --single` can only
 * produce a native binary for the machine running this command.
 */

import { $ } from "bun"
import { join } from "node:path"
import { currentPlatformTarget, normalizeTarget, VSIX_TARGET_CONFIGS } from "./artifact-validation"

const kiloVscodeDir = join(import.meta.dir, "..")
const opencodeDir = join(kiloVscodeDir, "..", "opencode")

const flag = process.argv.indexOf("--target")
const raw = flag !== -1 ? process.argv[flag + 1] : undefined
if (!raw) {
  throw new Error(
    `--target is required (one of ${VSIX_TARGET_CONFIGS.map((c) => c.target).join(", ")})\n` +
      `Usage: bun run package:vsix -- --target <target>`,
  )
}
const target = normalizeTarget(raw)

const current = currentPlatformTarget()
if (target !== current) {
  throw new Error(
    `Requested target ${target} does not match the current Bun platform ${current}. ` +
      `This command builds the native CLI for the machine it runs on; ` +
      `use the production builder (bun script/build.ts) for other targets.`,
  )
}

console.log(`[package:vsix] Target: ${target} (matches current Bun platform ${current})`)
console.log(`[package:vsix] Building native CLI via opencode \`build --single\`...`)
await $`bun run build --single`.cwd(opencodeDir)

console.log(`[package:vsix] Packaging VSIX for ${target} via production builder...`)
await $`bun script/build.ts --target ${target}`.cwd(kiloVscodeDir)

console.log(`[package:vsix] Done: packages/kilo-vscode/out/kilo-vscode-${target}.vsix`)
