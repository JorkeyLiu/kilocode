#!/usr/bin/env bun
/**
 * Watches packages/opencode/src/ for changes and rebuilds the CLI binary,
 * then copies it into packages/kilo-vscode/bin/kilo.
 *
 * Used during development so the VS Code extension always has an up-to-date
 * CLI backend without manual rebuild steps.
 */
import { watch, chmodSync } from "node:fs"
import { join, relative } from "node:path"
import { $ } from "bun"
import { copySandboxResources, copyTreeSitterResources } from "../src/services/cli-backend/cli-resources"

const kiloVscodeDir = join(import.meta.dir, "..")
const packagesDir = join(kiloVscodeDir, "..")
const opencodeDir = join(packagesDir, "opencode")
const opencodeSrcDir = join(opencodeDir, "src")
const targetBinDir = join(kiloVscodeDir, "bin")
// Platform naming mirrors script/local-bin.ts, server-manager.ts, and
// script/artifact-validation.ts: kilo(.exe) + kilo-serve(.exe).
const binName = process.platform === "win32" ? "kilo.exe" : "kilo"
const serveName = binName === "kilo.exe" ? "kilo-serve.exe" : "kilo-serve"
const targetBinPath = join(targetBinDir, binName)
const targetServePath = join(targetBinDir, serveName)

let building = false
let pending = false
let installed = false

function log(msg: string) {
  console.log(`[watch-cli] ${msg}`)
}

function platformTag(): string {
  const os = process.platform === "win32" ? "windows" : process.platform
  return `@kilocode/cli-${os}-${process.arch}`
}

function sourceBinaryPath(): string {
  return join(opencodeDir, "dist", platformTag(), "bin", binName)
}

function sourceServePath(): string {
  return join(opencodeDir, "dist", platformTag(), "bin", serveName)
}

async function rebuild() {
  if (building) {
    pending = true
    return
  }
  building = true
  pending = false

  try {
    log("Rebuilding CLI binary...")
    const start = performance.now()

    const args = installed ? ["run", "build", "--single", "--skip-install"] : ["run", "build", "--single"]
    const result = await $`bun ${args}`.cwd(opencodeDir).nothrow().quiet()
    if (result.exitCode !== 0) {
      log(`Build failed (exit ${result.exitCode}):\n${result.stderr.toString()}`)
      return
    }
    installed = true

    const source = sourceBinaryPath()
    if (!(await Bun.file(source).exists())) {
      log(`ERROR: Build completed but no binary found at ${relative(packagesDir, source)}`)
      return
    }

    await $`mkdir -p ${targetBinDir}`
    await $`cp ${source} ${targetBinPath}`
    await copyTreeSitterResources(source, targetBinPath)
    await copySandboxResources(source, targetBinPath)
    if (binName !== "kilo.exe") chmodSync(targetBinPath, 0o755)

    const serve = sourceServePath()
    if (await Bun.file(serve).exists()) {
      await $`cp ${serve} ${targetServePath}`
      if (serveName !== "kilo-serve.exe") chmodSync(targetServePath, 0o755)
      log(`Serve binary updated: ${relative(packagesDir, serve)} -> bin/${serveName}`)
    } else {
      log(`Serve binary not found at ${relative(packagesDir, serve)}; keeping full-CLI fallback.`)
    }

    const elapsed = ((performance.now() - start) / 1000).toFixed(1)
    log(`Binary updated (${elapsed}s): ${relative(packagesDir, source)} -> bin/${binName}`)
  } catch (err) {
    log(`ERROR: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    building = false
    if (pending) rebuild()
  }
}

// Initial build
await rebuild()

// Watch for changes
log(`Watching ${relative(kiloVscodeDir, opencodeSrcDir)}/ for changes...`)

const debounce = 500
let timer: ReturnType<typeof setTimeout> | null = null

watch(opencodeSrcDir, { recursive: true }, (_event, filename) => {
  if (!filename) return
  // Skip test files
  if (filename.endsWith(".test.ts") || filename.endsWith(".test.tsx")) return

  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    log(`Change detected: ${filename}`)
    rebuild()
  }, debounce)
})

log("CLI watcher running. Press Ctrl+C to stop.")
