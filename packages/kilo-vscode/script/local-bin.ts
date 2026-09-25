#!/usr/bin/env bun
import { $ } from "bun"
import { join, relative, dirname, basename } from "node:path"
import { chmodSync, statSync, rmSync, readdirSync, existsSync, readFileSync } from "node:fs"
import {
  copyKiloSandboxWorker,
  copySandboxResources,
  copyTreeSitterResources,
  hasKiloSandboxWorker,
  hasTreeSitterResources,
  kiloSandboxWorkerForBinary,
  sanitizeSandboxResources,
} from "../src/services/cli-backend/cli-resources"
import { currentBwrapTarget, ensureBwrapForTarget } from "./bwrap-helper"
import { currentFfmpegTarget, ensureFfmpegForTarget } from "./ffmpeg-helper"
import { generateServeSourceWrapperContent, generateSourceWrapperContent } from "./source-wrapper"

const forceRebuild = process.argv.includes("--force")

/**
 * Ensures the VS Code extension has a serve-only CLI binary at `packages/kilo-vscode/bin/kilo-serve`.
 *
 * Bounded cut: public full `bin/kilo` is no longer produced by `packages/opencode`
 * (`bun run build --single --skip-install` now emits only `bin/kilo-serve`). Dev
 * staging is therefore primarily serve-only. The legacy full CLI source tree
 * (`src/index.ts` / TUI) is retained on disk for SDK generation, but the
 * compiled `bin/kilo` is not required for local-bin staging and is treated as
 * stale (removed when present). When a compiled backend cannot be produced,
 * the fallback source wrapper proxies `kilo-serve` to `src/serve-entry.ts`
 * (still via bun), so the wrapper never requires a nonexistent full binary.
 *
 * Strategy:
 * 1) If `bin/kilo-serve` already exists with resources -> ok.
 * 2) Else try to locate a prebuilt `kilo-serve` produced by `packages/opencode` build.
 * 3) Else try to build it via `bun run build --single` in `packages/opencode`.
 * 4) Copy the resulting `kilo-serve` into `packages/kilo-vscode/bin/kilo-serve` and chmod +x.
 * 5) Remove any stale `bin/kilo` left from previous full-binary staging (serve-only).
 *
 * This script is intended to be run from `packages/kilo-vscode` as part of build/package.
 */

const kiloVscodeDir = join(import.meta.dir, "..")
const packagesDir = join(kiloVscodeDir, "..")
const opencodeDir = join(packagesDir, "opencode")
const coreDir = join(packagesDir, "core")
const gatewayDir = join(packagesDir, "kilo-gateway")
const sandboxDir = join(packagesDir, "kilo-sandbox")

const targetBinDir = join(kiloVscodeDir, "bin")
const binName = process.platform === "win32" ? "kilo.exe" : "kilo"
const serveName = binName === "kilo.exe" ? "kilo-serve.exe" : "kilo-serve"
const targetBinPath = join(targetBinDir, binName)
const targetServePath = join(targetBinDir, serveName)
const versionFile = join(targetBinDir, ".cli-version")

function log(msg: string) {
  console.log(`[local-bin] ${msg}`)
}

async function cliSourceHash(): Promise<string | null> {
  try {
    const opencodeResult = await $`git log -1 --format=%H -- .`.cwd(opencodeDir).quiet()
    const coreResult = await $`git log -1 --format=%H -- .`.cwd(coreDir).quiet()
    const gatewayResult = await $`git log -1 --format=%H -- .`.cwd(gatewayDir).quiet()
    const sandboxResult = await $`git log -1 --format=%H -- .`.cwd(sandboxDir).quiet()
    return `${opencodeResult.text().trim()}-${coreResult.text().trim()}-${gatewayResult.text().trim()}-${sandboxResult.text().trim()}`
  } catch {
    return null
  }
}

async function isDirty(): Promise<boolean> {
  try {
    const opencodeResult = await $`git status --porcelain -- .`.cwd(opencodeDir).quiet()
    const coreResult = await $`git status --porcelain -- .`.cwd(coreDir).quiet()
    const gatewayResult = await $`git status --porcelain -- .`.cwd(gatewayDir).quiet()
    const sandboxResult = await $`git status --porcelain -- .`.cwd(sandboxDir).quiet()
    return (
      opencodeResult.text().trim().length > 0 ||
      coreResult.text().trim().length > 0 ||
      gatewayResult.text().trim().length > 0 ||
      sandboxResult.text().trim().length > 0
    )
  } catch {
    return false
  }
}

async function isStale(): Promise<boolean> {
  if (await isDirty()) return true
  const hash = await cliSourceHash()
  if (!hash) return false // can't determine — assume fresh
  try {
    const stored = (await Bun.file(versionFile).text()).trim()
    return stored !== hash
  } catch {
    return true // no version file — treat as stale
  }
}

function platformTag(): string {
  const os = process.platform === "win32" ? "windows" : process.platform
  return `cli-${os}-${process.arch}`
}

async function findServeBinaryInOpencodeDist(): Promise<string | null> {
  const distDir = join(opencodeDir, "dist")

  try {
    readdirSync(distDir)
  } catch {
    return null
  }

  // Prefer the binary matching the current platform (e.g. cli-darwin-arm64)
  const tag = platformTag()
  const preferred = join(distDir, `@kilocode`, tag, "bin", serveName)
  try {
    statSync(preferred)
    if (!hasTreeSitterResources(preferred) || !hasKiloSandboxWorker(preferred)) return null
    return preferred
  } catch {
    // fall through to generic search
  }

  // Fallback: find any dist/**/bin/kilo-serve or kilo-serve.exe
  const queue = [distDir]
  while (queue.length) {
    const dir = queue.pop()
    if (!dir) continue

    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }

    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) {
        queue.push(p)
        continue
      }
      if (e.isFile() && (e.name === "kilo-serve" || e.name === "kilo-serve.exe") && basename(dirname(p)) === "bin") {
        if (!hasTreeSitterResources(p) || !hasKiloSandboxWorker(p)) continue
        return p
      }
    }
  }
  return null
}

// Legacy name retained for internal callers; now serve-only.
async function findKiloBinaryInOpencodeDist(): Promise<string | null> {
  return findServeBinaryInOpencodeDist()
}

async function ensureBuiltBinary(): Promise<string> {
  const found = await findServeBinaryInOpencodeDist()
  if (found) return found

  log(
    `No prebuilt serve binary found under ${relative(kiloVscodeDir, join(opencodeDir, "dist"))} - attempting build via bun.`,
  )

  const bunPath = Bun.which("bun")
  if (!bunPath) {
    throw new Error(
      `Bun is required to build the CLI binary, but was not found on PATH. ` +
        `Install bun, or build the CLI separately in ${opencodeDir} and re-run.`,
    )
  }

  // Ensure dependencies are installed before building.
  log("Installing dependencies in opencode package...")
  await $`bun install --frozen-lockfile`.cwd(opencodeDir)

  // Build using the opencode package script (serve-only).
  await $`bun run build --single`.cwd(opencodeDir)

  const built = await findServeBinaryInOpencodeDist()
  if (!built) {
    throw new Error(
      `CLI build completed but no serve binary was found in ${join(opencodeDir, "dist")} (expected dist/**/bin/kilo-serve).`,
    )
  }
  return built
}

async function bundleKiloSandboxWorkerForServe() {
  const result = await Bun.build({
    entrypoints: [join(sandboxDir, "src", "kilo-sandbox-mutation-worker.ts")],
    target: "bun",
    format: "esm",
    minify: true,
  })
  if (!result.success || result.outputs.length !== 1) throw new Error("Could not bundle Kilo sandbox mutation worker")
  await Bun.write(kiloSandboxWorkerForBinary(targetServePath), result.outputs[0])
}

async function ensureLocalHelpers() {
  await ensureFfmpegForTarget(currentFfmpegTarget(), targetBinDir)
  if (process.env.KILO_SKIP_BUNDLED_BWRAP === "1") return
  if (await sanitizeSandboxResources(targetBinDir, true)) return
  await ensureBwrapForTarget(currentBwrapTarget())
}

async function writeSourceWrapper() {
  if (process.platform === "win32") {
    throw new Error("Compiled CLI build failed and source wrapper fallback is not supported on Windows.")
  }

  const bun = Bun.which("bun") ?? "bun"
  await $`mkdir -p ${targetBinDir}`
  // Serve-only wrapper: proxies `bin/kilo-serve` to `src/serve-entry.ts` so
  // local dev never requires a nonexistent full `bin/kilo` binary.
  await Bun.write(targetServePath, generateServeSourceWrapperContent(opencodeDir, bun))
  chmodSync(targetServePath, 0o755)
  // Also keep a legacy `bin/kilo` wrapper for transition callers that still
  // resolve the full name, but it is not required for staging readiness and
  // must not be treated as an error if absent. Stale production checks forbid
  // packaging this marker, but local dev may still populate it for backward
  // compat until full cutover.
  try {
    await Bun.write(targetBinPath, generateSourceWrapperContent(opencodeDir, bun))
    chmodSync(targetBinPath, 0o755)
  } catch {}
  await bundleKiloSandboxWorkerForServe()
  await ensureLocalHelpers()

  const hash = await cliSourceHash()
  if (hash) await Bun.write(versionFile, hash + "\n")
  log(
    `Compiled CLI build failed; wrote serve source wrapper at ${relative(kiloVscodeDir, targetServePath)} for local development.`,
  )
}

function isSourceWrapper(file: string): boolean {
  try {
    // Source wrapper fallback is a bash script, not a native binary.
    return readFileSync(file, "utf8").slice(0, 2) === "#!"
  } catch {
    return false
  }
}

type Stage = {
  serveReady: boolean
  wrapper: boolean
  ready: boolean
}

function stageState(): Stage {
  const serveExists = existsSync(targetServePath)
  const serveReady = serveExists && hasTreeSitterResources(targetServePath) && hasKiloSandboxWorker(targetServePath)
  // Source-wrapper fallback for serve has no compiled serve binary resources;
  // a shebang at `bin/kilo-serve` keeps dev staging ready without requiring
  // a compiled backend. Presence of a stale full `bin/kilo` is ignored.
  const wrapper = serveExists && isSourceWrapper(targetServePath)
  return { serveReady: serveReady || wrapper, wrapper, ready: serveReady || wrapper }
}

// Fast path: compiled serve was already staged but version file indicates fresh.
// Kept for backward compat when upgrading from an older bin layout.
async function copyMissingServeFromDist(): Promise<boolean> {
  const distServe = await findServeBinaryInOpencodeDist()
  if (!distServe) return false
  const from = distServe
  if (!existsSync(from)) return false
  await $`mkdir -p ${targetBinDir}`
  await $`cp ${from} ${targetServePath}`
  if (serveName !== "kilo-serve.exe") chmodSync(targetServePath, 0o755)
  await ensureLocalHelpers()
  log(`Copied serve CLI binary from ${relative(packagesDir, from)} -> ${relative(kiloVscodeDir, targetServePath)}`)
  return true
}

async function main() {
  const stage = stageState()
  const ready = stage.ready

  const stale = ready && !forceRebuild && (await isStale())
  const rebuild = forceRebuild || stale || !ready

  if (ready && !rebuild) {
    // Serve-only fast path: report serve binary, ignore stale full binary.
    try {
      const st = statSync(targetServePath)
      const kind = stage.wrapper ? "source wrapper" : `${Math.round(st.size / 1024 / 1024)}MB`
      log(
        `Serve CLI binary already present at ${relative(kiloVscodeDir, targetServePath)} (${kind}). Use --force to rebuild.`,
      )
    } catch {
      log(`Serve CLI binary already present at ${relative(kiloVscodeDir, targetServePath)}. Use --force to rebuild.`)
    }
    await ensureLocalHelpers()
    // Best-effort clean stale full binary (serve-only packaging forbids it).
    try {
      if (existsSync(targetBinPath) && !isSourceWrapper(targetBinPath)) {
        // Keep wrapper for local dev compat, but remove compiled stale full binary if present and not a wrapper.
        // Source wrappers are git-ignored and allowed locally; compiled `bin/kilo` would be rejected by artifact validation.
        const buf = readFileSync(targetBinPath)
        // Detect native binary via magic; if it's a binary, remove it to keep staging serve-only.
        const isBinary = buf.length > 4 && (buf[0] === 0x7f || buf[0] === 0x4d)
        if (isBinary) {
          rmSync(targetBinPath, { force: true })
          log(`Removed stale full CLI binary at ${relative(kiloVscodeDir, targetBinPath)} (serve-only staging)`)
        }
      }
    } catch {}
    return
  }

  cleanForRebuild(rebuild, stale)

  const opencodePkgFile = Bun.file(join(opencodeDir, "package.json"))
  if (!(await opencodePkgFile.exists())) {
    throw new Error(`Expected opencode package at ${opencodeDir}, but it does not exist.`)
  }

  const sourceBinPath = await ensureBuiltBinary().catch(async (err) => {
    await writeSourceWrapper()
    log(`Wrapper fallback reason: ${err instanceof Error ? err.message : String(err)}`)
    return null
  })
  if (!sourceBinPath) return
  await installBuiltBinary(sourceBinPath)
}

function cleanForRebuild(rebuild: boolean, stale: boolean): void {
  if (!rebuild) return
  const serveExists = existsSync(targetServePath)
  if (!serveExists) {
    if (forceRebuild) removeDist()
    return
  }
  log(stale ? `CLI source has changed — rebuilding.` : `Refreshing existing CLI resources.`)
  try {
    rmSync(targetServePath, { force: true })
  } catch {}
  // Also clean stale full binary (serve-only).
  try {
    if (existsSync(targetBinPath) && !isSourceWrapper(targetBinPath)) {
      rmSync(targetBinPath, { force: true })
    }
  } catch {}
  removeDist()
}

async function installBuiltBinary(source: string): Promise<void> {
  await $`mkdir -p ${targetBinDir}`
  await $`cp ${source} ${targetServePath}`
  await copyTreeSitterResources(source, targetServePath)
  await copySandboxResources(source, targetServePath)
  await copyKiloSandboxWorker(source, targetServePath)
  if (serveName !== "kilo-serve.exe") chmodSync(targetServePath, 0o755)
  // Clean any stale full binary left from previous full staging (serve-only VSIX forbids it).
  for (const stale of [binName, binName === "kilo.exe" ? "kilo" : "kilo.exe"]) {
    const p = join(targetBinDir, stale)
    if (p === targetServePath) continue
    try {
      if (existsSync(p) && !isSourceWrapper(p)) rmSync(p, { force: true })
    } catch {}
  }
  await ensureLocalHelpers()

  const hash = await cliSourceHash()
  if (hash) await Bun.write(versionFile, hash + "\n")

  log(`Copied serve CLI binary from ${relative(packagesDir, source)} -> ${relative(kiloVscodeDir, targetServePath)}`)
}

function removeDist() {
  // Also remove the prebuilt dist so ensureBuiltBinary() triggers a fresh build
  const distDir = join(opencodeDir, "dist")
  if (!existsSync(distDir)) return
  rmSync(distDir, { recursive: true })
  log(`Removed ${relative(kiloVscodeDir, distDir)} to force rebuild.`)
}

try {
  await main()
} catch (err) {
  console.error(`[local-bin] ERROR: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}
