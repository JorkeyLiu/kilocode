#!/usr/bin/env bun
import { $ } from "bun"
import { join } from "node:path"
import { existsSync, mkdirSync, rmSync, chmodSync } from "node:fs"
import {
  copyKiloSandboxWorker,
  copySandboxResources,
  copyTreeSitterResources,
} from "../src/services/cli-backend/cli-resources"
import { ensureFfmpegForTarget } from "./ffmpeg-helper"
import {
  VSIX_TARGET_CONFIGS,
  normalizeTarget,
  serveBinaryFor,
  validateStagedBinDir,
  validateVsixFile,
} from "./artifact-validation"

const packageJsonPath = join(import.meta.dir, "..", "package.json")
const packageJson = await Bun.file(packageJsonPath).json()
const version = process.env.KILO_VERSION ? process.env.KILO_VERSION : packageJson.version
const prerelease = process.env.KILO_PRE_RELEASE === "true"

console.log(`Building VSCode extension version: ${version}${prerelease ? " (pre-release)" : ""}`)

if (packageJson.version !== version) {
  console.log(`Updating package.json version from ${packageJson.version} to ${version}`)
  packageJson.version = version
  await Bun.write(packageJsonPath, JSON.stringify(packageJson, null, 2) + "\n")
}

const cliDistDir = process.env.CLI_DIST_DIR || join(import.meta.dir, "..", "..", "opencode", "dist")
console.log(`Using CLI dist directory: ${cliDistDir}`)

if (!existsSync(cliDistDir)) {
  throw new Error(`CLI dist directory not found: ${cliDistDir}`)
}

// `--target <target>` selects a single target; no args builds all targets
// (existing CI behavior preserved). Selection is validated against the
// canonical matrix before any build step runs.
const targetFlag = process.argv.indexOf("--target")
const rawTarget = targetFlag !== -1 ? process.argv[targetFlag + 1] : undefined
if (targetFlag !== -1 && !rawTarget) {
  throw new Error(`--target requires a value (one of ${VSIX_TARGET_CONFIGS.map((c) => c.target).join(", ")})`)
}
const requested = rawTarget ? normalizeTarget(rawTarget) : undefined
if (requested) {
  console.log(`Single-target build requested: ${requested}`)
}
const targets = requested
  ? VSIX_TARGET_CONFIGS.filter((cfg) => cfg.target === requested)
  : [...VSIX_TARGET_CONFIGS]

const binDir = join(import.meta.dir, "..", "bin")
const distDir = join(import.meta.dir, "..", "dist")
const outDir = join(import.meta.dir, "..", "out")

console.log("\n🧹 Cleaning up directories...")
for (const dir of [binDir, distDir, outDir]) {
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true })
    console.log(`  ✓ Cleaned ${dir}`)
  }
}

mkdirSync(outDir, { recursive: true })
mkdirSync(distDir, { recursive: true })

console.log("\n🔄 Rebuilding SDK types (ensures dist/ is in sync with server API)...")
await $`bun run --cwd ${join(import.meta.dir, "..", "..", "sdk", "js")} build`

console.log("\n📦 Compiling extension...")
await $`bun run check-types:extension`
await $`bun run lint`
await $`node ${join(import.meta.dir, "..", "esbuild.js")} --production`

for (const config of targets) {
  console.log(`\n🎯 Processing target: ${config.target}`)

  if (existsSync(binDir)) {
    rmSync(binDir, { recursive: true, force: true })
  }
  mkdirSync(binDir, { recursive: true })

  const sourceServe = join(cliDistDir, config.cliDir, "bin", serveBinaryFor(config))
  const targetServe = join(binDir, serveBinaryFor(config))

  if (!existsSync(sourceServe)) {
    throw new Error(`Serve CLI binary not found at ${sourceServe}`)
  }

  console.log(`  📥 Copying serve binary from ${config.cliDir}/bin/${serveBinaryFor(config)}...`)
  await $`cp ${sourceServe} ${targetServe}`
  await copyTreeSitterResources(sourceServe, targetServe)
  await copySandboxResources(sourceServe, targetServe)
  await copyKiloSandboxWorker(sourceServe, targetServe)

  if (serveBinaryFor(config) !== "kilo-serve.exe") {
    chmodSync(targetServe, 0o755)
  }

  console.log(`  ✅ Binary ready at ${targetServe}`)

  // Serve-only VSIX: ensure no stale full CLI binary is staged and thus
  // packaged via `!bin/**` in .vscodeignore. Only remove owned files inside
  // the staged extension bin dir; never touch a user CLI outside it.
  for (const stale of [config.binary, config.binary === "kilo.exe" ? "kilo" : "kilo.exe"]) {
    const p = join(binDir, stale)
    if (existsSync(p)) {
      rmSync(p, { force: true })
      console.log(`  🧹 Removed stale full CLI ${stale} (serve-only VSIX)`)
    }
  }

  console.log("Adding bundled FFmpeg helper...")
  await ensureFfmpegForTarget(config.target, binDir)

  console.log("  🔍 Validating staged CLI artifacts...")
  validateStagedBinDir(binDir, config.target)

  console.log(`  📦 Packaging .vsix for ${config.target}${prerelease ? " (pre-release)" : ""}...`)
  const vsixPath = join(outDir, `kilo-vscode-${config.target}.vsix`)
  const args = ["--no-dependencies", "--skip-license", "--target", config.target, "-o", vsixPath]
  if (prerelease) args.push("--pre-release")
  await $`bunx vsce package ${args}`.env({
    ...process.env,
    npm_config_ignore_scripts: "true",
  })

  console.log("  🔍 Validating packaged VSIX archive...")
  validateVsixFile(vsixPath, config.target)
  console.log(`  ✅ Created ${vsixPath}`)
}

console.log("\n✨ All VSIX packages built successfully!")
